import { formatRepoRef, repoKey, type RepoRef } from "@everyrepo/core";

export interface GithubRepository {
  id: number;
  fullName: string;
  owner: string;
  name: string;
  description: string | null;
  stars: number;
  language: string | null;
  defaultBranch: string;
  archived: boolean;
  disabled: boolean;
  private: boolean;
  fork: boolean;
  parent: string | null;
  license: string | null;
  sizeKb: number;
  url: string;
  avatarUrl: string;
  pushedAt: string | null;
}

export interface GithubFileList {
  // Path and size of every file, as GitHub lists them for the default branch
  files: Array<{ path: string; bytes: number }>;
  truncated: boolean;
}

export type GithubErrorKind =
  // Missing, or private and invisible without access
  | "not-found"
  // Blocked for legal reasons or disabled by GitHub
  | "unavailable"
  // The repository has no commits
  | "empty"
  | "rate-limited"
  | "unreachable";

export class GithubError extends Error {
  override readonly name = "GithubError";

  constructor(
    readonly kind: GithubErrorKind,
    message: string,
    // When a rate limit resets, if GitHub said
    readonly retryAt?: Date,
  ) {
    super(message);
  }
}

export interface GithubCacheEntry {
  etag: string | null;
  payload: unknown;
  fetchedAt: number;
}

export interface GithubCache {
  get(key: string): GithubCacheEntry | undefined;
  set(key: string, entry: GithubCacheEntry): void;
}

export interface GithubClientOptions {
  token?: string;
  fetch?: typeof fetch;
  cache?: GithubCache;
  now?: () => number;
  timeoutMs?: number;
  // How long a saved answer is used without asking GitHub again
  repositoryMaxAgeMs?: number;
  fileListMaxAgeMs?: number;
}

export interface GithubClient {
  repository(ref: RepoRef): Promise<GithubRepository>;
  fileList(ref: RepoRef, branch: string): Promise<GithubFileList>;
  // Raw file contents at a branch or commit, or undefined when the file does not exist
  file(ref: RepoRef, revision: string, path: string): Promise<string | undefined>;
}

const API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";

interface ApiRepository {
  id: number;
  full_name: string;
  name: string;
  owner: { login: string; avatar_url: string };
  description: string | null;
  stargazers_count: number;
  language: string | null;
  default_branch: string;
  archived: boolean;
  disabled?: boolean;
  private: boolean;
  fork: boolean;
  parent?: { full_name: string };
  license?: { spdx_id?: string | null; name?: string | null } | null;
  size: number;
  html_url: string;
  pushed_at: string | null;
}

interface ApiTree {
  tree: Array<{ path: string; type: string; mode: string; size?: number }>;
  truncated: boolean;
}

function toRepository(item: ApiRepository): GithubRepository {
  const license = item.license?.spdx_id && item.license.spdx_id !== "NOASSERTION";
  return {
    id: item.id,
    fullName: item.full_name,
    owner: item.owner.login,
    name: item.name,
    description: item.description?.trim() || null,
    stars: item.stargazers_count,
    language: item.language,
    defaultBranch: item.default_branch,
    archived: item.archived,
    disabled: item.disabled ?? false,
    private: item.private,
    fork: item.fork,
    parent: item.parent?.full_name ?? null,
    license: license ? item.license!.spdx_id! : (item.license?.name ?? null),
    sizeKb: item.size,
    url: item.html_url,
    avatarUrl: item.owner.avatar_url,
    pushedAt: item.pushed_at,
  };
}

// Regular files only, the same set the indexer reads from git; submodules and links are skipped
function toFileList(tree: ApiTree): GithubFileList {
  return {
    files: tree.tree
      .filter((entry) => entry.type === "blob" && entry.mode !== "120000")
      .map((entry) => ({ path: entry.path, bytes: entry.size ?? 0 })),
    truncated: tree.truncated,
  };
}

function resetTime(response: Response, now: number): Date | undefined {
  const retryAfter = Number(response.headers.get("retry-after"));
  if (retryAfter > 0) return new Date(now + retryAfter * 1_000);
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  return reset > 0 ? new Date(reset * 1_000) : undefined;
}

export function createGithubClient(options: GithubClientOptions = {}): GithubClient {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 8_000;
  const memory = new Map<string, GithubCacheEntry>();
  const cache: GithubCache = options.cache ?? {
    get: (key) => memory.get(key),
    set: (key, entry) => memory.set(key, entry),
  };

  // One retry covers a dropped connection or a brief server error
  async function send(url: string, headers: Record<string, string>): Promise<Response> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        const response = await doFetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
        if (response.status < 500 || attempt === 2) return response;
      } catch {
        if (attempt === 2) throw new GithubError("unreachable", "GitHub could not be reached.");
      }
    }
  }

  async function api<T>(
    key: string,
    path: string,
    maxAgeMs: number,
    reduce: (body: unknown) => T,
  ): Promise<T> {
    const saved = cache.get(key);
    if (saved && now() - saved.fetchedAt < maxAgeMs) return saved.payload as T;
    const response = await send(`${API}${path}`, {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "everyrepo",
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(saved?.etag ? { "if-none-match": saved.etag } : {}),
    });
    // An unchanged answer does not count against the rate limit, so saved data is revalidated this way
    if (response.status === 304 && saved) {
      cache.set(key, { ...saved, fetchedAt: now() });
      return saved.payload as T;
    }
    if (response.ok) {
      const payload = reduce(await response.json());
      cache.set(key, { etag: response.headers.get("etag"), payload, fetchedAt: now() });
      return payload;
    }
    return failure(response);
  }

  async function failure(response: Response): Promise<never> {
    const body = await response.text().catch(() => "");
    if (response.status === 404) {
      throw new GithubError("not-found", "GitHub has no public repository at this address.");
    }
    if (response.status === 409 && /empty/i.test(body)) {
      throw new GithubError("empty", "The repository is empty.");
    }
    if (response.status === 451) {
      throw new GithubError("unavailable", "GitHub has blocked access to this repository.");
    }
    const limited =
      response.status === 429 ||
      (response.status === 403 &&
        (response.headers.get("x-ratelimit-remaining") === "0" || /rate limit/i.test(body)));
    if (limited) {
      throw new GithubError(
        "rate-limited",
        "GitHub is limiting requests right now.",
        resetTime(response, now()),
      );
    }
    if (response.status === 403 && /disabled|blocked/i.test(body)) {
      throw new GithubError("unavailable", "GitHub has disabled this repository.");
    }
    throw new GithubError("unreachable", `GitHub answered with status ${response.status}.`);
  }

  return {
    repository(ref) {
      return api(
        `repo:${repoKey(ref)}`,
        `/repos/${formatRepoRef(ref)}`,
        options.repositoryMaxAgeMs ?? 10 * 60_000,
        (body) => toRepository(body as ApiRepository),
      );
    },
    fileList(ref, branch) {
      return api(
        `tree:${repoKey(ref)}:${branch}`,
        `/repos/${formatRepoRef(ref)}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
        options.fileListMaxAgeMs ?? 30 * 60_000,
        (body) => toFileList(body as ApiTree),
      );
    },
    async file(ref, revision, path) {
      const encoded = path.split("/").map(encodeURIComponent).join("/");
      const response = await send(
        `${RAW}/${formatRepoRef(ref)}/${encodeURIComponent(revision)}/${encoded}`,
        { "user-agent": "everyrepo" },
      );
      if (response.status === 404) return undefined;
      return response.ok ? response.text() : failure(response);
    },
  };
}
