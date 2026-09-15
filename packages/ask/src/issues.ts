export interface GithubIssue {
  number: number;
  title: string;
  url: string;
  labels: string[];
  comments: number;
  reactions: number;
  createdAt: string;
  updatedAt: string;
  body: string;
  open: boolean;
}

export interface IssueSource {
  // Open issues labeled for newcomers, best candidates first
  newcomerIssues(repo: string): Promise<GithubIssue[]>;
  issue(repo: string, number: number): Promise<GithubIssue | null>;
}

export interface GithubIssueOptions {
  token?: string;
  fetch?: typeof fetch;
  now?: () => number;
  cacheMs?: number;
}

// GitHub refused or failed, so the answer says issues could not be loaded instead of guessing
export class IssueLookupError extends Error {
  override readonly name = "IssueLookupError";
}

const API = "https://api.github.com";
const NEWCOMER_LABEL =
  /good.?first|first.?timers?|beginner|\beasy\b|starter|up.?for.?grabs|ready.?to.?take|help.?wanted/i;
// Earlier patterns mark stronger invitations to newcomers
const LABEL_STRENGTH = [
  /good.?first|first.?timers?|beginner/i,
  /ready.?to.?take|up.?for.?grabs/i,
  /./,
];
const DAY_MS = 86_400_000;
const REQUEST_TIMEOUT_MS = 8_000;

interface ApiIssue {
  number: number;
  title: string;
  html_url: string;
  labels: Array<string | { name?: string }>;
  comments: number;
  reactions?: { total_count?: number };
  created_at: string;
  updated_at: string;
  body?: string | null;
  state: string;
  pull_request?: unknown;
}

function toIssue(item: ApiIssue): GithubIssue {
  return {
    number: item.number,
    title: item.title,
    url: item.html_url,
    labels: item.labels
      .map((label) => (typeof label === "string" ? label : (label.name ?? "")))
      .filter(Boolean),
    comments: item.comments,
    reactions: item.reactions?.total_count ?? 0,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
    body: item.body ?? "",
    open: item.state === "open",
  };
}

// Clear invitations first, then issues with a real description, recent activity and few comments
export function rankNewcomerIssues(issues: readonly GithubIssue[], now: number): GithubIssue[] {
  const score = (issue: GithubIssue) => {
    const strength = Math.min(
      ...issue.labels
        .filter((label) => NEWCOMER_LABEL.test(label))
        .map((label) => LABEL_STRENGTH.findIndex((pattern) => pattern.test(label))),
      LABEL_STRENGTH.length,
    );
    const age = (now - Date.parse(issue.updatedAt)) / DAY_MS;
    return (
      (LABEL_STRENGTH.length - strength) * 2 +
      (age < 180 ? 1 : 0) +
      (issue.body.length >= 150 ? 0.5 : 0) +
      Math.min(issue.reactions, 20) * 0.05 -
      Math.min(issue.comments, 30) * 0.05
    );
  };
  return [...issues].sort((a, b) => score(b) - score(a) || b.number - a.number);
}

export function createGithubIssues(options: GithubIssueOptions = {}): IssueSource {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const cacheMs = options.cacheMs ?? 30 * 60_000;
  const cache = new Map<string, { at: number; value: unknown }>();

  async function get<T>(path: string): Promise<T | null> {
    const hit = cache.get(path);
    if (hit && now() - hit.at < cacheMs) return hit.value as T;
    let response: Response | undefined;
    // A dropped connection or a slow reply gets one more try before the answer gives up
    for (let attempt = 1; attempt <= 2 && !response; attempt += 1) {
      try {
        const reply = await doFetch(`${API}${path}`, {
          headers: {
            accept: "application/vnd.github+json",
            "user-agent": "everyrepo",
            ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (reply.status < 500 || attempt === 2) response = reply;
      } catch {
        if (attempt === 2) throw new IssueLookupError("GitHub could not be reached.");
      }
    }
    if (!response) throw new IssueLookupError("GitHub could not be reached.");
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new IssueLookupError(
        response.status === 403 || response.status === 429
          ? "GitHub is limiting requests right now."
          : `GitHub answered with status ${response.status}.`,
      );
    }
    const value = (await response.json()) as T;
    cache.set(path, { at: now(), value });
    return value;
  }

  return {
    async newcomerIssues(repo) {
      const labels: string[] = [];
      for (let page = 1; page <= 5; page += 1) {
        const batch = await get<Array<{ name: string }>>(
          `/repos/${repo}/labels?per_page=100&page=${page}`,
        );
        if (!batch) break;
        labels.push(
          ...batch.map((label) => label.name).filter((name) => NEWCOMER_LABEL.test(name)),
        );
        if (batch.length < 100) break;
      }
      if (labels.length === 0) return [];
      const query = [
        `repo:${repo}`,
        "is:issue",
        "is:open",
        "no:assignee",
        "-linked:pr",
        `label:${labels.map((label) => `"${label.replaceAll('"', "")}"`).join(",")}`,
      ].join(" ");
      const result = await get<{ items?: ApiIssue[] }>(
        `/search/issues?q=${encodeURIComponent(query)}&sort=updated&order=desc&per_page=30`,
      );
      return rankNewcomerIssues((result?.items ?? []).map(toIssue), now());
    },
    async issue(repo, number) {
      const item = await get<ApiIssue>(`/repos/${repo}/issues/${number}`);
      return item && !item.pull_request ? toIssue(item) : null;
    },
  };
}
