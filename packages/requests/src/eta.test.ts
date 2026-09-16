import { describe, expect, it } from "vitest";
import {
  CapacityLedger,
  modelsFor,
  neuronCapacityAt,
  taskCapacityAt,
  type CapacityConfig,
} from "./capacity.ts";
import { simulateLine, workFromEstimate, type BuildWork } from "./eta.ts";

const config: CapacityConfig = {
  models: [
    {
      id: "lite",
      provider: "gemini",
      model: "lite",
      requestsPerDay: 10,
      requestsPerMinute: 15,
      tokensPerMinute: 250_000,
    },
    {
      id: "flash",
      provider: "gemini",
      model: "flash",
      requestsPerDay: 5,
      requestsPerMinute: 5,
      tokensPerMinute: 250_000,
    },
    {
      id: "groq",
      provider: "groq",
      model: "qwen",
      requestsPerDay: 1_000,
      requestsPerMinute: 30,
      tokensPerMinute: 8_000,
    },
  ],
  tasks: { summary: ["lite", "groq"], plan: ["flash", "lite"], page: ["lite", "flash"] },
  embeddings: { provider: "workers-ai", dailyNeuronBudget: 1_000 },
};

const at = (iso: string) => Date.parse(iso);
const iso = (time: number | undefined) =>
  time === undefined ? undefined : new Date(time).toISOString();

// The lite model used its whole allowance at 02:00, so it frees up at 02:00 the next day
const usedUp = [
  { hour: "2026-09-16T02", provider: "gemini", model: "lite", requests: 10, neurons: 0 },
];

const work = (
  overrides: Omit<Partial<BuildWork>, "calls"> & { calls?: Partial<BuildWork["calls"]> },
): BuildWork => ({
  readingMs: 0,
  embedTokens: 0,
  publishMs: 60_000,
  ...overrides,
  calls: { summary: 0, plan: 0, page: 0, ...overrides.calls },
});

describe("capacity", () => {
  it("counts usage over the same rolling day as the model router", () => {
    const ledger = new CapacityLedger(config, usedUp);
    const lite = config.models[0]!;
    expect(ledger.requestsLeft(lite, at("2026-09-16T08:00:00Z"))).toBe(0);
    expect(ledger.requestsLeft(lite, at("2026-09-17T01:59:59Z"))).toBe(0);
    expect(ledger.requestsLeft(lite, at("2026-09-17T02:00:00Z"))).toBe(10);
  });

  it("only offers models whose per-minute token limit fits the task's calls", () => {
    expect(modelsFor(config, "summary").map((model) => model.id)).toEqual(["lite"]);
    expect(modelsFor(config, "page").map((model) => model.id)).toEqual(["lite", "flash"]);
  });

  it("says when a task can run again", () => {
    const ledger = new CapacityLedger(config, usedUp);
    const now = at("2026-09-16T08:00:00Z");
    expect(iso(taskCapacityAt(ledger, "summary", now))).toBe("2026-09-17T02:00:00.000Z");
    expect(taskCapacityAt(ledger, "plan", now)).toBe(now);
    expect(taskCapacityAt(ledger, "missing", now)).toBeUndefined();

    const neurons = new CapacityLedger(config, [
      { hour: "2026-09-16T05", provider: "workers-ai", model: "embed", requests: 3, neurons: 600 },
      { hour: "2026-09-16T07", provider: "workers-ai", model: "embed", requests: 3, neurons: 400 },
    ]);
    expect(iso(neuronCapacityAt(neurons, now))).toBe("2026-09-17T05:00:00.000Z");
  });

  it("treats a model the provider refused as having nothing left until its rest ends", () => {
    const now = at("2026-09-16T09:00:00Z");
    const ledger = new CapacityLedger(config, usedUp, [
      { provider: "gemini", model: "flash", until: new Date("2026-09-17T07:00:00Z") },
    ]);
    const flash = config.models[1]!;
    expect(ledger.requestsLeft(flash, now)).toBe(0);
    expect(ledger.clone().requestsLeft(flash, at("2026-09-17T07:00:00Z"))).toBe(5);
    // Planning falls back to lite, which frees at 02:00, before flash's rest ends at 07:00
    expect(iso(taskCapacityAt(ledger, "plan", now))).toBe("2026-09-17T02:00:00.000Z");
  });
});

describe("line simulation", () => {
  it("waits for the allowance, then finishes builds in order while later ones read in the meantime", () => {
    const now = at("2026-09-16T08:00:00Z");
    const estimates = simulateLine(
      [
        { id: 1, work: work({ calls: { summary: 3, plan: 1, page: 2 } }), notBefore: now },
        {
          id: 2,
          work: work({ readingMs: 30_000, embedTokens: 500_000, calls: { summary: 2, page: 1 } }),
          notBefore: now,
        },
      ],
      new CapacityLedger(config, usedUp),
      now,
    );
    const first = estimates.get(1)!;
    expect(iso(first.startsAt)).toBe("2026-09-17T02:00:00.000Z");
    // Three summaries and two pages at 8 seconds, one plan at 12 seconds, then a minute to publish
    expect(iso(first.readyAt)).toBe("2026-09-17T02:01:52.000Z");
    expect(iso(first.allowanceWaitUntil ?? undefined)).toBe("2026-09-17T02:00:00.000Z");

    const second = estimates.get(2)!;
    expect(iso(second.startsAt)).toBe("2026-09-16T08:00:00.000Z");
    expect(second.readyAt).toBeGreaterThan(first.readyAt);
    expect(iso(second.readyAt)).toBe("2026-09-17T02:03:16.000Z");
    expect(second.workMs).toBe(30_000 + 125_000 + 24_000 + 60_000);
  });

  it("spreads embeddings over the neuron allowance and respects retry times", () => {
    const now = at("2026-09-16T08:00:00Z");
    const estimates = simulateLine(
      [{ id: 7, work: work({ embedTokens: 1_500_000 }), notBefore: at("2026-09-16T09:00:00Z") }],
      new CapacityLedger(config),
      now,
    );
    const build = estimates.get(7)!;
    expect(iso(build.startsAt)).toBe("2026-09-16T09:00:00.000Z");
    // About 930,000 tokens fit today's 1,000 neurons; the rest waits for them to free up a day later
    expect(iso(build.allowanceWaitUntil ?? undefined)).toBe("2026-09-17T09:00:00.000Z");
    expect(build.readyAt).toBeGreaterThan(at("2026-09-17T09:00:00Z"));
  });

  it("gives no estimate when no configured model can ever take a task", () => {
    const groqOnly: CapacityConfig = { ...config, tasks: { ...config.tasks, summary: ["groq"] } };
    const now = at("2026-09-16T08:00:00Z");
    const estimates = simulateLine(
      [
        { id: 1, work: work({ calls: { summary: 1 } }), notBefore: now },
        { id: 2, work: work({}), notBefore: now },
      ],
      new CapacityLedger(groqOnly),
      now,
    );
    expect(estimates.has(1)).toBe(false);
    expect(estimates.get(2)?.readyAt).toBe(now + 60_000);
  });

  it("sizes unread repositories from their file list", () => {
    expect(
      workFromEstimate({
        files: 101,
        sourceFiles: 49,
        sourceTokens: 44_826,
        sizeTier: "S",
        truncated: false,
        languages: [],
      }),
    ).toEqual({
      readingMs: 20_000 + 44_826 * 0.25,
      embedTokens: 62_756,
      calls: { summary: 7, plan: 2, page: 7 },
      publishMs: 90_000,
    });
  });
});
