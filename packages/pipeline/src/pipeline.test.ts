import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseRepoRef, type LocalConfig } from "@everyrepo/core";
import { embeddingCachePath, ensureRepo, findRepo, openAppDb, openEngineDb } from "@everyrepo/db";
import { createHashingEmbedder, EmbeddingBudgetError, type Embedder } from "@everyrepo/embed";
import {
  loadVectorIndex,
  rankFiles,
  searchHybrid,
  searchKeyword,
  searchVector,
} from "@everyrepo/search";
import { claimNextJob, enqueueJob, runJob, StageDeferredError } from "@everyrepo/queue";
import { git } from "@everyrepo/repo";
import { LlmRouter, type ChatModel } from "@everyrepo/llm";
import { summarizeRepository } from "@everyrepo/wiki";
import { afterAll, describe, expect, it } from "vitest";
import { runEmbedStage } from "./embed-stage.ts";
import { estimateIndexCost } from "./estimate.ts";
import { buildReport } from "./report.ts";
import { createIndexHandlers, stagesUntil, type SourceOutput } from "./stages.ts";

const root = mkdtempSync(join(tmpdir(), "pipeline-test-"));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

async function createRepo(dir: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  await git(["init", "-q", "-b", "main", dir]);
  await git(["add", "-A"], dir);
  await git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"], dir);
}

describe("index pipeline", () => {
  it("indexes a local clone end to end and reports on it", async () => {
    const upstream = join(root, "upstream");
    await createRepo(upstream, {
      "package.json": JSON.stringify({ name: "widgets", workspaces: ["packages/*"] }),
      LICENSE: "MIT License\n\nPermission is hereby granted, free of charge",
      "packages/core/package.json": JSON.stringify({ name: "@widgets/core" }),
      "packages/core/src/store.ts":
        "/** Keeps state. */\nexport class Store { load() { return read(); } }\nfunction read() { return 1; }\n",
      "packages/core/src/store.test.ts": "import { Store } from './store';\nnew Store().load();\n",
      "server/src/main/java/app/Server.java":
        "package app;\npublic class Server { public void start() { new Store(); } }\n",
      "README.md": "# Widgets\n",
    });
    const fork = join(root, "fork");
    await git(["clone", "-q", upstream, fork]);

    const config: LocalConfig = {
      dataDir: join(root, "data"),
      localRepos: { "acme/widgets": { path: fork, remote: "origin", defaultBranch: "main" } },
    };
    const ref = parseRepoRef("acme/widgets");
    const appDb = openAppDb(":memory:");
    const repo = ensureRepo(appDb, ref);
    enqueueJob(appDb, { repoId: repo.id, kind: "full", stages: stagesUntil(undefined) });

    const embedder = createHashingEmbedder();
    const handlers = createIndexHandlers({
      config,
      appDb,
      ref,
      repoId: repo.id,
      fetch: false,
      embedder,
    });
    const job = await runJob(appDb, claimNextJob(appDb, "test")!, handlers);
    expect(job.error).toBeNull();
    expect(job.status).toBe("succeeded");

    const stored = findRepo(appDb, ref)!;
    expect(stored.status).toBe("indexed");
    expect(stored.sizeTier).toBe("S");
    expect(stored.lastIndexedSha).toBe(await git(["rev-parse", "HEAD"], upstream));

    const outputs = appDb.$client
      .prepare("SELECT output FROM job_stage WHERE stage = 'source'")
      .get() as { output: string };
    const enginePath = (JSON.parse(outputs.output) as SourceOutput).enginePath;
    const engine = openEngineDb(enginePath);
    const hits = searchKeyword(engine, "keeps state store");
    expect(hits[0]?.path).toBe("packages/core/src/store.ts");
    expect(hits[0]?.header).toContain("defines Store");
    expect(searchKeyword(engine, "widgets readme").map((hit) => hit.path)).toContain("README.md");
    expect(
      (
        engine.$client.prepare("SELECT COUNT(*) AS n FROM edge WHERE kind = 'import'").get() as {
          n: number;
        }
      ).n,
    ).toBeGreaterThanOrEqual(1);
    const index = loadVectorIndex(engine);
    const chunkCount = (
      engine.$client.prepare("SELECT COUNT(*) AS n FROM chunk").get() as { n: number }
    ).n;
    expect(index.chunkIds.length).toBe(chunkCount);
    const [query] = await embedder.embed(["keeps state store"], "query");
    expect(searchVector(engine, index, query!, 5)[0]?.path).toBe("packages/core/src/store.ts");
    expect(searchHybrid(engine, index, "keeps state store", query!, { limit: 5 })[0]?.path).toBe(
      "packages/core/src/store.ts",
    );
    const files = rankFiles(engine, index, "keeps state store", query!, { limit: 5 });
    expect(files[0]?.path).toBe("packages/core/src/store.ts");
    expect(files[0]?.chunkIds.length).toBeGreaterThan(0);
    engine.$client.close();

    const again = await runEmbedStage({
      enginePath,
      cachePath: embeddingCachePath(config.dataDir, "acme__widgets"),
      embedder,
      log: () => {},
      heartbeat: () => {},
    });
    expect(again).toMatchObject({ chunks: chunkCount, cached: chunkCount, embedded: 0 });

    // A used-up allowance pauses the stage; vectors embedded before it stay cached
    let calls = 0;
    const limited: Embedder = {
      ...embedder,
      model: "limited",
      batchSize: 1,
      embed: (texts, purpose) => {
        calls += 1;
        if (calls > 1) return Promise.reject(new EmbeddingBudgetError("allowance used"));
        return embedder.embed(texts, purpose);
      },
    };
    const stageInput = {
      enginePath,
      cachePath: embeddingCachePath(config.dataDir, "acme__widgets"),
      log: () => {},
      heartbeat: () => {},
    };
    await expect(runEmbedStage({ ...stageInput, embedder: limited })).rejects.toBeInstanceOf(
      StageDeferredError,
    );
    const resumed = await runEmbedStage({
      ...stageInput,
      embedder: { ...embedder, model: "limited" },
    });
    expect(resumed).toMatchObject({ cached: 1, embedded: chunkCount - 1 });
    // Summaries are stored once and reused while their input stays the same
    let modelCalls = 0;
    const clusterAnswer = {
      title: "Core store",
      purpose: "Keeps widget state for the rest of the packages.",
      responsibilities: ["Load state"],
      keyFiles: [{ path: "packages/core/src/store.ts", role: "Defines the store" }],
      concepts: ["Store"],
    };
    const repoAnswer = {
      summary: "A small widget library with a state store.",
      overview: "The repository holds a core package with a store and a Java server that uses it.",
      architecture: "The core package defines the store and the server creates it.",
      mainAreas: [{ title: "Core", description: "State handling.", modules: ["packages/core"] }],
      technologies: ["TypeScript", "Java"],
    };
    const fakeModel: ChatModel = {
      id: "fake",
      provider: "test",
      model: "fake",
      limits: { requestsPerMinute: 100, tokensPerMinute: 1_000_000, requestsPerDay: 1_000 },
      complete: async (request) => {
        modelCalls += 1;
        const prompt = request.messages.map((message) => message.content).join("\n");
        const answer = prompt.includes("Describe the repository") ? repoAnswer : clusterAnswer;
        return {
          text: JSON.stringify(answer),
          provider: "test",
          model: "fake",
          inputTokens: 10,
          outputTokens: 5,
          cached: false,
        };
      },
    };
    const summarize = () =>
      summarizeRepository({
        enginePath,
        repo: "acme/widgets",
        router: new LlmRouter({ summary: [fakeModel] }),
        log: () => {},
        heartbeat: () => {},
      });
    const first = await summarize();
    expect(first.clusters.total).toBeGreaterThan(0);
    expect(first.clusters.written).toBe(first.clusters.total);
    expect(first.repo.written).toBe(1);
    const callsAfterFirst = modelCalls;
    const second = await summarize();
    expect(second.clusters).toMatchObject({ written: 0, reused: first.clusters.total });
    expect(second.modules.written).toBe(0);
    expect(second.repo).toMatchObject({ written: 0, reused: 1 });
    expect(modelCalls).toBe(callsAfterFirst);

    const report = buildReport(enginePath);
    expect(report.repo).toBe("acme/widgets");
    expect(report.topModules.map((module) => module.path).sort()).toEqual(["", "packages/core"]);
    expect(report.licenses).toEqual([{ license: "MIT", modules: 2 }]);
    expect(report.parse["ok"]).toBe(3);
    expect(report.definitions).toBeGreaterThanOrEqual(5);
    expect(report.mostReferenced.map((row) => row.name)).toContain("Store");
    expect(report.estimate?.pages).toBe(8);
  }, 60_000);

  it("rejects unknown stages", () => {
    expect(stagesUntil("detect")).toEqual(["source", "detect"]);
    expect(() => stagesUntil("wiki")).toThrow(/Unknown stage/);
  });
});

describe("estimateIndexCost", () => {
  it("summarizes large files from signatures and runs bulk work locally for large repositories", () => {
    const small = estimateIndexCost({
      sizeTier: "S",
      sourceFileTokens: [1000, 1000],
      sourceDirectories: 2,
    });
    expect(small.directorySummaryTokens).toBe(0);
    expect(small.localTokens).toBe(0);
    expect(small.fileSummaryTokens).toBe(2000);

    const large = estimateIndexCost({
      sizeTier: "L",
      sourceFileTokens: Array.from({ length: 1000 }, () => 3000),
      sourceDirectories: 200,
    });
    expect(large.fileSummaryTokens).toBe(1000 * 600);
    expect(large.localTokens).toBe(large.fileSummaryTokens + large.directorySummaryTokens);
    expect(large.cloudTokens).toBe(large.planningTokens + large.pageTokens);
  });
});
