import { posix } from "node:path";
import type { FileKind, ModuleKind } from "@everyrepo/core";
import { openEngineDb } from "@everyrepo/db";
import {
  clusterFiles,
  COMMIT_FORMAT,
  cochangeEdges,
  createImportResolver,
  parseJsonc,
  parseNameOnlyLog,
  rankFiles,
  referenceEdges,
  type GraphFile,
  type GraphImport,
  type GraphModule,
  type PathAlias,
  type WeightedEdge,
  type WorkspacePackage,
} from "@everyrepo/graph";
import { BlobReader, git } from "@everyrepo/repo";

export interface GraphInput {
  enginePath: string;
  gitDir: string;
  sha: string;
  log: (message: string) => void;
  heartbeat: () => void;
}

export interface ResolutionCounts {
  total: number;
  resolved: number;
  external: number;
  unresolved: number;
}

export interface GraphOutput {
  imports: ResolutionCounts & { byLanguage: Record<string, ResolutionCounts> };
  edges: { import: number; reference: number; cochange: number };
  commits: number;
  clusters: number;
  seconds: number;
}

const RANKED_KINDS = new Set<FileKind>(["src", "types", "test"]);
const CLUSTERED_KINDS = new Set<FileKind>(["src", "types"]);
const COCHANGE_DAYS = 365;
const TSCONFIG_FILES = ["tsconfig.json", "tsconfig.base.json", "jsconfig.json"];

interface FileRow {
  id: number;
  path: string;
  kind: FileKind;
  language: string | null;
  tokens: number;
  oid: string;
  packageName: string | null;
  modulePath: string;
}

type ReadText = (path: string) => Promise<string | undefined>;

async function loadAliases(readText: ReadText): Promise<PathAlias[]> {
  const aliases: PathAlias[] = [];
  const seen = new Set<string>();
  const visit = async (configPath: string, depth: number) => {
    if (depth > 3 || seen.has(configPath)) return;
    seen.add(configPath);
    const text = await readText(configPath);
    if (!text) return;
    let config: {
      extends?: string | string[];
      compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
    };
    try {
      config = parseJsonc(text) as typeof config;
    } catch {
      return;
    }
    const dir = posix.dirname(configPath) === "." ? "" : posix.dirname(configPath);
    const base = posix.join(dir || ".", config.compilerOptions?.baseUrl ?? ".");
    for (const [pattern, targets] of Object.entries(config.compilerOptions?.paths ?? {})) {
      aliases.push({ pattern, targets: targets.map((target) => posix.join(base, target)) });
    }
    for (const parent of [config.extends ?? []].flat()) {
      if (parent.startsWith(".")) {
        const resolvedPath = posix.join(
          dir || ".",
          parent.endsWith(".json") ? parent : `${parent}.json`,
        );
        await visit(resolvedPath, depth + 1);
      }
    }
  };
  for (const name of TSCONFIG_FILES) await visit(name, 0);
  return aliases;
}

async function loadPackages(
  modules: readonly GraphModule[],
  readText: ReadText,
): Promise<WorkspacePackage[]> {
  const packages: WorkspacePackage[] = [];
  for (const module of modules) {
    if (module.kind !== "npm") continue;
    const text = await readText(posix.join(module.path || ".", "package.json"));
    if (!text) continue;
    try {
      const manifest = JSON.parse(text) as Record<string, unknown>;
      if (typeof manifest["name"] !== "string") continue;
      const entryFields = ["source", "module", "main", "types"]
        .map((field) => manifest[field])
        .filter((value): value is string => typeof value === "string");
      packages.push({
        name: manifest["name"],
        path: module.path,
        entryFields,
        ...(manifest["exports"] !== undefined ? { exports: manifest["exports"] } : {}),
      });
    } catch {
      continue;
    }
  }
  return packages;
}

async function readCommits(gitDir: string, sha: string): Promise<string[][]> {
  const committed = Number(await git(["show", "-s", "--format=%ct", sha], gitDir));
  const since = new Date((committed - COCHANGE_DAYS * 86_400) * 1000).toISOString();
  const output = await git(
    [
      "-c",
      "core.quotepath=false",
      "log",
      "--no-merges",
      // Rename detection reads file contents, which partial clones would download one by one
      "--no-renames",
      `--format=${COMMIT_FORMAT}`,
      "--name-only",
      `--since=${since}`,
      sha,
    ],
    gitDir,
  );
  return parseNameOnlyLog(output);
}

function emptyCounts(): ResolutionCounts {
  return { total: 0, resolved: 0, external: 0, unresolved: 0 };
}

export async function runGraphStage(input: GraphInput): Promise<GraphOutput> {
  const started = Date.now();
  const engine = openEngineDb(input.enginePath);
  const sql = engine.$client;
  const reader = new BlobReader(input.gitDir);
  try {
    const moduleRows = sql.prepare("SELECT id, name, path, kind FROM module").all() as Array<{
      id: number;
      name: string;
      path: string;
      kind: ModuleKind;
    }>;
    const modules: GraphModule[] = moduleRows;
    const fileRows = sql
      .prepare(
        `SELECT f.id, f.path, f.kind, f.language, f.tokens, f.oid, f.package_name AS packageName,
                COALESCE(m.path, '') AS modulePath
         FROM file f LEFT JOIN module m ON m.id = f.module_id`,
      )
      .all() as FileRow[];
    const files: GraphFile[] = fileRows.map((row) => ({
      id: row.id,
      path: row.path,
      kind: row.kind,
      tokens: row.tokens,
      modulePath: row.modulePath,
      ...(row.language ? { language: row.language } : {}),
      ...(row.packageName ? { packageName: row.packageName } : {}),
    }));
    const byId = new Map(files.map((file) => [file.id, file]));
    const idByPath = new Map(files.map((file) => [file.path, file.id]));
    const oidByPath = new Map(fileRows.map((row) => [row.path, row.oid]));
    const readText: ReadText = async (path) => {
      const oid = oidByPath.get(path);
      return oid ? reader.readText(oid) : undefined;
    };

    const pythonRoots = [
      ...new Set([
        ...modules.filter((module) => module.kind === "python").map((module) => module.path),
        ...files
          .filter((file) => file.language === "python" && /(^|\/)src\//.test(file.path))
          .map((file) => file.path.slice(0, file.path.indexOf("src/") + 3)),
      ]),
    ];
    const resolve = createImportResolver({
      files,
      modules,
      aliases: await loadAliases(readText),
      packages: await loadPackages(modules, readText),
      pythonRoots,
    });

    const importRows = sql
      .prepare("SELECT id, file_id AS fileId, specifier, kind, names FROM file_import")
      .all() as Array<{
      id: number;
      fileId: number;
      specifier: string;
      kind: string;
      names: string | null;
    }>;
    const counts = { ...emptyCounts(), byLanguage: {} as Record<string, ResolutionCounts> };
    const importWeights = new Map<string, WeightedEdge>();
    const setResolution = sql.prepare("UPDATE file_import SET resolution = ? WHERE id = ?");
    const updates: Array<[string, number]> = [];

    for (const row of importRows) {
      const file = byId.get(row.fileId);
      if (!file) continue;
      const ref: GraphImport = {
        id: row.id,
        fileId: row.fileId,
        specifier: row.specifier,
        kind: row.kind,
        ...(row.names ? { names: JSON.parse(row.names) as string[] } : {}),
      };
      const result = resolve(file, ref);
      updates.push([result.resolution, row.id]);
      const language = file.language ?? "other";
      const perLanguage = (counts.byLanguage[language] ??= emptyCounts());
      for (const bucket of [counts, perLanguage]) {
        bucket.total += 1;
        bucket[result.resolution] += 1;
      }
      for (const target of result.targets) {
        const dst = idByPath.get(target);
        if (dst === undefined || dst === row.fileId) continue;
        const key = `${row.fileId}:${dst}`;
        const weight = 1 / result.targets.length;
        const existing = importWeights.get(key);
        if (existing) existing.weight += weight;
        else importWeights.set(key, { src: row.fileId, dst, weight });
      }
    }
    sql.transaction(() => {
      for (const [resolution, id] of updates) setResolution.run(resolution, id);
    })();
    input.heartbeat();

    const definitions = sql.prepare("SELECT file_id AS fileId, name FROM symbol").all() as Array<{
      fileId: number;
      name: string;
    }>;
    const references = sql
      .prepare(
        "SELECT file_id AS fileId, name, COUNT(*) AS count FROM symbol_ref GROUP BY file_id, name",
      )
      .all() as Array<{ fileId: number; name: string; count: number }>;
    const importEdges = [...importWeights.values()];
    const referenceEdgeList = referenceEdges(definitions, references);

    const sourceIds = new Map(
      files.filter((file) => CLUSTERED_KINDS.has(file.kind)).map((file) => [file.path, file.id]),
    );
    let commits: string[][] = [];
    try {
      commits = await readCommits(input.gitDir, input.sha);
    } catch (error) {
      input.log(
        `co-change history unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const cochanges = cochangeEdges(commits, sourceIds);
    input.heartbeat();

    const rankedIds = files.filter((file) => RANKED_KINDS.has(file.kind)).map((file) => file.id);
    const pagerank = rankFiles(rankedIds, [...importEdges, ...referenceEdgeList]);
    const clusterInput = files.filter((file) => CLUSTERED_KINDS.has(file.kind));
    const clusters = clusterFiles(
      clusterInput,
      modules,
      { imports: importEdges, references: referenceEdgeList, cochanges },
      pagerank,
    );

    sql.transaction(() => {
      sql.prepare("DELETE FROM edge").run();
      sql.prepare("UPDATE file SET pagerank = NULL, cluster_id = NULL").run();
      sql.prepare("DELETE FROM cluster").run();
      const insertEdge = sql.prepare(
        "INSERT INTO edge (src_file_id, dst_file_id, kind, weight) VALUES (?, ?, ?, ?)",
      );
      for (const [kind, list] of [
        ["import", importEdges],
        ["reference", referenceEdgeList],
        ["cochange", cochanges],
      ] as const) {
        for (const edge of list) insertEdge.run(edge.src, edge.dst, kind, edge.weight);
      }
      const setRank = sql.prepare("UPDATE file SET pagerank = ? WHERE id = ?");
      for (const [id, score] of pagerank) setRank.run(score, id);
      const insertCluster = sql.prepare(
        "INSERT INTO cluster (key, module_id, label, file_count, token_count, top_files) VALUES (?, ?, ?, ?, ?, ?)",
      );
      const setCluster = sql.prepare("UPDATE file SET cluster_id = ? WHERE id = ?");
      for (const cluster of clusters) {
        const { lastInsertRowid } = insertCluster.run(
          cluster.key,
          cluster.moduleId,
          cluster.label,
          cluster.fileIds.length,
          cluster.tokenCount,
          JSON.stringify(cluster.topFiles),
        );
        for (const id of cluster.fileIds) setCluster.run(lastInsertRowid, id);
      }
    })();

    const output: GraphOutput = {
      imports: counts,
      edges: {
        import: importEdges.length,
        reference: referenceEdgeList.length,
        cochange: cochanges.length,
      },
      commits: commits.length,
      clusters: clusters.length,
      seconds: Math.round((Date.now() - started) / 100) / 10,
    };
    const rate =
      counts.total > 0
        ? Math.round((100 * counts.resolved) / (counts.resolved + counts.unresolved || 1))
        : 0;
    input.log(
      `${counts.total} imports (${counts.resolved} resolved, ${counts.external} external, ${counts.unresolved} unresolved, ${rate}% of internal resolved), ${importEdges.length} import, ${referenceEdgeList.length} reference and ${cochanges.length} co-change edges from ${commits.length} commits, ${clusters.length} clusters in ${output.seconds}s`,
    );
    return output;
  } finally {
    await reader.close();
    sql.close();
  }
}
