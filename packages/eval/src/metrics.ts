export interface QuestionScore {
  recallAt5: number;
  recallAt10: number;
  hitAt10: number;
  reciprocalRank: number;
  firstRank: number | null;
}

// Paths in first-seen order, so a file ranks by its best chunk
export function distinctPaths(hits: ReadonlyArray<{ path: string }>): string[] {
  return [...new Set(hits.map((hit) => hit.path))];
}

export function scoreQuestion(
  expected: readonly string[],
  ranked: readonly string[],
): QuestionScore {
  const recall = (k: number) =>
    expected.filter((path) => ranked.slice(0, k).includes(path)).length / expected.length;
  const ranks = expected.map((path) => ranked.indexOf(path)).filter((rank) => rank >= 0);
  const first = ranks.length > 0 ? Math.min(...ranks) : null;
  return {
    recallAt5: recall(5),
    recallAt10: recall(10),
    hitAt10: first !== null && first < 10 ? 1 : 0,
    reciprocalRank: first !== null && first < 10 ? 1 / (first + 1) : 0,
    firstRank: first === null ? null : first + 1,
  };
}

export type Summary = Omit<QuestionScore, "firstRank"> & { questions: number };

export function summarize(scores: readonly QuestionScore[]): Summary {
  const mean = (pick: (score: QuestionScore) => number) =>
    scores.length === 0 ? 0 : scores.reduce((sum, score) => sum + pick(score), 0) / scores.length;
  return {
    questions: scores.length,
    recallAt5: mean((score) => score.recallAt5),
    recallAt10: mean((score) => score.recallAt10),
    hitAt10: mean((score) => score.hitAt10),
    reciprocalRank: mean((score) => score.reciprocalRank),
  };
}
