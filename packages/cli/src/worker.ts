import { hostname } from "node:os";
import { eq, repos, type AppDb, type RepoRow } from "@everyrepo/db";
import { claimNextJob, runJob, type Job, type StageHandler } from "@everyrepo/queue";
import {
  builderPaused,
  followUp,
  removeWorker,
  touchWorker,
  type RequestService,
} from "@everyrepo/requests";

export interface JobRuntime {
  handlers: Record<string, StageHandler>;
  close(): void | Promise<void>;
}

// Opens what a job needs, such as embeddings for reading code or models for writing
export type RuntimeFactory = (job: Job, repo: RepoRow) => Promise<JobRuntime>;

export interface WorkerOptions {
  db: AppDb;
  service: RequestService;
  runtimeFor: RuntimeFactory;
  workerId?: string;
  log?: (message: string) => void;
  heartbeatMs?: number;
  // The worker heartbeats every few seconds, so a job silent for this long lost its worker
  staleAfterMs?: number;
}

export interface WorkerStep {
  repo: string;
  job: Job;
  result: Job;
  next: Job | undefined;
}

export function createWorker(options: WorkerOptions) {
  const { db, service } = options;
  const workerId = options.workerId ?? `worker-${hostname()}-${process.pid}`;
  const log = options.log ?? (() => {});
  let currentJob: number | null = null;
  let pauseNoted = false;

  return {
    workerId,
    // Tells status pages the builder is running; called on a timer and around every job
    heartbeat(): void {
      touchWorker(db, workerId, currentJob);
    },
    stop(): void {
      removeWorker(db, workerId);
    },
    // Runs the next waiting requested job, if there is one, and queues the step after it
    async step(): Promise<WorkerStep | undefined> {
      touchWorker(db, workerId, null);
      if (builderPaused(db)) {
        if (!pauseNoted)
          log("paused from the admin dashboard; no new job starts until it is resumed");
        pauseNoted = true;
        return undefined;
      }
      if (pauseNoted) log("resumed from the admin dashboard");
      pauseNoted = false;
      const restarted = service.reconcile();
      if (restarted > 0) log(`queued ${restarted} approved builds that had no job`);
      const job = claimNextJob(db, workerId, {
        origin: "request",
        staleAfterMs: options.staleAfterMs ?? 60_000,
      });
      if (!job) return undefined;
      currentJob = job.id;
      touchWorker(db, workerId, job.id);
      const repo = db.select().from(repos).where(eq(repos.id, job.repoId)).get();
      if (!repo) throw new Error(`Job ${job.id} names a repository that does not exist`);
      const jobLog = (message: string) => log(`${repo.fullName} ${message}`);
      jobLog(`job ${job.id} (${job.kind}) started: ${job.stages.join(", ")}`);

      let runtime: JobRuntime;
      try {
        runtime = await options.runtimeFor(job, repo);
      } catch (error) {
        // A runtime that cannot open fails the first stage, so retries and failure work as usual
        const reason = error instanceof Error ? error : new Error(String(error));
        const handlers = Object.fromEntries(
          job.stages.map((stage) => [stage, () => Promise.reject(reason)]),
        );
        runtime = { handlers, close: () => {} };
      }
      const started = Date.now();
      let result: Job;
      try {
        result = await runJob(db, job, runtime.handlers, {
          heartbeatMs: options.heartbeatMs ?? 15_000,
          log: jobLog,
        });
      } finally {
        await runtime.close();
        currentJob = null;
        touchWorker(db, workerId, null);
      }
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      if (result.status === "succeeded") {
        jobLog(`job ${result.id} finished in ${seconds}s`);
      } else {
        const when = result.runAfter ? `, runs again after ${result.runAfter.toISOString()}` : "";
        jobLog(`job ${result.id} ${result.status} after ${seconds}s${when}: ${result.error ?? ""}`);
      }
      const next = followUp(db, result);
      if (next) jobLog(`queued job ${next.id} (${next.kind})`);
      return { repo: repo.fullName, job, result, next };
    },
  };
}
