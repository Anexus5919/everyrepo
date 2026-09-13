import type { EngineDb } from "@everyrepo/db";
import { fromBlob, normalize } from "@everyrepo/embed";
import type { SearchHit } from "./keyword.ts";

export interface VectorIndex {
  chunkIds: Int32Array;
  dimensions: number;
  matrix: Float32Array;
}

// Loads every chunk vector into one flat matrix; dimensions below the stored size truncate and renormalize
export function loadVectorIndex(engine: EngineDb, dimensions?: number): VectorIndex {
  const rows = engine.$client
    .prepare("SELECT chunk_id AS chunkId, vector FROM chunk_vector ORDER BY chunk_id")
    .all() as Array<{ chunkId: number; vector: Buffer }>;
  const stored = rows[0] ? rows[0].vector.byteLength / Float32Array.BYTES_PER_ELEMENT : 0;
  const size = Math.min(dimensions ?? stored, stored);
  const chunkIds = new Int32Array(rows.length);
  const matrix = new Float32Array(rows.length * size);
  for (const [index, row] of rows.entries()) {
    chunkIds[index] = row.chunkId;
    const vector = fromBlob(row.vector);
    matrix.set(size === stored ? vector : normalize(vector, size), index * size);
  }
  return { chunkIds, dimensions: size, matrix };
}

export function nearestChunks(
  index: VectorIndex,
  query: Float32Array,
  limit: number,
): Array<{ chunkId: number; score: number }> {
  const vector = query.length === index.dimensions ? query : normalize(query, index.dimensions);
  const count = index.chunkIds.length;
  const scores = new Float32Array(count);
  for (let row = 0; row < count; row += 1) {
    let sum = 0;
    const offset = row * index.dimensions;
    for (let column = 0; column < index.dimensions; column += 1) {
      sum += index.matrix[offset + column]! * vector[column]!;
    }
    scores[row] = sum;
  }
  const order = Array.from({ length: count }, (_, row) => row);
  order.sort((a, b) => scores[b]! - scores[a]!);
  return order
    .slice(0, limit)
    .map((row) => ({ chunkId: index.chunkIds[row]!, score: scores[row]! }));
}

export function hitsForChunks(
  engine: EngineDb,
  scored: ReadonlyArray<{ chunkId: number; score: number }>,
): SearchHit[] {
  if (scored.length === 0) return [];
  const rows = engine.$client
    .prepare(
      `SELECT c.id AS chunkId, f.path AS path, c.start_line AS startLine, c.end_line AS endLine, c.header AS header
       FROM chunk c JOIN file f ON f.id = c.file_id
       WHERE c.id IN (${scored.map(() => "?").join(",")})`,
    )
    .all(...scored.map((item) => item.chunkId)) as Array<Omit<SearchHit, "score">>;
  const byId = new Map(rows.map((row) => [row.chunkId, row]));
  return scored.flatMap((item) => {
    const row = byId.get(item.chunkId);
    return row ? [{ ...row, score: item.score }] : [];
  });
}

export function searchVector(
  engine: EngineDb,
  index: VectorIndex,
  query: Float32Array,
  limit = 20,
): SearchHit[] {
  return hitsForChunks(engine, nearestChunks(index, query, limit));
}
