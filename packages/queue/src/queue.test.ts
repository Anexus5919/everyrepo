import { parseRepoRef } from "@everyrepo/core";
import { ensureRepo, eq, indexJobs, openAppDb, type AppDb } from "@everyrepo/db";
import { beforeEach, describe, expect, it } from "vitest";
import {
  claimJob,
  claimNextJob,
  enqueueJob,
  findOpenJob,
  runJob,
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
