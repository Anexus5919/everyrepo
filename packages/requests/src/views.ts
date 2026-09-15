import {
  BUILD_STAGES,
  buildPercent,
  type BuildProgress,
  type GithubSummary,
  type RepoView,
  type SizeEstimate,
} from "@everyrepo/core";
import {
  and,
  asc,
  desc,
  eq,
  indexJobs,
  jobStages,
  repoRequests,
  type AppDb,
  type RepoRow,
} from "@everyrepo/db";
import type { GithubRepository } from "@everyrepo/github";
import { findOpenJob, type Job } from "@everyrepo/queue";
import { reasonMessage } from "./messages.ts";

export type RequestRow = typeof repoRequests.$inferSelect;
type StageRow = typeof jobStages.$inferSelect;

export interface RepoRecord {
  repo: RepoRow;
  request: RequestRow | undefined;
  openJob: Job | undefined;
  lastJob: Job | undefined;
  // Stages of the open job, or of the last job when none is open
  stages: StageRow[];
}

export type Positions = ReadonlyMap<number, { position: number; total: number }>;

export function loadRecord(db: AppDb, repo: RepoRow): RepoRecord {
  const openJob = findOpenJob(db, repo.id);
  const lastJob = db
    .select()
    .from(indexJobs)
    .where(eq(indexJobs.repoId, repo.id))
    .orderBy(desc(indexJobs.id))
    .get();
  const shown = openJob ?? lastJob;
  return {
    repo,
    request: db.select().from(repoRequests).where(eq(repoRequests.repoId, repo.id)).get(),
    openJob,
    lastJob,
    stages: shown ? db.select().from(jobStages).where(eq(jobStages.jobId, shown.id)).all() : [],
  };
}

// A job deferred for a model or embedding allowance, not yet due to run again
export function isPaused(job: Job, now: Date): boolean {
  return (
    job.status === "queued" &&
    job.deferrals > 0 &&
    job.runAfter !== null &&
    job.runAfter.getTime() > now.getTime()
  );
}

// Requested jobs that will run in turn; paused ones rejoin once their wait is over
export function queuePositions(db: AppDb, now: Date): Positions {
  const inLine = db
    .select()
    .from(indexJobs)
    .where(and(eq(indexJobs.status, "queued"), eq(indexJobs.origin, "request")))
    .orderBy(asc(indexJobs.priority), asc(indexJobs.id))
    .all()
    .filter((job) => !isPaused(job, now));
  return new Map(
    inLine.map((job, index) => [job.id, { position: index + 1, total: inLine.length }]),
  );
}

const iso = (date: Date | null | undefined) => (date ? date.toISOString() : null);

function progressFor(job: Job, stages: StageRow[]): BuildProgress | null {
  const started = stages.length > 0 || job.progress !== null;
  if (!started) return null;
  const finished = new Set(
    stages.filter((row) => row.status === "succeeded").map((row) => row.stage),
  );
  const current = job.progress?.stage ?? job.stages.find((stage) => !finished.has(stage));
  const index = BUILD_STAGES.findIndex((stage) => stage.key === current);
  const stage = BUILD_STAGES[index];
  if (!stage) return null;
  const counts = job.progress?.stage === stage.key ? job.progress : null;
  return {
    phase: stage.phase,
    stage: stage.key,
    label: stage.label,
    step: index + 1,
    steps: BUILD_STAGES.length,
    done: counts?.done ?? null,
    total: counts?.total ?? null,
    percent: buildPercent(stage.key, counts?.done ?? null, counts?.total ?? null),
    startedAt: iso(stages.find((row) => row.stage === stage.key)?.startedAt),
  };
}

export function summaryFromGithub(repository: GithubRepository): GithubSummary {
  return {
    description: repository.description,
    stars: repository.stars,
    language: repository.language,
    defaultBranch: repository.defaultBranch,
    archived: repository.archived,
    fork: repository.fork,
    parent: repository.parent,
    license: repository.license,
    url: repository.url,
    avatarUrl: repository.avatarUrl,
    pushedAt: repository.pushedAt,
  };
}

function summaryFromRow(repo: RepoRow): GithubSummary {
  const [owner = ""] = repo.fullName.split("/");
  return {
    description: repo.description,
    stars: repo.stars,
    language: null,
    defaultBranch: repo.defaultBranch,
    archived: repo.archived,
    fork: false,
    parent: null,
    license: null,
    url: `https://github.com/${repo.fullName}`,
    avatarUrl: `https://github.com/${owner}.png?size=96`,
    pushedAt: null,
  };
}

export interface DescribeContext {
  now: Date;
  positions: Positions;
  github?: GithubRepository | undefined;
  estimate?: SizeEstimate | undefined;
}

function latest(...dates: Array<Date | null | undefined>): Date | null {
  const times = dates.filter((date): date is Date => date instanceof Date);
  return times.length > 0 ? new Date(Math.max(...times.map((date) => date.getTime()))) : null;
}

export function describeRecord(record: RepoRecord, context: DescribeContext): RepoView {
  const { repo, request, openJob, lastJob, stages } = record;
  const name = repo.fullName;
  const reason = (code: string, detail?: string) => ({
    code,
    message: reasonMessage(code, name, detail),
  });
  const base: RepoView = {
    repo: name,
    state: "available",
    reason: null,
    github: context.github ? summaryFromGithub(context.github) : summaryFromRow(repo),
    estimate: request?.estimate ?? context.estimate ?? null,
    queue: null,
    progress: null,
    requests: request?.count ?? 0,
    requestedAt: iso(request?.firstAt),
    updatedAt: iso(
      latest(request?.lastAt, openJob?.heartbeatAt, lastJob?.finishedAt, repo.publishedAt),
    ),
    resumeAt: null,
    href: null,
  };

  if (repo.publishedAt) return { ...base, state: "ready", href: `/${name}` };
  if (openJob?.status === "running") {
    return { ...base, state: "building", progress: progressFor(openJob, stages) };
  }
  if (openJob) {
    const progress = progressFor(openJob, stages);
    if (isPaused(openJob, context.now)) {
      return {
        ...base,
        state: "paused",
        reason: reason("allowance"),
        resumeAt: iso(openJob.runAfter),
        progress,
      };
    }
    const retrying =
      openJob.runAfter !== null && openJob.runAfter.getTime() > context.now.getTime();
    return {
      ...base,
      state: "queued",
      queue: context.positions.get(openJob.id) ?? null,
      progress,
      reason: retrying ? reason("retry") : null,
      resumeAt: retrying ? iso(openJob.runAfter) : null,
    };
  }
  if (request?.decision === "review") {
    return { ...base, state: "review", reason: reason(request.reason ?? "large") };
  }
  if (request?.decision === "rejected") {
    return { ...base, state: "rejected", reason: reason("declined") };
  }
  if (request?.decision === "approved") {
    if (lastJob?.status === "failed" || lastJob?.status === "cancelled") {
      const failed = stages.find((row) => row.status === "failed")?.stage;
      return {
        ...base,
        state: "failed",
        reason: reason("failed", BUILD_STAGES.find((stage) => stage.key === failed)?.label),
        progress: progressFor(lastJob, stages),
      };
    }
    return { ...base, state: "queued" };
  }
  return base;
}
