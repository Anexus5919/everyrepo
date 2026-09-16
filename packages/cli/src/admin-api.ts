import type { SessionRow, UserRow } from "@everyrepo/accounts";
import { readRepoInput, repoInputMessage, type LocalConfig, type RepoRef } from "@everyrepo/core";
import { adminActions, findRepo, type AppDb } from "@everyrepo/db";
import {
  adminQueue,
  cancelBuild,
  moveBuild,
  queueRewrite,
  setBuilderPaused,
  type MoveDirection,
  type RequestService,
} from "@everyrepo/requests";
import {
  adminAccounts,
  adminActivity,
  adminOverview,
  adminPages,
  adminPageText,
  adminRequests,
  adminWikis,
  createGithubLimits,
  forgetWikiPages,
} from "./admin-data.ts";

export interface AdminApiOptions {
  db: AppDb;
  service: RequestService;
  config: LocalConfig;
  // GitHub account ids allowed in; a login can change hands, an id cannot
  admins: ReadonlySet<number>;
  // Only these exact origins may make changes, so no other page can act for a signed-in owner
  siteOrigins: readonly string[];
  sessionFor: (request: Request) => Promise<{ user: UserRow; session: SessionRow } | undefined>;
  githubToken?: string | undefined;
  fetch?: typeof fetch;
  now?: () => Date;
  log?: (message: string) => void;
}

export const ADMIN_HEADER = "x-everyrepo-admin";
// Changes need a sign-in from the last twelve hours, even though ordinary sessions last a month
export const ADMIN_SESSION_MS = 12 * 3_600_000;
const BODY_BYTES = 4_000;
const DIRECTIONS: readonly MoveDirection[] = ["top", "up", "down", "bottom"];

export function isAdminRoute(path: string): boolean {
  return path.startsWith("/api/admin/");
}

// Admin actions report their own problems as plain messages
class AdminError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function reply(value: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex",
    },
  });
}

const problem = (status: number, code: string, message: string) =>
  reply({ error: { code, message } }, status);

export function createAdminApi(options: AdminApiOptions) {
  const { db, service, config } = options;
  const now = options.now ?? (() => new Date());
  const github = createGithubLimits(options.githubToken, options.fetch);
  const dataDir = config.dataDir;

  async function allow(request: Request, change: boolean): Promise<UserRow> {
    const found = await options.sessionFor(request);
    if (!found) throw new AdminError(401, "sign-in", "Sign in to open the admin dashboard.");
    // Anyone else sees the same answer as for an address that does not exist
    if (!options.admins.has(found.user.githubId))
      throw new AdminError(404, "not-found", "Not found");
    if (now().getTime() - found.session.createdAt.getTime() > ADMIN_SESSION_MS) {
      throw new AdminError(401, "reauth", "Sign in again to keep using the admin dashboard.");
    }
    if (change) {
      const origin = request.headers.get("origin");
      if (!origin || !options.siteOrigins.includes(origin)) {
        throw new AdminError(403, "origin", "Make changes from the EveryRepo website.");
      }
      if (request.headers.get(ADMIN_HEADER) !== "1") {
        throw new AdminError(403, "header", "Make changes from the admin dashboard.");
      }
    }
    return found.user;
  }

  function record(user: UserRow, action: string, target: string, detail?: Record<string, unknown>) {
    db.insert(adminActions)
      .values({
        userId: user.id,
        login: user.login,
        action,
        target,
        detail: detail ?? null,
        createdAt: now(),
      })
      .run();
    options.log?.(`admin ${user.login}: ${action} ${target}`);
  }

  async function body(request: Request): Promise<Record<string, unknown>> {
    const text = await request.text();
    if (text.length > BODY_BYTES)
      throw new AdminError(413, "too-large", "The request is too large.");
    try {
      const parsed: unknown = JSON.parse(text || "{}");
      if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
      return parsed as Record<string, unknown>;
    } catch {
      throw new AdminError(400, "invalid-body", "Send a JSON object.");
    }
  }

  function repoRef(value: unknown): RepoRef {
    const read = readRepoInput(typeof value === "string" ? value : "");
    if (!read.ok)
      throw new AdminError(400, read.problem, repoInputMessage(read.problem, read.owner));
    return read.ref;
  }

  function knownRepo(value: unknown) {
    const repo = findRepo(db, repoRef(value));
    if (!repo) throw new AdminError(404, "unknown-repo", "EveryRepo has not read this repository.");
    return repo;
  }

  function jobId(value: unknown): number {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      throw new AdminError(400, "invalid-job", "Name the build by its job number.");
    }
    return value;
  }

  const reads: Record<string, (url: URL, user: UserRow) => Promise<unknown> | unknown> = {
    "/api/admin/overview": () => adminOverview(db, config, github, now()),
    "/api/admin/queue": () => adminQueue(db),
    "/api/admin/requests": () => adminRequests(db, service.requests()),
    "/api/admin/wikis": () => adminWikis(db, dataDir),
    "/api/admin/wikis/pages": (url) => adminPages(dataDir, knownRepo(url.searchParams.get("repo"))),
    "/api/admin/wikis/page": (url) => {
      const page = adminPageText(
        dataDir,
        knownRepo(url.searchParams.get("repo")),
        url.searchParams.get("slug") ?? "",
      );
      if (!page) throw new AdminError(404, "unknown-page", "This wiki has no page with that name.");
      return page;
    },
    "/api/admin/accounts": () => adminAccounts(db),
    "/api/admin/activity": () => adminActivity(db, now()),
  };

  const changes: Record<
    string,
    (input: Record<string, unknown>, user: UserRow) => Promise<unknown> | unknown
  > = {
    "/api/admin/builder": (input, user) => {
      const paused = input["paused"] === true;
      setBuilderPaused(db, paused, now());
      record(user, paused ? "pause builder" : "resume builder", "builder");
      return { paused };
    },
    "/api/admin/queue/move": (input, user) => {
      const id = jobId(input["jobId"]);
      const direction = input["direction"] as MoveDirection;
      if (!DIRECTIONS.includes(direction)) {
        throw new AdminError(
          400,
          "invalid-direction",
          "Move a build to the top, up, down or to the bottom.",
        );
      }
      const target = adminQueue(db).find((item) => item.jobId === id)?.repo ?? `job ${id}`;
      const priority = moveBuild(db, id, direction);
      record(user, `move ${direction}`, target, { jobId: id, priority });
      return adminQueue(db);
    },
    "/api/admin/queue/cancel": (input, user) => {
      const id = jobId(input["jobId"]);
      const target = adminQueue(db).find((item) => item.jobId === id)?.repo ?? `job ${id}`;
      cancelBuild(db, id, now());
      record(user, "cancel build", target, { jobId: id });
      return adminQueue(db);
    },
    "/api/admin/requests/approve": async (input, user) => {
      const view = await service.approve(repoRef(input["repo"]));
      record(user, "approve", view.repo);
      return view;
    },
    "/api/admin/requests/decline": (input, user) => {
      const view = service.decline(repoRef(input["repo"]));
      record(user, "decline", view.repo);
      return view;
    },
    "/api/admin/requests/retry": (input, user) => {
      const view = service.retry(repoRef(input["repo"]));
      record(user, "retry", view.repo);
      return view;
    },
    "/api/admin/repos/add": async (input, user) => {
      const view = await service.approve(repoRef(input["repo"]));
      record(user, "add to queue", view.repo);
      return view;
    },
    "/api/admin/wikis/rewrite": (input, user) => {
      const repo = knownRepo(input["repo"]);
      const pages = Array.isArray(input["pages"])
        ? input["pages"].filter((slug): slug is string => typeof slug === "string")
        : [];
      if (!repo.publishedAt) {
        throw new AdminError(409, "unpublished", "Only a published wiki can be written again.");
      }
      if (pages.length > 0) forgetPages(repo, pages);
      const queued = queueRewrite(db, repo.id, pages);
      if (!queued) throw new AdminError(409, "not-queued", "This wiki could not be queued again.");
      record(user, pages.length > 0 ? "rewrite pages" : "rewrite wiki", repo.fullName, {
        jobId: queued.jobId,
        ...(pages.length > 0 ? { pages } : {}),
      });
      return adminQueue(db);
    },
  };

  function forgetPages(repo: NonNullable<ReturnType<typeof findRepo>>, pages: readonly string[]) {
    const result = forgetWikiPages(dataDir, repo, pages);
    if (!result) throw new AdminError(409, "unread", "This repository has no stored wiki.");
    if (result.unknown.length > 0) {
      throw new AdminError(
        400,
        "unknown-page",
        `This wiki has no page named ${result.unknown.join(", ")}.`,
      );
    }
  }

  return async function handle(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url);
    if (!isAdminRoute(url.pathname)) return undefined;
    const read = reads[url.pathname];
    const change = changes[url.pathname];
    try {
      // Who is asking is settled before anything else, so strangers cannot learn which addresses exist
      if (read && request.method === "GET")
        return reply(await read(url, await allow(request, false)));
      if (change && request.method === "POST") {
        const user = await allow(request, true);
        return reply(await change(await body(request), user));
      }
      await allow(request, false);
      if (read || change) {
        throw new AdminError(405, "method", `Use ${read ? "GET" : "POST"} for this address.`);
      }
      throw new AdminError(404, "not-found", "Not found");
    } catch (caught) {
      if (caught instanceof AdminError) return problem(caught.status, caught.code, caught.message);
      // Checks such as a missing request throw plain errors that explain themselves; anything else is a fault
      if (caught instanceof Error && caught.name === "Error") {
        return problem(400, "refused", caught.message);
      }
      options.log?.(
        `admin request failed: ${caught instanceof Error ? caught.stack : String(caught)}`,
      );
      return problem(500, "internal", "Something went wrong.");
    }
  };
}
