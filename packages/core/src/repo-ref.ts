export interface RepoRef {
  owner: string;
  name: string;
}

// Why text could not be read as a repository, so a form can say what to change
export type RepoInputProblem =
  "empty" | "other-host" | "not-a-repository" | "owner-only" | "invalid";

export type RepoInput =
  { ok: true; ref: RepoRef } | { ok: false; problem: RepoInputProblem; owner?: string };

// GitHub user and organization names: letters, digits and hyphens, at most 39 characters
const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;
const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);
// First path segments of github.com pages that are not user or organization names
const RESERVED_OWNERS = new Set([
  "about",
  "apps",
  "codespaces",
  "collections",
  "contact",
  "customer-stories",
  "enterprise",
  "events",
  "explore",
  "features",
  "issues",
  "login",
  "marketplace",
  "new",
  "notifications",
  "organizations",
  "orgs",
  "pricing",
  "pulls",
  "search",
  "security",
  "settings",
  "site",
  "sponsors",
  "topics",
  "trending",
]);

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function fromSegments(segments: string[]): RepoInput {
  const parts = segments.map(decode).filter((part) => part !== "");
  const [first, second] = parts;
  if (!first) return { ok: false, problem: "not-a-repository" };
  if (first.toLowerCase() === "orgs" || first.toLowerCase() === "users") {
    return second && OWNER.test(second)
      ? { ok: false, problem: "owner-only", owner: second }
      : { ok: false, problem: "not-a-repository" };
  }
  if (RESERVED_OWNERS.has(first.toLowerCase())) return { ok: false, problem: "not-a-repository" };
  if (!OWNER.test(first)) return { ok: false, problem: "invalid" };
  if (!second) return { ok: false, problem: "owner-only", owner: first };
  return fromPair(first, second);
}

function fromPair(owner: string, rawName: string): RepoInput {
  const name = rawName.replace(/\.git$/i, "");
  if (!OWNER.test(owner) || !NAME.test(name) || /^\.+$/.test(name)) {
    return { ok: false, problem: "invalid" };
  }
  return { ok: true, ref: { owner, name } };
}

function fromUrl(text: string): RepoInput {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, problem: "invalid" };
  }
  const host = url.hostname.toLowerCase();
  if (host === "gist.github.com") return { ok: false, problem: "not-a-repository" };
  if (!GITHUB_HOSTS.has(host)) return { ok: false, problem: "other-host" };
  return fromSegments(url.pathname.split("/"));
}

// Reads owner/name or any GitHub address people paste: web links to a page inside the
// repository, clone URLs over HTTPS, SSH or git, with or without the scheme
export function readRepoInput(input: string): RepoInput {
  const text = input
    .trim()
    .replace(/^<(.*)>$/, "$1")
    .trim();
  if (text === "") return { ok: false, problem: "empty" };

  const scp = /^[\w.-]+@([\w.-]+):(?!\/\/)(.*)$/.exec(text);
  if (scp) {
    if (!GITHUB_HOSTS.has(scp[1]!.toLowerCase())) return { ok: false, problem: "other-host" };
    const [path = ""] = scp[2]!.split(/[?#]/);
    return fromSegments(path.split("/"));
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return fromUrl(text);

  const [path = ""] = text.split(/[?#]/);
  const segments = path.split("/").filter((part) => part !== "");
  const [first] = segments;
  // A first segment with a dot is a host name, since owner names never contain one
  if (first?.includes(".")) return fromUrl(`https://${text}`);
  if (segments.length === 2) return fromPair(segments[0]!, segments[1]!);
  if (segments.length === 1 && OWNER.test(segments[0]!)) {
    return { ok: false, problem: "owner-only", owner: segments[0]! };
  }
  return { ok: false, problem: "invalid" };
}

export function parseRepoRef(input: string): RepoRef {
  const result = readRepoInput(input);
  if (!result.ok) throw new Error(`Invalid repository reference: ${input}`);
  return result.ref;
}

export function formatRepoRef(ref: RepoRef): string {
  return `${ref.owner}/${ref.name}`;
}

// GitHub names are case-insensitive, so lookups compare lowercase keys
export function repoKey(ref: RepoRef): string {
  return formatRepoRef(ref).toLowerCase();
}

// Filesystem-safe directory name, for example mui__mui-x
export function repoDirName(ref: RepoRef): string {
  return `${ref.owner}__${ref.name}`;
}
