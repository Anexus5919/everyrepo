import type { EngineDb } from "@everyrepo/db";
import { rankFiles, searchHybrid, type VectorIndex } from "@everyrepo/search";
import { importShare, type Source } from "@everyrepo/wiki";

export interface RetrieveOptions {
  // Total excerpt size; 16,000 characters keeps a request with its answer under an 8,000 tokens per minute cap
  maxChars?: number;
  files?: number;
  chunks?: number;
}

interface ChunkRow {
  id: number;
  path: string;
  startLine: number;
  endLine: number;
  content: string;
}

const MAX_CHARS = 16_000;
const TOP_FILES = 8;
const TOP_CHUNKS = 30;
// One long chunk may not crowd out the rest, so it is cut to whole lines within this size
const MAX_EXCERPT_CHARS = 4_000;
const IMPORT_HEAVY = 0.6;

// Cuts an excerpt at a line boundary and moves its end line to match
export function trimExcerpt(row: ChunkRow, maxChars: number): ChunkRow {
  if (row.content.length <= maxChars) return row;
  const lines = row.content.split("\n");
  const kept: string[] = [];
  let size = 0;
  for (const line of lines) {
    if (size + line.length + 1 > maxChars && kept.length > 0) break;
    kept.push(line);
    size += line.length + 1;
  }
  return { ...row, content: kept.join("\n"), endLine: row.startLine + kept.length - 1 };
}

// Best chunks of the most relevant files alternate with the best matching chunks, then pack into a budget
export function retrieveSources(
  engine: EngineDb,
  index: VectorIndex,
  question: string,
  query: Float32Array,
  options: RetrieveOptions = {},
): Source[] {
  const maxChars = options.maxChars ?? MAX_CHARS;
  const files = rankFiles(engine, index, question, query, { limit: options.files ?? TOP_FILES });
  const hits = searchHybrid(engine, index, question, query, {
    limit: options.chunks ?? TOP_CHUNKS,
  });

  const order: number[] = [];
  const add = (id: number | undefined) => {
    if (id !== undefined && !order.includes(id)) order.push(id);
  };
  for (let position = 0; position < Math.max(files.length, hits.length); position += 1) {
    add(files[position]?.chunkIds[0]);
    add(hits[position]?.chunkId);
  }
  if (order.length === 0) return [];

  const rows = engine.$client
    .prepare(
      `SELECT c.id, f.path, c.start_line AS startLine, c.end_line AS endLine, c.content
       FROM chunk c JOIN file f ON f.id = c.file_id WHERE c.id IN (${order.map(() => "?").join(",")})`,
    )
    .all(...order) as ChunkRow[];
  const byId = new Map(rows.map((row) => [row.id, row]));
  const ranked = order.flatMap((id) => {
    const row = byId.get(id);
    return row ? [trimExcerpt(row, MAX_EXCERPT_CHARS)] : [];
  });
  const useful = ranked.filter((row) => importShare(row.content) <= IMPORT_HEAVY);
  const pool = useful.length > 0 ? useful : ranked;

  const picked: ChunkRow[] = [];
  let used = 0;
  for (const row of pool) {
    if (used + row.content.length > maxChars) continue;
    picked.push(row);
    used += row.content.length;
  }

  // Excerpts stay grouped by file, files in the order they ranked, so the numbered list reads in sequence
  const fileRank = new Map<string, number>();
  for (const row of picked) if (!fileRank.has(row.path)) fileRank.set(row.path, fileRank.size);
  picked.sort((a, b) => fileRank.get(a.path)! - fileRank.get(b.path)! || a.startLine - b.startLine);
  return picked.map((row, position) => ({
    label: `S${position + 1}`,
    chunkId: row.id,
    path: row.path,
    startLine: row.startLine,
    endLine: row.endLine,
    content: row.content,
  }));
}
