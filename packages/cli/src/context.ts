import { loadLocalConfig, type LocalConfig } from "@everyrepo/core";
import {
  appDbPath,
  LlmCache,
  llmCachePath,
  neuronsUsedLastDay,
  openAppDb,
  recordUsage,
  requestsLastDay,
  type AppDb,
} from "@everyrepo/db";
import {
  createWorkersAiReranker,
  openConfiguredEmbedder,
  type ConfiguredEmbedder,
  type Reranker,
} from "@everyrepo/embed";
import { createRouterFromConfig, type LlmRouter } from "@everyrepo/llm";

export interface CliContext {
  config: LocalConfig;
  appDb: AppDb;
  close(): void;
}

export async function openContext(): Promise<CliContext> {
  const config = await loadLocalConfig();
  const appDb = openAppDb(appDbPath(config.dataDir));
  return { config, appDb, close: () => appDb.$client.close() };
}

// Usage is recorded per call so the allowance holds across separate runs
export async function openEmbedder(context: CliContext): Promise<ConfiguredEmbedder | undefined> {
  const config = context.config.embeddings;
  if (!config) return undefined;
  const model = config.model;
  return openConfiguredEmbedder(config, {
    onUsage: (usage) => recordUsage(context.appDb, { provider: config.provider, model, ...usage }),
    neuronsUsedLastDay: () => neuronsUsedLastDay(context.appDb, config.provider),
  });
}

// The reranker shares the Workers AI credentials and daily neuron budget with embeddings
export function openReranker(context: CliContext): Reranker {
  const config = context.config.embeddings;
  const accountId = process.env["CLOUDFLARE_ACCOUNT_ID"];
  const apiToken = process.env["CLOUDFLARE_API_TOKEN"];
  if (config?.provider !== "workers-ai" || !accountId || !apiToken) {
    throw new Error("Reranking needs Workers AI embeddings and Cloudflare credentials in .env");
  }
  const budget = config.dailyNeuronBudget;
  const reranker = createWorkersAiReranker({
    accountId,
    apiToken,
    canSpend: () => neuronsUsedLastDay(context.appDb, config.provider) < budget,
    onUsage: (usage) =>
      recordUsage(context.appDb, { provider: config.provider, model: reranker.model, ...usage }),
  });
  return reranker;
}

export interface OpenLlm {
  router: LlmRouter;
  close(): void;
}

// Model calls count against daily limits across runs and identical prompts come from the cache
export function openLlm(context: CliContext): OpenLlm {
  const config = context.config.llm;
  if (!config) throw new Error("Add an llm section to the local config first");
  const cache = new LlmCache(llmCachePath(context.config.dataDir));
  const router = createRouterFromConfig(config, {
    cache,
    ledger: {
      requestsLastDay: (provider, model) => requestsLastDay(context.appDb, provider, model),
      record: (result) =>
        recordUsage(context.appDb, {
          provider: result.provider,
          model: result.model,
          tokens: result.inputTokens + result.outputTokens,
          neurons: 0,
        }),
    },
  });
  return { router, close: () => cache.close() };
}

export function timestamp(): string {
  return new Date().toISOString().slice(11, 19);
}
