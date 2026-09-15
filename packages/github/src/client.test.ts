import { describe, expect, it } from "vitest";
import { createGithubClient, GithubError } from "./client.ts";

const ref = { owner: "Acme", name: "App" };

const apiRepo = {
  id: 42,
  full_name: "acme/app",
  name: "app",
  owner: { login: "acme", avatar_url: "https://avatars.githubusercontent.com/u/1?v=4" },
  description: "  An app.  ",
  stargazers_count: 1_200,
  language: "TypeScript",
  default_branch: "main",
  archived: false,
  private: false,
  fork: true,
  parent: { full_name: "upstream/app" },
  license: { spdx_id: "MIT", name: "MIT License" },
  size: 5_120,
  html_url: "https://github.com/acme/app",
  pushed_at: "2026-09-10T10:00:00Z",
};

interface Call {
  url: string;
  headers: Record<string, string>;
}

function fakeFetch(replies: Array<() => Response>) {
  const calls: Call[] = [];
  const doFetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const reply = replies.shift();
    if (!reply) throw new Error(`Unexpected request to ${url}`);
    return reply();
  }) as typeof fetch;
  return { calls, doFetch };
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });

describe("GitHub client", () => {
  it("reads a repository once, then revalidates it with its entity tag", async () => {
    let clock = 0;
    const { calls, doFetch } = fakeFetch([
      () => json(apiRepo, { headers: { etag: 'W/"v1"' } }),
      () => new Response(null, { status: 304 }),
    ]);
    const client = createGithubClient({
      fetch: doFetch,
      token: "t",
      now: () => clock,
      repositoryMaxAgeMs: 1_000,
    });

    const repository = await client.repository(ref);
    expect(repository).toMatchObject({
      id: 42,
      fullName: "acme/app",
      description: "An app.",
      stars: 1_200,
      fork: true,
      parent: "upstream/app",
      license: "MIT",
      private: false,
    });
    expect(calls[0]?.url).toBe("https://api.github.com/repos/Acme/App");
    expect(calls[0]?.headers["authorization"]).toBe("Bearer t");

    clock = 500;
    expect(await client.repository({ owner: "acme", name: "app" })).toEqual(repository);
    expect(calls).toHaveLength(1);

    clock = 2_000;
    expect(await client.repository(ref)).toEqual(repository);
    expect(calls[1]?.headers["if-none-match"]).toBe('W/"v1"');
  });

  it("lists regular files with their sizes and says when GitHub cut the list short", async () => {
    const { calls, doFetch } = fakeFetch([
      () =>
        json({
          truncated: true,
          tree: [
            { path: "src", type: "tree", mode: "040000" },
            { path: "src/index.ts", type: "blob", mode: "100644", size: 120 },
            { path: "link", type: "blob", mode: "120000", size: 5 },
            { path: "vendor/lib", type: "commit", mode: "160000" },
          ],
        }),
    ]);
    const client = createGithubClient({ fetch: doFetch });
    expect(await client.fileList(ref, "release/2.x")).toEqual({
      files: [{ path: "src/index.ts", bytes: 120 }],
      truncated: true,
    });
    expect(calls[0]?.url).toBe(
      "https://api.github.com/repos/Acme/App/git/trees/release%2F2.x?recursive=1",
    );
  });

  it("names the reason a repository cannot be read", async () => {
    const cases: Array<[() => Response, string]> = [
      [() => json({ message: "Not Found" }, { status: 404 }), "not-found"],
      [() => json({ message: "Git Repository is empty." }, { status: 409 }), "empty"],
      [() => json({ message: "Repository access blocked" }, { status: 451 }), "unavailable"],
      [
        () =>
          json(
            { message: "API rate limit exceeded" },
            { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "2000" } },
          ),
        "rate-limited",
      ],
    ];
    for (const [reply, kind] of cases) {
      const client = createGithubClient({ fetch: fakeFetch([reply]).doFetch });
      const error = await client.fileList(ref, "main").catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(GithubError);
      expect((error as GithubError).kind).toBe(kind);
      if (kind === "rate-limited") {
        expect((error as GithubError).retryAt).toEqual(new Date(2_000_000));
      }
    }
  });

  it("tries once more after a server error or a dropped connection", async () => {
    const { calls, doFetch } = fakeFetch([
      () => new Response("busy", { status: 502 }),
      () => json(apiRepo),
    ]);
    expect((await createGithubClient({ fetch: doFetch }).repository(ref)).id).toBe(42);
    expect(calls).toHaveLength(2);

    const offline = createGithubClient({
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });
    await expect(offline.repository(ref)).rejects.toMatchObject({ kind: "unreachable" });
  });

  it("reads raw files and treats a missing file as absent", async () => {
    const { calls, doFetch } = fakeFetch([
      () => new Response("*.pb.go linguist-generated\n"),
      () => new Response("404: Not Found", { status: 404 }),
    ]);
    const client = createGithubClient({ fetch: doFetch });
    expect(await client.file(ref, "HEAD", ".gitattributes")).toBe("*.pb.go linguist-generated\n");
    expect(await client.file(ref, "HEAD", "docs/a b.md")).toBeUndefined();
    expect(calls.map((call) => call.url)).toEqual([
      "https://raw.githubusercontent.com/Acme/App/HEAD/.gitattributes",
      "https://raw.githubusercontent.com/Acme/App/HEAD/docs/a%20b.md",
    ]);
  });

  it("searches public repositories and owners, and finds nothing for a query GitHub refuses", async () => {
    const { calls, doFetch } = fakeFetch([
      () => json({ items: [apiRepo, { ...apiRepo, full_name: "acme/secret", private: true }] }),
      () =>
        json({
          items: [
            { login: "acme", type: "Organization" },
            { login: "acmebot", type: "User" },
          ],
        }),
      () => json({ message: "Validation Failed" }, { status: 422 }),
      () =>
        json(
          { message: "API rate limit exceeded" },
          {
            status: 403,
            headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1800000000" },
          },
        ),
    ]);
    const client = createGithubClient({ fetch: doFetch, token: "t" });

    const found = await client.searchRepositories("ap in:name user:acme", {
      limit: 8,
      sort: "stars",
    });
    expect(found.map((repo) => repo.fullName)).toEqual(["acme/app"]);
    expect(new URL(calls[0]!.url).search).toBe("?q=ap+in%3Aname+user%3Aacme&per_page=8&sort=stars");
    expect(calls[0]!.headers["if-none-match"]).toBeUndefined();

    expect(await client.searchOwners("acm in:login", { limit: 3 })).toEqual([
      { login: "acme", kind: "organization" },
      { login: "acmebot", kind: "user" },
    ]);
    expect(await client.searchRepositories("user:missing", { limit: 8 })).toEqual([]);
    const limited = await client.searchOwners("x", { limit: 3 }).catch((error: unknown) => error);
    expect(limited).toMatchObject({ kind: "rate-limited", retryAt: new Date(1_800_000_000_000) });
  });
});
