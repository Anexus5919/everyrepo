// Query helpers are re-exported so every package shares one drizzle-orm instance
export { and, asc, count, desc, eq, inArray, isNull, lt, ne, sql, sum } from "drizzle-orm";
export * from "./app-schema.ts";
export { neuronsUsed, recordUsage, utcDay, type UsageRecord } from "./budget.ts";
export * from "./engine-schema.ts";
export {
  appDbPath,
  engineDbPath,
  openAppDb,
  openEngineDb,
  type AppDb,
  type AppExecutor,
  type EngineDb,
  type EngineExecutor,
} from "./open.ts";
export { EmbeddingCache, embeddingCachePath } from "./embedding-cache.ts";
export { ensureRepo, findRepo, type RepoRow } from "./registry.ts";
