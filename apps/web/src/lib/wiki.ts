import type { SitePage, SiteWiki } from "@everyrepo/core";
import { languageName } from "./format.ts";
import { readablePages } from "./preview.ts";
import { loadRepos, loadWiki } from "./site-data.ts";

export function readyWikis(): SiteWiki[] {
  return loadRepos()
    .filter((repo) => repo.status === "ready")
    .map((repo) => loadWiki(repo.repo));
}

export const hubHref = (wiki: SiteWiki) => `/${wiki.repo}`;
export const pageHref = (wiki: SiteWiki, slug: string) => `/${wiki.repo}/${slug}`;
export const githubHref = (wiki: SiteWiki) => `https://github.com/${wiki.repo}`;

// Pages in wiki order that a reader can open, used for previous and next links
export function readingSequence(wiki: SiteWiki): SitePage[] {
  const readable = new Set(readablePages(wiki).map((page) => page.slug));
  const sequence: SitePage[] = [];
  for (const top of wiki.wikiPages.filter((page) => page.parentSlug === null)) {
    if (readable.has(top.slug)) sequence.push(top);
    for (const child of wiki.wikiPages.filter((page) => page.parentSlug === top.slug)) {
      if (readable.has(child.slug)) sequence.push(child);
    }
  }
  return sequence;
}

// Technologies named in the summary, without the languages already shown from file counts
export function technologies(wiki: SiteWiki): string[] {
  const languages = new Set(
    wiki.languages.flatMap((item) => [
      item.language.toLowerCase(),
      languageName(item.language).toLowerCase(),
    ]),
  );
  const seen = new Set<string>();
  return wiki.technologies.filter((name) => {
    const key = name.toLowerCase();
    if (languages.has(key) || seen.has(key) || name === key) return false;
    seen.add(key);
    return true;
  });
}

export function startingFiles(wiki: SiteWiki, limit = 5) {
  const counts = new Map<
    string,
    { item: SitePage["readingOrder"][number]; pages: number; first: number }
  >();
  readingSequence(wiki).forEach((page, order) => {
    for (const item of page.readingOrder) {
      if (!item.role) continue;
      const entry = counts.get(item.path);
      if (entry) entry.pages += 1;
      else counts.set(item.path, { item, pages: 1, first: order });
    }
  });
  return [...counts.values()]
    .sort((a, b) => b.pages - a.pages || a.first - b.first)
    .slice(0, limit)
    .map((entry) => entry.item);
}

export function formatDate(timestamp: number | null): string {
  if (!timestamp) return "";
  return new Date(timestamp).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
