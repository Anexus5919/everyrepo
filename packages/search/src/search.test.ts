import { describe, expect, it } from "vitest";
import { fuseRankings } from "./hybrid.ts";
import { ftsQuery } from "./keyword.ts";

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
