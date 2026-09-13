import { describe, expect, it } from "vitest";
import { QUERY_INSTRUCTION } from "./embedder.ts";
import { createWorkersAiEmbedder, EmbeddingBudgetError } from "./workers-ai.ts";

type Reply = { status: number; body: unknown };

function fakeFetch(replies: Array<Reply | ((body: Record<string, string[]>) => Reply)>) {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Record<string, string[]>;
    bodies.push(body);
    const next = replies.shift();
    if (!next) throw new Error("unexpected request");
    const reply = typeof next === "function" ? next(body) : next;
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  }) as unknown as typeof fetch;
  return { fetchImpl, bodies };
}

const vectors = (body: Record<string, string[]>) => {
  const texts = body["documents"] ?? body["queries"] ?? [];
  return {
    status: 200,
    body: {
      success: true,
      result: { data: texts.map(() => [3, 4]), usage: { prompt_tokens: 10, neurons: 0.5 } },
    },
  };
};

function embedder(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) {
  return createWorkersAiEmbedder({
    accountId: "acct",
    apiToken: "token",
    model: "@cf/qwen/qwen3-embedding-0.6b",
    dimensions: 2,
    batchSize: 64,
    fetch: fetchImpl,
    retryDelayMs: 1,
    ...extra,
  });
}

describe("Workers AI embedder", () => {
  it("sends documents in batches of 32 and queries with the instruction", async () => {
    const { fetchImpl, bodies } = fakeFetch([vectors, vectors, vectors]);
    const usage: number[] = [];
    const client = embedder(fetchImpl, {
      onUsage: (u: { neurons: number }) => usage.push(u.neurons),
    });
    const documents = await client.embed(
      Array.from({ length: 40 }, (_, i) => `doc ${i}`),
      "document",
    );
    expect(documents).toHaveLength(40);
    expect(Array.from(documents[0]!)).toEqual([expect.closeTo(0.6), expect.closeTo(0.8)]);
    expect((bodies[0]!["documents"] as string[]).length).toBe(32);
    expect((bodies[1]!["documents"] as string[]).length).toBe(8);
    await client.embed(["where is auth"], "query");
    expect(bodies[2]).toEqual({ queries: ["where is auth"], instruction: QUERY_INSTRUCTION });
    expect(usage).toEqual([0.5, 0.5, 0.5]);
  });

  it("retries rate limits and stops on a used-up allowance", async () => {
    const quota = {
      status: 429,
      body: { success: false, errors: [{ code: 4006, message: "daily free allocation used" }] },
    };
    const { fetchImpl } = fakeFetch([{ status: 429, body: { success: false } }, vectors, quota]);
    const client = embedder(fetchImpl);
    expect(await client.embed(["a"], "document")).toHaveLength(1);
    await expect(client.embed(["b"], "document")).rejects.toBeInstanceOf(EmbeddingBudgetError);
  });

  it("checks the local budget before spending", async () => {
    const { fetchImpl, bodies } = fakeFetch([]);
    const client = embedder(fetchImpl, { canSpend: () => false });
    await expect(client.embed(["a"], "document")).rejects.toBeInstanceOf(EmbeddingBudgetError);
    expect(bodies).toHaveLength(0);
  });
});
