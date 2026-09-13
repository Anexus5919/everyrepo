import { and, eq, sql, sum } from "drizzle-orm";
import { budgetCounters } from "./app-schema.ts";
import type { AppDb } from "./open.ts";

export interface UsageRecord {
  provider: string;
  model: string;
  tokens: number;
  neurons: number;
}

export function utcDay(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function recordUsage(db: AppDb, usage: UsageRecord, day = utcDay()): void {
  db.insert(budgetCounters)
    .values({ day, ...usage, requests: 1 })
    .onConflictDoUpdate({
      target: [budgetCounters.day, budgetCounters.provider, budgetCounters.model],
      set: {
        requests: sql`${budgetCounters.requests} + 1`,
        tokens: sql`${budgetCounters.tokens} + ${usage.tokens}`,
        neurons: sql`${budgetCounters.neurons} + ${usage.neurons}`,
      },
    })
    .run();
}

// Free allowances are per account, so usage adds up across models
export function neuronsUsed(db: AppDb, provider: string, day = utcDay()): number {
  const row = db
    .select({ neurons: sum(budgetCounters.neurons) })
    .from(budgetCounters)
    .where(and(eq(budgetCounters.day, day), eq(budgetCounters.provider, provider)))
    .get();
  return Number(row?.neurons ?? 0);
}
