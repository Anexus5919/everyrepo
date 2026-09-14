import type { EngineDb } from "@everyrepo/db";
import { searchKeyword, type SearchHit } from "./keyword.ts";
import { hitsForChunks, nearestChunks, type VectorIndex } from "./vector.ts";

export interface FusionOptions {
  k?: number;
  // One weight per list, 1 when omitted
  weights?: readonly number[];
}

export interface HybridOptions {
  limit?: number;
  candidates?: number;
  keywordWeight?: number;
  vectorWeight?: number;
}

const RRF_K = 60;
const CANDIDATES = 100;
// Measured on the gold sets: vector ranks are the stronger signal, keyword matches still add exact names
const VECTOR_WEIGHT = 2;

// Reciprocal rank fusion: each list contributes weight / (k + rank), so neither score scale dominates
export function fuseRankings(
  lists: ReadonlyArray<ReadonlyArray<{ chunkId: number }>>,
  limit: number,
  options: FusionOptions = {},
): Array<{ chunkId: number; score: number }> {
  const k = options.k ?? RRF_K;
  const scores = new Map<number, number>();
  for (const [position, list] of lists.entries()) {
    const weight = options.weights?.[position] ?? 1;
    for (const [rank, item] of list.entries()) {
      scores.set(item.chunkId, (scores.get(item.chunkId) ?? 0) + weight / (k + rank + 1));
    }
  }
  return [...scores.entries()]
    .map(([chunkId, score]) => ({ chunkId, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export function searchHybrid(
  engine: EngineDb,
  index: VectorIndex,
  text: string,
  query: Float32Array,
  options: HybridOptions = {},
): SearchHit[] {
  const candidates = options.candidates ?? CANDIDATES;
  const keyword = searchKeyword(engine, text, candidates);
  const vector = nearestChunks(index, query, candidates);
  const fused = fuseRankings([keyword, vector], options.limit ?? 20, {
    weights: [options.keywordWeight ?? 1, options.vectorWeight ?? VECTOR_WEIGHT],
  });
  return hitsForChunks(engine, fused);
}
