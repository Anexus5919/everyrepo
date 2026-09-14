import { QUERY_INSTRUCTION, type Embedder, type EmbedPurpose } from "./embedder.ts";
import { normalize } from "./vector.ts";

export const WORKERS_AI_PROVIDER = "workers-ai";
export const WORKERS_AI_MAX_BATCH = 32;

// The allowance is used up; work can resume once past usage ages out
export class EmbeddingBudgetError extends Error {
  override readonly name = "EmbeddingBudgetError";
}

export interface EmbeddingUsage {
  tokens: number;
  neurons: number;
}

export interface WorkersAiEmbedderOptions {
  accountId: string;
  apiToken: string;
  model: string;
  dimensions: number;
  batchSize: number;
  concurrency?: number;
  onUsage?: (usage: EmbeddingUsage) => void;
  // Checked before every request; returning false stops with EmbeddingBudgetError
  canSpend?: () => boolean;
  fetch?: typeof fetch;
  retryDelayMs?: number;
}

interface RunResponse {
  success: boolean;
  errors?: Array<{ code: number; message: string }>;
  result?: {
    data: number[][];
    usage?: { prompt_tokens?: number; neurons?: number };
  };
}

const QUOTA_ERROR_CODE = 4006;
const MAX_TRIES = 4;

export function createWorkersAiEmbedder(options: WorkersAiEmbedderOptions): Embedder {
  const doFetch = options.fetch ?? fetch;
  const batchSize = Math.min(options.batchSize, WORKERS_AI_MAX_BATCH);
  const url = `https://api.cloudflare.com/client/v4/accounts/${options.accountId}/ai/run/${options.model}`;

  async function run(body: object): Promise<number[][]> {
    for (let attempt = 1; ; attempt += 1) {
      if (options.canSpend && !options.canSpend()) {
        throw new EmbeddingBudgetError("the embedding budget for the past 24 hours is used up");
      }
      const response = await doFetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.apiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      const payload = (await response.json().catch(() => ({ success: false }))) as RunResponse;
      if (response.ok && payload.success && payload.result) {
        const usage = payload.result.usage;
        options.onUsage?.({ tokens: usage?.prompt_tokens ?? 0, neurons: usage?.neurons ?? 0 });
        return payload.result.data;
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
  }

  return {
    model: options.model,
    dimensions: options.dimensions,
    batchSize,
    concurrency: options.concurrency ?? 4,
    async embed(texts: readonly string[], purpose: EmbedPurpose) {
      const vectors: Float32Array[] = [];
      for (let start = 0; start < texts.length; start += batchSize) {
        const slice = texts.slice(start, start + batchSize);
        const body =
          purpose === "query"
            ? { queries: slice, instruction: QUERY_INSTRUCTION }
            : { documents: slice };
        const data = await run(body);
        if (data.length !== slice.length) {
          throw new Error(`Workers AI returned ${data.length} vectors for ${slice.length} inputs`);
        }
        for (const vector of data) {
          vectors.push(normalize(Float32Array.from(vector), options.dimensions));
        }
      }
      return vectors;
    },
  };
}
