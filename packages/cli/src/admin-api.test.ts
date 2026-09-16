import type { SessionRow, UserRow } from "@everyrepo/accounts";
import { parseRepoRef, type LocalConfig, type RepoView } from "@everyrepo/core";
import { ensureRepo, openAppDb, users, type AppDb } from "@everyrepo/db";
import { enqueueJob } from "@everyrepo/queue";
import { builderPaused, type RequestService } from "@everyrepo/requests";
import { beforeEach, describe, expect, it } from "vitest";
import { ADMIN_HEADER, createAdminApi } from "./admin-api.ts";

const SITE = "http://127.0.0.1:4323";
const NOW = new Date("2026-09-16T10:00:00Z");
const OWNER_GITHUB_ID = 4242;

let db: AppDb;
let owner: UserRow;
let other: UserRow;
const approved: string[] = [];

const view = (repo: string): RepoView =>
  ({ repo, state: "queued", requests: 0 }) as unknown as RepoView;

const service = {
  approve: async (ref: { owner: string; name: string }) => {
    approved.push(`${ref.owner}/${ref.name}`);
    return view(`${ref.owner}/${ref.name}`);
  },
  decline: () => {
    throw new Error("No request for acme/none");
  },
  retry: (ref: { owner: string; name: string }) => view(`${ref.owner}/${ref.name}`),
  requests: () => [],
} as unknown as RequestService;

const session = (user: UserRow, startedHoursAgo: number): SessionRow => ({
  tokenHash: "hash",
  userId: user.id,
  createdAt: new Date(NOW.getTime() - startedHoursAgo * 3_600_000),
  expiresAt: new Date(NOW.getTime() + 86_400_000),
  lastSeenAt: NOW,
});

function api() {
  return createAdminApi({
    db,
    service,
    config: { dataDir: "C:/nowhere", localRepos: [] } as unknown as LocalConfig,
    admins: new Set([OWNER_GITHUB_ID]),
    siteOrigins: [SITE],
    // The test names the signed-in person in the cookie instead of a real session token
    sessionFor: async (request) => {
      const who = request.headers.get("cookie");
      if (who === "owner") return { user: owner, session: session(owner, 1) };
      if (who === "owner-yesterday") return { user: owner, session: session(owner, 20) };
      if (who === "other") return { user: other, session: session(other, 1) };
      return undefined;
    },
    fetch: (async () =>
      Response.json({
        resources: {
          core: { limit: 5000, remaining: 4990, reset: 1_789_560_000 },
          search: { limit: 30, remaining: 30, reset: 1_789_556_460 },
        },
      })) as unknown as typeof fetch,
    githubToken: "token",
    now: () => NOW,
  });
}

const get = (path: string, cookie?: string) =>
  new Request(`http://127.0.0.1:8787${path}`, { headers: cookie ? { cookie } : {} });

const post = (path: string, body: unknown, headers: Record<string, string>) =>
  new Request(`http://127.0.0.1:8787${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const fromDashboard = { cookie: "owner", origin: SITE, [ADMIN_HEADER]: "1" };

beforeEach(() => {
  db = openAppDb(":memory:");
  approved.length = 0;
  const insert = (githubId: number, login: string) =>
    db.insert(users).values({ githubId, login, createdAt: NOW, lastSeenAt: NOW }).returning().get();
  owner = insert(OWNER_GITHUB_ID, "owner");
  other = insert(7, "someone");
});

describe("admin API", () => {
  it("lets in only an admin who signed in within the last twelve hours", async () => {
    const handle = api();
    const status = async (cookie?: string) =>
      (await handle(get("/api/admin/overview", cookie)))!.status;
    expect(await status()).toBe(401);
    // Other accounts are told the address does not exist
    expect(await status("other")).toBe(404);
    const stale = (await handle(get("/api/admin/overview", "owner-yesterday")))!;
    expect(stale.status).toBe(401);
    expect(await stale.json()).toMatchObject({ error: { code: "reauth" } });

    const overview = (await handle(get("/api/admin/overview", "owner")))!;
    expect(overview.status).toBe(200);
    expect(overview.headers.get("cache-control")).toBe("no-store");
    expect(await overview.json()).toMatchObject({
      builder: { online: false, paused: false, current: null },
      github: { core: { limit: 5000, remaining: 4990 }, token: true },
      counts: { accounts: 2, inLine: 0 },
    });
    expect((await handle(get("/api/admin/nothing-here", "other")))!.status).toBe(404);
    expect(await handle(get("/api/repos/acme/app", "owner"))).toBeUndefined();
  });

  it("takes changes only from the website's dashboard and records who made them", async () => {
    const handle = api();
    const pause = (headers: Record<string, string>) =>
      handle(post("/api/admin/builder", { paused: true }, headers));
    expect((await pause({ cookie: "owner" }))!.status).toBe(403);
    expect(
      (await pause({ cookie: "owner", origin: "https://evil.example", [ADMIN_HEADER]: "1" }))!
        .status,
    ).toBe(403);
    expect((await pause({ cookie: "owner", origin: SITE }))!.status).toBe(403);
    expect((await pause({ ...fromDashboard, cookie: "other" }))!.status).toBe(404);
    expect(builderPaused(db)).toBe(false);

    expect(await (await pause(fromDashboard))!.json()).toEqual({ paused: true });
    expect(builderPaused(db)).toBe(true);
    const activity = (await (await handle(get("/api/admin/activity", "owner")))!.json()) as Array<{
      who: string;
      action: string;
    }>;
    expect(activity[0]).toMatchObject({ who: "owner", action: "pause builder" });
    expect((await handle(get("/api/admin/builder", "owner")))!.status).toBe(405);
    expect((await handle(get("/api/admin/builder", "other")))!.status).toBe(404);
    expect((await handle(get("/api/admin/builder")))!.status).toBe(401);
  });

  it("moves and cancels builds, approves repositories and explains refusals", async () => {
    const handle = api();
    const build = (name: string, priority: number) =>
      enqueueJob(db, {
        repoId: ensureRepo(db, parseRepoRef(name)).id,
        kind: "full",
        stages: ["source"],
        origin: "request",
        priority,
      });
    build("acme/first", 80);
    const second = build("acme/second", 280);

    const moved = (await (await handle(
      post("/api/admin/queue/move", { jobId: second.id, direction: "top" }, fromDashboard),
    ))!.json()) as Array<{ repo: string }>;
    expect(moved.map((item) => item.repo)).toEqual(["acme/second", "acme/first"]);
    const sideways = await handle(
      post("/api/admin/queue/move", { jobId: second.id, direction: "sideways" }, fromDashboard),
    );
    expect(sideways!.status).toBe(400);

    const cancelled = (await (await handle(
      post("/api/admin/queue/cancel", { jobId: second.id }, fromDashboard),
    ))!.json()) as Array<{ repo: string }>;
    expect(cancelled.map((item) => item.repo)).toEqual(["acme/first"]);

    expect(
      (await handle(
        post("/api/admin/repos/add", { repo: "https://github.com/pallets/click" }, fromDashboard),
      ))!.status,
    ).toBe(200);
    expect(approved).toEqual(["pallets/click"]);

    const refused = (await handle(
      post("/api/admin/requests/decline", { repo: "acme/none" }, fromDashboard),
    ))!;
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: { message: "No request for acme/none" } });

    const unpublished = await handle(
      post("/api/admin/wikis/rewrite", { repo: "acme/first" }, fromDashboard),
    );
    expect(unpublished!.status).toBe(409);
  });
});
