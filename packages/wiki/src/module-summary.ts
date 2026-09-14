import type { EngineDb } from "@everyrepo/db";
import type { ChatMessage } from "@everyrepo/llm";
import type { ClusterSummary } from "./cluster-summary.ts";

type Sql = EngineDb["$client"];

export const MODULE_PROMPT_VERSION = "module-1";

export interface ModuleRow {
  id: number;
  name: string;
  path: string;
  kind: string;
  license: string | null;
}

export interface ModuleCluster {
  key: string;
  tokenCount: number;
}

export interface ModuleContext {
  module: ModuleRow;
  clusterKeys: string[];
  files: string[];
  text: string;
}

export function listModulesWithClusters(
  sql: Sql,
): Array<{ module: ModuleRow; clusters: ModuleCluster[] }> {
  const modules = sql
    .prepare("SELECT id, name, path, kind, license FROM module ORDER BY path")
    .all() as ModuleRow[];
  const clusters = sql
    .prepare(
      "SELECT key, module_id AS moduleId, token_count AS tokenCount FROM cluster ORDER BY token_count DESC",
    )
    .all() as Array<ModuleCluster & { moduleId: number | null }>;
  return modules
    .map((module) => ({
      module,
      clusters: clusters
        .filter((cluster) => cluster.moduleId === module.id)
        .map(({ key, tokenCount }) => ({ key, tokenCount })),
    }))
    .filter((entry) => entry.clusters.length > 0);
}

// Modules this module imports from and modules that import it, by number of import edges
export function moduleNeighbors(sql: Sql, moduleId: number): { uses: string[]; usedBy: string[] } {
  const query = (direction: "uses" | "usedBy") =>
    (
      sql
        .prepare(
          `SELECT m.name AS name, COUNT(*) AS n
           FROM edge e
           JOIN file s ON s.id = e.src_file_id
           JOIN file d ON d.id = e.dst_file_id
           JOIN module m ON m.id = ${direction === "uses" ? "d" : "s"}.module_id
           WHERE e.kind = 'import' AND s.module_id != d.module_id
             AND ${direction === "uses" ? "s" : "d"}.module_id = ?
           GROUP BY m.id ORDER BY n DESC LIMIT 8`,
        )
        .all(moduleId) as Array<{ name: string; n: number }>
    ).map((row) => `${row.name} (${row.n})`);
  return { uses: query("uses"), usedBy: query("usedBy") };
}

export function buildModuleContext(
  sql: Sql,
  module: ModuleRow,
  clusterKeys: readonly string[],
  clusterSummaries: ReadonlyMap<string, ClusterSummary>,
  maxChars: number,
): ModuleContext {
  const neighbors = moduleNeighbors(sql, module.id);
  const parts: string[] = [];
  const files = new Set<string>();
  let used = 0;
  for (const key of clusterKeys) {
    const summary = clusterSummaries.get(key);
    if (!summary) continue;
    const block = [
      `## ${summary.title} (${key})`,
      summary.purpose,
      summary.responsibilities.length > 0 ? `Does: ${summary.responsibilities.join("; ")}` : "",
      summary.keyFiles.length > 0
        ? `Key files: ${summary.keyFiles.map((file) => `${file.path} (${file.role})`).join("; ")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
    if (used + block.length > maxChars) break;
    parts.push(block);
    used += block.length + 2;
    for (const file of summary.keyFiles) files.add(file.path);
  }
  const header = [
    `Package: ${module.name} at ${module.path || "the repository root"} (${module.kind})`,
    module.license ? `License: ${module.license}` : "",
    neighbors.uses.length > 0 ? `Imports from: ${neighbors.uses.join(", ")}` : "",
    neighbors.usedBy.length > 0 ? `Imported by: ${neighbors.usedBy.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return {
    module,
    clusterKeys: [...clusterKeys],
    files: [...files],
    text: `${header}\n\n${parts.join("\n\n")}`,
  };
}

const SYSTEM = [
  "You describe packages of a software repository for developers who are new to it.",
  "Use only facts from the descriptions you are given; never guess names, files or behavior.",
  "Write plain, specific sentences. Do not use long dashes, emoji or marketing words.",
  "Reply with a single JSON object and nothing else.",
].join(" ");

export function moduleSummaryMessages(repo: string, context: ModuleContext): ChatMessage[] {
  const user = [
    `Repository: ${repo}`,
    "Below is a package with descriptions of its groups of files.",
    "",
    context.text,
    "",
    "Describe the whole package as JSON with exactly these fields:",
    '{"title": "2 to 6 words naming what the package does",',
    ' "purpose": "2 or 3 sentences on what the package provides and who uses it",',
    ' "responsibilities": ["up to 6 short phrases"],',
    ' "keyFiles": [{"path": "an exact path from the key files above", "role": "one sentence"}],',
    ' "concepts": ["up to 8 terms a reader must understand, as named in the code"]}',
  ].join("\n");
  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: user },
  ];
}
