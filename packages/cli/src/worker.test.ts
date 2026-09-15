import { parseRepoRef } from "@everyrepo/core";
import { ensureRepo, eq, indexJobs, openAppDb, repos, type AppDb } from "@everyrepo/db";
import type { GithubClient } from "@everyrepo/github";
import { enqueueJob, StageDeferredError, type StageHandler } from "@everyrepo/queue";
import { builderStatus, createRequestService, markPublished } from "@everyrepo/requests";
import { beforeEach, describe, expect, it } from "vitest";
import { createWorker, type RuntimeFactory } from "./worker.ts";

const github: GithubClient = {
  repository: async () => {
    throw new Error("not used");
  },
  fileList: async () => {
    throw new Error("not used");
  },
  file: async () => undefined,
};

let db: AppDb;

beforeEach(() => {
  db = openAppDb(":memory:");
});

function approvedRepo(name: string) {
  const repo = ensureRepo(db, parseRepoRef(name));
  const at = new Date();
  db.$client
    .prepare(
      "INSERT INTO repo_request (repo_id, decision, count, first_at, last_at, decided_at, decided_by) VALUES (?, 'approved', 1, ?, ?, ?, 'owner')",
    )
    .run(repo.id, at.getTime(), at.getTime(), at.getTime());
  return repo;
}

describe("worker", () => {
  it("reads, writes and publishes a requested repository one job at a time", async () => {
    const repo = approvedRepo("acme/app");
    const ran: string[] = [];
    const opened: string[] = [];
    const runtimeFor: RuntimeFactory = async (job) => {
      opened.push(job.kind);
      const handlers: Record<string, StageHandler> = Object.fromEntries(
        job.stages.map((stage) => [
          stage,
          async () => {
            ran.push(stage);
            if (stage === "estimate") {
              db.update(repos).set({ lastIndexedSha: "abc" }).where(eq(repos.id, repo.id)).run();
            }
            if (stage === "publish") markPublished(db, repo.id, "abc", new Date());
          },
        ]),
      );
      return { handlers, close: () => void opened.push(`closed ${job.kind}`) };
    };
    const logs: string[] = [];
    const worker = createWorker({
      db,
      service: createRequestService({ db, github }),
      runtimeFor,
      workerId: "test",
      log: (message) => logs.push(message),
    });

    const read = await worker.step();
    expect(read).toMatchObject({ repo: "acme/app", result: { kind: "full", status: "succeeded" } });
    expect(read?.next?.kind).toBe("wiki");
    expect((await worker.step())?.next?.kind).toBe("publish");
    expect((await worker.step())?.next).toBeUndefined();
    expect(await worker.step()).toBeUndefined();

    expect(opened).toEqual([
      "full",
      "closed full",
      "wiki",
      "closed wiki",
      "publish",
      "closed publish",
    ]);
    expect(ran).toEqual([
      "source",
      "detect",
      "parse",
      "graph",
      "chunk",
      "embed",
      "estimate",
      "summarize",
      "plan",
      "write",
      "glossary",
      "publish",
    ]);
    expect(logs[0]).toBe("queued 1 approved builds that had no job");
  });

  it("reports in while it runs and goes offline when it stops", async () => {
    const worker = createWorker({
      db,
      service: createRequestService({ db, github }),
      runtimeFor: async () => ({ handlers: {}, close: () => {} }),
      workerId: "beating",
    });
    expect(builderStatus(db).online).toBe(false);
    await worker.step();
    expect(builderStatus(db).online).toBe(true);
    worker.heartbeat();
    expect(builderStatus(db, new Date(Date.now() + 60_000)).online).toBe(true);
    expect(builderStatus(db, new Date(Date.now() + 5 * 60_000)).online).toBe(false);
    worker.stop();
    expect(builderStatus(db)).toEqual({ online: false, lastSeenAt: null });
  });

  it("leaves command line jobs alone and fails a job whose runtime cannot open", async () => {
    const cli = ensureRepo(db, parseRepoRef("medusajs/medusa"));
    enqueueJob(db, { repoId: cli.id, kind: "wiki", stages: ["summarize"] });
    const repo = approvedRepo("acme/app");
    const worker = createWorker({
      db,
      service: createRequestService({ db, github }),
      runtimeFor: async () => {
        throw new Error("Add an llm section to the local config first");
      },
      workerId: "test",
    });
    const step = await worker.step();
    expect(step?.repo).toBe("acme/app");
    expect(step?.result).toMatchObject({
      status: "queued",
      error: expect.stringContaining("llm section"),
    });
    expect(await worker.step()).toBeUndefined();
    const cliJob = db.select().from(indexJobs).where(eq(indexJobs.repoId, cli.id)).get();
    expect(cliJob?.status).toBe("queued");
    expect(repo.id).not.toBe(cli.id);
  });

  it("puts a job that ran out of allowance back to wait", async () => {
    approvedRepo("acme/app");
    const worker = createWorker({
      db,
      service: createRequestService({ db, github }),
      runtimeFor: async (job) => ({
        handlers: Object.fromEntries(
          job.stages.map((stage) => [
            stage,
            async () => {
              throw new StageDeferredError("daily limit");
            },
          ]),
        ),
        close: () => {},
      }),
      workerId: "test",
    });
    const step = await worker.step();
    expect(step?.result).toMatchObject({ status: "queued", deferrals: 1 });
    expect(step?.result.runAfter).not.toBeNull();
    expect(step?.next).toBeUndefined();
    expect(await worker.step()).toBeUndefined();
  });
});
