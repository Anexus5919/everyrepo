import { describe, expect, it } from "vitest";
import { hourBucket, neuronsUsedLastDay, recordUsage } from "./budget.ts";
import { openAppDb } from "./open.ts";

describe("usage ledger", () => {
  it("sums neurons across models over a rolling day of hourly buckets", () => {
    const db = openAppDb(":memory:");
    const at = (iso: string) => new Date(iso);
    const usage = { provider: "workers-ai", tokens: 100 };
    recordUsage(db, { ...usage, model: "a", neurons: 5 }, at("2026-09-13T06:30:00Z"));
    recordUsage(db, { ...usage, model: "a", neurons: 10 }, at("2026-09-13T23:10:00Z"));
    recordUsage(db, { ...usage, model: "a", neurons: 1 }, at("2026-09-13T23:50:00Z"));
    recordUsage(db, { ...usage, model: "b", neurons: 2 }, at("2026-09-14T07:00:00Z"));
    recordUsage(
      db,
      { provider: "other", model: "a", tokens: 1, neurons: 99 },
      at("2026-09-14T07:00:00Z"),
    );

    expect(hourBucket(at("2026-09-14T07:59:59Z"))).toBe("2026-09-14T07");
    expect(neuronsUsedLastDay(db, "workers-ai", at("2026-09-14T07:15:00Z"))).toBe(13);
    expect(neuronsUsedLastDay(db, "workers-ai", at("2026-09-15T00:05:00Z"))).toBe(2);
    const row = db.$client
      .prepare("SELECT requests, tokens FROM usage_counter WHERE hour = '2026-09-13T23'")
      .get();
    expect(row).toEqual({ requests: 2, tokens: 200 });
  });
});
