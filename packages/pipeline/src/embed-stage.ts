import { createHash } from "node:crypto";
import { EmbeddingCache, eq, openEngineDb, snapshots } from "@everyrepo/db";
import { documentText, EmbeddingBudgetError, toBlob, type Embedder } from "@everyrepo/embed";
import { StageDeferredError } from "@everyrepo/queue";

export interface EmbedInput {
  enginePath: string;
  cachePath: string;
  embedder: Embedder | undefined;
  log: (message: string) => void;
  heartbeat: () => void;
  // Reports work done inside the stage for status pages
  progress?: (done: number, total: number) => void;
  // When the embedding allowance frees up again, so a paused job resumes right then
  allowanceAt?: (() => Date | undefined) | undefined;
}

export interface EmbedOutput {
  model: string | null;
  dimensions: number;
  chunks: number;
  cached: number;
  embedded: number;
  seconds: number;
}

interface ChunkRow {
  id: number;
  header: string;
  content: string;
}

const FALLBACK_CHARS = 2_000;

// A failing batch is retried one text at a time, and a failing text once more in shortened form
async function embedBatch(embedder: Embedder, texts: string[]): Promise<Float32Array[]> {
  try {
    return await embedder.embed(texts, "document");
  } catch (error) {
    if (error instanceof EmbeddingBudgetError) throw error;
    if (texts.length === 1) {
      const [text] = texts;
      if (text === undefined || text.length <= FALLBACK_CHARS) throw error;
      return embedder.embed([text.slice(0, FALLBACK_CHARS)], "document");
    }
    const vectors: Float32Array[] = [];
    for (const text of texts) vectors.push(...(await embedBatch(embedder, [text])));
    return vectors;
  }
}

export async function runEmbedStage(input: EmbedInput): Promise<EmbedOutput> {
  const started = Date.now();
  const { embedder } = input;
  if (!embedder) {
    input.log("embeddings are not configured, skipping");
    return { model: null, dimensions: 0, chunks: 0, cached: 0, embedded: 0, seconds: 0 };
  }
  const engine = openEngineDb(input.enginePath);
  const sql = engine.$client;
  const cache = new EmbeddingCache(input.cachePath);
  try {
    const rows = sql
      .prepare("SELECT id, header, content FROM chunk ORDER BY id")
      .all() as ChunkRow[];
    const items = rows.map((row) => {
      const text = documentText(row.header, row.content);
      return { id: row.id, text, hash: createHash("sha256").update(text).digest().subarray(0, 16) };
    });
    const vectors = cache.getMany(
      embedder.model,
      items.map((item) => item.hash),
    );
    const cached = vectors.size;

    // Similar lengths in one batch waste less padding work on the server
    const pending = new Map<string, (typeof items)[number]>();
    for (const item of items) {
      const key = item.hash.toString("hex");
      if (!vectors.has(key) && !pending.has(key)) pending.set(key, item);
    }
    const missing = [...pending.values()].sort((a, b) => a.text.length - b.text.length);
    let embedded = 0;
    let lastLog = Date.now();
    const batches: Array<typeof missing> = [];
    for (let start = 0; start < missing.length; start += embedder.batchSize) {
      batches.push(missing.slice(start, start + embedder.batchSize));
    }
    let next = 0;
    let stopped: unknown;
    // Remote providers take several requests at once; a failure stops every worker after its current batch
    const worker = async () => {
      while (stopped === undefined && next < batches.length) {
        const batch = batches[next++]!;
        let result: Float32Array[];
        try {
          result = await embedBatch(
            embedder,
            batch.map((item) => item.text),
          );
        } catch (error) {
          stopped ??= error;
          return;
        }
        const entries = batch.map((item, index) => [item.hash, toBlob(result[index]!)] as const);
        cache.putMany(embedder.model, entries);
        for (const [hash, blob] of entries) vectors.set(hash.toString("hex"), blob);
        embedded += batch.length;
        input.progress?.(embedded, missing.length);
        if (Date.now() - lastLog > 15_000) {
          lastLog = Date.now();
          input.heartbeat();
          const rate = embedded / ((Date.now() - started) / 1000);
          input.log(`embedded ${embedded}/${missing.length} (${rate.toFixed(1)} chunks/s)`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, embedder.concurrency ?? 1) }, worker));
    if (stopped instanceof EmbeddingBudgetError) {
      input.log(
        `embedded ${embedded}/${missing.length} before the budget ran out; the rest resumes from cache`,
      );
      const retryAt = input.allowanceAt?.();
      throw new StageDeferredError(
        `${stopped.message}; run again later, the allowance refills as usage from the past 24 hours ages out`,
        retryAt ? { cause: stopped, retryAt } : { cause: stopped },
      );
    }
    if (stopped !== undefined) throw stopped;

    const insert = sql.prepare("INSERT INTO chunk_vector (chunk_id, vector) VALUES (?, ?)");
    sql.transaction(() => {
      sql.prepare("DELETE FROM chunk_vector").run();
      for (const item of items) insert.run(item.id, vectors.get(item.hash.toString("hex"))!);
    })();

    const snapshot = engine.select().from(snapshots).get();
    if (snapshot) {
      engine
        .update(snapshots)
        .set({
          stats: {
            ...(snapshot.stats ?? {}),
            embedding: { model: embedder.model, dimensions: embedder.dimensions },
          },
        })
        .where(eq(snapshots.sha, snapshot.sha))
        .run();
    }

    const output: EmbedOutput = {
      model: embedder.model,
      dimensions: embedder.dimensions,
      chunks: items.length,
      cached,
      embedded,
      seconds: Math.round((Date.now() - started) / 100) / 10,
    };
    input.log(
      `${output.chunks} chunk vectors (${cached} from cache, ${embedded} embedded) in ${output.seconds}s`,
    );
    return output;
  } finally {
    cache.close();
    sql.close();
  }
}
