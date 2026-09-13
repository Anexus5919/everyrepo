import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import * as appSchema from "./app-schema.ts";
import * as engineSchema from "./engine-schema.ts";

const migrationsRoot = fileURLToPath(new URL("../migrations/", import.meta.url));

function openSqlite(path: string): Database.Database {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("synchronous = NORMAL");
  return sqlite;
}

export function openAppDb(path: string) {
  const db = drizzle(openSqlite(path), { schema: appSchema });
  migrate(db, { migrationsFolder: join(migrationsRoot, "app") });
  return db;
}

export function openEngineDb(path: string) {
  const db = drizzle(openSqlite(path), { schema: engineSchema });
  migrate(db, { migrationsFolder: join(migrationsRoot, "engine") });
  return db;
}

export type AppDb = ReturnType<typeof openAppDb>;
export type EngineDb = ReturnType<typeof openEngineDb>;

// Accepts both a database handle and a transaction
export type AppExecutor = BaseSQLiteDatabase<"sync", Database.RunResult, typeof appSchema>;
export type EngineExecutor = BaseSQLiteDatabase<"sync", Database.RunResult, typeof engineSchema>;

export function appDbPath(dataDir: string): string {
  return join(dataDir, "app.sqlite");
}

export function engineDbPath(dataDir: string, repoDir: string, sha: string): string {
  return join(dataDir, "engine", repoDir, `${sha}.sqlite`);
}
