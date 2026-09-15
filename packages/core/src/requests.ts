// Shapes shared by the request API, the worker and the website; nothing here touches Node

import type { SizeTier } from "./vocabulary.ts";

export type { SizeTier };

export const INDEX_STAGE_KEYS = [
  "source",
  "detect",
  "parse",
  "graph",
  "chunk",
  "embed",
  "estimate",
] as const;
export const WIKI_STAGE_KEYS = ["summarize", "plan", "write", "glossary"] as const;
export const PUBLISH_STAGE_KEYS = ["publish"] as const;

export type BuildPhase = "reading" | "writing" | "publishing";

export interface BuildStage {
  key: string;
  phase: BuildPhase;
  label: string;
  // Rough share of the whole build, used to show one progress figure across stages
  weight: number;
}

export const BUILD_STAGES: readonly BuildStage[] = [
  { key: "source", phase: "reading", label: "Downloading the code", weight: 4 },
  { key: "detect", phase: "reading", label: "Sorting the files", weight: 2 },
  { key: "parse", phase: "reading", label: "Parsing the code", weight: 9 },
  { key: "graph", phase: "reading", label: "Linking imports", weight: 5 },
  { key: "chunk", phase: "reading", label: "Cutting the code into excerpts", weight: 4 },
  { key: "embed", phase: "reading", label: "Indexing excerpts for search", weight: 10 },
  { key: "estimate", phase: "reading", label: "Planning the work", weight: 1 },
  { key: "summarize", phase: "writing", label: "Summarizing each part of the code", weight: 32 },
  { key: "plan", phase: "writing", label: "Planning the pages", weight: 3 },
  { key: "write", phase: "writing", label: "Writing and checking pages", weight: 26 },
  { key: "glossary", phase: "writing", label: "Collecting project terms", weight: 2 },
  { key: "publish", phase: "publishing", label: "Publishing the wiki", weight: 2 },
];

// Owner review decides requests the automatic rules do not approve
export const REQUEST_DECISIONS = ["approved", "review", "rejected"] as const;
export type RequestDecision = (typeof REQUEST_DECISIONS)[number];

// Why a stored request waits for review or was declined
export const REQUEST_REASONS = ["large", "daily-limit", "queue-full", "declined"] as const;
export type RequestReason = (typeof REQUEST_REASONS)[number];

export const REPO_STATES = [
  // A published wiki can be opened
  "ready",
  // A job is reading or writing the repository right now
  "building",
  "queued",
  // Waiting for a free model or embedding allowance to refill
  "paused",
  "review",
  "failed",
  "rejected",
  // On GitHub and eligible, but nobody has asked for it
  "available",
  // Not on GitHub, private, or not something a wiki can be written for
  "unavailable",
] as const;
export type RepoState = (typeof REPO_STATES)[number];

export interface GithubSummary {
  description: string | null;
  stars: number | null;
  language: string | null;
  defaultBranch: string | null;
  archived: boolean;
  fork: boolean;
  parent: string | null;
  license: string | null;
  url: string;
  avatarUrl: string;
  pushedAt: string | null;
}

export interface SizeEstimate {
  files: number;
  sourceFiles: number;
  sourceTokens: number;
  sizeTier: SizeTier;
  // GitHub lists at most 100,000 files at once, so larger trees are only known to be at least this big
  truncated: boolean;
  languages: Array<{ language: string; files: number }>;
}

export interface BuildProgress {
  phase: BuildPhase;
  stage: string;
  label: string;
  // Position of the stage among all build stages, counting from 1
  step: number;
  steps: number;
  done: number | null;
  total: number | null;
  percent: number;
  startedAt: string | null;
}

// Whether a worker has reported in recently; builds only move while one is running
export interface BuilderStatus {
  online: boolean;
  lastSeenAt: string | null;
}

export interface RepoEta {
  // A build already in line, or what would happen if the repository were requested or approved now
  basis: "line" | "if-requested" | "if-approved";
  readyAt: string;
  startsAt: string;
  // Builds that finish before this one starts
  ahead: number;
  // Time spent on this repository alone, without waiting
  workMinutes: number;
  // When the free model or embedding allowance this build waits for comes back, if it waits
  allowanceUntil: string | null;
}

export interface RepoView {
  repo: string;
  state: RepoState;
  reason: { code: string; message: string } | null;
  github: GithubSummary | null;
  estimate: SizeEstimate | null;
  // Position 1 is the next repository to be built
  queue: { position: number; total: number } | null;
  progress: BuildProgress | null;
  requests: number;
  requestedAt: string | null;
  updatedAt: string | null;
  resumeAt: string | null;
  href: string | null;
  eta: RepoEta | null;
  builder: BuilderStatus;
}

export interface QueueView {
  building: RepoView[];
  waiting: RepoView[];
  review: RepoView[];
  recent: RepoView[];
  builder: BuilderStatus;
  updatedAt: string;
}

export interface ApiError {
  error: { code: string; message: string };
}

// Share of the whole build finished once a stage has done part of its work
export function buildPercent(stage: string, done: number | null, total: number | null): number {
  const all = BUILD_STAGES.reduce((sum, item) => sum + item.weight, 0);
  const index = BUILD_STAGES.findIndex((item) => item.key === stage);
  if (index < 0) return 0;
  const before = BUILD_STAGES.slice(0, index).reduce((sum, item) => sum + item.weight, 0);
  const within = done !== null && total ? Math.min(1, Math.max(0, done / total)) : 0;
  return Math.round(((before + BUILD_STAGES[index]!.weight * within) / all) * 100);
}

// One repository an account asked for, and when it asked
export interface AccountRequest {
  requestedAt: string;
  view: RepoView;
}

// What the website knows about the signed-in person
export interface AccountUser {
  login: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  memberSince: string;
}
