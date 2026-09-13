import { spawn } from "node:child_process";
import { formatQuery, type Embedder, type EmbedPurpose } from "./embedder.ts";
import { normalize } from "./vector.ts";

export interface LocalEmbedderOptions {
  baseUrl: string;
  model: string;
  dimensions: number;
  batchSize: number;
}

interface EmbeddingResponse {
  data: Array<{ index: number; embedding: number[] }>;
}

// Talks to a local server that exposes the common /v1/embeddings endpoint
export function createLocalEmbedder(options: LocalEmbedderOptions): Embedder {
  const url = new URL("/v1/embeddings", options.baseUrl);
  return {
    model: options.model,
    dimensions: options.dimensions,
    batchSize: options.batchSize,
    async embed(texts: readonly string[], purpose: EmbedPurpose) {
      if (texts.length === 0) return [];
      const input = purpose === "query" ? texts.map(formatQuery) : [...texts];
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: options.model, input }),
      });
      if (!response.ok) {
        throw new Error(`Embedding server returned ${response.status}: ${await response.text()}`);
      }
      const body = (await response.json()) as EmbeddingResponse;
      const vectors = new Array<Float32Array>(texts.length);
      for (const item of body.data) {
        vectors[item.index] = normalize(Float32Array.from(item.embedding), options.dimensions);
      }
      if (vectors.some((vector) => vector === undefined)) {
        throw new Error("Embedding server returned fewer vectors than inputs");
      }
      return vectors;
    },
  };
}

async function isHealthy(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(new URL("/health", baseUrl));
    return response.ok;
  } catch {
    return false;
  }
}

export interface LocalServer {
  started: boolean;
  stop(): void;
}

// Starts the configured server unless one is already answering at baseUrl
export async function ensureLocalServer(
  baseUrl: string,
  command: readonly string[] | undefined,
  timeoutMs = 120_000,
): Promise<LocalServer> {
  if (await isHealthy(baseUrl)) return { started: false, stop: () => {} };
  const [executable, ...args] = command ?? [];
  if (!executable) {
    throw new Error(`No embedding server at ${baseUrl} and no command configured to start one`);
  }
  const child = spawn(executable, args, { stdio: "ignore", windowsHide: true });
  let exitCode: number | null = null;
  child.on("exit", (code) => {
    exitCode = code ?? -1;
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exitCode !== null) throw new Error(`Embedding server exited with code ${exitCode}`);
    if (await isHealthy(baseUrl)) return { started: true, stop: () => child.kill() };
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  child.kill();
  throw new Error(`Embedding server did not become healthy within ${timeoutMs / 1000}s`);
}
