import { existsSync } from "node:fs";
import {
  parseRepoRef,
  repoDirName,
  type AdminAccount,
  type AdminActivity,
  type AdminGithubLimit,
  type AdminModel,
  type AdminOverview,
  type AdminPage,
  type AdminPageText,
  type AdminRequest,
  type AdminWiki,
  type LocalConfig,
  type RepoView,
} from "@everyrepo/core";
import {
  activeRests,
  adminActions,
  and,
  desc,
  engineDbPath,
  eq,
  gt,
  indexJobs,
  isNotNull,
  modelRests,
  neuronsUsedLastDay,
  openEngineDb,
  openEngineReadonly,
  repoRequests,
  repos,
  requestsLastDay,
  sql,
  usageBuckets,
  userRequests,
  users,
  type AppDb,
  type RepoRow,
} from "@everyrepo/db";
import { findOpenJob } from "@everyrepo/queue";
import {
  adminQueue,
  builderPaused,
  builderStatus,
  CapacityLedger,
  isPaused,
} from "@everyrepo/requests";
import { capacityConfig } from "./build-work.ts";

const DAY_MS = 86_400_000;
const iso = (date: Date | null | undefined) => (date ? date.toISOString() : null);

function modelAllowances(db: AppDb, config: LocalConfig, now: Date): AdminModel[] {
  const capacity = capacityConfig(config);
  if (!capacity || !config.llm) return [];
  const ledger = new CapacityLedger(capacity, usageBuckets(db, now), activeRests(db, now));
  const rests = db.select().from(modelRests).where(gt(modelRests.until, now)).all();
  return capacity.models.map((model) => {
    const rest = rests.find((row) => row.provider === model.provider && row.model === model.model);
    const left = ledger.requestsLeft(model, now.getTime());
    const frees = left === 0 ? ledger.nextRequestRelease(model, now.getTime()) : undefined;
    return {
      id: model.id,
      provider: model.provider,
      model: model.model,
      tasks: Object.entries(capacity.tasks)
        .filter(([, ids]) => ids.includes(model.id))
        .map(([task]) => task),
      usedLastDay: requestsLastDay(db, model.provider, model.model, now),
      limitPerDay: model.requestsPerDay,
      freesAt: frees === undefined ? null : new Date(frees).toISOString(),
      restingUntil: iso(rest?.until),
      restReason: rest?.reason ?? null,
    };
  });
}

function embeddingAllowance(db: AppDb, config: LocalConfig, now: Date) {
  const capacity = capacityConfig(config);
  const budget = capacity?.embeddings;
  if (!capacity || !budget) return null;
  const used = neuronsUsedLastDay(db, budget.provider, now);
  const ledger = new CapacityLedger(capacity, usageBuckets(db, now));
  const frees =
    used >= budget.dailyNeuronBudget ? ledger.nextNeuronRelease(now.getTime()) : undefined;
  return {
    provider: budget.provider,
    usedLastDay: Math.round(used),
    budgetPerDay: budget.dailyNeuronBudget,
    freesAt: frees === undefined ? null : new Date(frees).toISOString(),
  };
}

interface GithubLimits {
  core: AdminGithubLimit;
  search: AdminGithubLimit;
  token: boolean;
}

// Asking GitHub for its limits does not count against them; the answer is kept for a minute
export function createGithubLimits(token: string | undefined, doFetch: typeof fetch = fetch) {
  let saved: { at: number; value: GithubLimits | null } | undefined;
  return async (now: Date): Promise<GithubLimits | null> => {
    if (saved && now.getTime() - saved.at < 60_000) return saved.value;
    let value: GithubLimits | null = null;
    try {
      const response = await doFetch("https://api.github.com/rate_limit", {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "everyrepo",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        signal: AbortSignal.timeout(8_000),
      });
      if (response.ok) {
        const body = (await response.json()) as {
          resources: Record<string, { limit: number; remaining: number; reset: number }>;
        };
        const limit = (name: string): AdminGithubLimit => {
          const entry = body.resources[name] ?? { limit: 0, remaining: 0, reset: 0 };
          return {
            limit: entry.limit,
            remaining: entry.remaining,
            resetsAt: new Date(entry.reset * 1_000).toISOString(),
          };
        };
        value = { core: limit("core"), search: limit("search"), token: Boolean(token) };
      }
    } catch {
      value = null;
    }
    saved = { at: now.getTime(), value };
    return value;
  };
}

export async function adminOverview(
  db: AppDb,
  config: LocalConfig,
  github: (now: Date) => Promise<GithubLimits | null>,
  now: Date,
): Promise<AdminOverview> {
  const queue = adminQueue(db);
  const running = queue.find((item) => item.status === "running");
  const count = (query: { get(): { n: number } | undefined }) => query.get()?.n ?? 0;
  const queued = db
    .select()
    .from(indexJobs)
    .where(and(eq(indexJobs.status, "queued"), eq(indexJobs.origin, "request")))
    .all();
  return {
    now: now.toISOString(),
    builder: {
      ...builderStatus(db, now),
      paused: builderPaused(db),
      current: running
        ? { repo: running.repo, kind: running.kind, progress: running.progress }
        : null,
    },
    models: modelAllowances(db, config, now),
    embeddings: embeddingAllowance(db, config, now),
    github: await github(now),
    counts: {
      publishedWikis: count(
        db
          .select({ n: sql<number>`count(*)` })
          .from(repos)
          .where(isNotNull(repos.publishedAt)),
      ),
      building: queue.filter((item) => item.status === "running").length,
      inLine: queued.filter((job) => !isPaused(job, now)).length,
      paused: queued.filter((job) => isPaused(job, now)).length,
      inReview: count(
        db
          .select({ n: sql<number>`count(*)` })
          .from(repoRequests)
          .where(eq(repoRequests.decision, "review")),
      ),
      failedLastDay: count(
        db
          .select({ n: sql<number>`count(*)` })
          .from(indexJobs)
          .where(
            and(
              eq(indexJobs.status, "failed"),
              gt(indexJobs.finishedAt, new Date(now.getTime() - DAY_MS)),
            ),
          ),
      ),
      accounts: count(db.select({ n: sql<number>`count(*)` }).from(users)),
    },
  };
}

// Requests waiting for review first, then the most recently asked for
export function adminRequests(db: AppDb, views: readonly RepoView[]): AdminRequest[] {
  const byRepo = new Map(views.map((view) => [view.repo.toLowerCase(), view]));
  const askers = db
    .select({ repoId: userRequests.repoId, login: users.login })
    .from(userRequests)
    .innerJoin(users, eq(users.id, userRequests.userId))
    .orderBy(userRequests.requestedAt)
    .all();
  return db
    .select({ request: repoRequests, repo: repos })
    .from(repoRequests)
    .innerJoin(repos, eq(repos.id, repoRequests.repoId))
    .orderBy(desc(repoRequests.lastAt))
    .all()
    .map(({ request, repo }) => ({
      repo: repo.fullName,
      state: byRepo.get(repo.key)?.state ?? "available",
      decision: request.decision,
      reason: request.reason,
      decidedBy: request.decidedBy,
      count: request.count,
      requesters: askers.filter((row) => row.repoId === repo.id).map((row) => row.login),
      sizeTier: request.estimate?.sizeTier ?? repo.sizeTier,
      sourceFiles: request.estimate?.sourceFiles ?? null,
      firstAt: request.firstAt.toISOString(),
      lastAt: request.lastAt.toISOString(),
    }))
    .sort((a, b) => Number(b.decision === "review") - Number(a.decision === "review"));
}

function enginePath(dataDir: string, repo: RepoRow): string | undefined {
  if (!repo.lastIndexedSha) return undefined;
  const path = engineDbPath(dataDir, repoDirName(parseRepoRef(repo.fullName)), repo.lastIndexedSha);
  return existsSync(path) ? path : undefined;
}

// Opens a repository's engine database for reading, or undefined when it has not been read
export function withEngine<T>(
  dataDir: string,
  repo: RepoRow,
  read: (engine: ReturnType<typeof openEngineReadonly>) => T,
): T | undefined {
  const path = enginePath(dataDir, repo);
  if (!path) return undefined;
  const engine = openEngineReadonly(path);
  try {
    return read(engine);
  } finally {
    engine.close();
  }
}

export { enginePath };

// Chosen pages lose their saved inputs so the writer does not reuse them; answers the slugs the wiki does not have,
// or undefined when the repository has no stored wiki
export function forgetWikiPages(
  dataDir: string,
  repo: RepoRow,
  pages: readonly string[],
): { unknown: string[] } | undefined {
  const path = enginePath(dataDir, repo);
  if (!path) return undefined;
  const engine = openEngineDb(path).$client;
  try {
    const known = new Set(
      (engine.prepare("SELECT slug FROM wiki_page").all() as Array<{ slug: string }>).map(
        (row) => row.slug,
      ),
    );
    const unknown = pages.filter((slug) => !known.has(slug));
    if (unknown.length > 0) return { unknown };
    const forget = engine.prepare("UPDATE wiki_page SET input_hash = NULL WHERE slug = ?");
    engine.transaction(() => pages.forEach((slug) => forget.run(slug)))();
    return { unknown: [] };
  } finally {
    engine.close();
  }
}

export function adminWikis(db: AppDb, dataDir: string): AdminWiki[] {
  return db
    .select()
    .from(repos)
    .where(isNotNull(repos.lastIndexedSha))
    .all()
    .map((repo) => {
      const counts = withEngine(dataDir, repo, (engine) =>
        engine.prepare("SELECT status, COUNT(*) AS n FROM wiki_page GROUP BY status").all(),
      ) as Array<{ status: string; n: number }> | undefined;
      const of = (status: string) => counts?.find((row) => row.status === status)?.n ?? 0;
      return {
        repo: repo.fullName,
        sizeTier: repo.sizeTier,
        publishedAt: iso(repo.publishedAt),
        indexedAt: iso(repo.lastIndexedAt),
        pages: {
          total: (counts ?? []).reduce((sum, row) => sum + row.n, 0),
          written: of("written"),
          failed: of("failed"),
          empty: of("empty"),
          planned: of("planned"),
        },
        openJob: findOpenJob(db, repo.id)?.kind ?? null,
      };
    })
    .sort(
      (a, b) =>
        Number(b.publishedAt !== null) - Number(a.publishedAt !== null) ||
        (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "") ||
        a.repo.localeCompare(b.repo),
    );
}

interface PageRow {
  slug: string;
  parentSlug: string | null;
  title: string;
  purpose: string;
  status: string;
  markdown: string | null;
  citations: string | null;
  model: string | null;
  updatedAt: number | null;
}

function toPage(row: PageRow): AdminPage {
  const words = row.markdown ? row.markdown.split(/\s+/).filter(Boolean).length : 0;
  const citations = (() => {
    try {
      return row.citations ? (JSON.parse(row.citations) as unknown[]).length : 0;
    } catch {
      return 0;
    }
  })();
  return {
    slug: row.slug,
    parentSlug: row.parentSlug,
    title: row.title,
    status: row.status,
    words,
    citations,
    model: row.model,
    updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
  };
}

const PAGE_COLUMNS = `slug, parent_slug AS parentSlug, title, purpose, status, markdown, citations, model,
  updated_at AS updatedAt`;

export function adminPages(dataDir: string, repo: RepoRow): AdminPage[] {
  return (
    withEngine(dataDir, repo, (engine) =>
      (
        engine.prepare(`SELECT ${PAGE_COLUMNS} FROM wiki_page ORDER BY position`).all() as PageRow[]
      ).map(toPage),
    ) ?? []
  );
}

export function adminPageText(
  dataDir: string,
  repo: RepoRow,
  slug: string,
): AdminPageText | undefined {
  return withEngine(dataDir, repo, (engine) => {
    const row = engine.prepare(`SELECT ${PAGE_COLUMNS} FROM wiki_page WHERE slug = ?`).get(slug) as
      PageRow | undefined;
    return row ? { ...toPage(row), purpose: row.purpose, markdown: row.markdown } : undefined;
  });
}

export function adminAccounts(db: AppDb): AdminAccount[] {
  const counts = new Map(
    db
      .select({ userId: userRequests.userId, n: sql<number>`count(*)` })
      .from(userRequests)
      .groupBy(userRequests.userId)
      .all()
      .map((row) => [row.userId, row.n]),
  );
  return db
    .select()
    .from(users)
    .orderBy(desc(users.lastSeenAt))
    .all()
    .map((user) => ({
      login: user.login,
      name: user.name,
      email: user.email,
      createdAt: user.createdAt.toISOString(),
      lastSeenAt: user.lastSeenAt.toISOString(),
      requests: counts.get(user.id) ?? 0,
    }));
}

const ACTIVITY_LIMIT = 60;

// Changes made from the dashboard and what the builder did, newest first
export function adminActivity(db: AppDb, now: Date): AdminActivity[] {
  const admin = db
    .select()
    .from(adminActions)
    .orderBy(desc(adminActions.createdAt))
    .limit(ACTIVITY_LIMIT)
    .all()
    .map((row): AdminActivity => ({
      at: row.createdAt.toISOString(),
      kind: "admin",
      who: row.login,
      action: row.action,
      target: row.target,
      detail: row.detail ? JSON.stringify(row.detail) : null,
    }));
  const jobs = db
    .select({ job: indexJobs, repo: repos })
    .from(indexJobs)
    .innerJoin(repos, eq(repos.id, indexJobs.repoId))
    .orderBy(
      desc(sql`coalesce(${indexJobs.finishedAt}, ${indexJobs.startedAt}, ${indexJobs.createdAt})`),
    )
    .limit(ACTIVITY_LIMIT)
    .all()
    .map(({ job, repo }): AdminActivity => {
      const waiting = isPaused(job, now);
      return {
        at: (job.finishedAt ?? job.startedAt ?? job.createdAt).toISOString(),
        kind: "job",
        who: null,
        action: `${job.kind} ${waiting ? "waiting for allowance" : job.status}`,
        target: repo.fullName,
        detail: job.error,
      };
    });
  return [...admin, ...jobs].sort((a, b) => b.at.localeCompare(a.at)).slice(0, ACTIVITY_LIMIT);
}
