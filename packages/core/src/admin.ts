import type { BuildProgress, RepoState, SizeTier } from "./requests.ts";

// Shapes the admin API sends to the dashboard; every time is an ISO string

export interface AdminModel {
  id: string;
  provider: string;
  model: string;
  // Tasks that use this model, in the order the router tries it for each
  tasks: string[];
  usedLastDay: number;
  limitPerDay: number;
  // When requests free up again, set only while none are left
  freesAt: string | null;
  // Set while the provider refused the model and it is skipped
  restingUntil: string | null;
  restReason: string | null;
}

export interface AdminEmbeddings {
  provider: string;
  usedLastDay: number;
  budgetPerDay: number;
  freesAt: string | null;
}

export interface AdminGithubLimit {
  limit: number;
  remaining: number;
  resetsAt: string;
}

export interface AdminOverview {
  now: string;
  builder: {
    online: boolean;
    lastSeenAt: string | null;
    paused: boolean;
    current: { repo: string; kind: string; progress: BuildProgress | null } | null;
  };
  models: AdminModel[];
  embeddings: AdminEmbeddings | null;
  // Null when GitHub could not be asked
  github: { core: AdminGithubLimit; search: AdminGithubLimit; token: boolean } | null;
  counts: {
    publishedWikis: number;
    building: number;
    inLine: number;
    paused: number;
    inReview: number;
    failedLastDay: number;
    accounts: number;
  };
}

export interface AdminQueueItem {
  jobId: number;
  repo: string;
  kind: string;
  status: "queued" | "running";
  priority: number;
  // Requested by someone, as opposed to added by the owner or rewriting a published wiki
  asked: boolean;
  published: boolean;
  requests: number;
  runAfter: string | null;
  attempts: number;
  error: string | null;
  progress: BuildProgress | null;
  createdAt: string;
}

export interface AdminRequest {
  repo: string;
  state: RepoState;
  decision: string;
  reason: string | null;
  decidedBy: string;
  count: number;
  requesters: string[];
  sizeTier: SizeTier | null;
  sourceFiles: number | null;
  firstAt: string;
  lastAt: string;
}

export interface AdminWiki {
  repo: string;
  sizeTier: SizeTier | null;
  publishedAt: string | null;
  indexedAt: string | null;
  pages: { total: number; written: number; failed: number; empty: number; planned: number };
  // The open job for this repository, if a build or rewrite is under way
  openJob: string | null;
}

export interface AdminPage {
  slug: string;
  parentSlug: string | null;
  title: string;
  status: string;
  words: number;
  citations: number;
  model: string | null;
  updatedAt: string | null;
}

export interface AdminPageText extends AdminPage {
  purpose: string;
  markdown: string | null;
}

export interface AdminAccount {
  login: string;
  name: string | null;
  email: string | null;
  createdAt: string;
  lastSeenAt: string;
  requests: number;
}

export interface AdminActivity {
  at: string;
  kind: "admin" | "job";
  who: string | null;
  action: string;
  target: string;
  detail: string | null;
}
