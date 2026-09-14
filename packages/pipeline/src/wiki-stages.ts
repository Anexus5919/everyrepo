import { formatRepoRef, repoDirName, type LocalConfig, type RepoRef } from "@everyrepo/core";
import { engineDbPath, eq, repos, type AppDb } from "@everyrepo/db";
import { ModelUnavailableError, type LlmRouter } from "@everyrepo/llm";
import { StageDeferredError, type StageHandler } from "@everyrepo/queue";
import { summarizeRepository } from "@everyrepo/wiki";

export const WIKI_STAGES = ["summarize"] as const;
export type WikiStage = (typeof WIKI_STAGES)[number];

export interface WikiOptions {
  config: LocalConfig;
  appDb: AppDb;
  ref: RepoRef;
  repoId: number;
  router: LlmRouter;
}

function enginePathFor(options: WikiOptions): string {
  const repo = options.appDb.select().from(repos).where(eq(repos.id, options.repoId)).get();
  if (!repo?.lastIndexedSha) {
    throw new Error(`${formatRepoRef(options.ref)} has no indexed snapshot yet`);
  }
  return engineDbPath(options.config.dataDir, repoDirName(options.ref), repo.lastIndexedSha);
}

// Free model allowances run out during large repositories; the job waits and resumes where it stopped
async function deferWhenUnavailable<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ModelUnavailableError) {
      throw new StageDeferredError(`${error.message}; finished work is kept, run again later`, {
        cause: error,
      });
    }
    throw error;
  }
}

export function createWikiHandlers(options: WikiOptions): Record<WikiStage, StageHandler> {
  const summarize: StageHandler = async ({ heartbeat, log }) =>
    deferWhenUnavailable(() =>
      summarizeRepository({
        enginePath: enginePathFor(options),
        repo: formatRepoRef(options.ref),
        router: options.router,
        log,
        heartbeat,
      }),
    );
  return { summarize };
}

export function wikiStagesUntil(stage: string | undefined): WikiStage[] {
  if (!stage) return [...WIKI_STAGES];
  const index = WIKI_STAGES.indexOf(stage as WikiStage);
  if (index < 0)
    throw new Error(`Unknown wiki stage "${stage}". Stages: ${WIKI_STAGES.join(", ")}`);
  return WIKI_STAGES.slice(0, index + 1);
}
