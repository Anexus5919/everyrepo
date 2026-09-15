import type { SitePage, SiteWiki } from "@everyrepo/core";
import { sections } from "./markdown.ts";

const WORDS_PER_MINUTE = 230;
const CITATION = /\[\[\d+\]\]\([^)]*\)/g;
const HAS_CITATION = /\[\[\d+\]\]\(/;

function prose(markdown: string): string {
  return markdown.replace(/```[\s\S]*?```/g, " ").replace(CITATION, " ");
}

export function wordCount(markdown: string): number {
  return prose(markdown)
    .split(/\s+/)
    .filter((word) => /\w/.test(word)).length;
}

export function readingMinutes(wikis: readonly SiteWiki[]): number {
  const words = wikis.reduce(
    (sum, wiki) =>
      sum + wiki.wikiPages.reduce((count, page) => count + wordCount(page.markdown ?? ""), 0),
    0,
  );
  return Math.max(1, Math.round(words / WORDS_PER_MINUTE));
}

export function citationLinks(wikis: readonly SiteWiki[]): number {
  return wikis.reduce(
    (sum, wiki) =>
      sum +
      wiki.wikiPages.reduce(
        (count, page) => count + (page.markdown?.match(CITATION)?.length ?? 0),
        0,
      ),
    0,
  );
}

const paragraphs = (body: string) =>
  body
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block !== "" && !block.startsWith("```") && !block.startsWith("#"));

// A page reads well as a sample when it sits in a section, has cited sections and many sources
export function samplePage(wiki: SiteWiki): SitePage | undefined {
  const scored = wiki.wikiPages
    .filter((page) => page.status === "written" && !page.section && page.markdown)
    .map((page) => {
      const cited = sections(page.markdown!).filter(
        (part) => part.heading && paragraphs(part.body).some((block) => HAS_CITATION.test(block)),
      ).length;
      const words = wordCount(page.markdown!);
      const score =
        (page.parentSlug ? 2 : 0) +
        Math.min(cited, 3) +
        Math.min(page.citations.length, 20) / 10 -
        (words > 1400 ? 1 : 0);
      return { page, score };
    });
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.page;
}

export interface SampleText {
  intro: string;
  parts: Array<{ heading: string; body: string }>;
}

// The opening paragraph and the first two sections that cite their sources
export function sampleText(page: SitePage, maxParts = 2): SampleText {
  const all = sections(page.markdown ?? "");
  const intro = paragraphs(all[0]?.body ?? "")[0] ?? "";
  const parts = all
    .filter(
      (part) => part.heading && paragraphs(part.body).some((block) => HAS_CITATION.test(block)),
    )
    .slice(0, maxParts)
    .map((part) => ({ heading: part.heading!, body: part.body }));
  return { intro, parts };
}

export interface PipelineItem {
  repo: string;
  files: string;
  title: string;
  file: string;
  lines: string;
}

// Pages from every written wiki, taken in turn so each repository appears regularly
export function pipelineItems(wikis: readonly SiteWiki[], formatFiles: (count: number) => string) {
  const queues = wikis.map((wiki) =>
    wiki.wikiPages
      .filter((page) => page.status === "written" && !page.section && page.citations.length > 0)
      .map((page): PipelineItem => ({
        repo: wiki.repo,
        files: formatFiles(wiki.files),
        title: page.title,
        file: page.citations[0]!.path.split("/").pop() ?? page.citations[0]!.path,
        lines: `lines ${page.citations[0]!.startLine}-${page.citations[0]!.endLine}`,
      })),
  );
  const items: PipelineItem[] = [];
  const longest = Math.max(0, ...queues.map((queue) => queue.length));
  for (let index = 0; index < longest; index += 1) {
    for (const queue of queues) {
      const item = queue[index];
      if (item) items.push(item);
    }
  }
  return items;
}

const MERMAID = /```mermaid\n([\s\S]*?)```/;

// The first written page of a wiki that carries an import diagram
export function diagramPage(wiki: SiteWiki): SitePage | undefined {
  return wiki.wikiPages.find(
    (page) => page.status === "written" && page.markdown && MERMAID.test(page.markdown),
  );
}

export interface DiagramExample {
  repo: string;
  page: SitePage;
  source: string;
  boxes: number;
}

// A diagram that reads well on its own: enough boxes to be interesting, few enough links to stay calm
export function diagramExample(
  wikis: readonly SiteWiki[],
  measure: (source: string) => { boxes: number; links: number; crossings: number } | undefined,
): DiagramExample | undefined {
  const candidates = wikis.flatMap((wiki) =>
    wiki.wikiPages
      .filter((page) => page.status === "written" && page.markdown && MERMAID.test(page.markdown))
      .flatMap((page) => {
        const source = MERMAID.exec(page.markdown!)![1]!;
        const size = measure(source);
        if (!size || size.boxes < 6 || size.boxes > 10) return [];
        const score = size.crossings * 3 + Math.abs(size.links - size.boxes * 1.4);
        return [{ repo: wiki.repo, page, source, boxes: size.boxes, score }];
      }),
  );
  candidates.sort((a, b) => a.score - b.score);
  const best = candidates[0];
  return best
    ? { repo: best.repo, page: best.page, source: best.source, boxes: best.boxes }
    : undefined;
}

export interface AskExample {
  repo: string;
  page: SitePage;
  question: string;
  answer: string;
  sources: SitePage["citations"];
}

// A question a newcomer might ask about a cited page, answered with that page's own opening paragraph
export function askExample(wiki: SiteWiki): AskExample | undefined {
  const page = samplePage(wiki);
  if (!page) return undefined;
  const answer = sampleText(page).intro;
  const numbers = new Set([...answer.matchAll(/\[\[(\d+)\]\]/g)].map((match) => Number(match[1])));
  if (numbers.size === 0) return undefined;
  return {
    repo: wiki.repo,
    page,
    question: `How does ${page.title} work?`,
    answer,
    sources: page.citations.filter((citation) => numbers.has(citation.number)).slice(0, 4),
  };
}
