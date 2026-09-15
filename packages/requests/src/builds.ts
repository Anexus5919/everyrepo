import { INDEX_STAGE_KEYS, PUBLISH_STAGE_KEYS, WIKI_STAGE_KEYS } from "@everyrepo/core";
import { eq, repos, type AppExecutor, type RepoRow } from "@everyrepo/db";
import { enqueueJob, findOpenJob, type Job } from "@everyrepo/queue";
import type { AppDb } from "@everyrepo/db";

// Queues the next missing step of a requested build: reading the code, then writing, then publishing
export function enqueueBuild(db: AppDb, repo: RepoRow, priority: number): Job | undefined {
  const open = findOpenJob(db, repo.id);
  if (open) return open;
  if (repo.publishedAt) return undefined;
  const indexed = repo.lastIndexedSha !== null;
  return enqueueJob(db, {
    repoId: repo.id,
    kind: indexed ? "wiki" : "full",
    stages: indexed ? [...WIKI_STAGE_KEYS] : [...INDEX_STAGE_KEYS],
    origin: "request",
    priority,
  });
}

// After a requested job succeeds, the build carries on with the step that follows it
export function followUp(db: AppDb, finished: Job): Job | undefined {
  if (finished.status !== "succeeded" || finished.origin !== "request") return undefined;
  if (findOpenJob(db, finished.repoId)) return undefined;
  const next =
    finished.kind === "full"
      ? { kind: "wiki" as const, stages: [...WIKI_STAGE_KEYS] }
      : finished.kind === "wiki"
        ? { kind: "publish" as const, stages: [...PUBLISH_STAGE_KEYS] }
        : undefined;
  if (!next) return undefined;
  return enqueueJob(db, {
    repoId: finished.repoId,
    ...next,
    origin: "request",
    priority: finished.priority,
  });
}

export function markPublished(db: AppExecutor, repoId: number, sha: string, at: Date): void {
  db.update(repos).set({ publishedSha: sha, publishedAt: at }).where(eq(repos.id, repoId)).run();
}
