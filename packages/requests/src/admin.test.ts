import { parseRepoRef } from "@everyrepo/core";
import { ensureRepo, eq, indexJobs, openAppDb, repos, type AppDb } from "@everyrepo/db";
import { enqueueJob } from "@everyrepo/queue";
import { beforeEach, describe, expect, it } from "vitest";
import {
  adminQueue,
  builderPaused,
  cancelBuild,
  moveBuild,
  queueRewrite,
  setBuilderPaused,
} from "./admin.ts";

let db: AppDb;

beforeEach(() => {
  db = openAppDb(":memory:");
});

const build = (name: string, priority: number) => {
  const repo = ensureRepo(db, parseRepoRef(name));
  return enqueueJob(db, {
    repoId: repo.id,
    kind: "full",
    stages: ["source"],
    origin: "request",
    priority,
  });
};

const order = () => adminQueue(db).map((item) => item.repo);

describe("admin queue controls", () => {
  it("moves a waiting build to the top, up, down and to the bottom of the line", () => {
    build("acme/one", 80);
    const two = build("acme/two", 100);
    const three = build("acme/three", 280);
    expect(order()).toEqual(["acme/one", "acme/two", "acme/three"]);

    moveBuild(db, three.id, "top");
    expect(order()).toEqual(["acme/three", "acme/one", "acme/two"]);
    moveBuild(db, two.id, "up");
    expect(order()).toEqual(["acme/three", "acme/two", "acme/one"]);
    moveBuild(db, three.id, "down");
    expect(order()).toEqual(["acme/two", "acme/three", "acme/one"]);
    moveBuild(db, two.id, "bottom");
    expect(order()).toEqual(["acme/three", "acme/one", "acme/two"]);
    // Moving past the end changes nothing
    expect(moveBuild(db, two.id, "down")).toBe(adminQueue(db)[2]!.priority);
  });

  it("keeps the running build first and only moves or cancels waiting builds", () => {
    const running = build("acme/running", 300);
    db.update(indexJobs).set({ status: "running" }).where(eq(indexJobs.id, running.id)).run();
    const waiting = build("acme/waiting", 80);
    expect(order()).toEqual(["acme/running", "acme/waiting"]);
    expect(() => moveBuild(db, running.id, "top")).toThrow("is not waiting in the line");
    expect(() => cancelBuild(db, running.id)).toThrow("is not waiting in the line");

    cancelBuild(db, waiting.id);
    expect(order()).toEqual(["acme/running"]);
  });

  it("pauses the builder and queues rewrites of chosen pages for published wikis only", () => {
    expect(builderPaused(db)).toBe(false);
    setBuilderPaused(db, true);
    expect(builderPaused(db)).toBe(true);
    setBuilderPaused(db, false);
    expect(builderPaused(db)).toBe(false);

    const repo = ensureRepo(db, parseRepoRef("acme/lib"));
    expect(queueRewrite(db, repo.id, ["overview"])).toBeUndefined();
    db.update(repos)
      .set({ lastIndexedSha: "abc", sizeTier: "S", publishedSha: "abc", publishedAt: new Date() })
      .where(eq(repos.id, repo.id))
      .run();
    const queued = queueRewrite(db, repo.id, ["overview", "persist"])!;
    const job = db.select().from(indexJobs).where(eq(indexJobs.id, queued.jobId)).get()!;
    expect(job).toMatchObject({
      kind: "wiki",
      priority: 380,
      params: { pages: ["overview", "persist"] },
    });
    expect(adminQueue(db)[0]).toMatchObject({ repo: "acme/lib", published: true, asked: false });
  });
});
