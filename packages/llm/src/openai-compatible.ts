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
  // When the provider's daily quotas start over, for providers that do not say so in the refusal
  dailyResetAt?: (now: number) => number;
  now?: () => number;
}

interface CompletionResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; details?: Array<{ violations?: Array<{ quotaId?: string }> }> };
}

const MAX_TRIES = 4;
const DAILY_LIMIT = /per.?day|daily|RPD/i;
const MINUTE_MS = 60_000;
// A model still refused after every retry rests this long before anything asks it again
const REFUSED_REST_MS = 5 * MINUTE_MS;
// A daily limit with no reset time from the provider is tried again after this long
const UNKNOWN_DAILY_REST_MS = 60 * MINUTE_MS;

// Reads a Retry-After header, or a hint such as "retry in 17.5s" or "try again in 7m26.5s", in milliseconds
export function retryAfterMs(response: Response, message: string): number | undefined {
  const header = response.headers.get("retry-after");
  if (header && !Number.isNaN(Number(header))) return Number(header) * 1000;
  const match = /(?:retry|try again) in ((?:\d+h)?(?:\d+m(?!s))?(?:[\d.]+(?:ms|s))?)/i.exec(
    message,
  );
  if (!match?.[1]) return undefined;
  let total = 0;
  for (const [, amount, unit] of match[1].matchAll(/([\d.]+)(ms|h|m|s)/gi)) {
    total +=
      Number(amount) * { ms: 1, s: 1_000, m: MINUTE_MS, h: 60 * MINUTE_MS }[unit!.toLowerCase()]!;
  }
  return total;
}

// Quota names a provider lists with a refusal, such as GenerateRequestsPerDayPerProjectPerModel-FreeTier
function refusedQuotas(result: CompletionResponse | undefined): string[] {
  return (result?.error?.details ?? []).flatMap((detail) =>
    (detail.violations ?? []).map((violation) => violation.quotaId ?? ""),
  );
}

// The next midnight in a time zone, which is when some providers start their daily quotas over
export function nextMidnightIn(timeZone: string, now: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(now));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((item) => item.type === type)?.value ?? 0);
  const year = part("year");
  const month = part("month") - 1;
  const day = part("day");
  const wall = Date.UTC(year, month, day, part("hour"), part("minute"), part("second"));
  const offset = wall - Math.floor(now / 1000) * 1000;
  return Date.UTC(year, month, day + 1) - offset;
}

const firstLine = (message: string) => message.split("\n")[0]!.trim();

export function createOpenAiCompatibleModel(options: OpenAiCompatibleOptions): ChatModel {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
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
        const unavailable = (reason: string, restMs: number | undefined, until?: number) =>
          new ModelUnavailableError(
            `${options.id}: ${reason}`,
            undefined,
            new Date(until ?? now() + (restMs ?? MINUTE_MS)),
          );
        // A used-up daily quota can still come with a short retry hint, which retrying would only waste
        const daily =
          DAILY_LIMIT.test(message) || refusedQuotas(result).some((quota) => /PerDay/i.test(quota));
        if (daily) {
          const reset = options.dailyResetAt?.(now());
          throw unavailable(
            `daily quota used up at the provider (${firstLine(message)})`,
            reset === undefined ? (wait ?? UNKNOWN_DAILY_REST_MS) : undefined,
            reset,
          );
        }
        if (wait === undefined || wait > maxRetryWaitMs)
          throw unavailable(firstLine(message), wait);
        if (attempt < MAX_TRIES) {
          await sleep(wait + 250);
          continue;
        }
        throw unavailable(`still rate limited after ${attempt} tries`, REFUSED_REST_MS);
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
