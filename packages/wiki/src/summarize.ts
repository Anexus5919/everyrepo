import { openEngineDb } from "@everyrepo/db";
import type { LlmRouter } from "@everyrepo/llm";
import { buildClusterContext, hashInput, listClusters } from "./cluster-context.ts";
import {
  CLUSTER_PROMPT_VERSION,
  cleanClusterSummary,
  clusterSummaryMessages,
  clusterSummarySchema,
} from "./cluster-summary.ts";

export interface SummarizeInput {
  enginePath: string;
  repo: string;
  router: LlmRouter;
  log: (message: string) => void;
  heartbeat: () => void;
  // About 4 characters per token; keeps each request well inside free per-minute token limits
  maxContextChars?: number;
}

export interface SummarizeOutput {
  clusters: number;
  written: number;
  reused: number;
  inputTokens: number;
  outputTokens: number;
}

const DEFAULT_CONTEXT_CHARS = 48_000;

export async function summarizeClusters(input: SummarizeInput): Promise<SummarizeOutput> {
  const engine = openEngineDb(input.enginePath);
  const sql = engine.$client;
  try {
    const clusters = listClusters(sql);
    const existing = new Map(
      (
        sql
          .prepare("SELECT target, input_hash AS inputHash FROM summary WHERE level = 'cluster'")
          .all() as Array<{ target: string; inputHash: string }>
      ).map((row) => [row.target, row.inputHash]),
    );
    const upsert = sql.prepare(
      `INSERT INTO summary (level, target, prompt_version, input_hash, provider, model, content, input_tokens, output_tokens, created_at)
       VALUES ('cluster', ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (level, target) DO UPDATE SET prompt_version = excluded.prompt_version,
         input_hash = excluded.input_hash, provider = excluded.provider, model = excluded.model,
         content = excluded.content, input_tokens = excluded.input_tokens,
         output_tokens = excluded.output_tokens, created_at = excluded.created_at`,
    );
    const output: SummarizeOutput = {
      clusters: clusters.length,
      written: 0,
      reused: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    for (const cluster of clusters) {
      const context = buildClusterContext(
        sql,
        cluster,
        input.maxContextChars ?? DEFAULT_CONTEXT_CHARS,
      );
      const inputHash = hashInput(CLUSTER_PROMPT_VERSION, context.text);
      if (existing.get(cluster.key) === inputHash) {
        output.reused += 1;
        continue;
      }
      const { value, result } = await input.router.completeJson(
        "summary",
        {
          messages: clusterSummaryMessages(input.repo, context),
          maxTokens: 1_200,
          temperature: 0.2,
        },
        clusterSummarySchema,
        { promptVersion: CLUSTER_PROMPT_VERSION },
      );
      const summary = cleanClusterSummary(value, context.files);
      upsert.run(
        cluster.key,
        CLUSTER_PROMPT_VERSION,
        inputHash,
        result.provider,
        result.model,
        JSON.stringify(summary),
        result.inputTokens,
        result.outputTokens,
        Date.now(),
      );
      output.written += 1;
      output.inputTokens += result.inputTokens;
      output.outputTokens += result.outputTokens;
      input.heartbeat();
      input.log(
        `summarized ${cluster.key}: ${summary.title} (${output.written + output.reused}/${clusters.length})`,
      );
    }
    return output;
  } finally {
    sql.close();
  }
}
