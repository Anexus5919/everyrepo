import { formatRepoRef, parseRepoRef, type RepoRef } from "@everyrepo/core";
import {
  ensureRepo,
  eq,
  indexJobs,
  jobStages,
  openAppDb,
  repoRequests,
  repos,
  users,
  type AppDb,
} from "@everyrepo/db";
import {
  GithubError,
  type GithubClient,
  type GithubErrorKind,
  type GithubRepository,
} from "@everyrepo/github";
import { claimJob, claimNextJob, runJob, StageDeferredError } from "@everyrepo/queue";
import { beforeEach, describe, expect, it } from "vitest";
import { touchWorker } from "./builders.ts";
import { followUp, markPublished } from "./builds.ts";
import type { CapacityConfig } from "./capacity.ts";
import {
  createRequestService,
  OneRequestAtATimeError,
  RequestsUnavailableError,
  type RequestService,
} from "./service.ts";

interface FakeRepo {
  repository?: Partial<GithubRepository>;
  files?: Array<{ path: string; bytes: number }>;
  error?: GithubErrorKind;
  treeError?: GithubErrorKind;
  truncated?: boolean;
}

// Source files adding up to the given number of tokens at 3.7 bytes each
const sourceFiles = (tokens: number, count = 10) =>
  Array.from({ length: count }, (_, index) => ({
    path: `src/file${index}.ts`,
    bytes: Math.round((tokens * 3.7) / count),
  }));

function fakeGithub(entries: Record<string, FakeRepo>) {
  const calls: string[] = [];
  const find = (ref: RepoRef) => {
    const entry = entries[formatRepoRef(ref).toLowerCase()];
    if (!entry) throw new GithubError("not-found", "missing");
    return entry;
  };
  const client: GithubClient = {
    async repository(ref) {
      calls.push(`repo ${formatRepoRef(ref)}`);
      const entry = find(ref);
      if (entry.error) throw new GithubError(entry.error, entry.error);
      const [owner = "", name = ""] = (entry.repository?.fullName ?? formatRepoRef(ref)).split("/");
      return {
        // Every repository has its own GitHub id, which stays the same when it is renamed
        id: Object.keys(entries).indexOf(formatRepoRef(ref).toLowerCase()) + 1,
        fullName: `${owner}/${name}`,
        owner,
        name,
        description: "A project",
        stars: 10,
        language: "TypeScript",
        defaultBranch: "main",
        archived: false,
        disabled: false,
        private: false,
        fork: false,
        parent: null,
        license: "MIT",
        sizeKb: 100,
        url: `https://github.com/${owner}/${name}`,
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
        pushedAt: null,
        ...entry.repository,
      };
    },
    async fileList(ref) {
      calls.push(`tree ${formatRepoRef(ref)}`);
      const entry = find(ref);
      if (entry.treeError) throw new GithubError(entry.treeError, entry.treeError);
      return { files: entry.files ?? [], truncated: entry.truncated ?? false };
    },
    async file() {
      return undefined;
    },
  };
  return { calls, client };
}

let db: AppDb;
let clock: Date;
const at = (iso: string) => {
  clock = new Date(iso);
};

function service(
  entries: Record<string, FakeRepo>,
  policy = { autoApproveMaxTier: "M" as const, autoApprovePerDay: 5, maxWaiting: 10 },
): { requests: RequestService; calls: string[] } {
  const { calls, client } = fakeGithub(entries);
  return {
    requests: createRequestService({ db, github: client, policy, now: () => clock }),
    calls,
  };
}

const ref = parseRepoRef;
// One person per name, identified the way the API identifies a browser
// Accounts by name, created the first time a test asks for one
let people = new Map<string, number>();
const person = (name: string) => {
  let userId = people.get(name);
  if (userId === undefined) {
    userId = db
      .insert(users)
      .values({ githubId: 1_000 + people.size, login: name, createdAt: clock, lastSeenAt: clock })
      .returning()
      .get().id;
    people.set(name, userId);
  }
  return { userId };
};
const jobsFor = (name: string) => {
  const row = db.select().from(repos).where(eq(repos.fullName, name)).get();
  return row ? db.select().from(indexJobs).where(eq(indexJobs.repoId, row.id)).all() : [];
};

beforeEach(() => {
  db = openAppDb(":memory:");
  people = new Map();
  at("2026-09-16T08:00:00Z");
});

describe("looking up a repository", () => {
  it("describes an eligible repository nobody asked for without storing anything", async () => {
    const { requests } = service({ "acme/app": { files: sourceFiles(20_000) } });
    const view = await requests.lookup(ref("acme/app"));
    expect(view).toMatchObject({
      repo: "acme/app",
      state: "available",
      reason: null,
      requests: 0,
      github: { description: "A project", stars: 10, language: "TypeScript" },
      estimate: { sourceFiles: 10, sizeTier: "S", truncated: false },
    });
    expect(db.select().from(repos).all()).toEqual([]);
  });

  it("warns before a request that a large repository is approved by hand", async () => {
    const { requests } = service({ "acme/big": { files: sourceFiles(2_000_000) } });
    const view = await requests.lookup(ref("acme/big"));
    expect(view.state).toBe("available");
    expect(view.estimate?.sizeTier).toBe("L");
    expect(view.reason?.code).toBe("large");
  });

  it("explains why a repository cannot have a wiki", async () => {
    const { requests } = service({
      "acme/private": { repository: { private: true }, files: sourceFiles(1_000) },
      "acme/empty": { treeError: "empty" },
      "acme/docs": { files: [{ path: "README.md", bytes: 4_000 }] },
      "acme/blocked": { error: "unavailable" },
    });
    const code = async (name: string) => (await requests.lookup(ref(name))).reason?.code;
    expect((await requests.lookup(ref("acme/missing"))).state).toBe("unavailable");
    expect(await code("acme/missing")).toBe("not-found");
    expect(await code("acme/private")).toBe("private");
    expect(await code("acme/empty")).toBe("empty");
    expect(await code("acme/docs")).toBe("no-source");
    expect(await code("acme/blocked")).toBe("unavailable");
    // A private repository's details never reach the page
    expect((await requests.lookup(ref("acme/private"))).github).toBeNull();
  });

  it("reports a GitHub rate limit as a temporary problem", async () => {
    const { requests } = service({ "acme/app": { error: "rate-limited" } });
    await expect(requests.lookup(ref("acme/app"))).rejects.toBeInstanceOf(RequestsUnavailableError);
  });

  it("answers from the registry for a published wiki without asking GitHub", async () => {
    const { requests, calls } = service({});
    const row = ensureRepo(db, ref("mui/mui-x"));
    markPublished(db, row.id, "abc", clock);
    expect(await requests.lookup(ref("MUI/MUI-X"))).toMatchObject({
      repo: "mui/mui-x",
      state: "ready",
      href: "/mui/mui-x",
    });
    expect(calls).toEqual([]);
  });
});

describe("requesting a repository", () => {
  it("approves a small repository, queues its build and counts each requester once", async () => {
    const { requests } = service({
      "acme/app": { repository: { fullName: "Acme/App" }, files: sourceFiles(20_000) },
    });
    const first = await requests.submit(ref("acme/APP"), person("visitor-1:acme/app"));
    expect(first.counted).toBe(true);
    expect(first.view).toMatchObject({
      repo: "Acme/App",
      state: "queued",
      queue: { position: 1, total: 1 },
      requests: 1,
    });
    const [job] = jobsFor("Acme/App");
    expect(job).toMatchObject({ kind: "full", origin: "request", priority: 80, status: "queued" });

    expect((await requests.submit(ref("Acme/App"), person("visitor-1:acme/app"))).counted).toBe(
      false,
    );
    const third = await requests.submit(ref("acme/app"), person("visitor-2:acme/app"));
    expect(third).toMatchObject({ counted: true, view: { requests: 2 } });
    expect(jobsFor("Acme/App")).toHaveLength(1);

    // An account counts once for good, however often it asks
    at("2026-09-17T09:00:00Z");
    expect((await requests.submit(ref("acme/app"), person("visitor-1:acme/app"))).counted).toBe(
      false,
    );
  });

  it("puts smaller repositories ahead in the queue", async () => {
    const { requests } = service({
      "acme/medium": { files: sourceFiles(400_000) },
      "acme/small": { files: sourceFiles(10_000) },
    });
    await requests.submit(ref("acme/medium"), person("a:acme/medium"));
    const small = await requests.submit(ref("acme/small"), person("a:acme/small"));
    expect(small.view.queue).toEqual({ position: 1, total: 2 });
    expect((await requests.lookup(ref("acme/medium"))).queue).toEqual({ position: 2, total: 2 });
  });

  it("holds large requests and those past the daily allowance for review", async () => {
    const { requests } = service(
      {
        "acme/big": { files: sourceFiles(3_000_000, 40) },
        "acme/one": { files: sourceFiles(5_000) },
        "acme/two": { files: sourceFiles(5_000) },
      },
      { autoApproveMaxTier: "M", autoApprovePerDay: 1, maxWaiting: 10 },
    );
    expect((await requests.submit(ref("acme/big"), person("a:acme/big"))).view).toMatchObject({
      state: "review",
      reason: { code: "large" },
    });
    expect(jobsFor("acme/big")).toEqual([]);
    expect((await requests.submit(ref("acme/one"), person("a:acme/one"))).view.state).toBe(
      "queued",
    );
    expect((await requests.submit(ref("acme/two"), person("a:acme/two"))).view.reason?.code).toBe(
      "daily-limit",
    );

    const approved = await requests.approve(ref("acme/big"));
    expect(approved.state).toBe("queued");
    expect(jobsFor("acme/big")[0]).toMatchObject({ kind: "full", priority: 120 });

    const declined = requests.decline(ref("acme/two"));
    expect(declined).toMatchObject({ state: "rejected", reason: { code: "declined" } });
  });

  it("does not store requests for repositories that cannot have a wiki", async () => {
    const { requests } = service({ "acme/docs": { files: [{ path: "README.md", bytes: 10 }] } });
    const result = await requests.submit(ref("acme/docs"), person("a:acme/docs"));
    expect(result).toMatchObject({ counted: false, view: { state: "unavailable" } });
    expect(db.select().from(repos).all()).toEqual([]);
  });

  it("keeps one row when a repository was renamed on GitHub", async () => {
    const old = ensureRepo(db, ref("old-owner/app"));
    db.update(repos).set({ githubId: 77 }).where(eq(repos.id, old.id)).run();
    const { requests } = service({
      "new-owner/app": { repository: { id: 77, fullName: "new-owner/app" }, files: sourceFiles(1) },
    });
    await requests.submit(ref("new-owner/app"), person("a:new-owner/app"));
    expect(db.select({ name: repos.fullName }).from(repos).all()).toEqual([
      { name: "new-owner/app" },
    ]);
  });

  it("joins a build that is already under way instead of starting another", async () => {
    const { requests, calls } = service({});
    const row = ensureRepo(db, ref("medusajs/medusa"));
    db.insert(indexJobs)
      .values({ repoId: row.id, kind: "wiki", stages: ["summarize"], params: {} })
      .run();
    const result = await requests.submit(ref("medusajs/medusa"), person("a:medusajs/medusa"));
    expect(result).toMatchObject({ counted: true, view: { state: "queued", requests: 1 } });
    expect(db.select().from(repoRequests).get()?.decidedBy).toBe("existing");
    expect(calls).toEqual([]);
  });
});

describe("following a build", () => {
  it("shows the stage, counts and overall share while a job runs", async () => {
    const { requests } = service({ "acme/app": { files: sourceFiles(1_000) } });
    await requests.submit(ref("acme/app"), person("a:acme/app"));
    let during: unknown;
    const job = claimNextJob(db, "worker", { origin: "request", now: clock })!;
    await runJob(
      db,
      job,
      {
        source: async ({ progress }) => {
          progress(3, 4);
          during = await requests.lookup(ref("acme/app"));
          throw new StageDeferredError("allowance used", {
            retryAt: new Date("2026-09-16T12:00:00Z"),
          });
        },
      },
      { now: () => clock },
    );
    expect(during).toMatchObject({
      state: "building",
      progress: {
        phase: "reading",
        stage: "source",
        label: "Downloading the code",
        step: 1,
        steps: 12,
        done: 3,
        total: 4,
        percent: 3,
      },
    });
    expect(await requests.lookup(ref("acme/app"))).toMatchObject({
      state: "paused",
      resumeAt: "2026-09-16T12:00:00.000Z",
      reason: { code: "allowance" },
      queue: null,
      progress: { stage: "source" },
    });
  });

  it("reports a failed build and lets people ask again after a while", async () => {
    const { requests } = service({ "acme/app": { files: sourceFiles(1_000) } });
    await requests.submit(ref("acme/app"), person("a:acme/app"));
    const [queued] = jobsFor("acme/app");
    const crash = { source: async () => "ok", detect: async () => Promise.reject(new Error("x")) };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await runJob(db, claimJob(db, queued!.id, "worker", { now: clock })!, crash, {
        now: () => clock,
      });
    }
    const failed = await requests.lookup(ref("acme/app"));
    expect(failed).toMatchObject({ state: "failed", reason: { code: "failed" } });
    expect(failed.reason?.message).toContain("sorting the files");
    expect(failed.progress).toMatchObject({ stage: "detect", phase: "reading" });

    await requests.submit(ref("acme/app"), person("b:acme/app"));
    expect(jobsFor("acme/app")).toHaveLength(1);
    at("2026-09-16T15:00:00Z");
    expect((await requests.submit(ref("acme/app"), person("c:acme/app"))).view.state).toBe(
      "queued",
    );
    expect(jobsFor("acme/app")).toHaveLength(2);
  });

  it("chains reading, writing and publishing, and restarts builds that lost their job", async () => {
    const { requests } = service({ "acme/app": { files: sourceFiles(1_000) } });
    await requests.submit(ref("acme/app"), person("a:acme/app"));
    const pass = (stages: readonly string[]) =>
      Object.fromEntries(stages.map((stage) => [stage, async () => stage]));

    const full = claimNextJob(db, "w", { origin: "request", now: clock })!;
    const read = await runJob(db, full, pass(full.stages));
    const wiki = followUp(db, read)!;
    expect(wiki).toMatchObject({ kind: "wiki", origin: "request", priority: 80 });
    const written = await runJob(db, claimJob(db, wiki.id, "w")!, pass(wiki.stages));
    const publish = followUp(db, written)!;
    expect(publish).toMatchObject({ kind: "publish", stages: ["publish"] });
    const published = await runJob(db, claimJob(db, publish.id, "w")!, pass(["publish"]));
    markPublished(db, published.repoId, "abc", clock);
    expect(followUp(db, published)).toBeUndefined();

    // A command line run that finished the wiki leaves no job behind for the request
    const other = ensureRepo(db, ref("acme/other"));
    db.update(repos).set({ lastIndexedSha: "def" }).where(eq(repos.id, other.id)).run();
    db.insert(repoRequests)
      .values({
        repoId: other.id,
        decision: "approved",
        decidedBy: "owner",
        count: 1,
        firstAt: clock,
        lastAt: clock,
        decidedAt: clock,
      })
      .run();
    expect(requests.reconcile()).toBe(1);
    expect(jobsFor("acme/other")[0]).toMatchObject({ kind: "wiki", origin: "request" });
    expect(requests.reconcile()).toBe(0);
  });

  it("lists builds in progress, the line, requests in review and recent wikis", async () => {
    const { requests } = service({
      "acme/running": { files: sourceFiles(1_000) },
      "acme/waiting": { files: sourceFiles(1_000) },
      "acme/huge": { files: sourceFiles(9_000_000, 100), truncated: true },
    });
    await requests.submit(ref("acme/running"), person("a:acme/running"));
    await requests.submit(ref("acme/waiting"), person("a:acme/waiting"));
    await requests.submit(ref("acme/huge"), person("a:acme/huge"));
    claimNextJob(db, "worker", { origin: "request", now: clock });
    const done = ensureRepo(db, ref("acme/done"));
    markPublished(db, done.id, "abc", clock);

    const queue = requests.queue();
    expect(queue.building.map((view) => view.repo)).toEqual(["acme/running"]);
    expect(queue.waiting.map((view) => [view.repo, view.queue?.position])).toEqual([
      ["acme/waiting", 1],
    ]);
    expect(queue.review.map((view) => [view.repo, view.estimate?.sizeTier])).toEqual([
      ["acme/huge", "XL"],
    ]);
    expect(queue.recent.map((view) => view.repo)).toEqual(["acme/done"]);
  });
});

describe("one request at a time", () => {
  it("refuses an account a second repository until its first one is finished", async () => {
    const { requests } = service({
      "acme/one": { files: sourceFiles(5_000) },
      "acme/two": { files: sourceFiles(5_000) },
      "acme/three": { files: sourceFiles(5_000) },
    });
    const ada = person("ada");
    await requests.submit(ref("acme/one"), ada);

    const refused = await requests.submit(ref("acme/two"), ada).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(OneRequestAtATimeError);
    expect((refused as OneRequestAtATimeError).active).toMatchObject({
      repo: "acme/one",
      state: "queued",
    });
    expect(jobsFor("acme/two")).toEqual([]);

    // Another account is not held back by it, and asking again for the same repository is fine
    expect((await requests.submit(ref("acme/two"), person("grace"))).view.state).toBe("queued");
    expect((await requests.submit(ref("acme/one"), ada)).view.repo).toBe("acme/one");

    const one = db.select().from(repos).where(eq(repos.fullName, "acme/one")).get()!;
    markPublished(db, one.id, "abc", clock);
    at("2026-09-16T08:10:00Z");
    expect((await requests.submit(ref("acme/two"), ada)).view).toMatchObject({
      state: "queued",
      requests: 2,
    });

    // A declined request frees the account too
    requests.decline(ref("acme/two"));
    at("2026-09-16T08:20:00Z");
    expect((await requests.submit(ref("acme/three"), ada)).view.state).toBe("queued");

    // The account keeps its whole request history, newest first
    at("2026-09-16T09:00:00Z");
    expect(
      requests
        .requestsFor(ada.userId)
        .map(({ view, requestedAt }) => [view.repo, view.state, requestedAt]),
    ).toEqual([
      ["acme/three", "queued", "2026-09-16T08:20:00.000Z"],
      ["acme/two", "rejected", expect.any(String)],
      ["acme/one", "ready", expect.any(String)],
    ]);
    expect(requests.requestsFor(person("nobody").userId)).toEqual([]);
  });
});

describe("estimates", () => {
  const capacity: CapacityConfig = {
    models: [
      {
        id: "lite",
        provider: "gemini",
        model: "lite",
        requestsPerDay: 100,
        requestsPerMinute: 15,
        tokensPerMinute: 250_000,
      },
      {
        id: "flash",
        provider: "gemini",
        model: "flash",
        requestsPerDay: 18,
        requestsPerMinute: 5,
        tokensPerMinute: 250_000,
      },
    ],
    tasks: { summary: ["lite"], plan: ["flash", "lite"], page: ["lite", "flash"] },
  };
  // The lite model used its day's allowance at 07:00, so summaries wait until 07:00 tomorrow
  const usage = () => [
    { hour: "2026-09-16T07", provider: "gemini", model: "lite", requests: 100, neurons: 0 },
  ];

  it("gives builds in line and repositories not yet requested a ready time, counting builds ahead", async () => {
    const { client } = fakeGithub({
      "acme/first": { files: sourceFiles(20_000) },
      "acme/later": { files: sourceFiles(20_000) },
    });
    const requests = createRequestService({
      db,
      github: client,
      now: () => clock,
      capacity,
      usage,
    });

    const first = (await requests.submit(ref("acme/first"), person("a"))).view;
    expect(first.eta).toMatchObject({
      basis: "line",
      ahead: 0,
      allowanceUntil: "2026-09-17T07:00:00.000Z",
    });
    expect(Date.parse(first.eta!.readyAt)).toBeGreaterThan(Date.parse("2026-09-17T07:00:00Z"));
    expect(Date.parse(first.eta!.readyAt)).toBeLessThan(Date.parse("2026-09-17T08:00:00Z"));

    const later = await requests.lookup(ref("acme/later"));
    expect(later.eta).toMatchObject({ basis: "if-requested", ahead: 1 });
    expect(Date.parse(later.eta!.readyAt)).toBeGreaterThan(Date.parse(first.eta!.readyAt));
    expect(later.builder).toEqual({ online: false, lastSeenAt: null });

    touchWorker(db, "worker-1", null, clock);
    expect((await requests.lookup(ref("acme/first"))).builder).toEqual({
      online: true,
      lastSeenAt: clock.toISOString(),
    });
    at("2026-09-16T08:05:00Z");
    expect(requests.queue().builder.online).toBe(false);

    // A build paused for its allowance says when that allowance comes back
    const [job] = jobsFor("acme/first");
    db.update(indexJobs)
      .set({ deferrals: 1, runAfter: new Date("2026-09-17T07:00:00Z") })
      .where(eq(indexJobs.id, job!.id))
      .run();
    db.insert(jobStages)
      .values({ jobId: job!.id, stage: "source", status: "failed", startedAt: clock })
      .run();
    expect((await requests.lookup(ref("acme/first"))).eta).toMatchObject({
      basis: "line",
      allowanceUntil: "2026-09-17T07:00:00.000Z",
    });
  });
});
