import {
  formatRepoRef,
  repoKey,
  type QueueView,
  type RepoRef,
  type RepoView,
} from "@everyrepo/core";
import {
  and,
  asc,
  desc,
  ensureRepo,
  eq,
  findRepo,
  gte,
  inArray,
  indexJobs,
  isNotNull,
  lt,
  orgs,
  repoRequests,
  repos,
  requestVoters,
  sql,
  type AppDb,
  type RepoRow,
} from "@everyrepo/db";
import { GithubError, type GithubClient } from "@everyrepo/github";
import { enqueueBuild } from "./builds.ts";
import { reasonMessage } from "./messages.ts";
import {
  buildPriority,
  decideRequest,
  DEFAULT_REQUEST_POLICY,
  inspectRepository,
  type Inspection,
  type RequestPolicy,
} from "./policy.ts";
import {
  describeRecord,
  isPaused,
  loadRecord,
  queuePositions,
  summaryFromGithub,
  type RepoRecord,
} from "./views.ts";

// GitHub could not answer, so nothing can be decided yet; the caller should try again later
export class RequestsUnavailableError extends Error {
  override readonly name = "RequestsUnavailableError";

  constructor(
    message: string,
    readonly retryAt?: Date,
  ) {
    super(message);
  }
}

export interface RequestServiceOptions {
  db: AppDb;
  github: GithubClient;
  policy?: RequestPolicy;
  now?: () => Date;
}

export interface SubmitResult {
  view: RepoView;
  // False when this requester already asked today, or when the wiki was already published
  counted: boolean;
}

export interface RequestService {
  lookup(ref: RepoRef): Promise<RepoView>;
  submit(ref: RepoRef, requester: string): Promise<SubmitResult>;
  queue(): QueueView;
  // Owner decisions from the command line
  approve(ref: RepoRef): Promise<RepoView>;
  decline(ref: RepoRef): RepoView;
  retry(ref: RepoRef): RepoView;
  requests(): RepoView[];
  // Starts the next step for approved requests whose build has no job, such as after a command line run
  reconcile(): number;
}

const DAY_MS = 86_400_000;
// A failed build can be asked for again once this long has passed
const FAILED_RETRY_MS = 6 * 3_600_000;
const RECENT_MS = 30 * DAY_MS;
const RECENT_LIMIT = 6;

export function createRequestService(options: RequestServiceOptions): RequestService {
  const { db, github } = options;
  const policy = options.policy ?? DEFAULT_REQUEST_POLICY;
  const now = options.now ?? (() => new Date());

  const describe = (record: RepoRecord, extra: { inspection?: Inspection } = {}) => {
    const at = now();
    const inspection = extra.inspection;
    return describeRecord(record, {
      now: at,
      positions: queuePositions(db, at),
      github: inspection?.repository ?? undefined,
      estimate: inspection?.eligible ? inspection.estimate : undefined,
    });
  };

  const viewOf = (repo: RepoRow, extra: { inspection?: Inspection } = {}) =>
    describe(loadRecord(db, repo), extra);

  async function inspect(ref: RepoRef): Promise<Inspection> {
    try {
      return await inspectRepository(github, ref);
    } catch (error) {
      if (error instanceof GithubError) {
        throw new RequestsUnavailableError(
          error.kind === "rate-limited"
            ? "GitHub is limiting lookups right now. Try again in a few minutes."
            : "GitHub could not be reached. Try again in a moment.",
          error.retryAt,
        );
      }
      throw error;
    }
  }

  function unavailableView(ref: RepoRef, inspection: Inspection & { eligible: false }): RepoView {
    const name = inspection.repository?.fullName ?? formatRepoRef(ref);
    return {
      repo: name,
      state: "unavailable",
      reason: { code: inspection.code, message: reasonMessage(inspection.code, name) },
      github: inspection.repository ? summaryFromGithub(inspection.repository) : null,
      estimate: null,
      queue: null,
      progress: null,
      requests: 0,
      requestedAt: null,
      updatedAt: null,
      resumeAt: null,
      href: null,
    };
  }

  const startOfDay = (date: Date) => new Date(Math.floor(date.getTime() / DAY_MS) * DAY_MS);

  function decisionCounts() {
    const approvedToday = db
      .select({ count: sql<number>`count(*)` })
      .from(repoRequests)
      .where(
        and(
          eq(repoRequests.decision, "approved"),
          eq(repoRequests.decidedBy, "rules"),
          gte(repoRequests.decidedAt, startOfDay(now())),
        ),
      )
      .get()!.count;
    const waiting = queuePositions(db, now()).size;
    return { approvedToday, waiting };
  }

  // The same repository keeps its row when it is renamed or moved to another owner
  function syncRepository(inspection: Inspection & { eligible: true }): RepoRow {
    const { repository } = inspection;
    const ref = { owner: repository.owner, name: repository.name };
    const moved = db.select().from(repos).where(eq(repos.githubId, repository.id)).get();
    if (
      moved &&
      moved.key !== repoKey(ref) &&
      !findRepo(db, ref) &&
      !loadRecord(db, moved).openJob
    ) {
      const orgKey = ref.owner.toLowerCase();
      db.insert(orgs).values({ login: ref.owner, key: orgKey }).onConflictDoNothing().run();
      const org = db.select().from(orgs).where(eq(orgs.key, orgKey)).get()!;
      db.update(repos)
        .set({ orgId: org.id, name: ref.name, fullName: repository.fullName, key: repoKey(ref) })
        .where(eq(repos.id, moved.id))
        .run();
    }
    const row = ensureRepo(db, ref);
    return db
      .update(repos)
      .set({
        githubId: repository.id,
        description: repository.description,
        stars: repository.stars,
        archived: repository.archived,
        defaultBranch: row.defaultBranch ?? repository.defaultBranch,
      })
      .where(eq(repos.id, row.id))
      .returning()
      .get();
  }

  // Each requester counts once while their salted hash is kept, which is one day
  function countRequester(repoId: number, requester: string): boolean {
    const at = now();
    db.delete(requestVoters)
      .where(lt(requestVoters.createdAt, new Date(at.getTime() - DAY_MS)))
      .run();
    const inserted = db
      .insert(requestVoters)
      .values({ repoId, voter: requester, createdAt: at })
      .onConflictDoNothing()
      .run();
    if (inserted.changes === 0) return false;
    db.update(repoRequests)
      .set({ count: sql`${repoRequests.count} + 1`, lastAt: at })
      .where(eq(repoRequests.repoId, repoId))
      .run();
    return true;
  }

  function recordRequest(
    repo: RepoRow,
    values: Pick<
      typeof repoRequests.$inferInsert,
      "decision" | "reason" | "decidedBy" | "estimate"
    >,
  ): void {
    const at = now();
    db.insert(repoRequests)
      .values({ repoId: repo.id, count: 0, firstAt: at, lastAt: at, decidedAt: at, ...values })
      .onConflictDoNothing()
      .run();
  }

  // Requests for a repository whose state is already settled: join it, or ask again after a failure
  function joinExisting(repo: RepoRow, record: RepoRecord, requester: string): SubmitResult {
    const view = describe(record);
    if (view.state === "ready") return { view, counted: false };
    if (!record.request) {
      recordRequest(repo, {
        decision: "approved",
        reason: null,
        decidedBy: "existing",
        estimate: null,
      });
    }
    const failedAt = record.lastJob?.finishedAt?.getTime() ?? 0;
    if (view.state === "failed" && now().getTime() - failedAt >= FAILED_RETRY_MS) {
      enqueueBuild(db, repo, buildPriority(record.request?.estimate?.sizeTier));
    }
    const counted = countRequester(repo.id, requester);
    return { view: viewOf(repo), counted };
  }

  const settled = (view: RepoView) => view.state !== "available";

  return {
    async lookup(ref) {
      const known = findRepo(db, ref);
      if (known) {
        const view = viewOf(known);
        if (settled(view)) return view;
      }
      const inspection = await inspect(ref);
      if (!inspection.eligible) return unavailableView(ref, inspection);
      const row =
        findRepo(db, { owner: inspection.repository.owner, name: inspection.repository.name }) ??
        db.select().from(repos).where(eq(repos.githubId, inspection.repository.id)).get();
      if (row) {
        const view = viewOf(row, { inspection });
        if (settled(view)) return view;
      }
      const decision = decideRequest(inspection.estimate, policy, decisionCounts());
      const name = inspection.repository.fullName;
      return {
        repo: name,
        state: "available",
        reason:
          decision.decision === "review"
            ? { code: decision.reason, message: reasonMessage(decision.reason, name) }
            : null,
        github: summaryFromGithub(inspection.repository),
        estimate: inspection.estimate,
        queue: null,
        progress: null,
        requests: 0,
        requestedAt: null,
        updatedAt: null,
        resumeAt: null,
        href: null,
      };
    },

    async submit(ref, requester) {
      const known = findRepo(db, ref);
      if (known) {
        const record = loadRecord(db, known);
        if (settled(describe(record))) return joinExisting(known, record, requester);
      }
      const inspection = await inspect(ref);
      if (!inspection.eligible) return { view: unavailableView(ref, inspection), counted: false };

      const repo = syncRepository(inspection);
      const record = loadRecord(db, repo);
      if (settled(describe(record))) return joinExisting(repo, record, requester);

      const counted = db.transaction(
        () => {
          const decision = decideRequest(inspection.estimate, policy, decisionCounts());
          recordRequest(repo, {
            decision: decision.decision,
            reason: decision.decision === "review" ? decision.reason : null,
            decidedBy: "rules",
            estimate: inspection.estimate,
          });
          if (decision.decision === "approved") {
            enqueueBuild(db, repo, buildPriority(inspection.estimate.sizeTier));
          }
          return countRequester(repo.id, requester);
        },
        { behavior: "immediate" },
      );
      return { view: viewOf(repo, { inspection }), counted };
    },

    queue() {
      const at = now();
      const seen = new Set<number>();
      const views = (rows: RepoRow[]) =>
        rows.flatMap((row) => {
          if (seen.has(row.id)) return [];
          seen.add(row.id);
          return [viewOf(row)];
        });
      const reposFor = (ids: number[]) => {
        if (ids.length === 0) return [];
        const byId = new Map(
          db
            .select()
            .from(repos)
            .where(inArray(repos.id, ids))
            .all()
            .map((row) => [row.id, row]),
        );
        return ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
      };

      const running = db
        .select()
        .from(indexJobs)
        .where(eq(indexJobs.status, "running"))
        .orderBy(asc(indexJobs.startedAt))
        .all();
      const queued = db
        .select()
        .from(indexJobs)
        .where(eq(indexJobs.status, "queued"))
        .orderBy(asc(indexJobs.priority), asc(indexJobs.id))
        .all();
      // Jobs in line come first, then those waiting for an allowance or started from the command line
      const inLine = queued.filter((job) => job.origin === "request" && !isPaused(job, at));
      const others = queued.filter((job) => !inLine.includes(job));
      const review = db
        .select()
        .from(repoRequests)
        .where(eq(repoRequests.decision, "review"))
        .orderBy(desc(repoRequests.count), asc(repoRequests.firstAt))
        .all();
      const published = db
        .select()
        .from(repos)
        .where(
          and(
            isNotNull(repos.publishedAt),
            gte(repos.publishedAt, new Date(at.getTime() - RECENT_MS)),
          ),
        )
        .orderBy(desc(repos.publishedAt))
        .limit(RECENT_LIMIT)
        .all();

      return {
        building: views(reposFor(running.map((job) => job.repoId))),
        waiting: views(reposFor([...inLine, ...others].map((job) => job.repoId))),
        review: views(reposFor(review.map((row) => row.repoId))),
        recent: views(published),
        updatedAt: at.toISOString(),
      };
    },

    async approve(ref) {
      let repo = findRepo(db, ref);
      if (!repo || !loadRecord(db, repo).request) {
        const inspection = await inspect(ref);
        if (!inspection.eligible) {
          throw new Error(reasonMessage(inspection.code, formatRepoRef(ref)));
        }
        repo = syncRepository(inspection);
        recordRequest(repo, {
          decision: "approved",
          reason: null,
          decidedBy: "owner",
          estimate: inspection.estimate,
        });
      }
      const request = loadRecord(db, repo).request!;
      db.update(repoRequests)
        .set({ decision: "approved", reason: null, decidedBy: "owner", decidedAt: now() })
        .where(eq(repoRequests.repoId, repo.id))
        .run();
      enqueueBuild(db, repo, buildPriority(request.estimate?.sizeTier));
      return viewOf(repo);
    },

    decline(ref) {
      const repo = findRepo(db, ref);
      const record = repo ? loadRecord(db, repo) : undefined;
      if (!repo || !record?.request) throw new Error(`No request for ${formatRepoRef(ref)}`);
      db.update(repoRequests)
        .set({ decision: "rejected", reason: "declined", decidedBy: "owner", decidedAt: now() })
        .where(eq(repoRequests.repoId, repo.id))
        .run();
      // A queued build stops here; a running one finishes its current job first
      if (record.openJob?.status === "queued" && record.openJob.origin === "request") {
        db.update(indexJobs)
          .set({ status: "cancelled", finishedAt: now(), lockedBy: null })
          .where(eq(indexJobs.id, record.openJob.id))
          .run();
      }
      return viewOf(repo);
    },

    retry(ref) {
      const repo = findRepo(db, ref);
      const record = repo ? loadRecord(db, repo) : undefined;
      if (!repo || !record?.request) throw new Error(`No request for ${formatRepoRef(ref)}`);
      if (record.request.decision !== "approved") {
        throw new Error(`${formatRepoRef(ref)} is not approved; approve it first`);
      }
      enqueueBuild(db, repo, buildPriority(record.request.estimate?.sizeTier));
      return viewOf(repo);
    },

    requests() {
      const rows = db
        .select({ repo: repos })
        .from(repoRequests)
        .innerJoin(repos, eq(repos.id, repoRequests.repoId))
        .orderBy(desc(repoRequests.lastAt))
        .all();
      return rows.map((row) => viewOf(row.repo));
    },

    reconcile() {
      const approved = db
        .select({ repo: repos, request: repoRequests })
        .from(repoRequests)
        .innerJoin(repos, eq(repos.id, repoRequests.repoId))
        .where(eq(repoRequests.decision, "approved"))
        .all();
      let started = 0;
      for (const { repo, request } of approved) {
        const record = loadRecord(db, repo);
        if (repo.publishedAt || record.openJob) continue;
        if (record.lastJob?.status === "failed" || record.lastJob?.status === "cancelled") continue;
        if (enqueueBuild(db, repo, buildPriority(request.estimate?.sizeTier))) started += 1;
      }
      return started;
    },
  };
}
