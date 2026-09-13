import type { EngineDb } from "@everyrepo/db";

export interface SearchHit {
  chunkId: number;
  path: string;
  startLine: number;
  endLine: number;
  header: string;
  score: number;
}

const STOP_WORDS = new Set(
  "a an and are as at be by does do for from how in is it of on or that the this to what where which who why with".split(
    " ",
  ),
);

// Builds a safe FTS5 query: every term is quoted so user input cannot inject query syntax
export function ftsQuery(text: string): string | undefined {
  const terms = new Set<string>();
  for (const word of text.match(/[\p{L}\p{N}_$]+/gu) ?? []) {
    const lower = word.toLowerCase();
    if (lower.length > 1 && !STOP_WORDS.has(lower)) terms.add(lower);
    const parts = word
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .split(/[\s_$]+/)
      .map((part) => part.toLowerCase())
      .filter((part) => part.length > 1 && !STOP_WORDS.has(part));
    if (parts.length > 1) for (const part of parts) terms.add(part);
  }
  if (terms.size === 0) return undefined;
  return [...terms].map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
}

// Header and identifier matches weigh more than body text
const COLUMN_WEIGHTS = "2.0, 1.0, 3.0";

export function searchKeyword(engine: EngineDb, text: string, limit = 20): SearchHit[] {
  const query = ftsQuery(text);
  if (!query) return [];
  return engine.$client
    .prepare(
      `SELECT c.id AS chunkId, f.path AS path, c.start_line AS startLine, c.end_line AS endLine,
              c.header AS header, bm25(chunk_fts, ${COLUMN_WEIGHTS}) AS score
       FROM chunk_fts
       JOIN chunk c ON c.id = chunk_fts.rowid
       JOIN file f ON f.id = c.file_id
       WHERE chunk_fts MATCH ?
       ORDER BY score
       LIMIT ?`,
    )
    .all(query, limit) as SearchHit[];
}
