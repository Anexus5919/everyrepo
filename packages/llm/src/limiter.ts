import {
  ModelUnavailableError,
  type ChatModel,
  type ChatRequest,
  type ChatResult,
} from "./types.ts";

export interface UsageLedger {
  // Requests to this model over the past 24 hours, including earlier runs
  requestsLastDay(provider: string, model: string): number;
  record(result: ChatResult): void;
  // Until when a provider refused this model, shared across runs so no run asks a refused model again
  restingUntil(provider: string, model: string): Date | undefined;
  rest(provider: string, model: string, until: Date, reason: string): void;
}

const MINUTE_MS = 60_000;

// Rough count used only for pacing; providers report the real numbers afterwards
export function estimateTokens(request: ChatRequest): number {
  const chars = request.messages.reduce((sum, message) => sum + message.content.length, 0);
  return Math.ceil(chars / 3.5) + (request.maxTokens ?? 1_000);
}

// Paces calls under per-minute limits and refuses calls past the daily request limit
export function withLimits(
  model: ChatModel,
  ledger: UsageLedger,
  now: () => number = Date.now,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): ChatModel {
  const window: Array<{ at: number; tokens: number }> = [];
  let queue: Promise<void> = Promise.resolve();

  async function waitForRoom(tokens: number): Promise<void> {
    if (tokens > model.limits.tokensPerMinute) {
      throw new ModelUnavailableError(
        `${model.id}: a request of about ${tokens} tokens exceeds ${model.limits.tokensPerMinute} tokens per minute`,
      );
    }
    for (;;) {
      const cutoff = now() - MINUTE_MS;
      while (window.length > 0 && window[0]!.at <= cutoff) window.shift();
      const used = window.reduce((sum, entry) => sum + entry.tokens, 0);
      if (
        window.length < model.limits.requestsPerMinute &&
        used + tokens <= model.limits.tokensPerMinute
      ) {
        window.push({ at: now(), tokens });
        return;
      }
      await sleep(Math.max(250, window[0]!.at + MINUTE_MS - now()));
    }
  }

  return {
    ...model,
    async complete(request) {
      const resting = ledger.restingUntil(model.provider, model.model);
      if (resting && resting.getTime() > now()) {
        throw new ModelUnavailableError(
          `${model.id}: resting until ${resting.toISOString()} after the provider refused it`,
          undefined,
          resting,
        );
      }
      if (ledger.requestsLastDay(model.provider, model.model) >= model.limits.requestsPerDay) {
        throw new ModelUnavailableError(`${model.id}: daily request limit reached`);
      }
      const tokens = estimateTokens(request);
      // Calls to one model are admitted in order so pacing stays predictable
      const turn = queue.then(() => waitForRoom(tokens));
      queue = turn.catch(() => {});
      await turn;
      let result: ChatResult;
      try {
        result = await model.complete(request);
      } catch (error) {
        if (error instanceof ModelUnavailableError && error.until) {
          ledger.rest(model.provider, model.model, error.until, error.message);
        }
        throw error;
      }
      ledger.record(result);
      return result;
    },
  };
}
