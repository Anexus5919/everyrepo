import { describe, expect, it } from "vitest";
import {
  activeRests,
  hourBucket,
  neuronsUsedLastDay,
  recordUsage,
  restingUntil,
  restModel,
} from "./budget.ts";
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

describe("model rests", () => {
  it("keeps the longest running rest and forgets rests that are over", () => {
    const db = openAppDb(":memory:");
    const at = (iso: string) => new Date(iso);
    const flash = { provider: "gemini", model: "flash" };
    const now = at("2026-09-16T09:00:00Z");
    restModel(db, { ...flash, until: at("2026-09-17T07:00:00Z"), reason: "daily quota" }, now);
    restModel(db, { ...flash, until: at("2026-09-16T09:05:00Z"), reason: "per minute" }, now);
    expect(restingUntil(db, "gemini", "flash", now)).toEqual(at("2026-09-17T07:00:00Z"));
    expect(activeRests(db, now)).toEqual([{ ...flash, until: at("2026-09-17T07:00:00Z") }]);

    // Once a rest is over, a shorter one replaces it
    const later = at("2026-09-17T08:00:00Z");
    expect(restingUntil(db, "gemini", "flash", later)).toBeUndefined();
    restModel(db, { ...flash, until: at("2026-09-17T08:05:00Z"), reason: "per minute" }, later);
    expect(restingUntil(db, "gemini", "flash", later)).toEqual(at("2026-09-17T08:05:00Z"));
  });
});
