import {
  JOB_KINDS,
  JOB_ORIGINS,
  JOB_STATUSES,
  REPO_STATUSES,
  REQUEST_DECISIONS,
  REQUEST_REASONS,
  SIZE_TIERS,
  type SizeEstimate,
} from "@everyrepo/core";
import { index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

const timestamp = (name: string) => integer(name, { mode: "timestamp_ms" });
const createdAt = () =>
  timestamp("created_at")
    .notNull()
    .$defaultFn(() => new Date());

export const orgs = sqliteTable("org", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  login: text("login").notNull(),
  key: text("key").notNull().unique(),
  createdAt: createdAt(),
});

export const repos = sqliteTable("repo", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  orgId: integer("org_id")
    .notNull()
    .references(() => orgs.id),
  name: text("name").notNull(),
  fullName: text("full_name").notNull(),
  key: text("key").notNull().unique(),
  defaultBranch: text("default_branch"),
  status: text("status", { enum: REPO_STATUSES }).notNull().default("requested"),
  synced: integer("synced", { mode: "boolean" }).notNull().default(false),
  sizeTier: text("size_tier", { enum: SIZE_TIERS }),
  lastIndexedSha: text("last_indexed_sha"),
  lastIndexedAt: timestamp("last_indexed_at"),
  // GitHub's numeric id stays the same when a repository is renamed or moved
  githubId: integer("github_id"),
  description: text("description"),
  stars: integer("stars"),
  archived: integer("archived", { mode: "boolean" }).notNull().default(false),
  // The snapshot whose wiki the website currently shows
  publishedSha: text("published_sha"),
  publishedAt: timestamp("published_at"),
  createdAt: createdAt(),
});

// Latest known position inside the running stage, for status pages
export interface JobProgress {
  stage: string;
  done: number | null;
  total: number | null;
  at: number;
}

export const indexJobs = sqliteTable(
  "index_job",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    repoId: integer("repo_id")
      .notNull()
      .references(() => repos.id),
    kind: text("kind", { enum: JOB_KINDS }).notNull(),
    origin: text("origin", { enum: JOB_ORIGINS }).notNull().default("cli"),
    status: text("status", { enum: JOB_STATUSES }).notNull().default("queued"),
    stages: text("stages", { mode: "json" }).$type<string[]>().notNull(),
    params: text("params", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    priority: integer("priority").notNull().default(100),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    lockedBy: text("locked_by"),
    heartbeatAt: timestamp("heartbeat_at"),
    estTokens: integer("est_tokens"),
    usedTokens: integer("used_tokens").notNull().default(0),
    // A deferred or retried job is not claimed again before this time
    runAfter: timestamp("run_after"),
    deferrals: integer("deferrals").notNull().default(0),
    progress: text("progress", { mode: "json" }).$type<JobProgress>(),
    error: text("error"),
    createdAt: createdAt(),
    startedAt: timestamp("started_at"),
    finishedAt: timestamp("finished_at"),
  },
  (table) => [index("index_job_claim").on(table.status, table.priority, table.id)],
);

export const jobStages = sqliteTable(
  "job_stage",
  {
    jobId: integer("job_id")
      .notNull()
      .references(() => indexJobs.id, { onDelete: "cascade" }),
    stage: text("stage").notNull(),
    status: text("status", { enum: ["running", "succeeded", "failed"] }).notNull(),
    output: text("output", { mode: "json" }).$type<unknown>(),
    error: text("error"),
    startedAt: timestamp("started_at").notNull(),
    finishedAt: timestamp("finished_at"),
  },
  (table) => [primaryKey({ columns: [table.jobId, table.stage] })],
);

// Provider usage per UTC hour; allowances such as Workers AI's are enforced over a rolling day
export const usageCounters = sqliteTable(
  "usage_counter",
  {
    hour: text("hour").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    requests: integer("requests").notNull().default(0),
    tokens: integer("tokens").notNull().default(0),
    neurons: real("neurons").notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.hour, table.provider, table.model] })],
);

// One row per repository someone asked for on the site, with the decision about building it
export const repoRequests = sqliteTable(
  "repo_request",
  {
    repoId: integer("repo_id")
      .primaryKey()
      .references(() => repos.id, { onDelete: "cascade" }),
    decision: text("decision", { enum: REQUEST_DECISIONS }).notNull(),
    reason: text("reason", { enum: REQUEST_REASONS }),
    // Distinct people who asked, each counted once a day
    count: integer("count").notNull().default(0),
    estimate: text("estimate", { mode: "json" }).$type<SizeEstimate>(),
    firstAt: timestamp("first_at").notNull(),
    lastAt: timestamp("last_at").notNull(),
    decidedAt: timestamp("decided_at").notNull(),
    decidedBy: text("decided_by", { enum: ["rules", "owner"] }).notNull(),
  },
  (table) => [index("repo_request_decision").on(table.decision, table.decidedAt)],
);

// Salted hashes of requesters, kept for a day so repeated clicks count once and no address is stored
export const requestVoters = sqliteTable(
  "request_voter",
  {
    repoId: integer("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    voter: text("voter").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.repoId, table.voter] }),
    index("request_voter_created").on(table.createdAt),
  ],
);

// Fixed-window counters keyed by a salted hash of the caller and the action
export const rateLimits = sqliteTable(
  "rate_limit",
  {
    key: text("key").notNull(),
    windowStart: integer("window_start").notNull(),
    count: integer("count").notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.key, table.windowStart] })],
);

// GitHub API answers with their entity tags, so repeat lookups can be revalidated cheaply
export const githubCache = sqliteTable("github_cache", {
  key: text("key").primaryKey(),
  etag: text("etag"),
  payload: text("payload", { mode: "json" }).$type<unknown>().notNull(),
  fetchedAt: timestamp("fetched_at").notNull(),
});
