import { openEngineDb, snapshots } from "@kickstart/db";
import type { DocsSource, LanguageStat } from "@kickstart/detect";
import type { CostEstimate } from "./estimate.ts";

export interface ModuleSummary {
  path: string;
  name: string;
  kind: string;
  license: string | null;
  files: number;
  sourceTokens: number;
}

export interface SnapshotReport {
  repo: string;
  ref: string;
  sha: string;
  sizeTier: string | null;
  sourceTokens: number;
  kinds: Record<string, number>;
  languages: LanguageStat[];
  docsSources: DocsSource[];
  moduleCount: number;
  topModules: ModuleSummary[];
  licenses: Array<{ license: string; modules: number }>;
  parse: Record<string, number>;
  definitions: number;
  exportedDefinitions: number;
  references: number;
  definitionKinds: Array<{ kind: string; count: number }>;
  mostReferenced: Array<{ name: string; references: number }>;
  estimate?: CostEstimate;
}

export function buildReport(enginePath: string): SnapshotReport {
  const engine = openEngineDb(enginePath);
  const sql = engine.$client;
  try {
    const snapshot = engine.select().from(snapshots).get();
    if (!snapshot) throw new Error(`No snapshot found in ${enginePath}`);
    const stats = (snapshot.stats ?? {}) as {
      kinds?: Record<string, number>;
      languages?: LanguageStat[];
      docsSources?: DocsSource[];
      estimate?: CostEstimate;
    };

    const all = <T>(query: string) => sql.prepare(query).all() as T[];
    const one = <T>(query: string) => sql.prepare(query).get() as T;

    const topModules = all<ModuleSummary>(`
      SELECT m.path, m.name, m.kind, m.license,
             COUNT(f.id) AS files,
             COALESCE(SUM(CASE WHEN f.kind = 'src' THEN f.tokens END), 0) AS sourceTokens
      FROM module m LEFT JOIN file f ON f.module_id = m.id
      GROUP BY m.id ORDER BY sourceTokens DESC LIMIT 12`);
    const parse = Object.fromEntries(
      all<{ status: string; count: number }>(
        `SELECT parse_status AS status, COUNT(*) AS count FROM file GROUP BY parse_status`,
      ).map((row) => [row.status, row.count]),
    );

    return {
      repo: snapshot.repo,
      ref: snapshot.ref,
      sha: snapshot.sha,
      sizeTier: snapshot.sizeTier,
      sourceTokens: snapshot.sourceTokens ?? 0,
      kinds: stats.kinds ?? {},
      languages: stats.languages ?? [],
      docsSources: stats.docsSources ?? [],
      moduleCount: one<{ count: number }>(`SELECT COUNT(*) AS count FROM module`).count,
      topModules,
      licenses: all(
        `SELECT COALESCE(license, 'none') AS license, COUNT(*) AS modules FROM module GROUP BY 1 ORDER BY 2 DESC`,
      ),
      parse,
      definitions: one<{ count: number }>(`SELECT COUNT(*) AS count FROM symbol`).count,
      exportedDefinitions: one<{ count: number }>(
        `SELECT COUNT(*) AS count FROM symbol WHERE exported = 1`,
      ).count,
      references: one<{ count: number }>(`SELECT COUNT(*) AS count FROM symbol_ref`).count,
      definitionKinds: all(
        `SELECT kind, COUNT(*) AS count FROM symbol GROUP BY kind ORDER BY count DESC LIMIT 8`,
      ),
      mostReferenced: all(`
        SELECT r.name AS name, COUNT(*) AS "references"
        FROM symbol_ref r
        WHERE r.name IN (SELECT name FROM symbol)
        GROUP BY r.name ORDER BY 2 DESC LIMIT 10`),
      ...(stats.estimate ? { estimate: stats.estimate } : {}),
    };
  } finally {
    sql.close();
  }
}
