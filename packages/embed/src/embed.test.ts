import { describe, expect, it } from "vitest";
import { documentText, formatQuery, MAX_DOCUMENT_CHARS } from "./embedder.ts";
import { createHashingEmbedder } from "./hashing.ts";
import { dot, fromBlob, normalize, toBlob } from "./vector.ts";

describe("vectors", () => {
  it("normalizes, truncates and round-trips through blobs", () => {
    const vector = normalize(Float32Array.from([3, 4, 12]), 2);
    expect(Array.from(vector)).toEqual([expect.closeTo(0.6), expect.closeTo(0.8)]);
    const restored = fromBlob(toBlob(vector));
    expect(Array.from(restored)).toEqual(Array.from(vector));
  });

  it("gives related texts higher similarity with the hashing embedder", async () => {
    const [query, near, far] = await createHashingEmbedder().embed(
      ["grid filter panel", "the filter panel of the grid", "date picker calendar"],
      "document",
    );
    expect(dot(query!, near!)).toBeGreaterThan(dot(query!, far!));
  });
});

describe("inputs", () => {
  it("wraps queries in the instruction format and caps documents", () => {
    expect(formatQuery("where is auth")).toMatch(/^Instruct: .+\nQuery:where is auth$/);
    expect(documentText("h", "x".repeat(MAX_DOCUMENT_CHARS * 2))).toHaveLength(MAX_DOCUMENT_CHARS);
  });
});
