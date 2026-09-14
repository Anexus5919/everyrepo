import type { SitePage, SiteWiki } from "@everyrepo/core";
import { languageForPath } from "./format.ts";
import { highlight, renderMarkdown } from "./markdown.ts";

const EXCERPT_LINES = 28;

export interface PreviewPage {
  slug: string;
  title: string;
  excerpts: number;
  html: string;
  sourcesHtml: string;
  active: number | null;
}

export interface TreeGroup {
  slug: string;
  title: string;
  written: boolean;
  children: Array<{ slug: string; title: string }>;
}

const escape = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function repoKey(repo: string): string {
  return repo.replace("/", "__");
}

export function readablePages(wiki: SiteWiki): SitePage[] {
  return wiki.wikiPages.filter((page) => page.status === "written" && page.markdown);
}

// Top level pages in wiki order, each with the written pages filed under it
export function pageTree(wiki: SiteWiki): TreeGroup[] {
  const readable = new Set(readablePages(wiki).map((page) => page.slug));
  return wiki.wikiPages
    .filter((page) => page.parentSlug === null)
    .map((page) => ({
      slug: page.slug,
      title: page.title,
      written: readable.has(page.slug),
      children: wiki.wikiPages
        .filter((child) => child.parentSlug === page.slug && readable.has(child.slug))
        .map((child) => ({ slug: child.slug, title: child.title })),
    }))
    .filter((group) => group.written || group.children.length > 0);
}

export async function buildPreview(page: SitePage): Promise<PreviewPage> {
  const html = await renderMarkdown(page.markdown ?? "");
  const cited = [
    ...new Set([...html.matchAll(/data-cite="(\d+)"/g)].map((match) => Number(match[1]))),
  ];
  const sources = await Promise.all(
    page.citations
      .filter((citation) => cited.includes(citation.number) && citation.excerpt.trim() !== "")
      .map(async (citation) => {
        const lines = citation.excerpt.split("\n");
        const code = await highlight(
          lines.slice(0, EXCERPT_LINES).join("\n"),
          languageForPath(citation.path),
        );
        const name = citation.path.split("/").pop() ?? citation.path;
        const folder = citation.path.split("/").slice(0, -1).join("/");
        const more = Math.max(0, lines.length - EXCERPT_LINES);
        return {
          number: citation.number,
          html: `<div class="source-item" data-source="${citation.number}" hidden>
  <div class="source-head">
    <span class="badge mono">${citation.number}</span>
    <span class="source-file"><span class="mono name">${escape(name)}</span><span class="mono folder">${escape(folder)}</span></span>
    <a class="lines mono" href="${escape(citation.url)}" target="_blank" rel="noopener">lines ${citation.startLine}-${citation.endLine}</a>
  </div>
  <div class="code" style="counter-reset: line ${citation.startLine - 1}">${code}</div>
  ${more > 0 ? `<a class="more" href="${escape(citation.url)}" target="_blank" rel="noopener">${more} more lines on GitHub</a>` : ""}
</div>`,
        };
      }),
  );
  const active = sources[0]?.number ?? null;
  return {
    slug: page.slug,
    title: page.title,
    excerpts: page.citations.length,
    html,
    sourcesHtml: sources
      .map((source) =>
        source.number === active ? source.html.replace(" hidden>", ">") : source.html,
      )
      .join("\n"),
    active,
  };
}
