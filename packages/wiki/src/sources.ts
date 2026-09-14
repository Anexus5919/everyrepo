import type { EngineDb } from "@everyrepo/db";
import type { ClusterSummary } from "./cluster-summary.ts";

type Sql = EngineDb["$client"];

export interface Source {
  label: string;
  chunkId: number;
  path: string;
  startLine: number;
  endLine: number;
  content: string;
}

export interface PageRef {
  slug: string;
  clusters: string[];
  files: string[];
}

interface ChunkRow {
  id: number;
  startLine: number;
  endLine: number;
  content: string;
}

const MAX_FILES = 24;

// Files a page should draw on: the planner's picks, the clusters' key files, then the clusters' most central files
export function candidateFiles(
  sql: Sql,
  page: PageRef,
  clusterSummaries: ReadonlyMap<string, ClusterSummary>,
  children: readonly PageRef[] = [],
): string[] {
  const ordered: string[] = [...page.files];
  for (const key of page.clusters) {
    for (const file of clusterSummaries.get(key)?.keyFiles ?? []) ordered.push(file.path);
  }
  // A parent page introduces its children, so it reads the first files each child starts from
  for (const child of children) {
    ordered.push(...child.files.slice(0, 2));
    const firstCluster = child.clusters[0];
    const keyFile = firstCluster ? clusterSummaries.get(firstCluster)?.keyFiles[0] : undefined;
    if (keyFile) ordered.push(keyFile.path);
  }
  if (page.clusters.length > 0) {
    const placeholders = page.clusters.map(() => "?").join(",");
    const central = sql
      .prepare(
        `SELECT f.path FROM file f JOIN cluster c ON c.id = f.cluster_id
         WHERE c.key IN (${placeholders}) ORDER BY f.pagerank DESC NULLS LAST LIMIT ${MAX_FILES}`,
      )
      .all(...page.clusters) as Array<{ path: string }>;
    ordered.push(...central.map((row) => row.path));
  }
  if (page.slug === "overview" || ordered.length === 0) {
    const docs = sql
      .prepare(
        `SELECT path FROM file WHERE kind = 'docs' AND path NOT LIKE '%/%'
         ORDER BY CASE WHEN lower(path) LIKE 'readme%' THEN 0 ELSE 1 END, length(path) LIMIT 4`,
      )
      .all() as Array<{ path: string }>;
    ordered.unshift(...docs.map((row) => row.path));
  }
  return [...new Set(ordered)].slice(0, MAX_FILES);
}

const IMPORT_LINE =
  /^(?:import\s|export\s+(?:\*|\{[^}]*\})\s+from\s|\}\s*from\s|from\s+\S+\s+import\s|package\s|using\s|use\s|#include\s|const\s+\w+\s*=\s*require\()/;

// Share of non-empty lines that only import or re-export other code
export function importShare(content: string): number {
  const lines = content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("//") && !line.startsWith("*"));
  if (lines.length === 0) return 1;
  return lines.filter((line) => IMPORT_LINE.test(line)).length / lines.length;
}

interface RankedChunk extends ChunkRow {
  header: string;
}

// Chunks that define things explain more than chunks that only import; file order breaks ties
function rankChunks(chunks: readonly RankedChunk[]): RankedChunk[] {
  const useful = chunks.filter((chunk) => importShare(chunk.content) <= IMPORT_HEAVY);
  const pool = useful.length > 0 ? useful : chunks.slice(0, 1);
  return [...pool].sort((a, b) => {
    const defines = Number(b.header.includes("defines ")) - Number(a.header.includes("defines "));
    return defines !== 0 ? defines : a.startLine - b.startLine;
  });
}

const IMPORT_HEAVY = 0.6;
// The most important files are read in depth, the rest contribute one excerpt each
const DEEP_FILES = 6;
const DEEP_CHUNKS = 3;

export function selectSources(sql: Sql, files: readonly string[], maxChars: number): Source[] {
  const chunkQuery = sql.prepare(
    `SELECT c.id, c.start_line AS startLine, c.end_line AS endLine, c.content, c.header
     FROM chunk c JOIN file f ON f.id = c.file_id WHERE f.path = ? ORDER BY c.start_line`,
  );
  const perFile = files.map((path) => ({
    path,
    chunks: rankChunks(chunkQuery.all(path) as RankedChunk[]),
  }));
  const sources: Source[] = [];
  let used = 0;
  const take = (path: string, chunk: RankedChunk | undefined) => {
    if (!chunk || used + chunk.content.length > maxChars) return;
    sources.push({
      label: `S${sources.length + 1}`,
      chunkId: chunk.id,
      path,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      content: chunk.content,
    });
    used += chunk.content.length;
  };
  perFile.slice(0, DEEP_FILES).forEach(({ path, chunks }) => {
    for (const chunk of chunks.slice(0, 2)) take(path, chunk);
  });
  perFile.slice(DEEP_FILES).forEach(({ path, chunks }) => take(path, chunks[0]));
  perFile.slice(0, DEEP_FILES).forEach(({ path, chunks }) => {
    for (const chunk of chunks.slice(2, DEEP_CHUNKS)) take(path, chunk);
  });
  // Sources stay grouped by file in reading order, which makes the numbered list easier to follow
  const order = new Map(files.map((path, index) => [path, index]));
  sources.sort((a, b) => order.get(a.path)! - order.get(b.path)! || a.startLine - b.startLine);
  sources.forEach((source, index) => {
    source.label = `S${index + 1}`;
  });
  return sources;
}

export function formatSources(sources: readonly Source[]): string {
  return sources
    .map(
      (source) =>
        `[${source.label}] ${source.path} (lines ${source.startLine}-${source.endLine})\n\`\`\`\n${source.content}\n\`\`\``,
    )
    .join("\n\n");
}
