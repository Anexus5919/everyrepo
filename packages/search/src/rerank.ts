import type { EngineDb } from "@everyrepo/db";
import type { FileHit } from "./files.ts";

export interface RerankOptions {
  // How many of the top files are sent to the reranker
  top: number;
  // 0 keeps the first order, 1 uses only the reranker order, values between fuse the two ranks
  blend: number;
}

const FUSION_K = 10;

// The passage for a file is its best matching chunk, or its first chunk when it was added through imports
export function filePassages(engine: EngineDb, hits: readonly FileHit[]): string[] {
  const sql = engine.$client;
  const byId = sql.prepare("SELECT header, content FROM chunk WHERE id = ?");
  const firstOfFile = sql.prepare(
    "SELECT header, content FROM chunk WHERE file_id = ? ORDER BY start_line LIMIT 1",
  );
  return hits.map((hit) => {
    const row = (
      hit.chunkIds.length > 0 ? byId.get(hit.chunkIds[0]) : firstOfFile.get(hit.fileId)
    ) as { header: string; content: string } | undefined;
    return `${hit.path}\n${row ? `${row.header}\n${row.content}` : ""}`;
  });
}

// Reorders the top files by combining their first rank with the reranker's rank
export function applyRerank(
  hits: readonly FileHit[],
  scores: readonly number[],
  options: RerankOptions,
): FileHit[] {
  const head = hits.slice(0, options.top);
  const tail = hits.slice(options.top);
  const byScore = head
    .map((hit, index) => ({ index, score: scores[index] ?? Number.NEGATIVE_INFINITY }))
    .sort((a, b) => b.score - a.score);
  const rerankRank = new Map(byScore.map((item, rank) => [item.index, rank]));
  const fused = head
    .map((hit, index) => ({
      hit,
      value:
        (1 - options.blend) / (FUSION_K + index + 1) +
        options.blend / (FUSION_K + (rerankRank.get(index) ?? index) + 1),
    }))
    .sort((a, b) => b.value - a.value)
    .map((item) => item.hit);
  return [...fused, ...tail];
}
