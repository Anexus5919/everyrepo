import { hostname } from "node:os";
import { formatRepoRef, parseRepoRef } from "@kickstart/core";
import { ensureRepo } from "@kickstart/db";
import { createIndexHandlers, stagesUntil } from "@kickstart/pipeline";
import { claimJob, enqueueJob, findOpenJob, runJob } from "@kickstart/queue";
import { Command } from "commander";
import { openContext, timestamp } from "../context.ts";

interface IndexOptions {
  until?: string;
  fetch: boolean;
}

export function indexCommand(): Command {
  return new Command("index")
    .description("Index a repository up to the given stage, resuming unfinished work")
    .argument("<repo>", "owner/name or GitHub URL")
    .option("--until <stage>", "stop after this stage")
    .option("--no-fetch", "use the locally available upstream commit without fetching")
    .action(async (repoArg: string, options: IndexOptions) => {
      const ref = parseRepoRef(repoArg);
      const stages = stagesUntil(options.until);
      const context = await openContext();
      const log = (message: string) =>
        console.log(`${timestamp()} ${formatRepoRef(ref)} ${message}`);
      try {
        const repo = ensureRepo(context.appDb, ref);
        const open = findOpenJob(context.appDb, repo.id);
        const queued = open ?? enqueueJob(context.appDb, { repoId: repo.id, kind: "full", stages });
        if (open) log(`resuming job ${open.id} (${open.stages.join(", ")})`);

        const workerId = `cli-${hostname()}-${process.pid}`;
        // The CLI heartbeats every 15 seconds, so a minute of silence means the previous run died
        const job = claimJob(context.appDb, queued.id, workerId, { staleAfterMs: 60_000 });
        if (!job) {
          throw new Error(`Job ${queued.id} is already running in another process`);
        }
        const handlers = createIndexHandlers({
          config: context.config,
          appDb: context.appDb,
          ref,
          repoId: repo.id,
          fetch: options.fetch,
        });
        const started = Date.now();
        const result = await runJob(context.appDb, job, handlers, { heartbeatMs: 15_000, log });
        const seconds = ((Date.now() - started) / 1000).toFixed(1);
        if (result.status !== "succeeded") {
          log(
            `job ${result.id} ${result.status} after ${seconds}s: ${result.error ?? "unknown error"}`,
          );
          process.exitCode = 1;
          return;
        }
        log(`job ${result.id} finished in ${seconds}s`);
      } finally {
        context.close();
      }
    });
}
