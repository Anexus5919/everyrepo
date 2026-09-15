import { and, eq, lt, sql } from "drizzle-orm";
import { githubCache, rateLimits } from "./app-schema.ts";
import type { AppDb } from "./open.ts";

export interface RateDecision {
  allowed: boolean;
  remaining: number;
  // Time until the current window ends, for a Retry-After header
  retryAfterMs: number;
}

// Counts one call against a fixed window; earlier windows of the same key are removed as it goes
export function hitRateLimit(
  db: AppDb,
  key: string,
  limit: number,
  windowMs: number,
  now = Date.now(),
): RateDecision {
  const windowStart = Math.floor(now / windowMs) * windowMs;
  return db.transaction((tx) => {
    tx.delete(rateLimits)
      .where(and(eq(rateLimits.key, key), lt(rateLimits.windowStart, windowStart)))
      .run();
    const row = tx
      .insert(rateLimits)
      .values({ key, windowStart, count: 1 })
      .onConflictDoUpdate({
        target: [rateLimits.key, rateLimits.windowStart],
        set: { count: sql`${rateLimits.count} + 1` },
      })
      .returning()
      .get();
    return {
      allowed: row.count <= limit,
      remaining: Math.max(0, limit - row.count),
      retryAfterMs: windowStart + windowMs - now,
    };
  });
}

// Windows older than the longest one in use carry no information
export function pruneRateLimits(db: AppDb, olderThanMs: number, now = Date.now()): void {
  db.delete(rateLimits)
    .where(lt(rateLimits.windowStart, now - olderThanMs))
    .run();
}

export interface GithubCacheEntry {
  etag: string | null;
  payload: unknown;
  fetchedAt: number;
}

export interface GithubCacheStore {
  get(key: string): GithubCacheEntry | undefined;
  set(key: string, entry: GithubCacheEntry): void;
}

export function createGithubCacheStore(db: AppDb): GithubCacheStore {
  return {
    get(key) {
      const row = db.select().from(githubCache).where(eq(githubCache.key, key)).get();
      return row
        ? { etag: row.etag, payload: row.payload, fetchedAt: row.fetchedAt.getTime() }
        : undefined;
    },
    set(key, entry) {
      const values = {
        etag: entry.etag,
        payload: entry.payload,
        fetchedAt: new Date(entry.fetchedAt),
      };
      db.insert(githubCache)
        .values({ key, ...values })
        .onConflictDoUpdate({ target: githubCache.key, set: values })
        .run();
    },
  };
}
