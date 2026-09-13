import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";

// Vectors keyed by model and content hash survive across snapshots, so updates only embed changed chunks
export class EmbeddingCache {
  private readonly db: Database.Database;
  private readonly insert: Database.Statement;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS embedding (model TEXT NOT NULL, hash BLOB NOT NULL, vector BLOB NOT NULL, PRIMARY KEY (model, hash)) WITHOUT ROWID",
    );
    this.insert = this.db.prepare(
      "INSERT OR REPLACE INTO embedding (model, hash, vector) VALUES (?, ?, ?)",
    );
  }

  getMany(model: string, hashes: readonly Buffer[]): Map<string, Buffer> {
    const found = new Map<string, Buffer>();
    for (let start = 0; start < hashes.length; start += 500) {
      const slice = hashes.slice(start, start + 500);
      const rows = this.db
        .prepare(
          `SELECT hash, vector FROM embedding WHERE model = ? AND hash IN (${slice.map(() => "?").join(",")})`,
        )
        .all(model, ...slice) as Array<{ hash: Buffer; vector: Buffer }>;
      for (const row of rows) found.set(row.hash.toString("hex"), row.vector);
    }
    return found;
  }

  putMany(model: string, entries: ReadonlyArray<readonly [Buffer, Buffer]>): void {
    this.db.transaction(() => {
      for (const [hash, vector] of entries) this.insert.run(model, hash, vector);
    })();
  }

  close(): void {
    this.db.close();
  }
}

export function embeddingCachePath(dataDir: string, repoDir: string): string {
  return join(dataDir, "engine", repoDir, "embeddings.sqlite");
}
