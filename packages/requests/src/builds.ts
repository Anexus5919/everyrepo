import { INDEX_STAGE_KEYS, PUBLISH_STAGE_KEYS, WIKI_STAGE_KEYS } from "@everyrepo/core";
import {
  and,
  eq,
  gt,
  inArray,
  indexJobs,
  repos,
  type AppExecutor,
  type RepoRow,
} from "@everyrepo/db";
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

// Writes a published wiki again, for example after the planner learned to cover more; it waits behind every request
export function enqueueRewrite(
  db: AppDb,
  repo: RepoRow,
  priority: number,
  // Only these page slugs are written again when given
  pages?: readonly string[],
): Job | undefined {
  const open = findOpenJob(db, repo.id);
  if (open) return open;
  if (!repo.publishedAt || !repo.lastIndexedSha) return undefined;
  return enqueueJob(db, {
    repoId: repo.id,
    kind: "wiki",
    stages: [...WIKI_STAGE_KEYS],
    origin: "request",
    priority,
    ...(pages && pages.length > 0 ? { params: { pages: [...pages] } } : {}),
  });
}

// Someone asking for a repository the owner added moves its build up to just behind the requests of its size that
// were already waiting, since its job was queued before theirs; the running job carries the place on to later steps
export function promoteBuild(db: AppDb, repoId: number, priority: number): void {
  db.update(indexJobs)
    .set({ priority: priority + 1 })
    .where(
      and(
        eq(indexJobs.repoId, repoId),
        inArray(indexJobs.status, ["queued", "running"]),
        gt(indexJobs.priority, priority + 1),
      ),
    )
    .run();
}

// After a requested job succeeds, the build carries on with the step that follows it. Each step sits one place ahead
// of the step before it, so a build that has started is written and published before a build of the same kind starts,
// and a finished wiki goes live without waiting for other wikis to be written
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
    priority: finished.priority - 1,
  });
}

export function markPublished(db: AppExecutor, repoId: number, sha: string, at: Date): void {
  db.update(repos).set({ publishedSha: sha, publishedAt: at }).where(eq(repos.id, repoId)).run();
}
