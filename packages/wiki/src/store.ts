import type { EngineDb } from "@everyrepo/db";

type Sql = EngineDb["$client"];

export type SummaryLevel = "cluster" | "module" | "repo";

export interface StoredSummary<T> {
  target: string;
  inputHash: string;
  content: T;
}

export interface SummaryWrite {
  level: SummaryLevel;
  target: string;
  promptVersion: string;
  inputHash: string;
  provider: string;
  model: string;
  content: unknown;
  inputTokens: number;
  outputTokens: number;
}

export function loadSummaries<T>(sql: Sql, level: SummaryLevel): Map<string, StoredSummary<T>> {
  const rows = sql
    .prepare("SELECT target, input_hash AS inputHash, content FROM summary WHERE level = ?")
    .all(level) as Array<{ target: string; inputHash: string; content: string }>;
  return new Map(
    rows.map((row) => [
      row.target,
      { target: row.target, inputHash: row.inputHash, content: JSON.parse(row.content) as T },
    ]),
  );
}

export function saveSummary(sql: Sql, summary: SummaryWrite): void {
  sql
    .prepare(
      `INSERT INTO summary (level, target, prompt_version, input_hash, provider, model, content, input_tokens, output_tokens, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (level, target) DO UPDATE SET prompt_version = excluded.prompt_version,
         input_hash = excluded.input_hash, provider = excluded.provider, model = excluded.model,
         content = excluded.content, input_tokens = excluded.input_tokens,
         output_tokens = excluded.output_tokens, created_at = excluded.created_at`,
    )
    .run(
      summary.level,
      summary.target,
      summary.promptVersion,
      summary.inputHash,
      summary.provider,
      summary.model,
      JSON.stringify(summary.content),
      summary.inputTokens,
      summary.outputTokens,
      Date.now(),
    );
}

// Removes summaries for clusters or modules that no longer exist in the snapshot
export function pruneSummaries(sql: Sql, level: SummaryLevel, keep: ReadonlySet<string>): number {
  const stale = [...loadSummaries(sql, level).keys()].filter((target) => !keep.has(target));
  const remove = sql.prepare("DELETE FROM summary WHERE level = ? AND target = ?");
  for (const target of stale) remove.run(level, target);
  return stale.length;
}
