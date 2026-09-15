import { describe, expect, it } from "vitest";
import { fuseRankings } from "./hybrid.ts";
import { ftsQuery } from "./keyword.ts";
import { applyRerank } from "./rerank.ts";

describe("ftsQuery", () => {
  it("quotes terms, splits camelCase and drops stop words", () => {
    expect(ftsQuery("How does useGridApiRef work?")).toBe(
      '"usegridapiref" OR "use" OR "grid" OR "api" OR "ref" OR "work"',
    );
    expect(ftsQuery('the "of" to')).toBeUndefined();
  });
});

describe("fuseRankings", () => {
  it("rewards chunks that rank well in both lists", () => {
    const fused = fuseRankings(
      [
        [{ chunkId: 1 }, { chunkId: 2 }, { chunkId: 3 }],
        [{ chunkId: 4 }, { chunkId: 2 }, { chunkId: 5 }],
      ],
      3,
    );
    expect(fused.map((item) => item.chunkId)).toEqual([2, 1, 4]);
  });

  it("lets a heavier list lead", () => {
    const lists = [
      [{ chunkId: 1 }, { chunkId: 2 }],
      [{ chunkId: 3 }, { chunkId: 4 }],
    ];
    expect(fuseRankings(lists, 1)[0]?.chunkId).toBe(1);
    expect(fuseRankings(lists, 1, { weights: [1, 2] })[0]?.chunkId).toBe(3);
  });
});

describe("applyRerank", () => {
  const hit = (fileId: number) => ({
    fileId,
    path: `f${fileId}.ts`,
    kind: "src",
    score: 0,
    chunkIds: [],
  });

  it("keeps the first order at blend 0 and follows the reranker at blend 1", () => {
    const hits = [hit(1), hit(2), hit(3), hit(4)];
    const scores = [0.1, 0.9, 0.5];
    const order = (blend: number) =>
      applyRerank(hits, scores, { top: 3, blend }).map((item) => item.fileId);
    expect(order(0)).toEqual([1, 2, 3, 4]);
    expect(order(1)).toEqual([2, 3, 1, 4]);
  });
});
