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
  if (segments.length === 2) return fromSegments(segments);
  if (segments.length === 1 && OWNER.test(segments[0]!)) {
    return { ok: false, problem: "owner-only", owner: segments[0]! };
  }
  return { ok: false, problem: "invalid" };
}

// What the repository box searches GitHub for while someone types: an owner's repositories once a slash
// follows the owner, otherwise owners and repositories whose names match the text
export type SearchInput =
  { kind: "owner"; owner: string; name: string } | { kind: "text"; text: string };

const PARTIAL_NAME = /^[A-Za-z0-9._-]{0,100}$/;
const SEARCH_TEXT = /^[A-Za-z0-9._-]{2,100}$/;

export function readSearchInput(input: string): SearchInput | undefined {
  const text = input.trim();
  // A pasted address names its repository exactly, so it is looked up instead of searched
  if (/^[a-z][a-z0-9+.-]*:\/\/|^[\w.-]+@|^(www\.)?github\.com/i.test(text)) {
    const read = readRepoInput(text);
    return !read.ok && read.problem === "owner-only" && read.owner
      ? { kind: "owner", owner: read.owner, name: "" }
      : undefined;
  }
  const slash = text.indexOf("/");
  if (slash === -1) return SEARCH_TEXT.test(text) ? { kind: "text", text } : undefined;
  const owner = text.slice(0, slash);
  const name = text.slice(slash + 1);
  if (!OWNER.test(owner) || !PARTIAL_NAME.test(name)) return undefined;
  if (RESERVED_OWNERS.has(owner.toLowerCase())) return undefined;
  return { kind: "owner", owner, name };
}

// What to tell someone whose text could not be read as a repository
export function repoInputMessage(problem: RepoInputProblem, owner?: string): string {
  switch (problem) {
    case "empty":
      return "Enter a repository as owner/name, or paste its GitHub link.";
    case "other-host":
      return "Only repositories on GitHub can be read for now.";
    case "not-a-repository":
      return "That link is not a repository. Open the repository on GitHub and copy its address.";
    case "owner-only":
      return owner
        ? `That is the ${owner} account. Add a repository name, like ${owner}/name.`
        : "Add a repository name after the account, like owner/name.";
    case "invalid":
      return "That does not look like a GitHub repository. Use owner/name or paste its GitHub link.";
  }
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
