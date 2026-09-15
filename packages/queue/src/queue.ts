import type { JobKind, JobOrigin } from "@everyrepo/core";
import {
  and,
  asc,
  eq,
  inArray,
  indexJobs,
  isNull,
  jobStages,
  lt,
  lte,
  or,
  type AppDb,
  type AppExecutor,
} from "@everyrepo/db";

export type Job = typeof indexJobs.$inferSelect;

export interface EnqueueInput {
  repoId: number;
  kind: JobKind;
  stages: string[];
  params?: Record<string, unknown>;
  priority?: number;
  maxAttempts?: number;
  origin?: JobOrigin;
  runAfter?: Date;
}

export interface ClaimOptions {
  staleAfterMs?: number;
  now?: Date;
  // Only jobs from this origin, so the worker leaves command line jobs alone
  origin?: JobOrigin;
}

export interface StageContext {
  job: Job;
  outputs: Record<string, unknown>;
  heartbeat(): void;
  log(message: string): void;
  // Work done inside the stage, shown on status pages; null while the amount is not known
  progress(done: number | null, total: number | null): void;
}

export type StageHandler = (context: StageContext) => Promise<unknown>;

// Thrown by a stage that cannot continue yet, such as after a daily quota; the job waits without using an attempt
export class StageDeferredError extends Error {
  override readonly name = "StageDeferredError";
  readonly retryAt: Date | undefined;

  constructor(message: string, options: ErrorOptions & { retryAt?: Date } = {}) {
    super(message, options);
    this.retryAt = options.retryAt;
  }
}

export interface RunOptions {
  heartbeatMs?: number;
  log?: (message: string) => void;
  now?: () => Date;
  // Wait before a deferred job is claimed again, given how many deferrals in a row it has had
  deferDelayMs?: (deferrals: number) => number;
  // Wait before a failed job is retried, given the attempts used so far
  retryDelayMs?: (attempts: number) => number;
}

const DEFAULT_STALE_MS = 10 * 60_000;
const MINUTE_MS = 60_000;
const PROGRESS_WRITE_MS = 1_000;

// Allowances refill over hours, so waits double from a quarter of an hour up to four hours
export function defaultDeferDelayMs(deferrals: number): number {
  return Math.min(15 * MINUTE_MS * 2 ** Math.max(0, deferrals - 1), 240 * MINUTE_MS);
}

// Crashes are usually brief, such as a dropped connection, so retries start after a minute
export function defaultRetryDelayMs(attempts: number): number {
  return Math.min(MINUTE_MS * 2 ** Math.max(0, attempts - 1), 30 * MINUTE_MS);
}

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
      origin: input.origin ?? "cli",
      runAfter: input.runAfter ?? null,
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
        .where(
          and(
            eq(indexJobs.status, "queued"),
            or(isNull(indexJobs.runAfter), lte(indexJobs.runAfter, now)),
            options.origin ? eq(indexJobs.origin, options.origin) : undefined,
          ),
        )
        .orderBy(asc(indexJobs.priority), asc(indexJobs.id))
        .limit(1)
        .get();
      return next ? markRunning(tx, next, workerId, now) : undefined;
    },
    { behavior: "immediate" },
  );
}

// Claims a specific job even while it waits to run later, as when someone resumes it by hand
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
      runAfter: null,
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
  const now = options.now ?? (() => new Date());
  const completed = completedStageOutputs(db, job.id);
  const outputs: Record<string, unknown> = Object.fromEntries(completed);
  const heartbeat = () => {
    db.update(indexJobs).set({ heartbeatAt: now() }).where(eq(indexJobs.id, job.id)).run();
  };

  for (const stage of job.stages) {
    if (completed.has(stage)) {
      log(`${stage}: already done`);
      continue;
    }
    const handler = handlers[stage];
    const startedAt = now();
    setStage(db, job.id, stage, { status: "running", startedAt, output: null, error: null });
    const progress = progressWriter(db, job.id, stage, now);
    progress(null, null);
    const timer = setInterval(heartbeat, options.heartbeatMs ?? 30_000);
    try {
      if (!handler) throw new Error(`No handler registered for stage "${stage}"`);
      log(`${stage}: started`);
      const output = (await handler({ job, outputs, heartbeat, log, progress })) ?? null;
      outputs[stage] = output;
      setStage(db, job.id, stage, {
        status: "succeeded",
        startedAt,
        output,
        error: null,
        finishedAt: now(),
      });
      // A finished stage is progress, so the next deferral starts again from the shortest wait
      db.update(indexJobs).set({ deferrals: 0 }).where(eq(indexJobs.id, job.id)).run();
      log(`${stage}: done`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStage(db, job.id, stage, {
        status: "failed",
        startedAt,
        output: null,
        error: message,
        finishedAt: now(),
      });
      if (error instanceof StageDeferredError) {
        return deferJob(db, job, `${stage}: ${message}`, error.retryAt, now(), options);
      }
      return failJob(db, job, `${stage}: ${message}`, now(), options);
    } finally {
      clearInterval(timer);
    }
  }

  return db
    .update(indexJobs)
    .set({ status: "succeeded", lockedBy: null, finishedAt: now(), error: null, progress: null })
    .where(eq(indexJobs.id, job.id))
    .returning()
    .get();
}

// Progress is written at most once a second, but the first figure and the last are always written
function progressWriter(db: AppDb, jobId: number, stage: string, now: () => Date) {
  let lastWrite: number | undefined;
  let counting = false;
  return (done: number | null, total: number | null) => {
    const at = now().getTime();
    const finished = done !== null && total !== null && done >= total;
    const throttled = lastWrite !== undefined && at - lastWrite < PROGRESS_WRITE_MS;
    if (throttled && counting && !finished) return;
    lastWrite = at;
    counting = done !== null;
    db.update(indexJobs)
      .set({ progress: { stage, done, total, at } })
      .where(eq(indexJobs.id, jobId))
      .run();
  };
}

function deferJob(
  db: AppDb,
  job: Job,
  message: string,
  retryAt: Date | undefined,
  now: Date,
  options: RunOptions,
): Job {
  const current = db.select().from(indexJobs).where(eq(indexJobs.id, job.id)).get();
  const deferrals = (current?.deferrals ?? job.deferrals) + 1;
  const delay = (options.deferDelayMs ?? defaultDeferDelayMs)(deferrals);
  return db
    .update(indexJobs)
    .set({
      status: "queued",
      lockedBy: null,
      attempts: Math.max(0, (current?.attempts ?? job.attempts) - 1),
      deferrals,
      runAfter: retryAt ?? new Date(now.getTime() + delay),
      error: message,
    })
    .where(eq(indexJobs.id, job.id))
    .returning()
    .get();
}

function failJob(db: AppDb, job: Job, message: string, now: Date, options: RunOptions): Job {
  const current = db.select().from(indexJobs).where(eq(indexJobs.id, job.id)).get();
  const attempts = current?.attempts ?? job.attempts;
  const exhausted = attempts >= job.maxAttempts;
  const delay = (options.retryDelayMs ?? defaultRetryDelayMs)(attempts);
  return db
    .update(indexJobs)
    .set({
      status: exhausted ? "failed" : "queued",
      lockedBy: null,
      error: message,
      runAfter: exhausted ? null : new Date(now.getTime() + delay),
      finishedAt: exhausted ? now : null,
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
