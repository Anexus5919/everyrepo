import { EmbeddingBudgetError, type EmbeddingUsage } from "./workers-ai.ts";

export const WORKERS_AI_RERANK_MODEL = "@cf/baai/bge-reranker-base";
// The model reads about 512 tokens per query and passage pair, so longer passages are cut
const MAX_CONTEXT_CHARS = 1_600;
const MAX_TRIES = 4;
const QUOTA_ERROR_CODE = 4006;

export interface Reranker {
  model: string;
  // Relevance scores in the order of the given passages
  rerank(query: string, passages: readonly string[]): Promise<number[]>;
}

export interface WorkersAiRerankerOptions {
  accountId: string;
  apiToken: string;
  model?: string;
  onUsage?: (usage: EmbeddingUsage) => void;
  canSpend?: () => boolean;
  fetch?: typeof fetch;
  retryDelayMs?: number;
}

interface RerankResponse {
  success: boolean;
  errors?: Array<{ code: number; message: string }>;
  result?: {
    response: Array<{ id: number; score: number }>;
    usage?: { prompt_tokens?: number; neurons?: number };
  };
}

export function createWorkersAiReranker(options: WorkersAiRerankerOptions): Reranker {
  const doFetch = options.fetch ?? fetch;
  const model = options.model ?? WORKERS_AI_RERANK_MODEL;
  const url = `https://api.cloudflare.com/client/v4/accounts/${options.accountId}/ai/run/${model}`;

  return {
    model,
    async rerank(query, passages) {
      if (passages.length === 0) return [];
      const body = {
        query,
        contexts: passages.map((text) => ({ text: text.slice(0, MAX_CONTEXT_CHARS) })),
        top_k: passages.length,
      };
      for (let attempt = 1; ; attempt += 1) {
        if (options.canSpend && !options.canSpend()) {
          throw new EmbeddingBudgetError("the Workers AI budget for the past 24 hours is used up");
        }
        const response = await doFetch(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.apiToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        });
        const payload = (await response.json().catch(() => ({ success: false }))) as RerankResponse;
        if (response.ok && payload.success && payload.result) {
          const usage = payload.result.usage;
          options.onUsage?.({ tokens: usage?.prompt_tokens ?? 0, neurons: usage?.neurons ?? 0 });
          const scores = new Array<number>(passages.length).fill(Number.NEGATIVE_INFINITY);
          for (const item of payload.result.response) {
            if (item.id >= 0 && item.id < scores.length) scores[item.id] = item.score;
          }
          return scores;
        }
        const errors = payload.errors ?? [];
        const message = errors.map((error) => `${error.code} ${error.message}`).join("; ");
        if (errors.some((error) => error.code === QUOTA_ERROR_CODE) || /neurons/i.test(message)) {
          throw new EmbeddingBudgetError(`Workers AI allowance reached: ${message}`);
        }
        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable || attempt >= MAX_TRIES) {
          throw new Error(`Workers AI returned ${response.status}: ${message || "no details"}`);
        }
        const delay = (options.retryDelayMs ?? 1_000) * 2 ** (attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    },
  };
}
