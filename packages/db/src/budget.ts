import { and, eq, gt, gte, sql, sum } from "drizzle-orm";
import { modelRests, usageCounters } from "./app-schema.ts";
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

export function requestsLastDay(
  db: AppDb,
  provider: string,
  model: string,
  now = new Date(),
): number {
  const since = hourBucket(new Date(now.getTime() - 23 * HOUR_MS));
  const row = db
    .select({ requests: sum(usageCounters.requests) })
    .from(usageCounters)
    .where(
      and(
        eq(usageCounters.provider, provider),
        eq(usageCounters.model, model),
        gte(usageCounters.hour, since),
      ),
    )
    .get();
  return Number(row?.requests ?? 0);
}

export interface ModelRest {
  provider: string;
  model: string;
  until: Date;
}

// A later refusal never shortens a rest that is still running
export function restModel(db: AppDb, rest: ModelRest & { reason: string }, now = new Date()): void {
  const current = restingUntil(db, rest.provider, rest.model, now);
  if (current && current >= rest.until) return;
  db.insert(modelRests)
    .values({ ...rest, updatedAt: now })
    .onConflictDoUpdate({
      target: [modelRests.provider, modelRests.model],
      set: { until: rest.until, reason: rest.reason, updatedAt: now },
    })
    .run();
}

export function restingUntil(
  db: AppDb,
  provider: string,
  model: string,
  now = new Date(),
): Date | undefined {
  const row = db
    .select({ until: modelRests.until })
    .from(modelRests)
    .where(
      and(
        eq(modelRests.provider, provider),
        eq(modelRests.model, model),
        gt(modelRests.until, now),
      ),
    )
    .get();
  return row?.until;
}

// Rests still running, which allowance times and estimates treat as no requests left
export function activeRests(db: AppDb, now = new Date()): ModelRest[] {
  return db
    .select({ provider: modelRests.provider, model: modelRests.model, until: modelRests.until })
    .from(modelRests)
    .where(gt(modelRests.until, now))
    .all();
}

export interface UsageBucket {
  hour: string;
  provider: string;
  model: string;
  requests: number;
  neurons: number;
}

// Usage per model and hour for the rolling day, which decides when each allowance frees up again
export function usageBuckets(db: AppDb, now = new Date()): UsageBucket[] {
  const since = hourBucket(new Date(now.getTime() - 23 * HOUR_MS));
  return db
    .select({
      hour: usageCounters.hour,
      provider: usageCounters.provider,
      model: usageCounters.model,
      requests: usageCounters.requests,
      neurons: usageCounters.neurons,
    })
    .from(usageCounters)
    .where(gte(usageCounters.hour, since))
    .all();
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
