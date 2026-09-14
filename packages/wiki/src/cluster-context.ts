import { createHash } from "node:crypto";
import type { EngineDb } from "@everyrepo/db";

export interface ClusterRow {
  id: number;
  key: string;
  label: string;
  moduleName: string;
  fileCount: number;
  tokenCount: number;
}

export interface ClusterContext {
  cluster: ClusterRow;
  files: string[];
  text: string;
}

interface FileRow {
  id: number;
  path: string;
  kind: string;
}

interface SymbolRow {
  name: string;
  exported: number;
  signature: string | null;
  doc: string | null;
}

const OUTLINE_SHARE = 0.5;
const MAX_SIGNATURES_PER_FILE = 8;
const MAX_DOC_CHARS = 300;
const MAX_EXCERPT_CHARS = 6_000;

type Sql = EngineDb["$client"];

export function listClusters(sql: Sql): ClusterRow[] {
  return sql
    .prepare(
      `SELECT c.id, c.key, c.label, COALESCE(m.name, '') AS moduleName, c.file_count AS fileCount,
              c.token_count AS tokenCount
       FROM cluster c LEFT JOIN module m ON m.id = c.module_id
       ORDER BY c.key`,
    )
    .all() as ClusterRow[];
}

function outlineFor(file: FileRow, symbols: readonly SymbolRow[]): string {
  const ordered = [...symbols].sort((a, b) => b.exported - a.exported);
  const signatures = ordered
    .slice(0, MAX_SIGNATURES_PER_FILE)
    .map((symbol) => (symbol.signature ?? symbol.name).replace(/\s+/g, " ").trim());
  const doc = ordered
    .map((symbol) => symbol.doc?.replace(/\s+/g, " ").trim())
    .find((text): text is string => Boolean(text));
  return [
    `### ${file.path}`,
    signatures.length > 0 ? `Defines: ${signatures.join(" | ")}` : "",
    doc ? `Notes: ${doc.slice(0, MAX_DOC_CHARS)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

// Half the budget outlines every file, the rest shows code from the most central files
export function buildClusterContext(
  sql: Sql,
  cluster: ClusterRow,
  maxChars: number,
): ClusterContext {
  const files = sql
    .prepare(
      "SELECT id, path, kind FROM file WHERE cluster_id = ? ORDER BY pagerank DESC NULLS LAST, path",
    )
    .all(cluster.id) as FileRow[];
  const symbolQuery = sql.prepare(
    "SELECT name, exported, signature, doc FROM symbol WHERE file_id = ? ORDER BY start_line",
  );
  const chunkQuery = sql.prepare(
    "SELECT start_line AS startLine, end_line AS endLine, content FROM chunk WHERE file_id = ? ORDER BY start_line",
  );

  const parts: string[] = [];
  let used = 0;
  const outlineBudget = maxChars * OUTLINE_SHARE;
  for (const file of files) {
    const outline = outlineFor(file, symbolQuery.all(file.id) as SymbolRow[]);
    if (used + outline.length > outlineBudget) break;
    parts.push(outline);
    used += outline.length + 2;
  }
  for (const file of files) {
    if (used >= maxChars) break;
    const chunks = chunkQuery.all(file.id) as Array<{
      startLine: number;
      endLine: number;
      content: string;
    }>;
    const first = chunks[0];
    if (!first) continue;
    const excerpt = first.content.slice(0, Math.min(MAX_EXCERPT_CHARS, maxChars - used));
    const block = `Code from ${file.path} (lines ${first.startLine}-${first.endLine}):\n${excerpt}`;
    parts.push(block);
    used += block.length + 2;
  }
  return { cluster, files: files.map((file) => file.path), text: parts.join("\n\n") };
}

export function hashInput(promptVersion: string, text: string): string {
  return createHash("sha256").update(promptVersion).update("\n").update(text).digest("hex");
}
