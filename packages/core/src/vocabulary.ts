export const SIZE_TIERS = ["S", "M", "L", "XL"] as const;
export type SizeTier = (typeof SIZE_TIERS)[number];

export const FILE_KINDS = [
  "src",
  "types",
  "test",
  "example",
  "docs",
  "changelog",
  "locale",
  "config",
  "generated",
  "vendored",
  "asset",
  "other",
] as const;
export type FileKind = (typeof FILE_KINDS)[number];

export const MODULE_KINDS = [
  "repository",
  "npm",
  "maven",
  "gradle",
  "cargo",
  "go",
  "python",
  "directory",
] as const;
export type ModuleKind = (typeof MODULE_KINDS)[number];

export const REPO_STATUSES = ["requested", "queued", "indexing", "indexed", "failed"] as const;
export type RepoStatus = (typeof REPO_STATUSES)[number];

export const JOB_KINDS = ["full", "incremental", "wiki", "publish"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const JOB_STATUSES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

// Jobs started from the command line run there; jobs from site requests belong to the worker
export const JOB_ORIGINS = ["cli", "request"] as const;
export type JobOrigin = (typeof JOB_ORIGINS)[number];

// Upper bounds of source tokens for each tier; anything larger is XL
const TIER_LIMITS: ReadonlyArray<[SizeTier, number]> = [
  ["S", 150_000],
  ["M", 1_000_000],
  ["L", 5_000_000],
];

export function sizeTierFor(sourceTokens: number): SizeTier {
  for (const [tier, limit] of TIER_LIMITS) {
    if (sourceTokens < limit) return tier;
  }
  return "XL";
}

// Rough average for source code across common tokenizers
const BYTES_PER_TOKEN = 3.7;

export function estimateTokens(bytes: number): number {
  return Math.ceil(bytes / BYTES_PER_TOKEN);
}
