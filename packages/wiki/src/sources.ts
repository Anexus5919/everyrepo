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

const CHUNKS_PER_FILE = 3;
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

// Takes chunks round-robin across files so one large file cannot use up the whole budget
export function selectSources(sql: Sql, files: readonly string[], maxChars: number): Source[] {
  const chunkQuery = sql.prepare(
    `SELECT c.id, c.start_line AS startLine, c.end_line AS endLine, c.content
     FROM chunk c JOIN file f ON f.id = c.file_id WHERE f.path = ? ORDER BY c.start_line`,
  );
  const perFile = files.map((path) => ({ path, chunks: chunkQuery.all(path) as ChunkRow[] }));
  const sources: Source[] = [];
  let used = 0;
  for (let round = 0; round < CHUNKS_PER_FILE; round += 1) {
    for (const { path, chunks } of perFile) {
      const chunk = chunks[round];
      if (!chunk) continue;
      if (used + chunk.content.length > maxChars) continue;
      sources.push({
        label: `S${sources.length + 1}`,
        chunkId: chunk.id,
        path,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        content: chunk.content,
      });
      used += chunk.content.length;
    }
  }
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
