import type { RepoSearch, SearchInput, SearchOwner, SearchRepo } from "@everyrepo/core";
import { GithubError, type GithubClient, type GithubRepository } from "@everyrepo/github";

export interface RepoSearchOptions {
  github: GithubClient;
  now?: () => number;
  // How long an answer for the same text is reused
  ttlMs?: number;
  maxEntries?: number;
}

export interface RepoSearcher {
  search(input: SearchInput): Promise<RepoSearch>;
}

const TEXT_REPOS = 6;
const TEXT_OWNERS = 3;
const OWNER_REPOS = 8;
// GitHub's best matches are fetched in a larger batch, then ordered so names that start with the text come first
const FETCHED = 20;
const DEFAULT_TTL_MS = 10 * 60_000;
const DEFAULT_ENTRIES = 1_000;
const DEFAULT_BACKOFF_MS = 60_000;

// Exact names first, then names starting with the text, then names containing it, then everything else
function closeness(value: string, needle: string): number {
  const text = value.toLowerCase();
  if (needle === "" || text === needle) return 0;
  if (text.startsWith(needle)) return 1;
  return text.includes(needle) ? 2 : 3;
}

export function rankRepositories(
  items: readonly GithubRepository[],
  name: string,
  limit: number,
): SearchRepo[] {
  const needle = name.toLowerCase();
  return items
    .map((item, index) => ({ item, index, score: closeness(item.name, needle) }))
    .sort((a, b) => a.score - b.score || b.item.stars - a.item.stars || a.index - b.index)
    .slice(0, limit)
    .map(({ item }) => ({
      repo: item.fullName,
      description: item.description,
      stars: item.stars,
      language: item.language,
      archived: item.archived,
    }));
}

export function rankOwners(
  items: readonly SearchOwner[],
  text: string,
  limit: number,
): SearchOwner[] {
  const needle = text.toLowerCase();
  return (
    items
      .map((item, index) => ({ item, index, score: closeness(item.login, needle) }))
      // Owners that only loosely match are left out, since repositories already cover loose matches
      .filter(({ score }) => score < 2)
      .sort((a, b) => a.score - b.score || a.index - b.index)
      .slice(0, limit)
      .map(({ item }) => item)
  );
}

export function createRepoSearch(options: RepoSearchOptions): RepoSearcher {
  const { github } = options;
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const maxEntries = options.maxEntries ?? DEFAULT_ENTRIES;
  const answers = new Map<string, { at: number; result: RepoSearch }>();
  const running = new Map<string, Promise<RepoSearch>>();
  // After GitHub limits searches, nothing is sent until its limit resets
  let pausedUntil = 0;

  const keyOf = (input: SearchInput) =>
    input.kind === "owner"
      ? `owner:${input.owner.toLowerCase()}/${input.name.toLowerCase()}`
      : `text:${input.text.toLowerCase()}`;

  function remember(key: string, result: RepoSearch) {
    if (result.unavailable) return;
    answers.delete(key);
    answers.set(key, { at: now(), result });
    // The map keeps insertion order, so the first key is the one used longest ago
    while (answers.size > maxEntries) answers.delete(answers.keys().next().value!);
  }

  // A failed half of a search leaves the other half usable
  async function attempt<T>(call: Promise<T[]>): Promise<{ items: T[]; failed: boolean }> {
    try {
      return { items: await call, failed: false };
    } catch (error) {
      if (!(error instanceof GithubError)) throw error;
      if (error.kind === "rate-limited") {
        pausedUntil = Math.max(pausedUntil, error.retryAt?.getTime() ?? now() + DEFAULT_BACKOFF_MS);
      }
      return { items: [], failed: true };
    }
  }

  async function run(input: SearchInput): Promise<RepoSearch> {
    if (input.kind === "owner") {
      const found = await attempt(
        input.name
          ? github.searchRepositories(`${input.name} in:name user:${input.owner}`, {
              limit: FETCHED,
            })
          : github.searchRepositories(`user:${input.owner}`, { limit: OWNER_REPOS, sort: "stars" }),
      );
      return {
        owners: [],
        repos: rankRepositories(found.items, input.name, OWNER_REPOS),
        unavailable: found.failed,
      };
    }
    const [repos, owners] = await Promise.all([
      attempt(github.searchRepositories(`${input.text} in:name`, { limit: FETCHED })),
      attempt(github.searchOwners(`${input.text} in:login`, { limit: 10 })),
    ]);
    return {
      owners: rankOwners(owners.items, input.text, TEXT_OWNERS),
      repos: rankRepositories(repos.items, input.text, TEXT_REPOS),
      unavailable: repos.failed || owners.failed,
    };
  }

  return {
    search(input) {
      const key = keyOf(input);
      const saved = answers.get(key);
      if (saved && now() - saved.at < ttlMs) return Promise.resolve(saved.result);
      if (now() < pausedUntil) {
        return Promise.resolve({ owners: [], repos: [], unavailable: true });
      }
      // People typing the same letters at once share one call to GitHub
      const pending = running.get(key);
      if (pending) return pending;
      const started = run(input)
        .then((result) => {
          remember(key, result);
          return result;
        })
        .finally(() => running.delete(key));
      running.set(key, started);
      return started;
    },
  };
}
