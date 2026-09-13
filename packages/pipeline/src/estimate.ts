import type { SizeTier } from "@kickstart/core";

export interface EstimateInput {
  sizeTier: SizeTier;
  // Token counts of individual source files
  sourceFileTokens: readonly number[];
  sourceDirectories: number;
}

export interface CostEstimate {
  pages: number;
  fileSummaryTokens: number;
  directorySummaryTokens: number;
  planningTokens: number;
  pageTokens: number;
  inputTokens: number;
  outputTokens: number;
  // Bulk summaries of large repositories run on the local model
  localTokens: number;
  cloudTokens: number;
}

const PAGES: Record<SizeTier, number> = { S: 8, M: 18, L: 40, XL: 50 };
const PLANNING: Record<SizeTier, number> = { S: 15_000, M: 60_000, L: 150_000, XL: 200_000 };
const LARGE_FILE_TOKENS = 2_200;
const SIGNATURE_SHARE = 0.15;
const DIRECTORY_SUMMARY_TOKENS = 800;
const MAX_PAGE_CONTEXT = 35_000;
const MIN_PAGE_CONTEXT = 8_000;
const OUTPUT_SHARE = 0.12;

export function estimateIndexCost(input: EstimateInput): CostEstimate {
  const { sizeTier } = input;
  const sourceTokens = input.sourceFileTokens.reduce((sum, tokens) => sum + tokens, 0);
  // Large files are summarized from signatures and doc comments only
  const fileSummaryTokens = Math.round(
    input.sourceFileTokens.reduce(
      (sum, tokens) =>
        sum + (tokens > LARGE_FILE_TOKENS ? Math.max(600, tokens * SIGNATURE_SHARE) : tokens),
      0,
    ),
  );
  const directorySummaryTokens =
    sizeTier === "S" ? 0 : input.sourceDirectories * DIRECTORY_SUMMARY_TOKENS;
  const pages = PAGES[sizeTier];
  const pageContext = Math.min(MAX_PAGE_CONTEXT, Math.max(MIN_PAGE_CONTEXT, sourceTokens / pages));
  const pageTokens = Math.round(pages * pageContext);
  const planningTokens = PLANNING[sizeTier];

  const inputTokens = fileSummaryTokens + directorySummaryTokens + planningTokens + pageTokens;
  const localTokens =
    sizeTier === "L" || sizeTier === "XL" ? fileSummaryTokens + directorySummaryTokens : 0;
  return {
    pages,
    fileSummaryTokens,
    directorySummaryTokens,
    planningTokens,
    pageTokens,
    inputTokens,
    outputTokens: Math.round(inputTokens * OUTPUT_SHARE),
    localTokens,
    cloudTokens: inputTokens - localTokens,
  };
}
