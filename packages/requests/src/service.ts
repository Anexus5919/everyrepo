import {
  formatRepoRef,
  repoKey,
  type AccountRequest,
  type BuilderStatus,
  type QueueView,
  type RepoEta,
  type RepoRef,
  type RepoState,
  type RepoView,
  type SizeEstimate,
} from "@everyrepo/core";
import {
  activeRests,
  and,
  asc,
  desc,
  ensureRepo,
  eq,
  findRepo,
  gt,
  gte,
  inArray,
  indexJobs,
  isNotNull,
  orgs,
  repoRequests,
  repos,
  sql,
  usageBuckets,
  userRequests,
  type AppDb,
  type RepoRow,
  type UsageBucket,
} from "@everyrepo/db";
import { GithubError, type GithubClient } from "@everyrepo/github";
import type { Job } from "@everyrepo/queue";
import { builderStatus } from "./builders.ts";
import { enqueueBuild, promoteBuild } from "./builds.ts";
import { CapacityLedger, type CapacityConfig } from "./capacity.ts";
import {
  PUBLISH_MS,
  simulateLine,
  workFromEstimate,
  type BuildWork,
  type LineItem,
} from "./eta.ts";
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
  type Positions,
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

// Each person may have one request in progress; this is the one they already have
export class OneRequestAtATimeError extends Error {
  override readonly name = "OneRequestAtATimeError";

  constructor(readonly active: RepoView) {
    super(
      "We are working on handling several requests at once. For now you can request one repository at a time.",
    );
  }
}

// The signed-in account asking; every request belongs to one
export interface Requester {
  userId: number;
}

export interface RequestServiceOptions {
  db: AppDb;
  github: GithubClient;
  policy?: RequestPolicy;
  now?: () => Date;
  // Model and embedding allowances; without them no completion time is estimated
  capacity?: CapacityConfig | undefined;
  usage?: () => UsageBucket[];
  // Work still left for a repository that has been read, measured from its engine database
  workFor?: (repo: RepoRow) => BuildWork | undefined;
}

export interface SubmitResult {
  view: RepoView;
  // False when this requester already asked today, or when the wiki was already published
  counted: boolean;
}

export interface RequestService {
  lookup(ref: RepoRef): Promise<RepoView>;
  submit(ref: RepoRef, requester: Requester): Promise<SubmitResult>;
  queue(): QueueView;
  // Owner decisions from the command line
  approve(ref: RepoRef): Promise<RepoView>;
  decline(ref: RepoRef): RepoView;
  retry(ref: RepoRef): RepoView;
  // Links a request made before its requester had an account, keeping the time it was first made
  assign(ref: RepoRef, userId: number): RepoView;
  requests(): RepoView[];
  // Everything one account asked for, newest first
  requestsFor(userId: number): AccountRequest[];
  // Starts the next step for approved requests whose build has no job, such as after a command line run
  reconcile(): number;
}

const DAY_MS = 86_400_000;
// A failed build can be asked for again once this long has passed
const FAILED_RETRY_MS = 6 * 3_600_000;
const RECENT_MS = 30 * DAY_MS;
const RECENT_LIMIT = 6;
const ACTIVE_STATES: ReadonlySet<RepoState> = new Set(["queued", "building", "paused", "review"]);

const iso = (time: number) => new Date(time).toISOString();

// Everything a set of views shares, worked out once per call
interface Snapshot {
  now: Date;
  positions: Positions;
  builder: BuilderStatus;
  ledger: CapacityLedger | undefined;
  line: Array<LineItem & { priority: number; running: boolean }>;
  estimates: ReturnType<typeof simulateLine>;
}

export function createRequestService(options: RequestServiceOptions): RequestService {
  const { db, github } = options;
  const policy = options.policy ?? DEFAULT_REQUEST_POLICY;
  const now = options.now ?? (() => new Date());
  const usage = options.usage ?? (() => usageBuckets(db, now()));

  // Work left for a build of this repository, from its engine database once read, or from its size before that
  function workLeft(
    repo: RepoRow,
    job: Job | undefined,
    estimate: SizeEstimate | null | undefined,
  ): BuildWork {
    const measured = repo.lastIndexedSha ? options.workFor?.(repo) : undefined;
    const sized = workFromEstimate(
      estimate ?? {
        files: 0,
        sourceFiles: 0,
        sourceTokens: 50_000,
        sizeTier: repo.sizeTier ?? "S",
        truncated: false,
        languages: [],
      },
    );
    const noCalls = { summary: 0, plan: 0, page: 0 };
    if (job?.kind === "publish") {
      return { readingMs: 0, embedTokens: 0, calls: noCalls, publishMs: PUBLISH_MS };
    }
    const reading = !repo.lastIndexedSha || job?.kind === "full";
    return {
      readingMs: reading ? sized.readingMs : 0,
      embedTokens: reading ? sized.embedTokens : 0,
      calls: measured?.calls ?? sized.calls,
      publishMs: PUBLISH_MS,
    };
  }

  function takeSnapshot(): Snapshot {
    const at = now();
    const positions = queuePositions(db, at);
    const builder = builderStatus(db, at);
    const ledger = options.capacity
      ? new CapacityLedger(options.capacity, usage(), activeRests(db, at))
      : undefined;
    if (!ledger) return { now: at, positions, builder, ledger, line: [], estimates: new Map() };

    // The running build first, then the rest in the order the worker claims them
    const jobs = db
      .select({ job: indexJobs, repo: repos, request: repoRequests })
      .from(indexJobs)
      .innerJoin(repos, eq(repos.id, indexJobs.repoId))
      .leftJoin(repoRequests, eq(repoRequests.repoId, indexJobs.repoId))
      .where(and(inArray(indexJobs.status, ["queued", "running"]), eq(indexJobs.origin, "request")))
      .orderBy(asc(indexJobs.priority), asc(indexJobs.id))
      .all()
      .sort((a, b) => Number(b.job.status === "running") - Number(a.job.status === "running"));
    const line = jobs.map(({ job, repo, request }) => ({
      id: job.id,
      priority: job.priority,
      running: job.status === "running",
      work: workLeft(repo, job, request?.estimate),
      notBefore: Math.max(at.getTime(), job.runAfter?.getTime() ?? 0),
    }));
    return {
      now: at,
      positions,
      builder,
      ledger,
      line,
      estimates: simulateLine(line, ledger, at.getTime()),
    };
  }

  function toEta(
    basis: RepoEta["basis"],
    estimate: {
      startsAt: number;
      readyAt: number;
      workMs: number;
      allowanceWaitUntil: number | null;
    },
    ahead: number,
  ): RepoEta {
    return {
      basis,
      readyAt: iso(estimate.readyAt),
      startsAt: iso(estimate.startsAt),
      ahead,
      workMinutes: Math.max(1, Math.round(estimate.workMs / 60_000)),
      allowanceUntil:
        estimate.allowanceWaitUntil === null ? null : iso(estimate.allowanceWaitUntil),
    };
  }

  // Plays the line with one more build added where its size would place it
  function hypothetical(
    snap: Snapshot,
    work: BuildWork,
    priority: number,
    basis: RepoEta["basis"],
  ): RepoEta | null {
    if (!snap.ledger) return null;
    const id = -1;
    // A new job joins behind the running one and every job of its size or smaller
    const index = snap.line.findIndex((item) => !item.running && item.priority > priority);
    const at = index < 0 ? snap.line.length : index;
    const line = [...snap.line];
    line.splice(at, 0, { id, priority, running: false, work, notBefore: snap.now.getTime() });
    const estimate = simulateLine(line, snap.ledger, snap.now.getTime()).get(id);
    return estimate ? toEta(basis, estimate, at) : null;
  }

  function etaFor(snap: Snapshot, record: RepoRecord, state: RepoState): RepoEta | null {
    const job = record.openJob;
    if (
      job &&
      job.origin === "request" &&
      (state === "queued" || state === "building" || state === "paused")
    ) {
      const estimate = snap.estimates.get(job.id);
      const ahead = snap.line.findIndex((item) => item.id === job.id);
      if (!estimate) return null;
      // A paused job already knows when its allowance comes back: it is the time it runs again
      const pausedUntil = isPaused(job, snap.now) && job.runAfter ? job.runAfter.getTime() : null;
      return toEta(
        "line",
        { ...estimate, allowanceWaitUntil: estimate.allowanceWaitUntil ?? pausedUntil },
        Math.max(0, ahead),
      );
    }
    if (state === "review" || (state === "available" && record.request?.estimate)) {
      const estimate = record.request?.estimate;
      return hypothetical(
        snap,
        workLeft(record.repo, undefined, estimate),
        buildPriority(estimate?.sizeTier ?? record.repo.sizeTier),
        state === "review" ? "if-approved" : "if-requested",
      );
    }
    return null;
  }

  const describe = (
    record: RepoRecord,
    extra: { inspection?: Inspection; snap?: Snapshot } = {},
  ) => {
    const snap = extra.snap ?? takeSnapshot();
    const inspection = extra.inspection;
    return describeRecord(record, {
      now: snap.now,
      positions: snap.positions,
      builder: snap.builder,
      github: inspection?.repository ?? undefined,
      estimate: inspection?.eligible ? inspection.estimate : undefined,
      etaFor: (target, state) => etaFor(snap, target, state),
    });
  };

  const viewOf = (repo: RepoRow, extra: { inspection?: Inspection; snap?: Snapshot } = {}) =>
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

  function emptyView(repo: string, builder: BuilderStatus): RepoView {
    return {
      repo,
      state: "unavailable",
      reason: null,
      github: null,
      estimate: null,
      queue: null,
      progress: null,
      requests: 0,
      requestedAt: null,
      updatedAt: null,
      resumeAt: null,
      href: null,
      eta: null,
      builder,
    };
  }

  function unavailableView(ref: RepoRef, inspection: Inspection & { eligible: false }): RepoView {
    const name = inspection.repository?.fullName ?? formatRepoRef(ref);
    return {
      ...emptyView(name, builderStatus(db, now())),
      reason: { code: inspection.code, message: reasonMessage(inspection.code, name) },
      github: inspection.repository ? summaryFromGithub(inspection.repository) : null,
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
    // Only builds someone asked for fill the line; repositories the owner added never hold up a request
    const asked = new Set(
      db
        .select({ repoId: repoRequests.repoId })
        .from(repoRequests)
        .where(gt(repoRequests.count, 0))
        .all()
        .map((row) => row.repoId),
    );
    const at = now();
    const waiting = db
      .select()
      .from(indexJobs)
      .where(and(eq(indexJobs.status, "queued"), eq(indexJobs.origin, "request")))
      .all()
      .filter((job) => asked.has(job.repoId) && !isPaused(job, at)).length;
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

  // An account counts once per repository, and the time it first asked is kept as its request history
  function recordRequester(repoId: number, userId: number): boolean {
    const at = now();
    const inserted = db
      .insert(userRequests)
      .values({ userId, repoId, requestedAt: at })
      .onConflictDoNothing()
      .run();
    if (inserted.changes === 0) return false;
    db.update(repoRequests)
      .set({ count: sql`${repoRequests.count} + 1`, lastAt: at })
      .where(eq(repoRequests.repoId, repoId))
      .run();
    return true;
  }

  function requestedBy(userId: number): Array<{ repo: RepoRow; requestedAt: Date }> {
    return db
      .select({ repo: repos, requestedAt: userRequests.requestedAt })
      .from(userRequests)
      .innerJoin(repos, eq(repos.id, userRequests.repoId))
      .where(eq(userRequests.userId, userId))
      .orderBy(desc(userRequests.requestedAt))
      .all();
  }

  // The request this account is still waiting on, if any; ready, failed and declined ones free it to ask again
  function activeRequest(userId: number): { repo: RepoRow; view: RepoView } | undefined {
    const snap = takeSnapshot();
    for (const { repo } of requestedBy(userId)) {
      const view = viewOf(repo, { snap });
      if (ACTIVE_STATES.has(view.state)) return { repo, view };
    }
    return undefined;
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
  function joinExisting(repo: RepoRow, record: RepoRecord, requester: Requester): SubmitResult {
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
    const counted = recordRequester(repo.id, requester.userId);
    promoteBuild(db, repo.id, buildPriority(record.request?.estimate?.sizeTier ?? repo.sizeTier));
    return { view: viewOf(repo), counted };
  }

  const settled = (view: RepoView) => view.state !== "available";

  // A second request is refused unless it names the repository the person already waits on, even by an old name
  async function guardOneAtATime(ref: RepoRef, requester: Requester): Promise<void> {
    const active = activeRequest(requester.userId);
    if (!active) return;
    if (repoKey(ref) === active.repo.key) return;
    if (!findRepo(db, ref) && active.repo.githubId !== null) {
      const same = await github
        .repository(ref)
        .then((repository) => repository.id === active.repo.githubId)
        .catch(() => false);
      if (same) return;
    }
    throw new OneRequestAtATimeError(active.view);
  }

  return {
    async lookup(ref) {
      const snap = takeSnapshot();
      const known = findRepo(db, ref);
      if (known) {
        const view = viewOf(known, { snap });
        if (settled(view)) return view;
      }
      const inspection = await inspect(ref);
      if (!inspection.eligible) return unavailableView(ref, inspection);
      const row =
        findRepo(db, { owner: inspection.repository.owner, name: inspection.repository.name }) ??
        db.select().from(repos).where(eq(repos.githubId, inspection.repository.id)).get();
      if (row) {
        const view = viewOf(row, { inspection, snap });
        if (settled(view)) return view;
      }
      const decision = decideRequest(inspection.estimate, policy, decisionCounts());
      const name = inspection.repository.fullName;
      const priority = buildPriority(inspection.estimate.sizeTier);
      const work = workFromEstimate(inspection.estimate);
      return {
        ...emptyView(name, snap.builder),
        state: "available",
        reason:
          decision.decision === "review"
            ? { code: decision.reason, message: reasonMessage(decision.reason, name) }
            : null,
        github: summaryFromGithub(inspection.repository),
        estimate: inspection.estimate,
        eta: hypothetical(
          snap,
          work,
          priority,
          decision.decision === "review" ? "if-approved" : "if-requested",
        ),
      };
    },

    async submit(ref, requester) {
      await guardOneAtATime(ref, requester);
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
          return recordRequester(repo.id, requester.userId);
        },
        { behavior: "immediate" },
      );
      return { view: viewOf(repo, { inspection }), counted };
    },

    queue() {
      const snap = takeSnapshot();
      const at = snap.now;
      const seen = new Set<number>();
      const views = (rows: RepoRow[]) =>
        rows.flatMap((row) => {
          if (seen.has(row.id)) return [];
          seen.add(row.id);
          return [viewOf(row, { snap })];
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
        .limit(20)
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
        builder: snap.builder,
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
      enqueueBuild(db, repo, buildPriority(request.estimate?.sizeTier, request.count > 0));
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
      enqueueBuild(
        db,
        repo,
        buildPriority(record.request.estimate?.sizeTier, record.request.count > 0),
      );
      return viewOf(repo);
    },

    assign(ref, userId) {
      const repo = findRepo(db, ref);
      const record = repo ? loadRecord(db, repo) : undefined;
      if (!repo || !record?.request) throw new Error(`No request for ${formatRepoRef(ref)}`);
      db.insert(userRequests)
        .values({ userId, repoId: repo.id, requestedAt: record.request.firstAt })
        .onConflictDoNothing()
        .run();
      return viewOf(repo);
    },

    requestsFor(userId) {
      const snap = takeSnapshot();
      return requestedBy(userId).map(({ repo, requestedAt }) => ({
        requestedAt: requestedAt.toISOString(),
        view: viewOf(repo, { snap }),
      }));
    },

    requests() {
      const snap = takeSnapshot();
      const rows = db
        .select({ repo: repos })
        .from(repoRequests)
        .innerJoin(repos, eq(repos.id, repoRequests.repoId))
        .orderBy(desc(repoRequests.lastAt))
        .all();
      return rows.map((row) => viewOf(row.repo, { snap }));
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
        const priority = buildPriority(request.estimate?.sizeTier, request.count > 0);
        if (enqueueBuild(db, repo, priority)) started += 1;
      }
      return started;
    },
  };
}
