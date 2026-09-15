import type { QueueView, RepoRef, RepoView } from "@everyrepo/core";
import { openAppDb } from "@everyrepo/db";
import { RequestsUnavailableError, type RequestService } from "@everyrepo/requests";
import { describe, expect, it } from "vitest";
import { createRequestApi, hashAddress, type RequestApiOptions } from "./request-api.ts";

const view = (repo: string, state: RepoView["state"] = "available"): RepoView => ({
  repo,
  state,
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
});

function fakeService(overrides: Partial<RequestService> = {}) {
  const submitted: Array<{ ref: RepoRef; requester: string }> = [];
  const service: RequestService = {
    lookup: async (ref) => view(`${ref.owner}/${ref.name}`),
    submit: async (ref, requester) => {
      submitted.push({ ref, requester });
      return { view: view(`${ref.owner}/${ref.name}`, "queued"), counted: true };
    },
    queue: (): QueueView => ({
      building: [],
      waiting: [view("acme/app", "queued")],
      review: [],
      recent: [],
      updatedAt: "2026-09-16T08:00:00.000Z",
    }),
    approve: async () => view("x/y"),
    decline: () => view("x/y"),
    retry: () => view("x/y"),
    requests: () => [],
    reconcile: () => 0,
    ...overrides,
  };
  return { service, submitted };
}

const NOW = Date.parse("2026-09-16T08:00:00Z");

function api(service: RequestService, extra: Partial<RequestApiOptions> = {}) {
  const logs: string[] = [];
  const handle = createRequestApi({
    service,
    db: openAppDb(":memory:"),
    secret: "test-secret",
    now: () => NOW,
    log: (message) => logs.push(message),
    ...extra,
  });
  return { handle, logs };
}

const get = (path: string, headers: HeadersInit = {}) =>
  new Request(`http://127.0.0.1:8787${path}`, { headers });
const post = (body: unknown) =>
  new Request("http://127.0.0.1:8787/api/requests", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("request API", () => {
  it("looks a repository up and answers an unchanged poll with 304", async () => {
    const { handle } = api(fakeService().service);
    const first = (await handle(get("/api/repos/acme/app"), "1.2.3.4"))!;
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(await first.json()).toMatchObject({ repo: "acme/app", state: "available" });

    const etag = first.headers.get("etag")!;
    const again = (await handle(get("/api/repos/acme/app", { "if-none-match": etag }), "1.2.3.4"))!;
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
  });

  it("explains addresses that are not a repository", async () => {
    const { handle } = api(fakeService().service);
    const reply = (await handle(get("/api/repos/orgs/jenkinsci"), "1.2.3.4"))!;
    expect(reply.status).toBe(400);
    expect(await reply.json()).toEqual({
      error: {
        code: "owner-only",
        message: "That is the jenkinsci account. Add a repository name, like jenkinsci/name.",
      },
    });
    expect((await handle(get("/api/repos/acme"), "1.2.3.4"))!.status).toBe(404);
    expect((await handle(get("/api/repos/%E0%A4%A/x"), "1.2.3.4"))!.status).toBe(404);
    expect(await handle(get("/api/ask"), "1.2.3.4")).toBeUndefined();
    expect((await handle(post({ repo: "a/b" }).clone(), "1.2.3.4"))!.status).toBe(200);
    const wrongMethod = new Request("http://127.0.0.1:8787/api/queue", { method: "POST" });
    expect((await handle(wrongMethod, "1.2.3.4"))!.status).toBe(405);
  });

  it("limits lookups per visitor and says when to try again", async () => {
    const { handle } = api(fakeService().service, { limits: { lookupsPerMinute: 2 } });
    for (let index = 0; index < 2; index += 1) {
      expect((await handle(get("/api/queue"), "5.5.5.5"))!.status).toBe(200);
    }
    const blocked = (await handle(get("/api/repos/acme/app"), "5.5.5.5"))!;
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("60");
    expect((await handle(get("/api/queue"), "6.6.6.6"))!.status).toBe(200);
  });

  it("reports GitHub trouble as temporary and hides unexpected errors", async () => {
    const retryAt = new Date(NOW + 120_000);
    const { handle, logs } = api(
      fakeService({
        lookup: async () => {
          throw new RequestsUnavailableError("GitHub is limiting lookups right now.", retryAt);
        },
        submit: async () => {
          throw new Error("disk full");
        },
      }).service,
    );
    const unavailable = (await handle(get("/api/repos/acme/app"), "1.1.1.1"))!;
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get("retry-after")).toBe("120");

    const failed = (await handle(post({ repo: "acme/app" }), "1.1.1.1"))!;
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({
      error: { code: "internal", message: "Something went wrong. Try again in a moment." },
    });
    expect(logs.join("\n")).toContain("disk full");
  });

  it("accepts a request with a pasted link and passes a daily hash, never the address", async () => {
    const { service, submitted } = fakeService();
    const { handle } = api(service);
    const reply = (await handle(
      post({ repo: "https://github.com/medusajs/medusa/tree/develop" }),
      "9.9.9.9",
    ))!;
    expect(reply.status).toBe(200);
    expect(await reply.json()).toMatchObject({ counted: true, view: { state: "queued" } });
    expect(submitted[0]?.ref).toEqual({ owner: "medusajs", name: "medusa" });
    expect(submitted[0]?.requester).toBe(await hashAddress("test-secret", "9.9.9.9", NOW));
    expect(submitted[0]?.requester).not.toContain("9.9.9.9");

    for (const [body, code] of [
      ["not json", "invalid-body"],
      [{}, "empty"],
      [{ repo: "https://gitlab.com/a/b" }, "other-host"],
    ] as const) {
      const bad = (await handle(post(body), "9.9.9.9"))!;
      expect(bad.status).toBe(400);
      expect(((await bad.json()) as { error: { code: string } }).error.code).toBe(code);
    }
  });

  it("changes a visitor's hash every day", async () => {
    const today = await hashAddress("s", "1.2.3.4", NOW);
    expect(await hashAddress("s", "1.2.3.4", NOW + 3_600_000)).toBe(today);
    expect(await hashAddress("s", "1.2.3.4", NOW + 86_400_000)).not.toBe(today);
    expect(await hashAddress("s", "1.2.3.5", NOW)).not.toBe(today);
  });

  it("limits requests per visitor per hour", async () => {
    const { handle } = api(fakeService().service, { limits: { requestsPerHour: 1 } });
    expect((await handle(post({ repo: "a/b" }), "7.7.7.7"))!.status).toBe(200);
    const blocked = (await handle(post({ repo: "a/c" }), "7.7.7.7"))!;
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe(String(3_600 - ((NOW / 1_000) % 3_600)));
  });

  it("checks the person test when one is configured", async () => {
    const checked: string[] = [];
    const turnstileFetch = (async (_url: string, init?: RequestInit) => {
      const form = new URLSearchParams(String(init?.body));
      checked.push(`${form.get("secret")} ${form.get("response")} ${form.get("remoteip")}`);
      return Response.json({ success: form.get("response") === "good" });
    }) as typeof fetch;
    const { handle } = api(fakeService().service, {
      turnstile: { secret: "ts", fetch: turnstileFetch },
    });
    expect((await handle(post({ repo: "a/b" }), "8.8.8.8"))!.status).toBe(403);
    expect((await handle(post({ repo: "a/b", token: "bad" }), "8.8.8.8"))!.status).toBe(403);
    expect((await handle(post({ repo: "a/b", token: "good" }), "8.8.8.8"))!.status).toBe(200);
    expect(checked).toEqual(["ts bad 8.8.8.8", "ts good 8.8.8.8"]);
  });
});
