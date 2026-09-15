import type { BuilderStatus } from "@everyrepo/core";
import { desc, eq, workers, type AppDb } from "@everyrepo/db";

// A worker reports in every 15 seconds, so a minute and a half of silence means it stopped
export const WORKER_STALE_MS = 90_000;

export function touchWorker(db: AppDb, id: string, jobId: number | null, now = new Date()): void {
  db.insert(workers)
    .values({ id, startedAt: now, heartbeatAt: now, jobId })
    .onConflictDoUpdate({ target: workers.id, set: { heartbeatAt: now, jobId } })
    .run();
}

export function removeWorker(db: AppDb, id: string): void {
  db.delete(workers).where(eq(workers.id, id)).run();
}

export function builderStatus(
  db: AppDb,
  now = new Date(),
  staleMs = WORKER_STALE_MS,
): BuilderStatus {
  const latest = db.select().from(workers).orderBy(desc(workers.heartbeatAt)).get();
  return {
    online: latest !== undefined && now.getTime() - latest.heartbeatAt.getTime() <= staleMs,
    lastSeenAt: latest ? latest.heartbeatAt.toISOString() : null,
  };
}
