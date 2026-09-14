import {
  ModelUnavailableError,
  type ChatModel,
  type ChatRequest,
  type ChatResult,
  type ModelLimits,
} from "./types.ts";

export interface OpenAiCompatibleOptions {
  id: string;
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  limits: ModelLimits;
  fetch?: typeof fetch;
  retryDelayMs?: number;
  // Longest wait for a short rate limit before giving up on this model
  maxRetryWaitMs?: number;
}

interface CompletionResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

const MAX_TRIES = 4;
const DAILY_LIMIT = /per.?day|daily|RPD/i;

// Reads a Retry-After header or a "retry in 17.5s" hint, in milliseconds
export function retryAfterMs(response: Response, message: string): number | undefined {
  const header = response.headers.get("retry-after");
  if (header && !Number.isNaN(Number(header))) return Number(header) * 1000;
  const match = /retry in ([\d.]+)\s*(ms|s)/i.exec(message);
  if (!match) return undefined;
  return Number(match[1]) * (match[2]!.toLowerCase() === "ms" ? 1 : 1000);
}

export function createOpenAiCompatibleModel(options: OpenAiCompatibleOptions): ChatModel {
  const doFetch = options.fetch ?? fetch;
  const maxRetryWaitMs = options.maxRetryWaitMs ?? 90_000;
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  async function complete(request: ChatRequest): Promise<ChatResult> {
    const body = {
      model: options.model,
      messages: request.messages,
      ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.json ? { response_format: { type: "json_object" } } : {}),
    };
    for (let attempt = 1; ; attempt += 1) {
      const response = await doFetch(`${options.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json().catch(() => ({}))) as
        CompletionResponse | CompletionResponse[];
      const result = Array.isArray(payload) ? payload[0] : payload;
      const text = result?.choices?.[0]?.message?.content;
      if (response.ok && typeof text === "string") {
        return {
          text,
          provider: options.provider,
          model: options.model,
          inputTokens: result?.usage?.prompt_tokens ?? 0,
          outputTokens: result?.usage?.completion_tokens ?? 0,
          cached: false,
        };
      }
      const message = result?.error?.message ?? `HTTP ${response.status}`;
      if (response.status === 429) {
        const wait = retryAfterMs(response, message);
        if (DAILY_LIMIT.test(message) || wait === undefined || wait > maxRetryWaitMs) {
          throw new ModelUnavailableError(`${options.id}: ${message}`);
        }
        if (attempt < MAX_TRIES) {
          await sleep(wait + 250);
          continue;
        }
        throw new ModelUnavailableError(`${options.id}: still rate limited after ${attempt} tries`);
      }
      if (response.status >= 500) {
        if (attempt < MAX_TRIES) {
          await sleep((options.retryDelayMs ?? 2_000) * 2 ** (attempt - 1));
          continue;
        }
        // A provider that stays overloaded is skipped so the next configured model can answer
        throw new ModelUnavailableError(`${options.id} returned ${response.status}: ${message}`);
      }
      throw new Error(`${options.id} returned ${response.status}: ${message}`);
    }
  }

  return {
    id: options.id,
    provider: options.provider,
    model: options.model,
    limits: options.limits,
    complete,
  };
}
