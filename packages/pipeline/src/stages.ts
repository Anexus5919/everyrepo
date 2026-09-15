import {
  INDEX_STAGE_KEYS,
  repoDirName,
  type LocalConfig,
  type RepoRef,
  type SizeTier,
} from "@everyrepo/core";
import {
  embeddingCachePath,
  engineDbPath,
  eq,
  files,
  indexJobs,
  inArray,
  openEngineDb,
  repos,
  snapshots,
  type AppDb,
} from "@everyrepo/db";
import { detectRepository } from "@everyrepo/detect";
import type { Embedder } from "@everyrepo/embed";
import { isParseable, parseSource } from "@everyrepo/parse";
import type { StageHandler } from "@everyrepo/queue";
import {
  BlobReader,
  ensureBlobs,
  ensureClone,
  fetchLatest,
  listTree,
  resolveBranch,
  resolveRepoSource,
  resolveSnapshot,
} from "@everyrepo/repo";
import { createParseWriter, writeDetection, type ParsedFile } from "./engine-writer.ts";
import { runChunkStage } from "./chunk-stage.ts";
import { runEmbedStage } from "./embed-stage.ts";
import { runGraphStage } from "./graph-stage.ts";
import { estimateIndexCost, type CostEstimate } from "./estimate.ts";

export const INDEX_STAGES = INDEX_STAGE_KEYS;
export type IndexStage = (typeof INDEX_STAGES)[number];

export interface PipelineOptions {
  config: LocalConfig;
  appDb: AppDb;
  ref: RepoRef;
  repoId: number;
  fetch: boolean;
  embedder?: Embedder | undefined;
}

export interface SourceOutput {
  sha: string;
  branch: string;
  remoteRef: string;
  gitDir: string;
  enginePath: string;
}

export interface DetectOutput {
  files: number;
  modules: number;
  sourceTokens: number;
  sizeTier: SizeTier;
}

export interface ParseOutput {
  candidates: number;
  ok: number;
  partial: number;
  failed: number;
  skippedLarge: number;
  definitions: number;
  references: number;
  seconds: number;
}

const PARSED_KINDS = ["src", "types", "test"] as const;
const MAX_PARSE_BYTES = 512 * 1024;
const WRITE_BATCH = 200;

function sourceOutput(outputs: Record<string, unknown>): SourceOutput {
  const output = outputs["source"] as SourceOutput | undefined;
  if (!output) throw new Error("The source stage has not produced a snapshot");
  return output;
}

export function createIndexHandlers(options: PipelineOptions): Record<IndexStage, StageHandler> {
  const { appDb, config, ref, repoId } = options;

  const source: StageHandler = async ({ log }) => {
    const repoSource = resolveRepoSource(config, ref);
    await ensureClone(repoSource);
    const branch = await resolveBranch(repoSource);
    if (options.fetch) {
      log(`fetching ${repoSource.remote}/${branch}`);
      await fetchLatest(repoSource, branch);
    }
    const snapshot = await resolveSnapshot({ ...repoSource, branch });
    await ensureBlobs(repoSource, snapshot.sha);
    appDb
      .update(repos)
      .set({ defaultBranch: branch, status: "indexing" })
      .where(eq(repos.id, repoId))
      .run();
    log(`snapshot ${snapshot.remoteRef} at ${snapshot.sha.slice(0, 10)}`);
    const output: SourceOutput = {
      ...snapshot,
      gitDir: repoSource.gitDir,
      enginePath: engineDbPath(config.dataDir, repoDirName(ref), snapshot.sha),
    };
    return output;
  };

  const detect: StageHandler = async ({ outputs, log }) => {
    const snapshot = sourceOutput(outputs);
    const entries = await listTree(snapshot.gitDir, snapshot.sha);
    const oids = new Map(entries.map((entry) => [entry.path, entry.oid]));
    const reader = new BlobReader(snapshot.gitDir);
    try {
      const detection = await detectRepository({
        entries,
        repoName: ref.name,
        readText: async (path) => {
          const oid = oids.get(path);
          return oid ? reader.readText(oid) : undefined;
        },
      });
      const engine = openEngineDb(snapshot.enginePath);
      try {
        writeDetection(
          engine,
          { ref, sha: snapshot.sha, remoteRef: snapshot.remoteRef },
          detection,
        );
      } finally {
        engine.$client.close();
      }
      log(
        `${entries.length} files, ${detection.modules.length} modules, ${detection.sourceTokens} source tokens (${detection.sizeTier})`,
      );
      const output: DetectOutput = {
        files: entries.length,
        modules: detection.modules.length,
        sourceTokens: detection.sourceTokens,
        sizeTier: detection.sizeTier,
      };
      return output;
    } finally {
      await reader.close();
    }
  };

  const parse: StageHandler = async ({ outputs, heartbeat, log, progress }) => {
    const snapshot = sourceOutput(outputs);
    const started = Date.now();
    const engine = openEngineDb(snapshot.enginePath);
    const reader = new BlobReader(snapshot.gitDir);
    try {
      const writer = createParseWriter(engine);
      writer.clear();
      const candidates = engine
        .select({ id: files.id, oid: files.oid, bytes: files.bytes, language: files.language })
        .from(files)
        .where(inArray(files.kind, [...PARSED_KINDS]))
        .all()
        .filter((row) => isParseable(row.language ?? undefined));

      const counts: ParseOutput = {
        candidates: candidates.length,
        ok: 0,
        partial: 0,
        failed: 0,
        skippedLarge: 0,
        definitions: 0,
        references: 0,
        seconds: 0,
      };
      let batch: ParsedFile[] = [];
      for (const [index, row] of candidates.entries()) {
        const language = row.language ?? undefined;
        if (!isParseable(language)) continue;
        progress(index, candidates.length);
        if (row.bytes > MAX_PARSE_BYTES) {
          counts.skippedLarge += 1;
          continue;
        }
        try {
          const result = await parseSource(language, await reader.readText(row.oid));
          const status = result.hasErrors ? "partial" : "ok";
          counts[status] += 1;
          counts.definitions += result.definitions.length;
          counts.references += result.references.length;
          batch.push({ fileId: row.id, status, result });
        } catch {
          counts.failed += 1;
          batch.push({ fileId: row.id, status: "failed" });
        }
        if (batch.length >= WRITE_BATCH) {
          writer.write(batch);
          batch = [];
        }
        if ((index + 1) % 1000 === 0) {
          heartbeat();
          log(`parsed ${index + 1}/${candidates.length}`);
        }
      }
      writer.write(batch);
      progress(candidates.length, candidates.length);
      counts.seconds = Math.round((Date.now() - started) / 100) / 10;
      log(
        `${counts.ok} ok, ${counts.partial} with syntax errors, ${counts.failed} failed, ${counts.definitions} definitions in ${counts.seconds}s`,
      );
      return counts;
    } finally {
      await reader.close();
      engine.$client.close();
    }
  };

  const graph: StageHandler = async ({ outputs, heartbeat, log }) => {
    const snapshot = sourceOutput(outputs);
    return runGraphStage({
      enginePath: snapshot.enginePath,
      gitDir: snapshot.gitDir,
      sha: snapshot.sha,
      log,
      heartbeat,
    });
  };

  const chunk: StageHandler = async ({ outputs, heartbeat, log, progress }) => {
    const snapshot = sourceOutput(outputs);
    return runChunkStage({
      enginePath: snapshot.enginePath,
      gitDir: snapshot.gitDir,
      log,
      heartbeat,
      progress,
    });
  };

  const embed: StageHandler = async ({ outputs, heartbeat, log, progress }) => {
    const snapshot = sourceOutput(outputs);
    return runEmbedStage({
      enginePath: snapshot.enginePath,
      cachePath: embeddingCachePath(config.dataDir, repoDirName(ref)),
      embedder: options.embedder,
      log,
      heartbeat,
      progress,
    });
  };

  const estimate: StageHandler = async ({ outputs, job, log }) => {
    const snapshot = sourceOutput(outputs);
    const engine = openEngineDb(snapshot.enginePath);
    try {
      const row = engine.select().from(snapshots).get();
      if (!row?.sizeTier) throw new Error("Detection results are missing");
      const sourceFiles = engine
        .select({ path: files.path, tokens: files.tokens })
        .from(files)
        .where(eq(files.kind, "src"))
        .all();
      const directories = new Set(sourceFiles.map((file) => file.path.replace(/\/?[^/]*$/, "")));
      const cost: CostEstimate = estimateIndexCost({
        sizeTier: row.sizeTier,
        sourceFileTokens: sourceFiles.map((file) => file.tokens),
        sourceDirectories: directories.size,
      });
      engine
        .update(snapshots)
        .set({ stats: { ...(row.stats ?? {}), estimate: cost } })
        .where(eq(snapshots.sha, row.sha))
        .run();

      appDb
        .update(indexJobs)
        .set({ estTokens: cost.inputTokens })
        .where(eq(indexJobs.id, job.id))
        .run();
      appDb
        .update(repos)
        .set({
          status: "indexed",
          sizeTier: row.sizeTier,
          lastIndexedSha: row.sha,
          lastIndexedAt: new Date(),
        })
        .where(eq(repos.id, repoId))
        .run();
      log(
        `first index needs about ${(cost.inputTokens / 1e6).toFixed(2)}M input tokens (${(cost.localTokens / 1e6).toFixed(2)}M local, ${(cost.cloudTokens / 1e6).toFixed(2)}M cloud), ${cost.pages} pages`,
      );
      return cost;
    } finally {
      engine.$client.close();
    }
  };

  return { source, detect, parse, graph, chunk, embed, estimate };
}

export function stagesUntil(stage: string | undefined): IndexStage[] {
  if (!stage) return [...INDEX_STAGES];
  const index = INDEX_STAGES.indexOf(stage as IndexStage);
  if (index < 0) {
    throw new Error(`Unknown stage "${stage}". Stages: ${INDEX_STAGES.join(", ")}`);
  }
  return INDEX_STAGES.slice(0, index + 1);
}
