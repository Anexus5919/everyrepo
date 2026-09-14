import type { EngineDb } from "@everyrepo/db";
import { fuseRankings } from "./hybrid.ts";
import { searchKeyword } from "./keyword.ts";
import { nearestChunks, type VectorIndex } from "./vector.ts";

export interface FileRankOptions {
  limit?: number;
  candidates?: number;
  vectorWeight?: number;
  // Weights for a file's best, second and third chunk
  chunkDecay?: readonly number[];
  // Up to this fraction is added for the most central files
  centralityWeight?: number;
  // Multiplier for documentation files
  docsWeight?: number;
  // Share of a top file's score passed to each file it imports
  neighborWeight?: number;
  // How many top files pass score to their imports
  neighborSources?: number;
  // Divide passed score by log2(2 + times the target is imported), so shared utilities do not win everything
  dampenPopular?: boolean;
}

export interface FileHit {
  fileId: number;
  path: string;
  kind: string;
  score: number;
  chunkIds: number[];
}

interface CandidateRow {
  chunkId: number;
  fileId: number;
  path: string;
  kind: string;
}

// Tuned on the gold sets; extra chunks per file did not help, so a file ranks by its best chunk
const DEFAULTS = {
  limit: 20,
  candidates: 100,
  vectorWeight: 2,
  chunkDecay: [1],
  centralityWeight: 0.25,
  docsWeight: 0.9,
  neighborWeight: 0.25,
  neighborSources: 10,
  dampenPopular: true,
} satisfies Required<FileRankOptions>;

// PageRank percentile per file, computed once per engine and reused across queries
const centralityCache = new WeakMap<EngineDb, Map<number, number>>();

export function fileCentrality(engine: EngineDb): Map<number, number> {
  const cached = centralityCache.get(engine);
  if (cached) return cached;
  const rows = engine.$client
    .prepare("SELECT id FROM file WHERE pagerank IS NOT NULL ORDER BY pagerank")
    .all() as Array<{ id: number }>;
  const percentiles = new Map(rows.map((row, index) => [row.id, (index + 1) / rows.length]));
  centralityCache.set(engine, percentiles);
  return percentiles;
}

// Ranks files rather than chunks: several relevant chunks, central files and code over prose all count
export function rankFiles(
  engine: EngineDb,
  index: VectorIndex,
  text: string,
  query: Float32Array,
  options: FileRankOptions = {},
): FileHit[] {
  const settings = { ...DEFAULTS, ...options };
  const keyword = searchKeyword(engine, text, settings.candidates);
  const vector = nearestChunks(index, query, settings.candidates);
  const fused = fuseRankings([keyword, vector], settings.candidates * 2, {
    weights: [1, settings.vectorWeight],
  });
  if (fused.length === 0) return [];

  const rows = engine.$client
    .prepare(
      `SELECT c.id AS chunkId, c.file_id AS fileId, f.path AS path, f.kind AS kind
       FROM chunk c JOIN file f ON f.id = c.file_id
       WHERE c.id IN (${fused.map(() => "?").join(",")})`,
    )
    .all(...fused.map((item) => item.chunkId)) as CandidateRow[];
  const byChunk = new Map(rows.map((row) => [row.chunkId, row]));
  const centrality = settings.centralityWeight > 0 ? fileCentrality(engine) : undefined;

  const files = new Map<number, { row: CandidateRow; scores: number[]; chunkIds: number[] }>();
  for (const item of fused) {
    const row = byChunk.get(item.chunkId);
    if (!row) continue;
    const entry = files.get(row.fileId) ?? { row, scores: [], chunkIds: [] };
    entry.scores.push(item.score);
    entry.chunkIds.push(item.chunkId);
    files.set(row.fileId, entry);
  }

  const ranked = [...files.values()]
    .map(({ row, scores, chunkIds }) => {
      let score = settings.chunkDecay.reduce(
        (sum, weight, rank) => sum + weight * (scores[rank] ?? 0),
        0,
      );
      if (centrality) score *= 1 + settings.centralityWeight * (centrality.get(row.fileId) ?? 0);
      if (row.kind === "docs") score *= settings.docsWeight;
      return { fileId: row.fileId, path: row.path, kind: row.kind, score, chunkIds };
    })
    .sort((a, b) => b.score - a.score);
  const expanded = settings.neighborWeight > 0 ? expandImports(engine, ranked, settings) : ranked;
  return expanded.slice(0, settings.limit);
}

// Files imported by several strong results are often the shared mechanism a question is about
function expandImports(
  engine: EngineDb,
  ranked: FileHit[],
  settings: Required<FileRankOptions>,
): FileHit[] {
  const sources = ranked.slice(0, settings.neighborSources);
  if (sources.length === 0) return ranked;
  const sql = engine.$client;
  const edges = sql
    .prepare(
      `SELECT src_file_id AS src, dst_file_id AS dst FROM edge
       WHERE kind = 'import' AND src_file_id IN (${sources.map(() => "?").join(",")})`,
    )
    .all(...sources.map((hit) => hit.fileId)) as Array<{ src: number; dst: number }>;
  if (edges.length === 0) return ranked;

  const sourceScore = new Map(sources.map((hit) => [hit.fileId, hit.score]));
  const targets = [...new Set(edges.map((edge) => edge.dst))];
  const placeholders = targets.map(() => "?").join(",");
  const inDegree = new Map(
    (
      sql
        .prepare(
          `SELECT dst_file_id AS id, COUNT(*) AS n FROM edge WHERE kind = 'import' AND dst_file_id IN (${placeholders}) GROUP BY dst_file_id`,
        )
        .all(...targets) as Array<{ id: number; n: number }>
    ).map((row) => [row.id, row.n]),
  );
  const bonus = new Map<number, number>();
  for (const edge of edges) {
    if (edge.src === edge.dst) continue;
    const damping = settings.dampenPopular ? Math.log2(2 + (inDegree.get(edge.dst) ?? 0)) : 1;
    const passed = (settings.neighborWeight * (sourceScore.get(edge.src) ?? 0)) / damping;
    bonus.set(edge.dst, (bonus.get(edge.dst) ?? 0) + passed);
  }

  const byId = new Map(ranked.map((hit) => [hit.fileId, { ...hit }]));
  const missing = [...bonus.keys()].filter((id) => !byId.has(id));
  if (missing.length > 0) {
    const rows = sql
      .prepare(
        `SELECT id AS fileId, path, kind FROM file WHERE id IN (${missing.map(() => "?").join(",")})`,
      )
      .all(...missing) as Array<{ fileId: number; path: string; kind: string }>;
    for (const row of rows) byId.set(row.fileId, { ...row, score: 0, chunkIds: [] });
  }
  for (const [id, extra] of bonus) {
    const hit = byId.get(id);
    if (hit) hit.score += extra;
  }
  return [...byId.values()].sort((a, b) => b.score - a.score);
}
