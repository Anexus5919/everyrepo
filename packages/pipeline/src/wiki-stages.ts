import {
  formatRepoRef,
  repoDirName,
  WIKI_STAGE_KEYS,
  type LocalConfig,
  type RepoRef,
} from "@everyrepo/core";
import { engineDbPath, eq, repos, type AppDb } from "@everyrepo/db";
import { ModelUnavailableError, type LlmRouter } from "@everyrepo/llm";
import { StageDeferredError, type StageHandler } from "@everyrepo/queue";
import { buildGlossary, planWiki, summarizeRepository, writePages } from "@everyrepo/wiki";

export const WIKI_STAGES = WIKI_STAGE_KEYS;
export type WikiStage = (typeof WIKI_STAGES)[number];

export interface WikiOptions {
  config: LocalConfig;
  appDb: AppDb;
  ref: RepoRef;
  repoId: number;
  router: LlmRouter;
  // Rewrites only these page slugs when set
  pages?: readonly string[] | undefined;
  // When a task's model allowance frees up again, for resuming a paused job on time
  allowanceAt?: ((task: string) => Date | undefined) | undefined;
}

function enginePathFor(options: WikiOptions): string {
  const repo = options.appDb.select().from(repos).where(eq(repos.id, options.repoId)).get();
  if (!repo?.lastIndexedSha) {
    throw new Error(`${formatRepoRef(options.ref)} has no indexed snapshot yet`);
  }
  return engineDbPath(options.config.dataDir, repoDirName(options.ref), repo.lastIndexedSha);
}

// Free model allowances run out during large repositories; the job waits and resumes where it stopped
async function deferWhenUnavailable<T>(
  work: () => Promise<T>,
  allowanceAt: WikiOptions["allowanceAt"],
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ModelUnavailableError) {
      const retryAt = error.task ? allowanceAt?.(error.task) : undefined;
      throw new StageDeferredError(
        `${error.message}; finished work is kept, run again later`,
        retryAt ? { cause: error, retryAt } : { cause: error },
      );
    }
    throw error;
  }
}

export function createWikiHandlers(options: WikiOptions): Record<WikiStage, StageHandler> {
  const summarize: StageHandler = async ({ heartbeat, log, progress }) =>
    deferWhenUnavailable(
      () =>
        summarizeRepository({
          enginePath: enginePathFor(options),
          repo: formatRepoRef(options.ref),
          router: options.router,
          log,
          heartbeat,
          progress,
        }),
      options.allowanceAt,
    );
  const plan: StageHandler = async ({ log }) =>
    deferWhenUnavailable(
      () =>
        planWiki({
          enginePath: enginePathFor(options),
          repo: formatRepoRef(options.ref),
          router: options.router,
          log,
          // Replanning would reset every written page when only a few were meant to be written again
          keepExisting: options.pages !== undefined && options.pages.length > 0,
        }),
      options.allowanceAt,
    );
  const write: StageHandler = async ({ heartbeat, log, progress }) =>
    deferWhenUnavailable(
      () =>
        writePages({
          enginePath: enginePathFor(options),
          router: options.router,
          ...(options.pages ? { only: options.pages } : {}),
          log,
          heartbeat,
          progress,
        }),
      options.allowanceAt,
    );
  const glossary: StageHandler = async ({ log }) =>
    deferWhenUnavailable(
      () => buildGlossary({ enginePath: enginePathFor(options), router: options.router, log }),
      options.allowanceAt,
    );
  return { summarize, plan, write, glossary };
}

export function wikiStagesUntil(stage: string | undefined): WikiStage[] {
  if (!stage) return [...WIKI_STAGES];
  const index = WIKI_STAGES.indexOf(stage as WikiStage);
  if (index < 0)
    throw new Error(`Unknown wiki stage "${stage}". Stages: ${WIKI_STAGES.join(", ")}`);
  return WIKI_STAGES.slice(0, index + 1);
}
