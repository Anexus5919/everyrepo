import type { EmbeddingsConfig } from "@everyrepo/core";
import type { Embedder } from "./embedder.ts";
import { createLocalEmbedder, ensureLocalServer, type LocalServer } from "./local.ts";
import { createWorkersAiEmbedder, type EmbeddingUsage } from "./workers-ai.ts";

export interface ConfiguredEmbedder {
  embedder: Embedder;
  provider: string;
  server: LocalServer;
}

export interface EmbedderHooks {
  env?: NodeJS.ProcessEnv;
  onUsage?: (usage: EmbeddingUsage) => void;
  // Neurons used over the past 24 hours, for providers with a rolling daily allowance
  neuronsUsedLastDay?: () => number;
}

const noServer: LocalServer = { started: false, stop: () => {} };

export async function openConfiguredEmbedder(
  config: EmbeddingsConfig | undefined,
  hooks: EmbedderHooks = {},
): Promise<ConfiguredEmbedder | undefined> {
  if (!config) return undefined;
  if (config.provider === "workers-ai") {
    const env = hooks.env ?? process.env;
    const accountId = env["CLOUDFLARE_ACCOUNT_ID"];
    const apiToken = env["CLOUDFLARE_API_TOKEN"];
    if (!accountId || !apiToken) {
      throw new Error(
        "Workers AI embeddings need CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in .env",
      );
    }
    const { neuronsUsedLastDay } = hooks;
    const embedder = createWorkersAiEmbedder({
      accountId,
      apiToken,
      model: config.model,
      dimensions: config.dimensions,
      batchSize: config.batchSize,
      concurrency: config.concurrency,
      ...(hooks.onUsage ? { onUsage: hooks.onUsage } : {}),
      ...(neuronsUsedLastDay
        ? { canSpend: () => neuronsUsedLastDay() < config.dailyNeuronBudget }
        : {}),
    });
    return { embedder, provider: config.provider, server: noServer };
  }
  const server = await ensureLocalServer(config.baseUrl, config.command);
  const embedder = createLocalEmbedder({
    baseUrl: config.baseUrl,
    model: config.model,
    dimensions: config.dimensions,
    batchSize: config.batchSize,
  });
  return { embedder, provider: config.provider, server };
}
