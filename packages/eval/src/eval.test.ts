import { describe, expect, it } from "vitest";
import { loadGoldSets } from "./gold.ts";
import { distinctPaths, scoreQuestion, summarize } from "./metrics.ts";

describe("metrics", () => {
  it("scores recall, hits and reciprocal rank over distinct files", () => {
    const ranked = distinctPaths([{ path: "a" }, { path: "a" }, { path: "b" }, { path: "c" }]);
    expect(ranked).toEqual(["a", "b", "c"]);
    expect(scoreQuestion(["b", "z"], ranked)).toEqual({
      recallAt5: 0.5,
      recallAt10: 0.5,
      hitAt10: 1,
      reciprocalRank: 0.5,
      firstRank: 2,
    });
    const miss = scoreQuestion(["z"], ranked);
    expect(summarize([scoreQuestion(["a"], ranked), miss])).toMatchObject({
      questions: 2,
      hitAt10: 0.5,
      reciprocalRank: 0.5,
    });
  });
});

describe("gold sets", () => {
  it("parse and have unique question ids", async () => {
    const sets = await loadGoldSets();
    const ids = sets.flatMap((set) => set.questions.map((question) => question.id));
    expect(new Set(ids).size).toBe(ids.length);
  });
});
