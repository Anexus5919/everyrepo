import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRepoRef } from "@everyrepo/core";
import {
  engineDbPath,
  ensureRepo,
  eq,
  indexJobs,
  openAppDb,
  openEngineDb,
  repoRequests,
  repos,
} from "@everyrepo/db";
import { enqueueJob } from "@everyrepo/queue";
import { afterAll, describe, expect, it } from "vitest";
import { exportSite } from "./site-export.ts";

const dataDir = mkdtempSync(join(tmpdir(), "site-export-"));

afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

describe("site export", () => {
  it("keeps a first wiki off the site while it is still being written", async () => {
    const app = openAppDb(":memory:");
    const repo = ensureRepo(app, parseRepoRef("acme/app"));
    app
      .update(repos)
      .set({ lastIndexedSha: "abc", status: "indexed" })
      .where(eq(repos.id, repo.id))
      .run();
    const at = new Date();
    app
      .insert(repoRequests)
      .values({
        repoId: repo.id,
        decision: "approved",
        decidedBy: "owner",
        firstAt: at,
        lastAt: at,
        decidedAt: at,
      })
      .run();
    const engine = openEngineDb(engineDbPath(dataDir, "acme__app", "abc")).$client;
    engine
      .prepare(
        "INSERT INTO snapshot (sha, repo, ref, engine_version, stats, created_at) VALUES ('abc', 'acme/app', 'main', '1', '{}', 1)",
      )
      .run();
    engine
      .prepare(
        `INSERT INTO wiki_page (slug, parent_slug, position, title, purpose, clusters, files, status, markdown, updated_at)
         VALUES ('overview', NULL, 0, 'Overview', 'What it is.', '[]', '[]', 'written', 'Text', 1),
                ('core', NULL, 1, 'Core', 'The core.', '[]', '[]', 'planned', NULL, 1)`,
      )
      .run();
    engine.close();
    const out = join(dataDir, "site");

    const wiki = enqueueJob(app, { repoId: repo.id, kind: "wiki", stages: ["write"] });
    const writing = await exportSite(app, dataDir, out);
    expect(writing.listed).toMatchObject([{ repo: "acme/app", status: "queued", pages: 0 }]);
    expect(writing.ready).toEqual([]);

    app.update(indexJobs).set({ status: "succeeded" }).where(eq(indexJobs.id, wiki.id)).run();
    enqueueJob(app, { repoId: repo.id, kind: "publish", stages: ["publish"] });
    const publishing = await exportSite(app, dataDir, out);
    expect(publishing.listed).toMatchObject([{ repo: "acme/app", status: "ready", pages: 1 }]);
    expect(publishing.ready.map((ready) => ready.repo)).toEqual(["acme/app"]);
  });
});
