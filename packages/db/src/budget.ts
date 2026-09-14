import { and, eq, gte, sql, sum } from "drizzle-orm";
import { usageCounters } from "./app-schema.ts";
import type { AppDb } from "./open.ts";

export interface UsageRecord {
  provider: string;
  model: string;
  tokens: number;
  neurons: number;
}

const HOUR_MS = 3_600_000;

// UTC hour bucket, for example 2026-09-14T07
export function hourBucket(date = new Date()): string {
  return date.toISOString().slice(0, 13);
}

export function recordUsage(db: AppDb, usage: UsageRecord, at = new Date()): void {
  db.insert(usageCounters)
    .values({ hour: hourBucket(at), ...usage, requests: 1 })
    .onConflictDoUpdate({
      target: [usageCounters.hour, usageCounters.provider, usageCounters.model],
      set: {
        requests: sql`${usageCounters.requests} + 1`,
        tokens: sql`${usageCounters.tokens} + ${usage.tokens}`,
        neurons: sql`${usageCounters.neurons} + ${usage.neurons}`,
      },
    })
    .run();
}

// Neurons across all models in the current hour and the 23 before it; the allowance is per account over a rolling day
export function neuronsUsedLastDay(db: AppDb, provider: string, now = new Date()): number {
  const since = hourBucket(new Date(now.getTime() - 23 * HOUR_MS));
  const row = db
    .select({ neurons: sum(usageCounters.neurons) })
    .from(usageCounters)
    .where(and(eq(usageCounters.provider, provider), gte(usageCounters.hour, since)))
    .get();
  return Number(row?.neurons ?? 0);
}
