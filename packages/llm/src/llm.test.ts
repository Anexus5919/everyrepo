import { describe, expect, it } from "vitest";
import { z } from "zod";
import { estimateTokens, withLimits, type UsageLedger } from "./limiter.ts";
import { createOpenAiCompatibleModel, retryAfterMs } from "./openai-compatible.ts";
import { LlmRouter, parseJson, type ResponseCache } from "./router.ts";
import { ModelUnavailableError, type ChatModel, type ChatResult } from "./types.ts";

const limits = { requestsPerMinute: 2, tokensPerMinute: 10_000, requestsPerDay: 100 };

function reply(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

function scripted(responses: Response[]) {
  const bodies: unknown[] = [];
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body));
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    return next;
  }) as unknown as typeof fetch;
  return { fetchImpl, bodies };
}

const ok = (text: string) =>
  reply(200, {
    choices: [{ message: { content: text } }],
    usage: { prompt_tokens: 5, completion_tokens: 2 },
  });

function model(fetchImpl: typeof fetch) {
  return createOpenAiCompatibleModel({
    id: "test",
    provider: "gemini",
    model: "m",
    baseUrl: "https://example.test",
    apiKey: "key",
    limits,
    fetch: fetchImpl,
    retryDelayMs: 1,
  });
}

describe("OpenAI-compatible model", () => {
  it("returns text and usage and asks for JSON when requested", async () => {
    const { fetchImpl, bodies } = scripted([ok("{}")]);
    const result = await model(fetchImpl).complete({
      messages: [{ role: "user", content: "hi" }],
      json: true,
      maxTokens: 50,
    });
    expect(result).toMatchObject({ text: "{}", inputTokens: 5, outputTokens: 2, cached: false });
    expect(bodies[0]).toMatchObject({
      model: "m",
      max_tokens: 50,
      response_format: { type: "json_object" },
    });
  });

  it("waits out short rate limits, retries server errors and gives up on daily limits", async () => {
    const { fetchImpl } = scripted([
      reply(429, { error: { message: "Please retry in 1ms." } }),
      reply(503, { error: { message: "overloaded" } }),
      ok("done"),
      reply(429, { error: { message: "Quota exceeded for requests per day" } }),
    ]);
    const client = model(fetchImpl);
    expect((await client.complete({ messages: [{ role: "user", content: "a" }] })).text).toBe(
      "done",
    );
    await expect(
      client.complete({ messages: [{ role: "user", content: "b" }] }),
    ).rejects.toBeInstanceOf(ModelUnavailableError);
  });

  it("reports a provider that stays overloaded as unavailable", async () => {
    const overloaded = () => reply(503, { error: { message: "high demand" } });
    const { fetchImpl } = scripted([overloaded(), overloaded(), overloaded(), overloaded()]);
    await expect(
      model(fetchImpl).complete({ messages: [{ role: "user", content: "a" }] }),
    ).rejects.toBeInstanceOf(ModelUnavailableError);
  });

  it("reads retry hints from headers and messages", () => {
    expect(retryAfterMs(new Response(null, { headers: { "retry-after": "3" } }), "")).toBe(3000);
    expect(retryAfterMs(new Response(null), "Please retry in 17.5s.")).toBe(17_500);
    expect(retryAfterMs(new Response(null), "slow down")).toBeUndefined();
  });
});

function fakeModel(id: string, answers: Array<string | Error>): ChatModel & { calls: number } {
  const state = {
    id,
    provider: "groq",
    model: id,
    limits,
    calls: 0,
    complete: async () => {
      state.calls += 1;
      const next = answers.shift();
      if (next instanceof Error) throw next;
      const result: ChatResult = {
        text: next ?? "",
        provider: "groq",
        model: id,
        inputTokens: 1,
        outputTokens: 1,
        cached: false,
      };
      return result;
    },
  };
  return state;
}

describe("limits", () => {
  it("paces requests per minute and refuses past the daily limit", async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const recorded: ChatResult[] = [];
    let dayCount = 0;
    const ledger: UsageLedger = {
      requestsLastDay: () => dayCount,
      record: (result) => {
        recorded.push(result);
        dayCount += 1;
      },
    };
    const limited = withLimits(
      fakeModel("a", ["1", "2", "3"]),
      ledger,
      () => clock,
      async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    );
    const request = { messages: [{ role: "user" as const, content: "x" }], maxTokens: 10 };
    for (let index = 0; index < 3; index += 1) await limited.complete(request);
    expect(recorded).toHaveLength(3);
    expect(sleeps).toEqual([60_000]);

    dayCount = 100;
    await expect(limited.complete(request)).rejects.toBeInstanceOf(ModelUnavailableError);
    expect(
      estimateTokens({ messages: [{ role: "user", content: "x".repeat(70) }], maxTokens: 5 }),
    ).toBe(25);
  });
});

describe("router", () => {
  it("falls back to the next model, caches answers and repairs invalid JSON once", async () => {
    const store = new Map<string, ChatResult>();
    const cache: ResponseCache = {
      get: (key) => store.get(key),
      set: (key, value) => store.set(key, value),
    };
    const exhausted = fakeModel(
      "first",
      Array.from({ length: 4 }, () => new ModelUnavailableError("out")),
    );
    const backup = fakeModel("second", ["not json", '{"title":"Grid"}']);
    const router = new LlmRouter({ page: [exhausted, backup] }, cache);
    const schema = z.object({ title: z.string() });
    const request = { messages: [{ role: "user" as const, content: "plan" }] };

    const { value, result } = await router.completeJson("page", request, schema, {
      promptVersion: "1",
    });
    expect(value).toEqual({ title: "Grid" });
    expect(result.model).toBe("second");
    expect(backup.calls).toBe(2);

    const again = await router.completeJson("page", request, schema, { promptVersion: "1" });
    expect(again.result.cached).toBe(true);
    expect(backup.calls).toBe(2);
    expect(() => router.models("missing")).toThrow(/No models configured/);
  });

  it("names the task when no model can take it, so a job can wait for that task's allowance", async () => {
    const router = new LlmRouter({
      summary: [fakeModel("only", [new ModelUnavailableError("daily request limit reached")])],
    });
    const request = { messages: [{ role: "user" as const, content: "sum" }] };
    const error = await router
      .complete("summary", request, { promptVersion: "1" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ModelUnavailableError);
    expect((error as ModelUnavailableError).task).toBe("summary");
  });

  it("parses fenced JSON and reports schema problems", () => {
    const schema = z.object({ pages: z.array(z.string()) });
    expect(parseJson('```json\n{"pages":["a"]}\n```', schema)).toEqual({
      ok: true,
      value: { pages: ["a"] },
    });
    expect(parseJson('{"pages":"a"}', schema)).toMatchObject({ ok: false });
  });
});
