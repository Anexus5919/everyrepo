import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";

export interface CachedResponse {
  text: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cached: boolean;
}

// Model answers keyed by a hash of model, prompt version and request, shared by all repositories
export class LlmCache {
  private readonly db: Database.Database;
  private readonly select: Database.Statement;
  private readonly insert: Database.Statement;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS response (key TEXT PRIMARY KEY, result TEXT NOT NULL, created_at INTEGER NOT NULL) WITHOUT ROWID",
    );
    this.select = this.db.prepare("SELECT result FROM response WHERE key = ?");
    this.insert = this.db.prepare(
      "INSERT OR REPLACE INTO response (key, result, created_at) VALUES (?, ?, ?)",
    );
  }

  get(key: string): CachedResponse | undefined {
    const row = this.select.get(key) as { result: string } | undefined;
    return row ? (JSON.parse(row.result) as CachedResponse) : undefined;
  }

  set(key: string, result: CachedResponse): void {
    this.insert.run(key, JSON.stringify(result), Date.now());
  }

  close(): void {
    this.db.close();
  }
}

export function llmCachePath(dataDir: string): string {
  return join(dataDir, "cache", "llm.sqlite");
}
