import type { EngineDb } from "@everyrepo/db";
import { importShare, type Source } from "@everyrepo/wiki";
import { trimExcerpt } from "./retrieve.ts";

export interface AskDiagram {
  nodes: Array<{ id: number; label: string }>;
  edges: Array<{ from: number; to: number }>;
}

const PER_BOX_CHARS = 1_100;

// Package names look like @scope/name or a single word; file boxes carry a folder and a file name
const isFileLabel = (label: string) => label.includes("/") && !label.startsWith("@");

// The diagram written out as boxes and arrows, with how connected each box is, so a model can walk through it
export function diagramText(diagram: AskDiagram): string {
  const labels = new Map(diagram.nodes.map((node) => [node.id, node.label]));
  const kind = diagram.nodes.every((node) => isFileLabel(node.label)) ? "file" : "package";
  const importedBy = new Map<number, number>();
  const imports = new Map<number, number>();
  for (const edge of diagram.edges) {
    imports.set(edge.from, (imports.get(edge.from) ?? 0) + 1);
    importedBy.set(edge.to, (importedBy.get(edge.to) ?? 0) + 1);
  }
  const pairs = new Set(diagram.edges.map((edge) => `${edge.from}>${edge.to}`));
  const mutual = diagram.edges.filter(
    (edge) => edge.from < edge.to && pairs.has(`${edge.to}>${edge.from}`),
  );
  const lines = [
    `The diagram has ${diagram.nodes.length} boxes and ${diagram.edges.length} arrows. Each box is a ${kind}. An arrow from A to B means A imports code from B, so boxes that use others sit on the left and the ones they rely on sit on the right. Dashed arrows point back to a box further left.`,
    "",
    "Boxes:",
    ...[...diagram.nodes]
      .sort((a, b) => (importedBy.get(b.id) ?? 0) - (importedBy.get(a.id) ?? 0))
      .map(
        (node) =>
          `- ${node.label}: imported by ${importedBy.get(node.id) ?? 0}, imports ${imports.get(node.id) ?? 0}`,
      ),
    "",
    "Arrows:",
    ...diagram.edges.map((edge) => `- ${labels.get(edge.from)} imports ${labels.get(edge.to)}`),
  ];
  if (mutual.length > 0) {
    lines.push(
      "",
      "Loops, where two boxes import each other:",
      ...mutual.map((edge) => `- ${labels.get(edge.from)} and ${labels.get(edge.to)}`),
    );
  }
  return lines.join("\n");
}

interface ChunkRow {
  id: number;
  path: string;
  startLine: number;
  endLine: number;
  content: string;
}

// One opening excerpt for each box: the file itself, or a package's README, manifest or entry file
export function diagramChunks(engine: EngineDb, diagram: AskDiagram, maxChars: number): Source[] {
  const sql = engine.$client;
  const chunksOf = sql.prepare(
    `SELECT c.id, f.path, c.start_line AS startLine, c.end_line AS endLine, c.content
     FROM chunk c JOIN file f ON f.id = c.file_id WHERE f.path = ? ORDER BY c.start_line`,
  );
  const fileFor = (label: string) =>
    (
      sql
        .prepare(
          `SELECT path FROM file WHERE path = ? OR path LIKE ? ORDER BY pagerank DESC NULLS LAST LIMIT 1`,
        )
        .get(label, `%/${label}`) as { path: string } | undefined
    )?.path;
  const packageFile = (label: string) => {
    const module = sql.prepare("SELECT path FROM module WHERE name = ?").get(label) as
      { path: string } | undefined;
    if (!module) return undefined;
    const prefix = module.path && module.path !== "." ? `${module.path}/` : "";
    for (const candidate of [
      "README.md",
      "package.json",
      "src/index.ts",
      "src/index.js",
      "index.ts",
    ]) {
      const found = sql
        .prepare("SELECT path FROM file WHERE path = ?")
        .get(`${prefix}${candidate}`) as { path: string } | undefined;
      if (found) return found.path;
    }
    return undefined;
  };

  const sources: Source[] = [];
  let used = 0;
  for (const node of diagram.nodes) {
    const path = isFileLabel(node.label) ? fileFor(node.label) : packageFile(node.label);
    if (!path) continue;
    const rows = chunksOf.all(path) as ChunkRow[];
    const row = rows.find((chunk) => importShare(chunk.content) <= 0.6) ?? rows[0];
    if (!row) continue;
    const excerpt = trimExcerpt(row, Math.min(PER_BOX_CHARS, maxChars - used));
    if (excerpt.content.length < 40) continue;
    sources.push({
      label: "",
      chunkId: excerpt.id,
      path: excerpt.path,
      startLine: excerpt.startLine,
      endLine: excerpt.endLine,
      content: excerpt.content,
    });
    used += excerpt.content.length;
    if (used >= maxChars) break;
  }
  return sources;
}
