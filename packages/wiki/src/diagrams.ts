import type { EngineDb } from "@everyrepo/db";

type Sql = EngineDb["$client"];

const MAX_NODES = 12;

function label(text: string): string {
  return text.replace(/["\\]/g, "'").replace(/[<>]/g, "");
}

function flowchart(nodes: readonly string[], edges: ReadonlyArray<[number, number]>): string {
  const lines = ["flowchart LR"];
  nodes.forEach((name, index) => lines.push(`  n${index}["${label(name)}"]`));
  for (const [from, to] of edges) lines.push(`  n${from} --> n${to}`);
  return lines.join("\n");
}

// Import links between the most central files of the page's clusters, drawn from the graph rather than by a model
export function clusterDiagram(sql: Sql, clusterKeys: readonly string[]): string | undefined {
  if (clusterKeys.length === 0) return undefined;
  const files = sql
    .prepare(
      `SELECT f.id, f.path FROM file f JOIN cluster c ON c.id = f.cluster_id
       WHERE c.key IN (${clusterKeys.map(() => "?").join(",")}) AND f.pagerank IS NOT NULL
       ORDER BY f.pagerank DESC LIMIT ${MAX_NODES}`,
    )
    .all(...clusterKeys) as Array<{ id: number; path: string }>;
  if (files.length < 3) return undefined;
  const index = new Map(files.map((file, position) => [file.id, position]));
  const edges = (
    sql
      .prepare(
        `SELECT src_file_id AS src, dst_file_id AS dst FROM edge
         WHERE kind = 'import' AND src_file_id IN (${files.map(() => "?").join(",")})`,
      )
      .all(...files.map((file) => file.id)) as Array<{ src: number; dst: number }>
  )
    .filter((edge) => index.has(edge.dst) && edge.src !== edge.dst)
    .map((edge) => [index.get(edge.src)!, index.get(edge.dst)!] as [number, number]);
  if (edges.length < 2) return undefined;
  const connected = new Set(edges.flat());
  const kept = files
    .map((file, position) => ({ file, position }))
    .filter(({ position }) => connected.has(position));
  const remap = new Map(kept.map(({ position }, newIndex) => [position, newIndex]));
  const names = kept.map(({ file }) => file.path.split("/").slice(-2).join("/"));
  return flowchart(
    names,
    edges.map(([from, to]) => [remap.get(from)!, remap.get(to)!]),
  );
}

// Package level import links for the overview page
export function moduleDiagram(sql: Sql): string | undefined {
  const rows = sql
    .prepare(
      `SELECT s.module_id AS src, d.module_id AS dst, COUNT(*) AS n
       FROM edge e JOIN file s ON s.id = e.src_file_id JOIN file d ON d.id = e.dst_file_id
       WHERE e.kind = 'import' AND s.module_id IS NOT NULL AND d.module_id IS NOT NULL AND s.module_id != d.module_id
       GROUP BY s.module_id, d.module_id ORDER BY n DESC LIMIT 40`,
    )
    .all() as Array<{ src: number; dst: number; n: number }>;
  if (rows.length < 2) return undefined;
  const weight = new Map<number, number>();
  for (const row of rows) {
    weight.set(row.src, (weight.get(row.src) ?? 0) + row.n);
    weight.set(row.dst, (weight.get(row.dst) ?? 0) + row.n);
  }
  const top = [...weight.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_NODES)
    .map(([id]) => id);
  const index = new Map(top.map((id, position) => [id, position]));
  const names = top.map(
    (id) =>
      (sql.prepare("SELECT name FROM module WHERE id = ?").get(id) as { name: string } | undefined)
        ?.name ?? String(id),
  );
  const edges = rows
    .filter((row) => index.has(row.src) && index.has(row.dst))
    .map((row) => [index.get(row.src)!, index.get(row.dst)!] as [number, number]);
  return edges.length >= 2 ? flowchart(names, edges) : undefined;
}
