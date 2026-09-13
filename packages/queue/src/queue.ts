import type { JobKind } from "@kickstart/core";
import {
  and,
  asc,
  eq,
  inArray,
  indexJobs,
  jobStages,
  lt,
  type AppDb,
  type AppExecutor,
} from "@kickstart/db";

export type Job = typeof indexJobs.$inferSelect;

export interface EnqueueInput {
  repoId: number;
  kind: JobKind;
  stages: string[];
  params?: Record<string, unknown>;
  priority?: number;
  maxAttempts?: number;
}

export interface ClaimOptions {
  staleAfterMs?: number;
  now?: Date;
}

export interface StageContext {
  job: Job;
  outputs: Record<string, unknown>;
  heartbeat(): void;
  log(message: string): void;
}

export type StageHandler = (context: StageContext) => Promise<unknown>;

export interface RunOptions {
  heartbeatMs?: number;
  log?: (message: string) => void;
}

const DEFAULT_STALE_MS = 10 * 60_000;

export function enqueueJob(db: AppDb, input: EnqueueInput): Job {
  if (input.stages.length === 0) {
    throw new Error("A job needs at least one stage");
  }
  return db
    .insert(indexJobs)
    .values({
      repoId: input.repoId,
      kind: input.kind,
      stages: input.stages,
      params: input.params ?? {},
      priority: input.priority ?? 100,
      maxAttempts: input.maxAttempts ?? 3,
    })
    .returning()
    .get();
}

export function findOpenJob(db: AppDb, repoId: number): Job | undefined {
  return db
    .select()
    .from(indexJobs)
    .where(and(eq(indexJobs.repoId, repoId), inArray(indexJobs.status, ["queued", "running"])))
    .orderBy(asc(indexJobs.id))
    .get();
}

// Jobs whose worker stopped sending heartbeats are retried or failed
function releaseStaleJobs(db: AppExecutor, now: Date, staleAfterMs: number): void {
  const staleBefore = new Date(now.getTime() - staleAfterMs);
  const stale = db
    .select()
    .from(indexJobs)
    .where(and(eq(indexJobs.status, "running"), lt(indexJobs.heartbeatAt, staleBefore)))
    .all();
  for (const job of stale) {
    const exhausted = job.attempts >= job.maxAttempts;
    db.update(indexJobs)
      .set({
        status: exhausted ? "failed" : "queued",
        lockedBy: null,
        error: "Worker stopped responding",
        finishedAt: exhausted ? now : null,
      })
      .where(eq(indexJobs.id, job.id))
      .run();
  }
}

export function claimNextJob(
  db: AppDb,
  workerId: string,
  options: ClaimOptions = {},
): Job | undefined {
  const now = options.now ?? new Date();
  return db.transaction(
    (tx) => {
      releaseStaleJobs(tx, now, options.staleAfterMs ?? DEFAULT_STALE_MS);
      const next = tx
        .select()
        .from(indexJobs)
        .where(eq(indexJobs.status, "queued"))
        .orderBy(asc(indexJobs.priority), asc(indexJobs.id))
        .limit(1)
        .get();
      return next ? markRunning(tx, next, workerId, now) : undefined;
    },
    { behavior: "immediate" },
  );
}

export function claimJob(
  db: AppDb,
  jobId: number,
  workerId: string,
  options: ClaimOptions = {},
): Job | undefined {
  const now = options.now ?? new Date();
  return db.transaction(
    (tx) => {
      releaseStaleJobs(tx, now, options.staleAfterMs ?? DEFAULT_STALE_MS);
      const job = tx
        .select()
        .from(indexJobs)
        .where(and(eq(indexJobs.id, jobId), eq(indexJobs.status, "queued")))
        .get();
      return job ? markRunning(tx, job, workerId, now) : undefined;
    },
    { behavior: "immediate" },
  );
}

function markRunning(db: AppExecutor, job: Job, workerId: string, now: Date): Job {
  return db
    .update(indexJobs)
    .set({
      status: "running",
      lockedBy: workerId,
      attempts: job.attempts + 1,
      startedAt: job.startedAt ?? now,
      heartbeatAt: now,
      error: null,
    })
    .where(eq(indexJobs.id, job.id))
    .returning()
    .get();
}

export function completedStageOutputs(db: AppDb, jobId: number): Map<string, unknown> {
  const rows = db
    .select()
    .from(jobStages)
    .where(and(eq(jobStages.jobId, jobId), eq(jobStages.status, "succeeded")))
    .all();
  return new Map(rows.map((row) => [row.stage, row.output]));
}

export async function runJob(
  db: AppDb,
  job: Job,
  handlers: Record<string, StageHandler>,
  options: RunOptions = {},
): Promise<Job> {
  const log = options.log ?? (() => {});
  const completed = completedStageOutputs(db, job.id);
  const outputs: Record<string, unknown> = Object.fromEntries(completed);
  const heartbeat = () => {
    db.update(indexJobs).set({ heartbeatAt: new Date() }).where(eq(indexJobs.id, job.id)).run();
  };

  for (const stage of job.stages) {
    if (completed.has(stage)) {
      log(`${stage}: already done`);
      continue;
    }
    const handler = handlers[stage];
    const startedAt = new Date();
    setStage(db, job.id, stage, { status: "running", startedAt, output: null, error: null });
    const timer = setInterval(heartbeat, options.heartbeatMs ?? 30_000);
    try {
      if (!handler) throw new Error(`No handler registered for stage "${stage}"`);
      log(`${stage}: started`);
      const output = (await handler({ job, outputs, heartbeat, log })) ?? null;
      outputs[stage] = output;
      setStage(db, job.id, stage, {
        status: "succeeded",
        startedAt,
        output,
        error: null,
        finishedAt: new Date(),
      });
      log(`${stage}: done`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStage(db, job.id, stage, {
        status: "failed",
        startedAt,
        output: null,
        error: message,
        finishedAt: new Date(),
      });
      return failJob(db, job, `${stage}: ${message}`);
    } finally {
      clearInterval(timer);
    }
  }

  return db
    .update(indexJobs)
    .set({ status: "succeeded", lockedBy: null, finishedAt: new Date(), error: null })
    .where(eq(indexJobs.id, job.id))
    .returning()
    .get();
}

function failJob(db: AppDb, job: Job, message: string): Job {
  const current = db.select().from(indexJobs).where(eq(indexJobs.id, job.id)).get();
  const attempts = current?.attempts ?? job.attempts;
  const exhausted = attempts >= job.maxAttempts;
  return db
    .update(indexJobs)
    .set({
      status: exhausted ? "failed" : "queued",
      lockedBy: null,
      error: message,
      finishedAt: exhausted ? new Date() : null,
    })
    .where(eq(indexJobs.id, job.id))
    .returning()
    .get();
}

interface StageState {
  status: "running" | "succeeded" | "failed";
  startedAt: Date;
  output: unknown;
  error: string | null;
  finishedAt?: Date;
}

function setStage(db: AppDb, jobId: number, stage: string, state: StageState): void {
  const values = { ...state, finishedAt: state.finishedAt ?? null };
  db.insert(jobStages)
    .values({ jobId, stage, ...values })
    .onConflictDoUpdate({ target: [jobStages.jobId, jobStages.stage], set: values })
    .run();
}
