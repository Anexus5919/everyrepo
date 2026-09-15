import { describe, expect, it } from "vitest";
import { openAppDb } from "./open.ts";
import { createGithubCacheStore, hitRateLimit, pruneRateLimits } from "./rate-limit.ts";

describe("rate limits", () => {
  it("allows calls up to the limit in each window and says when the window ends", () => {
    const db = openAppDb(":memory:");
    const start = 1_800_000_000_000;
    const hits = [0, 1, 2].map((offset) => hitRateLimit(db, "lookup:a", 2, 60_000, start + offset));
    expect(hits.map((hit) => hit.allowed)).toEqual([true, true, false]);
    expect(hits[2]).toMatchObject({ remaining: 0, retryAfterMs: 60_000 - 2 });

    expect(hitRateLimit(db, "lookup:b", 2, 60_000, start).allowed).toBe(true);
    expect(hitRateLimit(db, "lookup:a", 2, 60_000, start + 60_000).allowed).toBe(true);
    const rows = db.$client.prepare("SELECT COUNT(*) AS count FROM rate_limit").get();
    expect(rows).toEqual({ count: 2 });

    pruneRateLimits(db, 30_000, start + 60_000);
    expect(db.$client.prepare("SELECT key FROM rate_limit").all()).toEqual([{ key: "lookup:a" }]);
  });
});

describe("GitHub cache", () => {
  it("stores and replaces entries with their entity tags", () => {
    const store = createGithubCacheStore(openAppDb(":memory:"));
    expect(store.get("repo:acme/app")).toBeUndefined();
    store.set("repo:acme/app", { etag: 'W/"1"', payload: { stars: 1 }, fetchedAt: 10 });
    store.set("repo:acme/app", { etag: 'W/"2"', payload: { stars: 2 }, fetchedAt: 20 });
    expect(store.get("repo:acme/app")).toEqual({
      etag: 'W/"2"',
      payload: { stars: 2 },
      fetchedAt: 20,
    });
  });
});
