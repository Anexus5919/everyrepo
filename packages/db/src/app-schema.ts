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

// Models a provider refused until a given time, such as a free daily quota it counts differently from us
export const modelRests = sqliteTable(
  "model_rest",
  {
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    until: timestamp("until").notNull(),
    reason: text("reason").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.provider, table.model] })],
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
    // Accounts that asked for this repository
    count: integer("count").notNull().default(0),
    estimate: text("estimate", { mode: "json" }).$type<SizeEstimate>(),
    firstAt: timestamp("first_at").notNull(),
    lastAt: timestamp("last_at").notNull(),
    decidedAt: timestamp("decided_at").notNull(),
    // Rules and the owner decide new builds; "existing" joins a build that was already under way
    decidedBy: text("decided_by", { enum: ["rules", "owner", "existing"] }).notNull(),
  },
  (table) => [index("repo_request_decision").on(table.decision, table.decidedAt)],
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

// People who signed in with GitHub; the GitHub id stays the same when someone renames their login
export const users = sqliteTable("user", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  githubId: integer("github_id").notNull().unique(),
  login: text("login").notNull(),
  name: text("name"),
  email: text("email"),
  avatarUrl: text("avatar_url"),
  createdAt: createdAt(),
  lastSeenAt: timestamp("last_seen_at").notNull(),
});

// Signed-in browsers; only a hash of each session token is stored, so a copy of the database signs nobody in
export const sessions = sqliteTable(
  "session",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at").notNull(),
    lastSeenAt: timestamp("last_seen_at").notNull(),
  },
  (table) => [index("session_user").on(table.userId)],
);

// Sign-ins in progress; GitHub's answer is accepted only by the browser that started the sign-in
export const authStates = sqliteTable("auth_state", {
  stateHash: text("state_hash").primaryKey(),
  verifier: text("verifier").notNull(),
  returnTo: text("return_to").notNull(),
  createdAt: createdAt(),
});

// Who asked for which repository and when, which is each account's request history
export const userRequests = sqliteTable(
  "user_request",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    repoId: integer("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    requestedAt: timestamp("requested_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.repoId] }),
    index("user_request_repo").on(table.repoId),
  ],
);

// Running workers report in regularly; a stale heartbeat means the builder is offline
export const workers = sqliteTable("worker", {
  id: text("id").primaryKey(),
  startedAt: timestamp("started_at").notNull(),
  heartbeatAt: timestamp("heartbeat_at").notNull(),
  jobId: integer("job_id"),
});

// Switches the owner sets from the admin dashboard, such as pausing the builder
export const settings = sqliteTable("setting", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

// Every change made from the admin dashboard, with who made it; the login is copied so the record outlives the account
export const adminActions = sqliteTable(
  "admin_action",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
    login: text("login").notNull(),
    action: text("action").notNull(),
    target: text("target").notNull(),
    detail: text("detail", { mode: "json" }).$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (table) => [index("admin_action_created").on(table.createdAt)],
);

// GitHub API answers with their entity tags, so repeat lookups can be revalidated cheaply
export const githubCache = sqliteTable("github_cache", {
  key: text("key").primaryKey(),
  etag: text("etag"),
  payload: text("payload", { mode: "json" }).$type<unknown>().notNull(),
  fetchedAt: timestamp("fetched_at").notNull(),
});
