import { parseRepoRef } from "@everyrepo/core";
import { ensureRepo, eq, indexJobs, openAppDb, type AppDb } from "@everyrepo/db";
import { beforeEach, describe, expect, it } from "vitest";
import {
  claimJob,
  claimNextJob,
  enqueueJob,
  findOpenJob,
  runJob,
  StageDeferredError,
  type StageHandler,
} from "./queue.ts";

let db: AppDb;
let repoId: number;

beforeEach(() => {
  db = openAppDb(":memory:");
  repoId = ensureRepo(db, parseRepoRef("example/project")).id;
});

function recorder(failOnce: string[] = []) {
  const calls: string[] = [];
  const pending = new Set(failOnce);
  const handler =
    (name: string): StageHandler =>
    async ({ outputs }) => {
      calls.push(name);
      if (pending.delete(name)) throw new Error(`${name} crashed`);
      return { name, seen: Object.keys(outputs) };
    };
  return { calls, handlers: { a: handler("a"), b: handler("b"), c: handler("c") } };
}

describe("job queue", () => {
  it("runs stages in order and passes earlier outputs forward", async () => {
    const { calls, handlers } = recorder();
    enqueueJob(db, { repoId, kind: "full", stages: ["a", "b", "c"] });
    const job = claimNextJob(db, "worker-1");
    expect(job?.status).toBe("running");

    const finished = await runJob(db, job!, handlers);
    expect(finished.status).toBe("succeeded");
    expect(calls).toEqual(["a", "b", "c"]);
  });

  it("requeues a failed job and resumes after the last completed stage", async () => {
    const { calls, handlers } = recorder(["b"]);
    const queued = enqueueJob(db, { repoId, kind: "full", stages: ["a", "b", "c"] });

    const first = await runJob(db, claimNextJob(db, "worker-1")!, handlers);
    expect(first.status).toBe("queued");
    expect(first.error).toContain("b crashed");

    const second = await runJob(db, claimJob(db, queued.id, "worker-2")!, handlers);
    expect(second.status).toBe("succeeded");
    expect(second.attempts).toBe(2);
    expect(calls).toEqual(["a", "b", "b", "c"]);
  });

  it("defers a job without using an attempt and resumes it later", async () => {
    let quotaLeft = false;
    const handlers: Record<string, StageHandler> = {
      a: async () => "a",
      b: async () => {
        if (!quotaLeft) throw new StageDeferredError("daily quota used");
        return "b";
      },
    };
    enqueueJob(db, { repoId, kind: "full", stages: ["a", "b"] });
    const later = () => new Date(Date.now() + 5 * 3_600_000);
    for (let day = 0; day < 4; day += 1) {
      const deferred = await runJob(db, claimNextJob(db, "worker-1", { now: later() })!, handlers);
      expect(deferred).toMatchObject({
        status: "queued",
        attempts: 0,
        deferrals: day + 1,
        error: "b: daily quota used",
      });
    }
    quotaLeft = true;
    const done = await runJob(db, claimNextJob(db, "worker-1", { now: later() })!, handlers);
    expect(done.status).toBe("succeeded");
  });

  it("waits longer after each deferral and honours a stage's own retry time", async () => {
    const start = new Date("2026-09-16T06:00:00Z");
    const retry: { at?: Date } = {};
    const handlers: Record<string, StageHandler> = {
      a: async () => {
        throw new StageDeferredError("allowance used", retry.at ? { retryAt: retry.at } : {});
      },
    };
    enqueueJob(db, { repoId, kind: "full", stages: ["a"] });
    const minutes = (job: { runAfter: Date | null }) =>
      (job.runAfter!.getTime() - start.getTime()) / 60_000;

    const first = await runJob(db, claimNextJob(db, "w", { now: start })!, handlers, {
      now: () => start,
    });
    expect(minutes(first)).toBe(15);
    expect(claimNextJob(db, "w", { now: new Date(start.getTime() + 14 * 60_000) })).toBeUndefined();

    const second = await runJob(db, claimJob(db, first.id, "w", { now: start })!, handlers, {
      now: () => start,
    });
    expect(minutes(second)).toBe(30);

    retry.at = new Date("2026-09-16T09:00:00Z");
    const third = await runJob(db, claimJob(db, first.id, "w", { now: start })!, handlers, {
      now: () => start,
    });
    expect(third.runAfter).toEqual(retry.at);
  });

  it("retries a crashed job after a short wait", async () => {
    const start = new Date("2026-09-16T06:00:00Z");
    const { handlers } = recorder(["a"]);
    enqueueJob(db, { repoId, kind: "full", stages: ["a"] });
    const failed = await runJob(db, claimNextJob(db, "w", { now: start })!, handlers, {
      now: () => start,
    });
    expect(failed).toMatchObject({ status: "queued", runAfter: new Date("2026-09-16T06:01:00Z") });
    expect(claimNextJob(db, "w", { now: start })).toBeUndefined();
    expect(claimNextJob(db, "w", { now: new Date("2026-09-16T06:01:00Z") })?.id).toBe(failed.id);
  });

  it("lets a worker claim only the jobs from its origin", () => {
    const cli = enqueueJob(db, { repoId, kind: "wiki", stages: ["a"] });
    const requested = enqueueJob(db, { repoId, kind: "full", stages: ["a"], origin: "request" });
    expect(claimNextJob(db, "worker", { origin: "request" })?.id).toBe(requested.id);
    expect(claimNextJob(db, "worker", { origin: "request" })).toBeUndefined();
    expect(claimNextJob(db, "worker")?.id).toBe(cli.id);
  });

  it("records progress inside a stage and clears it when the job finishes", async () => {
    let clock = new Date("2026-09-16T06:00:00Z").getTime();
    const now = () => new Date(clock);
    const seen: unknown[] = [];
    const read = () => db.select().from(indexJobs).where(eq(indexJobs.repoId, repoId)).get();
    const handlers: Record<string, StageHandler> = {
      a: async ({ progress }) => {
        seen.push(read()?.progress);
        progress(1, 10);
        clock += 200;
        progress(2, 10);
        seen.push(read()?.progress);
        clock += 1_000;
        progress(3, 10);
        seen.push(read()?.progress);
        clock += 10;
        progress(10, 10);
        seen.push(read()?.progress);
      },
    };
    enqueueJob(db, { repoId, kind: "full", stages: ["a"] });
    const done = await runJob(db, claimNextJob(db, "w", { now: now() })!, handlers, { now });
    const at = new Date("2026-09-16T06:00:00Z").getTime();
    expect(seen).toEqual([
      { stage: "a", done: null, total: null, at },
      { stage: "a", done: 1, total: 10, at },
      { stage: "a", done: 3, total: 10, at: at + 1_200 },
      { stage: "a", done: 10, total: 10, at: at + 1_210 },
    ]);
    expect(done.progress).toBeNull();
  });

  it("marks a job failed once attempts are exhausted", async () => {
    const { handlers } = recorder(["a"]);
    enqueueJob(db, { repoId, kind: "full", stages: ["a"], maxAttempts: 1 });
    const result = await runJob(db, claimNextJob(db, "worker-1")!, handlers);
    expect(result.status).toBe("failed");
    expect(findOpenJob(db, repoId)).toBeUndefined();
  });

  it("reclaims a running job whose worker stopped sending heartbeats", () => {
    const job = enqueueJob(db, { repoId, kind: "full", stages: ["a"] });
    const start = new Date("2026-09-14T10:00:00Z");
    claimNextJob(db, "worker-1", { now: start });

    const later = new Date(start.getTime() + 11 * 60_000);
    const reclaimed = claimNextJob(db, "worker-2", { now: later });
    expect(reclaimed?.id).toBe(job.id);
    expect(reclaimed?.lockedBy).toBe("worker-2");
    expect(reclaimed?.attempts).toBe(2);
  });

  it("does not hand out a job that is still healthy", () => {
    enqueueJob(db, { repoId, kind: "full", stages: ["a"] });
    const now = new Date();
    claimNextJob(db, "worker-1", { now });
    expect(claimNextJob(db, "worker-2", { now })).toBeUndefined();
    const stored = db.select().from(indexJobs).where(eq(indexJobs.repoId, repoId)).get();
    expect(stored?.lockedBy).toBe("worker-1");
  });

  it("fails a job that names a stage without a handler", async () => {
    enqueueJob(db, { repoId, kind: "full", stages: ["missing"], maxAttempts: 1 });
    const result = await runJob(db, claimNextJob(db, "worker-1")!, {});
    expect(result.status).toBe("failed");
    expect(result.error).toContain("No handler");
  });
});
