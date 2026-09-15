import { readRepoInput, repoInputMessage, type ApiError, type RepoRef } from "@everyrepo/core";
import { hitRateLimit, type AppDb } from "@everyrepo/db";
import { isAllowedOrigin } from "./http.ts";
import {
  OneRequestAtATimeError,
  RequestsUnavailableError,
  type RequestService,
} from "@everyrepo/requests";

export interface RequestLimits {
  lookupsPerMinute: number;
  requestsPerHour: number;
  requestsPerDay: number;
}

export interface Turnstile {
  secret: string;
  fetch?: typeof fetch;
}

export interface RequestApiOptions {
  service: RequestService;
  db: AppDb;
  // Keys the daily hashes of visitor addresses; addresses themselves are never stored
  secret: string;
  turnstile?: Turnstile | undefined;
  limits?: Partial<RequestLimits>;
  now?: () => number;
  log?: (message: string) => void;
  // The signed-in account behind a request, from its session cookie
  userFor: (request: Request) => Promise<{ id: number; login: string } | undefined>;
  // Sites allowed to send requests that act for a signed-in account
  allowedOrigins?: readonly string[];
}

export const REQUEST_BODY_BYTES = 4_000;

const DEFAULT_LIMITS: RequestLimits = {
  lookupsPerMinute: 40,
  requestsPerHour: 10,
  requestsPerDay: 30,
};
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const TURNSTILE_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export function isRequestRoute(path: string): boolean {
  return (
    path === "/api/requests" ||
    path === "/api/queue" ||
    path === "/api/account/requests" ||
    path.startsWith("/api/repos/")
  );
}

// Same visitor, same day, same hash; the key changes every UTC day so hashes cannot be linked across days
export async function hashAddress(secret: string, address: string, now: number): Promise<string> {
  const day = new Date(now).toISOString().slice(0, 10);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${day}:${address}`),
  );
  return Buffer.from(signature).subarray(0, 16).toString("hex");
}

async function etagFor(body: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return `"${Buffer.from(digest).subarray(0, 12).toString("base64url")}"`;
}

function error(status: number, code: string, message: string, headers: HeadersInit = {}): Response {
  const body: ApiError = { error: { code, message } };
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", ...headers },
  });
}

const retryAfter = (ms: number) => ({ "retry-after": String(Math.max(1, Math.ceil(ms / 1_000))) });

export function createRequestApi(options: RequestApiOptions) {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const now = options.now ?? Date.now;

  // Status pages poll often, so unchanged answers come back as 304 without a body
  async function json(request: Request, value: unknown, status = 200): Promise<Response> {
    const body = JSON.stringify(value);
    const etag = await etagFor(body);
    const headers = { "cache-control": "no-store", etag };
    if (status === 200 && request.headers.get("if-none-match") === etag) {
      return new Response(null, { status: 304, headers });
    }
    return new Response(body, {
      status,
      headers: { ...headers, "content-type": "application/json; charset=utf-8" },
    });
  }

  function limited(key: string, limit: number, windowMs: number): Response | undefined {
    const decision = hitRateLimit(options.db, key, limit, windowMs, now());
    if (decision.allowed) return undefined;
    return error(
      429,
      "rate-limited",
      "Too many requests from this connection. Wait a little and try again.",
      retryAfter(decision.retryAfterMs),
    );
  }

  function unavailable(caught: unknown): Response {
    if (caught instanceof OneRequestAtATimeError) {
      return Response.json(
        {
          error: { code: "one-at-a-time", message: caught.message },
          active: caught.active,
        },
        { status: 409, headers: { "cache-control": "no-store" } },
      );
    }
    if (caught instanceof RequestsUnavailableError) {
      const wait = caught.retryAt ? caught.retryAt.getTime() - now() : 60_000;
      return error(503, "github-unavailable", caught.message, retryAfter(wait));
    }
    options.log?.(`requests failed: ${caught instanceof Error ? caught.stack : String(caught)}`);
    return error(500, "internal", "Something went wrong. Try again in a moment.");
  }

  async function verifyTurnstile(token: unknown, address: string): Promise<boolean> {
    if (!options.turnstile) return true;
    if (typeof token !== "string" || token.length === 0 || token.length > 2_048) return false;
    const form = new URLSearchParams({
      secret: options.turnstile.secret,
      response: token,
      remoteip: address,
    });
    try {
      const reply = await (options.turnstile.fetch ?? fetch)(TURNSTILE_URL, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(8_000),
      });
      const result = (await reply.json()) as { success?: boolean };
      return result.success === true;
    } catch {
      return false;
    }
  }

  function readRef(text: string): { ref: RepoRef } | { response: Response } {
    const input = readRepoInput(text);
    if (input.ok) return { ref: input.ref };
    return {
      response: error(400, input.problem, repoInputMessage(input.problem, input.owner)),
    };
  }

  return async (request: Request, address: string): Promise<Response | undefined> => {
    const path = new URL(request.url).pathname;
    if (!isRequestRoute(path)) return undefined;
    const visitor = await hashAddress(options.secret, address, now());

    if (path.startsWith("/api/repos/")) {
      if (request.method !== "GET") return error(405, "method", "Use GET for this address.");
      let parts: string[];
      try {
        parts = path.slice("/api/repos/".length).split("/").map(decodeURIComponent);
      } catch {
        parts = [];
      }
      if (parts.length !== 2) return error(404, "not-found", "Use /api/repos/owner/name.");
      const read = readRef(parts.join("/"));
      if ("response" in read) return read.response;
      const blocked = limited(`lookup:${visitor}`, limits.lookupsPerMinute, MINUTE_MS);
      if (blocked) return blocked;
      try {
        return await json(request, await options.service.lookup(read.ref));
      } catch (caught) {
        return unavailable(caught);
      }
    }

    if (path === "/api/account/requests") {
      if (request.method !== "GET") return error(405, "method", "Use GET for this address.");
      const user = await options.userFor(request);
      if (!user) return error(401, "sign-in", "Sign in to see your requests.");
      return json(request, options.service.requestsFor(user.id));
    }

    if (path === "/api/queue") {
      if (request.method !== "GET") return error(405, "method", "Use GET for this address.");
      const blocked = limited(`lookup:${visitor}`, limits.lookupsPerMinute, MINUTE_MS);
      if (blocked) return blocked;
      return json(request, options.service.queue());
    }

    if (request.method !== "POST") return error(405, "method", "Use POST to request a repository.");
    // Requests act for an account, so they are only taken from the website itself
    const origin = request.headers.get("origin");
    if (origin !== null && !isAllowedOrigin(origin, options.allowedOrigins ?? [])) {
      return error(403, "origin", "Request repositories from the EveryRepo website.");
    }
    const user = await options.userFor(request);
    if (!user) {
      return error(401, "sign-in", "Sign in with GitHub to request a repository.");
    }
    let body: Record<string, unknown>;
    try {
      const text = await request.text();
      if (text.length > REQUEST_BODY_BYTES) throw new Error("too large");
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
      body = parsed as Record<string, unknown>;
    } catch {
      return error(
        400,
        "invalid-body",
        'Send JSON with the repository, like {"repo": "owner/name"}.',
      );
    }
    if (typeof body["repo"] !== "string") {
      return error(400, "empty", repoInputMessage("empty"));
    }
    const read = readRef(body["repo"]);
    if ("response" in read) return read.response;
    const blocked =
      limited(`request-hour:user:${user.id}`, limits.requestsPerHour, HOUR_MS) ??
      limited(`request-day:user:${user.id}`, limits.requestsPerDay, DAY_MS) ??
      limited(`request-day:${visitor}`, limits.requestsPerDay, DAY_MS);
    if (blocked) return blocked;
    if (!(await verifyTurnstile(body["token"], address))) {
      return error(403, "verification", "The check that you are a person did not pass. Try again.");
    }
    try {
      const result = await options.service.submit(read.ref, { userId: user.id });
      options.log?.(
        `request ${result.view.repo} by ${user.login}: ${result.view.state}${result.view.reason ? ` (${result.view.reason.code})` : ""}${result.counted ? "" : ", not counted"}`,
      );
      return json(request, result);
    } catch (caught) {
      return unavailable(caught);
    }
  };
}
