import type { EngineDb } from "@everyrepo/db";
import { searchKeyword, type SearchHit } from "./keyword.ts";
import { hitsForChunks, nearestChunks, type VectorIndex } from "./vector.ts";

const RRF_K = 60;
const CANDIDATES = 50;

// Reciprocal rank fusion: each list contributes 1 / (k + rank), so neither score scale dominates
export function fuseRankings(
  lists: ReadonlyArray<ReadonlyArray<{ chunkId: number }>>,
  limit: number,
): Array<{ chunkId: number; score: number }> {
  const scores = new Map<number, number>();
  for (const list of lists) {
    for (const [rank, item] of list.entries()) {
      scores.set(item.chunkId, (scores.get(item.chunkId) ?? 0) + 1 / (RRF_K + rank + 1));
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
  limit = 20,
): SearchHit[] {
  const keyword = searchKeyword(engine, text, CANDIDATES);
  const vector = nearestChunks(index, query, CANDIDATES);
  return hitsForChunks(engine, fuseRankings([keyword, vector], limit));
}
