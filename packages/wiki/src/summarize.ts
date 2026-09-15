import { openEngineDb, type EngineDb } from "@everyrepo/db";
import type { ChatRequest, LlmRouter } from "@everyrepo/llm";
import type { z } from "zod";
import { buildClusterContext, hashInput, listClusters } from "./cluster-context.ts";
import {
  CLUSTER_PROMPT_VERSION,
  cleanClusterSummary,
  clusterSummaryMessages,
  clusterSummarySchema,
  type ClusterSummary,
} from "./cluster-summary.ts";
import {
  buildModuleContext,
  listModulesWithClusters,
  MODULE_PROMPT_VERSION,
  moduleSummaryMessages,
} from "./module-summary.ts";
import {
  buildRepoContext,
  cleanRepoSummary,
  REPO_PROMPT_VERSION,
  repoSummaryMessages,
  repoSummarySchema,
  type RepoSummary,
} from "./repo-summary.ts";
import { loadSummaries, pruneSummaries, saveSummary, type SummaryLevel } from "./store.ts";

export interface SummarizeInput {
  enginePath: string;
  repo: string;
  router: LlmRouter;
  log: (message: string) => void;
  heartbeat: () => void;
  // Reports work done inside the stage for status pages
  progress?: (done: number, total: number) => void;
  // About 4 characters per token; keeps each request well inside free per-minute token limits
  maxContextChars?: number;
}

export interface LevelCounts {
  total: number;
  written: number;
  reused: number;
}

export interface SummarizeOutput {
  clusters: LevelCounts;
  modules: LevelCounts;
  repo: LevelCounts;
  inputTokens: number;
  outputTokens: number;
}

const DEFAULT_CONTEXT_CHARS = 48_000;
const SINGLE_CLUSTER_VERSION = "module-from-cluster-1";

type Sql = EngineDb["$client"];

interface Generation<T> {
  level: SummaryLevel;
  target: string;
  promptVersion: string;
  text: string;
  request: () => ChatRequest;
  schema: z.ZodType<T>;
  clean: (value: T) => T;
}

export async function summarizeRepository(input: SummarizeInput): Promise<SummarizeOutput> {
  const engine = openEngineDb(input.enginePath);
  const sql = engine.$client;
  const maxChars = input.maxContextChars ?? DEFAULT_CONTEXT_CHARS;
  const output: SummarizeOutput = {
    clusters: { total: 0, written: 0, reused: 0 },
    modules: { total: 0, written: 0, reused: 0 },
    repo: { total: 1, written: 0, reused: 0 },
    inputTokens: 0,
    outputTokens: 0,
  };

  // Generates one summary unless an identical input was summarized before
  async function generate<T>(
    counts: LevelCounts,
    existing: ReadonlyMap<string, { inputHash: string; content: unknown }>,
    job: Generation<T>,
  ): Promise<T> {
    const inputHash = hashInput(job.promptVersion, job.text);
    const previous = existing.get(job.target);
    if (previous?.inputHash === inputHash) {
      counts.reused += 1;
      return previous.content as T;
    }
    const { value, result } = await input.router.completeJson(
      "summary",
      job.request(),
      job.schema,
      { promptVersion: job.promptVersion },
    );
    const content = job.clean(value);
    saveSummary(sql, {
      level: job.level,
      target: job.target,
      promptVersion: job.promptVersion,
      inputHash,
      provider: result.provider,
      model: result.model,
      content,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    });
    counts.written += 1;
    output.inputTokens += result.inputTokens;
    output.outputTokens += result.outputTokens;
    input.heartbeat();
    return content;
  }

  try {
    // Every cluster, every package and the repository itself count as one unit of work
    const total = listClusters(sql).length + listModulesWithClusters(sql).length + 1;
    let finished = 0;
    const step = () => input.progress?.(++finished, total);
    const clusterSummaries = await summarizeClusters(sql, input, maxChars, output, generate, step);
    const moduleSummaries = await summarizeModules(
      sql,
      input,
      maxChars,
      output,
      clusterSummaries,
      generate,
      step,
    );

    const modules = listModulesWithClusters(sql).map(({ module, clusters }) => ({
      module,
      tokenCount: clusters.reduce((sum, cluster) => sum + cluster.tokenCount, 0),
    }));
    const text = buildRepoContext(sql, input.repo, modules, moduleSummaries, maxChars);
    const modulePaths = new Set(modules.map(({ module }) => module.path));
    const repoSummary = await generate<RepoSummary>(output.repo, loadSummaries(sql, "repo"), {
      level: "repo",
      target: "",
      promptVersion: REPO_PROMPT_VERSION,
      text,
      request: () => ({ messages: repoSummaryMessages(text), maxTokens: 2_000, temperature: 0.2 }),
      schema: repoSummarySchema,
      clean: (value: RepoSummary) => cleanRepoSummary(value, modulePaths),
    });
    step();
    input.log(`repository: ${repoSummary.summary}`);
    return output;
  } finally {
    sql.close();
  }
}

type Generate = <T>(
  counts: LevelCounts,
  existing: ReadonlyMap<string, { inputHash: string; content: unknown }>,
  job: Generation<T>,
) => Promise<T>;

async function summarizeClusters(
  sql: Sql,
  input: SummarizeInput,
  maxChars: number,
  output: SummarizeOutput,
  generate: Generate,
  step: () => void,
): Promise<Map<string, ClusterSummary>> {
  const clusters = listClusters(sql);
  output.clusters.total = clusters.length;
  pruneSummaries(sql, "cluster", new Set(clusters.map((cluster) => cluster.key)));
  const existing = loadSummaries<ClusterSummary>(sql, "cluster");
  const summaries = new Map<string, ClusterSummary>();
  for (const cluster of clusters) {
    const context = buildClusterContext(sql, cluster, maxChars);
    const summary = await generate<ClusterSummary>(output.clusters, existing, {
      level: "cluster",
      target: cluster.key,
      promptVersion: CLUSTER_PROMPT_VERSION,
      text: context.text,
      request: () => ({
        messages: clusterSummaryMessages(input.repo, context),
        maxTokens: 1_200,
        temperature: 0.2,
      }),
      schema: clusterSummarySchema,
      clean: (value: ClusterSummary) => cleanClusterSummary(value, context.files),
    });
    summaries.set(cluster.key, summary);
    step();
    const done = output.clusters.written + output.clusters.reused;
    if (done % 10 === 0 || done === clusters.length) {
      input.log(`cluster summaries ${done}/${clusters.length}`);
    }
  }
  return summaries;
}

async function summarizeModules(
  sql: Sql,
  input: SummarizeInput,
  maxChars: number,
  output: SummarizeOutput,
  clusterSummaries: ReadonlyMap<string, ClusterSummary>,
  generate: Generate,
  step: () => void,
): Promise<Map<string, ClusterSummary>> {
  const modules = listModulesWithClusters(sql);
  output.modules.total = modules.length;
  pruneSummaries(sql, "module", new Set(modules.map(({ module }) => module.path)));
  const existing = loadSummaries<ClusterSummary>(sql, "module");
  const summaries = new Map<string, ClusterSummary>();
  for (const { module, clusters } of modules) {
    const keys = clusters.map((cluster) => cluster.key);
    const only = keys.length === 1 ? clusterSummaries.get(keys[0]!) : undefined;
    if (only) {
      // A package with one cluster is described by that cluster; no model call needed
      const inputHash = hashInput(SINGLE_CLUSTER_VERSION, JSON.stringify(only));
      if (existing.get(module.path)?.inputHash === inputHash) {
        output.modules.reused += 1;
      } else {
        saveSummary(sql, {
          level: "module",
          target: module.path,
          promptVersion: SINGLE_CLUSTER_VERSION,
          inputHash,
          provider: "copy",
          model: "",
          content: only,
          inputTokens: 0,
          outputTokens: 0,
        });
        output.modules.written += 1;
      }
      summaries.set(module.path, only);
      step();
      continue;
    }
    const context = buildModuleContext(sql, module, keys, clusterSummaries, maxChars);
    const summary = await generate<ClusterSummary>(output.modules, existing, {
      level: "module",
      target: module.path,
      promptVersion: MODULE_PROMPT_VERSION,
      text: context.text,
      request: () => ({
        messages: moduleSummaryMessages(input.repo, context),
        maxTokens: 1_200,
        temperature: 0.2,
      }),
      schema: clusterSummarySchema,
      clean: (value: ClusterSummary) => cleanClusterSummary(value, context.files),
    });
    summaries.set(module.path, summary);
    step();
  }
  input.log(`module summaries ${modules.length} (${output.modules.written} written)`);
  return summaries;
}
