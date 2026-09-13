import { createHash } from "node:crypto";
import type { Embedder } from "./embedder.ts";
import { normalize } from "./vector.ts";

// Deterministic bag-of-words vectors for tests; no model required
export function createHashingEmbedder(dimensions = 256): Embedder {
  return {
    model: `hashing-${dimensions}`,
    dimensions,
    batchSize: 64,
    embed(texts) {
      return Promise.resolve(
        texts.map((text) => {
          const vector = new Float32Array(dimensions);
          for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
            const digest = createHash("sha1").update(word).digest();
            vector[digest.readUInt32LE(0) % dimensions]! += 1;
          }
          return normalize(vector);
        }),
      );
    },
  };
}
