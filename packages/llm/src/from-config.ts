import type { LlmConfig } from "@everyrepo/core";
import { withLimits, type UsageLedger } from "./limiter.ts";
import { createOpenAiCompatibleModel } from "./openai-compatible.ts";
import { LlmRouter, type ResponseCache } from "./router.ts";
import type { ChatModel } from "./types.ts";

interface ProviderEndpoint {
  baseUrl: (env: NodeJS.ProcessEnv) => string;
  keyVariable: string;
}

const PROVIDERS: Record<LlmConfig["models"][string]["provider"], ProviderEndpoint> = {
  gemini: {
    baseUrl: () => "https://generativelanguage.googleapis.com/v1beta/openai",
    keyVariable: "GEMINI_API_KEY",
  },
  groq: {
    baseUrl: () => "https://api.groq.com/openai/v1",
    keyVariable: "GROQ_API_KEY",
  },
  "workers-ai": {
    baseUrl: (env) =>
      `https://api.cloudflare.com/client/v4/accounts/${env["CLOUDFLARE_ACCOUNT_ID"] ?? ""}/ai/v1`,
    keyVariable: "CLOUDFLARE_API_TOKEN",
  },
};

export interface RouterDependencies {
  ledger: UsageLedger;
  cache?: ResponseCache;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
}

export function createRouterFromConfig(config: LlmConfig, deps: RouterDependencies): LlmRouter {
  const env = deps.env ?? process.env;
  const models = new Map<string, ChatModel>();
  const modelFor = (id: string): ChatModel => {
    const existing = models.get(id);
    if (existing) return existing;
    const settings = config.models[id];
    if (!settings) throw new Error(`Task refers to unknown model "${id}"`);
    const endpoint = PROVIDERS[settings.provider];
    const apiKey = env[endpoint.keyVariable];
    if (!apiKey) throw new Error(`Model "${id}" needs ${endpoint.keyVariable} in .env`);
    const model = withLimits(
      createOpenAiCompatibleModel({
        id,
        provider: settings.provider,
        model: settings.model,
        baseUrl: endpoint.baseUrl(env),
        apiKey,
        limits: {
          requestsPerMinute: settings.requestsPerMinute,
          tokensPerMinute: settings.tokensPerMinute,
          requestsPerDay: settings.requestsPerDay,
        },
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
      }),
      deps.ledger,
    );
    models.set(id, model);
    return model;
  };
  const tasks = Object.fromEntries(
    Object.entries(config.tasks).map(([task, ids]) => [task, ids.map(modelFor)]),
  );
  return new LlmRouter(tasks, deps.cache);
}
