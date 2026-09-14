import { hostname } from "node:os";
import { formatRepoRef, parseRepoRef } from "@everyrepo/core";
import { ensureRepo } from "@everyrepo/db";
import { createWikiHandlers, wikiStagesUntil } from "@everyrepo/pipeline";
import { claimJob, enqueueJob, findOpenJob, runJob } from "@everyrepo/queue";
import { Command } from "commander";
import { openContext, openLlm, timestamp } from "../context.ts";

export function wikiCommand(): Command {
  return new Command("wiki")
    .description("Generate the wiki for an indexed repository, resuming unfinished work")
    .argument("<repo>", "owner/name or GitHub URL")
    .option("--until <stage>", "stop after this stage")
    .option("--pages <slugs>", "comma separated page slugs to write, others are left as they are")
    .action(async (repoArg: string, options: { until?: string; pages?: string }) => {
      const ref = parseRepoRef(repoArg);
      const stages = wikiStagesUntil(options.until);
      const context = await openContext();
      const llm = openLlm(context);
      const log = (message: string) =>
        console.log(`${timestamp()} ${formatRepoRef(ref)} ${message}`);
      try {
        const repo = ensureRepo(context.appDb, ref);
        const open = findOpenJob(context.appDb, repo.id);
        if (open && open.kind !== "wiki") {
          throw new Error(
            `Job ${open.id} (${open.kind}) is still open; finish it with the index command first`,
          );
        }
        const queued = open ?? enqueueJob(context.appDb, { repoId: repo.id, kind: "wiki", stages });
        if (open) log(`resuming job ${open.id} (${open.stages.join(", ")})`);
        const job = claimJob(context.appDb, queued.id, `cli-${hostname()}-${process.pid}`, {
          staleAfterMs: 60_000,
        });
        if (!job) throw new Error(`Job ${queued.id} is already running in another process`);
        const handlers = createWikiHandlers({
          config: context.config,
          appDb: context.appDb,
          ref,
          repoId: repo.id,
          router: llm.router,
          pages: options.pages?.split(",").map((slug) => slug.trim()),
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
        llm.close();
        context.close();
      }
    });
}
