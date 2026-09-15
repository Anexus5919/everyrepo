import { spawn } from "node:child_process";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseRepoRef } from "@everyrepo/core";
import type { RepoRow } from "@everyrepo/db";
import { createIndexHandlers, createWikiHandlers } from "@everyrepo/pipeline";
import type { Job } from "@everyrepo/queue";
import { markPublished } from "@everyrepo/requests";
import { Command } from "commander";
import { createAllowanceClock, type AllowanceClock } from "../build-work.ts";
import {
  openContext,
  openEmbedder,
  openLlm,
  openRequests,
  timestamp,
  type CliContext,
} from "../context.ts";
import { exportSite } from "../site-export.ts";
import { createWorker, type JobRuntime } from "../worker.ts";

interface WorkerOptions {
  once?: boolean;
  poll: string;
  build: boolean;
}

// Builds the website from the fresh site data; output is kept only to explain a failure
function buildWebsite(siteData: string, log: (message: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    log("building the website");
    const child = spawn("pnpm", ["--filter", "@everyrepo/web", "build"], {
      cwd: process.cwd(),
      env: { ...process.env, EVERYREPO_SITE_DATA: siteData },
      // pnpm is a script on Windows, which only a shell can start
      shell: process.platform === "win32",
      windowsHide: true,
    });
    const output: string[] = [];
    const keep = (chunk: Buffer) => {
      output.push(chunk.toString("utf8"));
      if (output.length > 200) output.shift();
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`The website build failed:\n${output.join("").slice(-2_000)}`));
    });
  });
}

async function runtimeFor(
  context: CliContext,
  job: Job,
  repo: RepoRow,
  build: boolean,
  clock: AllowanceClock,
): Promise<JobRuntime> {
  const ref = parseRepoRef(repo.fullName);
  const base = { config: context.config, appDb: context.appDb, ref, repoId: repo.id };

  if (job.kind === "full") {
    const configured = await openEmbedder(context);
    return {
      handlers: createIndexHandlers({
        ...base,
        fetch: true,
        embedder: configured?.embedder,
        embeddingsAt: () => clock.embeddingsAt(),
      }),
      close: () => configured?.server.stop(),
    };
  }
  if (job.kind === "wiki") {
    const llm = openLlm(context);
    return {
      handlers: createWikiHandlers({
        ...base,
        router: llm.router,
        allowanceAt: (task) => clock.modelsAt(task),
      }),
      close: () => llm.close(),
    };
  }
  if (job.kind === "publish") {
    const out = join(context.config.dataDir, "site");
    return {
      handlers: {
        publish: async ({ log, progress }) => {
          const steps = build ? 2 : 1;
          progress(0, steps);
          const result = await exportSite(context.appDb, context.config.dataDir, out);
          const own = result.ready.find((wiki) => wiki.repoId === repo.id);
          if (!own) throw new Error("The wiki has no written pages to publish");
          progress(1, steps);
          if (build) await buildWebsite(out, log);
          const at = new Date();
          for (const wiki of result.ready) {
            if (wiki.publishedSha !== wiki.sha) {
              markPublished(context.appDb, wiki.repoId, wiki.sha, at);
            }
          }
          progress(steps, steps);
          return { wikis: result.ready.length, built: build };
        },
      },
      close: () => {},
    };
  }
  throw new Error(`The worker does not run ${job.kind} jobs`);
}

export function workerCommand(): Command {
  return new Command("worker")
    .description("Build requested repositories: read the code, write the wiki, then publish it")
    .option("--once", "stop when no job is waiting instead of checking again")
    .option("--poll <seconds>", "seconds between checks while nothing is waiting", "30")
    .option(
      "--no-build",
      "write the site data after a wiki is written without building the website",
    )
    .action(async (options: WorkerOptions) => {
      const context = await openContext();
      const log = (message: string) => console.log(`${timestamp()} ${message}`);
      const clock = createAllowanceClock(context.appDb, context.config);
      const worker = createWorker({
        db: context.appDb,
        service: openRequests(context),
        runtimeFor: (job, repo) => runtimeFor(context, job, repo, options.build, clock),
        log,
      });
      // Status pages show the builder as online while these heartbeats keep coming
      worker.heartbeat();
      const beat = setInterval(() => worker.heartbeat(), 15_000);
      const shutdown = () => {
        clearInterval(beat);
        worker.stop();
        context.close();
      };

      let busy = false;
      let stopping = false;
      // The first Ctrl+C lets the current job finish; a second one stops at once and the job is retried later
      const stop = () => {
        if (stopping || !busy) {
          shutdown();
          process.exit(130);
        }
        stopping = true;
        log("stopping after the current job; press Ctrl+C again to stop now");
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);

      log(`${worker.workerId} is waiting for requested builds`);
      try {
        while (!stopping) {
          busy = true;
          const step = await worker.step();
          busy = false;
          if (step) continue;
          if (options.once) break;
          await sleep(Number(options.poll) * 1_000);
        }
      } finally {
        shutdown();
      }
    });
}
