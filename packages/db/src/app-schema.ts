import { JOB_KINDS, JOB_STATUSES, REPO_STATUSES, SIZE_TIERS } from "@everyrepo/core";
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
  createdAt: createdAt(),
});

export const indexJobs = sqliteTable(
  "index_job",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    repoId: integer("repo_id")
      .notNull()
      .references(() => repos.id),
    kind: text("kind", { enum: JOB_KINDS }).notNull(),
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
