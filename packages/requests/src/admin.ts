import type { AdminQueueItem } from "@everyrepo/core";
import {
  and,
  asc,
  eq,
  inArray,
  indexJobs,
  jobStages,
  repoRequests,
  repos,
  settings,
  type AppDb,
} from "@everyrepo/db";
import { enqueueRewrite } from "./builds.ts";
import { rewritePriority } from "./policy.ts";
import { progressFor } from "./views.ts";

const PAUSED_KEY = "builder.paused";

export function builderPaused(db: AppDb): boolean {
  return db.select().from(settings).where(eq(settings.key, PAUSED_KEY)).get()?.value === "true";
}

// A paused builder finishes the job it is on and then claims nothing until it is resumed
export function setBuilderPaused(db: AppDb, paused: boolean, now = new Date()): void {
  db.insert(settings)
    .values({ key: PAUSED_KEY, value: String(paused), updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value: String(paused), updatedAt: now } })
    .run();
}

// Builds in the order the worker takes them: the running one, then the line by priority
export function adminQueue(db: AppDb): AdminQueueItem[] {
  const rows = db
    .select({ job: indexJobs, repo: repos, request: repoRequests })
    .from(indexJobs)
    .innerJoin(repos, eq(repos.id, indexJobs.repoId))
    .leftJoin(repoRequests, eq(repoRequests.repoId, indexJobs.repoId))
    .where(and(inArray(indexJobs.status, ["queued", "running"]), eq(indexJobs.origin, "request")))
    .orderBy(asc(indexJobs.priority), asc(indexJobs.id))
    .all()
    .sort((a, b) => Number(b.job.status === "running") - Number(a.job.status === "running"));
  const stagesFor = (jobId: number) =>
    db.select().from(jobStages).where(eq(jobStages.jobId, jobId)).all();
  return rows.map(({ job, repo, request }) => ({
    jobId: job.id,
    repo: repo.fullName,
    kind: job.kind,
    status: job.status as "queued" | "running",
    priority: job.priority,
    asked: (request?.count ?? 0) > 0,
    published: repo.publishedAt !== null,
    requests: request?.count ?? 0,
    runAfter: job.runAfter ? job.runAfter.toISOString() : null,
    attempts: job.attempts,
    error: job.error,
    progress: progressFor(job, stagesFor(job.id)),
    createdAt: job.createdAt.toISOString(),
  }));
}

export type MoveDirection = "top" | "up" | "down" | "bottom";

// Moves a waiting build within the line; the running build stays put. The line is ordered by priority, then by job
// number, so a build placed ahead of another takes one less than its priority and every build ahead of that spot
// moves two further ahead. Builds only ever gain places, so a request made later can never pass one of them.
export function moveBuild(db: AppDb, jobId: number, direction: MoveDirection): number {
  const line = adminQueue(db).filter((item) => item.status === "queued");
  const index = line.findIndex((item) => item.jobId === jobId);
  if (index === -1) throw new Error(`Job ${jobId} is not waiting in the line`);
  const moving = line[index]!;
  const others = line.filter((item) => item.jobId !== jobId);
  // The build that ends up right behind the moved one, or null to go last
  const behind =
    direction === "top"
      ? others[0]
      : direction === "up"
        ? line[index - 1]
        : direction === "down"
          ? others[index + 1]
          : undefined;
  if (direction === "up" && index === 0) return moving.priority;
  if (direction === "down" && index === line.length - 1) return moving.priority;
  return db.transaction(() => {
    if (!behind) {
      const last = others[others.length - 1];
      const priority = last ? Math.max(moving.priority, last.priority + 1) : moving.priority;
      db.update(indexJobs).set({ priority }).where(eq(indexJobs.id, jobId)).run();
      return priority;
    }
    const at = others.indexOf(behind);
    for (const item of others.slice(0, at)) {
      db.update(indexJobs)
        .set({ priority: item.priority - 2 })
        .where(eq(indexJobs.id, item.jobId))
        .run();
    }
    const priority = behind.priority - 1;
    db.update(indexJobs).set({ priority }).where(eq(indexJobs.id, jobId)).run();
    return priority;
  });
}

export function cancelBuild(db: AppDb, jobId: number, now = new Date()): void {
  const job = db.select().from(indexJobs).where(eq(indexJobs.id, jobId)).get();
  if (!job || job.status !== "queued") throw new Error(`Job ${jobId} is not waiting in the line`);
  db.update(indexJobs)
    .set({ status: "cancelled", finishedAt: now, lockedBy: null })
    .where(eq(indexJobs.id, jobId))
    .run();
}

// Rewrites a published wiki, or only the chosen pages of it, behind every request and every new wiki
export function queueRewrite(
  db: AppDb,
  repoId: number,
  pages?: readonly string[],
): { jobId: number } | undefined {
  const repo = db.select().from(repos).where(eq(repos.id, repoId)).get();
  if (!repo?.publishedAt) return undefined;
  const request = db.select().from(repoRequests).where(eq(repoRequests.repoId, repoId)).get();
  const job = enqueueRewrite(
    db,
    repo,
    rewritePriority(request?.estimate?.sizeTier ?? repo.sizeTier),
    pages,
  );
  return job ? { jobId: job.id } : undefined;
}
