import type { SearchInput } from "@everyrepo/core/repo-ref";
import type { RepoSearch, SearchOwner, SearchRepo } from "@everyrepo/core/requests";

export interface KnownWiki {
  repo: string;
  status: string;
  summary: string | null;
  pages: number;
}

export type Suggestion =
  | { kind: "wiki"; wiki: KnownWiki }
  | { kind: "repo"; repo: SearchRepo; wiki: KnownWiki | undefined }
  | { kind: "owner"; owner: SearchOwner };

export interface SuggestionGroup {
  label: string;
  items: Suggestion[];
}

const WIKIS_ALONE = 6;
const WIKIS_WITH_SEARCH = 3;

export const searchKey = (input: SearchInput) =>
  input.kind === "owner"
    ? `owner:${input.owner.toLowerCase()}/${input.name.toLowerCase()}`
    : `text:${input.text.toLowerCase()}`;

// Whether answers for one search still fit a longer one, so results stay on screen while the next letters are searched
export function covers(previous: SearchInput, next: SearchInput): boolean {
  if (previous.kind === "owner" && next.kind === "owner") {
    return (
      previous.owner.toLowerCase() === next.owner.toLowerCase() &&
      next.name.toLowerCase().startsWith(previous.name.toLowerCase())
    );
  }
  return (
    previous.kind === "text" &&
    next.kind === "text" &&
    next.text.toLowerCase().startsWith(previous.text.toLowerCase())
  );
}

// Keeps only the earlier answers that still match what is typed now
export function narrow(result: RepoSearch, input: SearchInput): RepoSearch {
  if (input.kind === "owner") {
    const owner = input.owner.toLowerCase();
    const name = input.name.toLowerCase();
    return {
      ...result,
      owners: [],
      repos: result.repos.filter((item) => {
        const [itemOwner = "", itemName = ""] = item.repo.toLowerCase().split("/");
        return itemOwner === owner && itemName.includes(name);
      }),
    };
  }
  const text = input.text.toLowerCase();
  return {
    ...result,
    owners: result.owners.filter((owner) => owner.login.toLowerCase().includes(text)),
    repos: result.repos.filter((item) => item.repo.toLowerCase().split("/")[1]?.includes(text)),
  };
}

// The text a repository name is matched against, used to find the part to highlight
export function nameNeedle(text: string, input: SearchInput | undefined): string {
  if (input?.kind === "owner") return input.name;
  if (input?.kind === "text") return input.text;
  return text.trim();
}

export function buildSuggestions(
  text: string,
  input: SearchInput | undefined,
  known: readonly KnownWiki[],
  result: RepoSearch | undefined,
): SuggestionGroup[] {
  const typed = text.trim().toLowerCase();
  const byKey = new Map(known.map((wiki) => [wiki.repo.toLowerCase(), wiki]));
  const searching = input !== undefined;
  const wikis = known
    .filter((wiki) => wiki.status === "ready")
    .filter((wiki) => typed === "" || wiki.repo.toLowerCase().includes(typed))
    .slice(0, searching ? WIKIS_WITH_SEARCH : WIKIS_ALONE);
  const shownWikis = new Set(wikis.map((wiki) => wiki.repo.toLowerCase()));

  const groups: SuggestionGroup[] = [];
  if (wikis.length > 0) {
    groups.push({ label: "Written wikis", items: wikis.map((wiki) => ({ kind: "wiki", wiki })) });
  }
  if (!result) return groups;

  const repos = result.repos
    .filter((item) => !shownWikis.has(item.repo.toLowerCase()))
    .map((repo): Suggestion => ({ kind: "repo", repo, wiki: byKey.get(repo.repo.toLowerCase()) }));
  const repoGroup: SuggestionGroup = {
    label: input?.kind === "owner" ? `Repositories from ${input.owner}` : "Repositories on GitHub",
    items: repos,
  };
  const ownerGroup: SuggestionGroup = {
    label: "Owners",
    items: result.owners.map((owner) => ({ kind: "owner", owner })),
  };
  // Text that is exactly an account name most likely means that account, so it is offered first
  const ownerFirst = result.owners.some((owner) => owner.login.toLowerCase() === typed);
  const ordered = ownerFirst ? [ownerGroup, repoGroup] : [repoGroup, ownerGroup];
  return [...groups, ...ordered.filter((group) => group.items.length > 0)];
}

// Star counts the way GitHub lists them, such as 950, 1.2k or 240k
export function compactCount(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) {
    const thousands = value / 1_000;
    return `${thousands < 10 ? Math.floor(thousands * 10) / 10 : Math.floor(thousands)}k`;
  }
  return `${Math.floor(value / 100_000) / 10}m`;
}
