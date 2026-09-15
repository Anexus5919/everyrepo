import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRepoRef, type LocalConfig } from "@everyrepo/core";
import {
  engineDbPath,
  ensureRepo,
  eq,
  openAppDb,
  openEngineDb,
  recordUsage,
  repos,
} from "@everyrepo/db";
import { afterAll, describe, expect, it } from "vitest";
import { capacityConfig, createAllowanceClock, createWorkMeasure } from "./build-work.ts";

const dataDir = mkdtempSync(join(tmpdir(), "build-work-"));

afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

const config = {
  dataDir,
  localRepos: {},
  llm: {
    models: {
      lite: {
        provider: "gemini",
        model: "flash-lite",
        requestsPerMinute: 15,
        tokensPerMinute: 250_000,
        requestsPerDay: 2,
      },
      groq: {
        provider: "groq",
        model: "qwen",
        requestsPerMinute: 30,
        tokensPerMinute: 8_000,
        requestsPerDay: 1_000,
      },
    },
    tasks: { summary: ["lite", "groq"], plan: ["lite"], page: ["lite"] },
  },
} as LocalConfig;

describe("work still left", () => {
  it("counts the model calls a read repository still needs from its engine database", () => {
    const app = openAppDb(":memory:");
    const repo = ensureRepo(app, parseRepoRef("acme/app"));
    app
      .update(repos)
      .set({ lastIndexedSha: "abc", sizeTier: "S" })
      .where(eq(repos.id, repo.id))
      .run();
    const row = app.select().from(repos).where(eq(repos.id, repo.id)).get()!;

    const engine = openEngineDb(engineDbPath(dataDir, "acme__app", "abc")).$client;
    engine
      .prepare(
        "INSERT INTO module (id, name, path, kind) VALUES (1, 'core', 'core', 'npm'), (2, 'ui', 'ui', 'npm')",
      )
      .run();
    engine
      .prepare(
        `INSERT INTO cluster (key, module_id, label, file_count, token_count, top_files) VALUES
         ('c1', 1, 'a', 1, 10, '[]'), ('c2', 1, 'b', 1, 10, '[]'), ('c3', 2, 'c', 1, 10, '[]')`,
      )
      .run();
    engine
      .prepare(
        `INSERT INTO summary (level, target, prompt_version, input_hash, provider, model, content, input_tokens, output_tokens, created_at)
         VALUES ('cluster', 'c1', '1', 'h', 'gemini', 'lite', '{}', 1, 1, 1)`,
      )
      .run();
    engine.close();

    const measure = createWorkMeasure(dataDir);
    // Two clusters and the package with two clusters still need calls, then the repository and the glossary
    expect(measure(row)).toEqual({
      readingMs: 0,
      embedTokens: 0,
      calls: { summary: 5, plan: 2, page: 7 },
      publishMs: 90_000,
    });
    expect(measure({ ...row, lastIndexedSha: null })).toBeUndefined();
  });

  it("tells a paused job when its task's allowance frees up", () => {
    const app = openAppDb(":memory:");
    const clock = createAllowanceClock(app, config);
    expect(clock.modelsAt("summary")).toBeUndefined();
    const hourAgo = new Date(Date.now() - 3_600_000);
    recordUsage(app, { provider: "gemini", model: "flash-lite", tokens: 10, neurons: 0 }, hourAgo);
    recordUsage(app, { provider: "gemini", model: "flash-lite", tokens: 10, neurons: 0 }, hourAgo);
    const bucket = new Date(Math.floor(hourAgo.getTime() / 3_600_000) * 3_600_000);
    // The groq model cannot take summary calls within its per-minute tokens, so only the lite allowance counts
    expect(clock.modelsAt("summary")).toEqual(new Date(bucket.getTime() + 86_400_000));
    expect(capacityConfig(config)?.embeddings).toBeUndefined();
  });
});
