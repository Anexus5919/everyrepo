import type { Source } from "./sources.ts";
import { plainText } from "./text.ts";

export interface Citation {
  number: number;
  label: string;
  chunkId: number;
  path: string;
  startLine: number;
  endLine: number;
  url: string;
}

export interface VerifyStats {
  blocks: number;
  kept: number;
  uncited: number;
  unknownNames: number;
  unmatchedCode: number;
  // Up to 20 backticked names that no cited source contains, for diagnosing prompts
  missingNames: string[];
}

export interface VerifiedPage {
  markdown: string;
  citations: Citation[];
  stats: VerifyStats;
}

type Block =
  | { type: "heading"; text: string }
  | { type: "code"; text: string; language: string }
  | { type: "text"; text: string };

const CITATION = /\[(S\d+(?:\s*,\s*S\d+)*)\]/g;
const INLINE_CODE = /`([^`\n]+)`/g;

export function splitBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length > 0) blocks.push({ type: "text", text: paragraph.join("\n") });
    paragraph = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const fence = /^\s*```(\S*)/.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index]!)) {
        body.push(lines[index]!);
        index += 1;
      }
      blocks.push({ type: "code", text: body.join("\n"), language: fence[1] ?? "" });
      continue;
    }
    if (/^#{1,6}\s/.test(line)) {
      flush();
      blocks.push({ type: "heading", text: line.trim() });
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    // Each list item stands on its own citations
    if (/^\s*(?:[-*+]|\d+\.)\s/.test(line)) flush();
    paragraph.push(line);
  }
  flush();
  return blocks;
}

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

// A name is grounded when a cited source contains it, ignoring case, or when it names a source file
export function isGroundedName(
  name: string,
  citedContent: string,
  sourcePaths: readonly string[],
): boolean {
  if (citedContent.includes(name) || citedContent.toLowerCase().includes(name.toLowerCase())) {
    return true;
  }
  const trimmed = name.replace(/^\.?\//, "");
  return sourcePaths.some(
    (path) =>
      path === trimmed ||
      path.endsWith(`/${trimmed}`) ||
      (path.split("/").pop() ?? "").replace(/\.[^.]+$/, "") === trimmed,
  );
}

export function githubLink(repo: string, sha: string, source: Source): string {
  const path = source.path.split("/").map(encodeURIComponent).join("/");
  return `https://github.com/${repo}/blob/${sha}/${path}#L${source.startLine}-L${source.endLine}`;
}

// Keeps only prose backed by the numbered sources and turns source labels into commit-pinned links
export function verifyPage(
  raw: string,
  sources: readonly Source[],
  link: (source: Source) => string,
): VerifiedPage {
  const byLabel = new Map(sources.map((source) => [source.label, source]));
  const allContent = normalize(sources.map((source) => source.content).join("\n"));
  const sourcePaths = [...new Set(sources.map((source) => source.path))];
  const citations = new Map<string, Citation>();
  const stats: VerifyStats = {
    blocks: 0,
    kept: 0,
    uncited: 0,
    unknownNames: 0,
    unmatchedCode: 0,
    missingNames: [],
  };
  const output: string[] = [];

  const numberFor = (source: Source): Citation => {
    const existing = citations.get(source.label);
    if (existing) return existing;
    const citation: Citation = {
      number: citations.size + 1,
      label: source.label,
      chunkId: source.chunkId,
      path: source.path,
      startLine: source.startLine,
      endLine: source.endLine,
      url: link(source),
    };
    citations.set(source.label, citation);
    return citation;
  };

  for (const block of splitBlocks(raw)) {
    if (block.type === "heading") {
      if (/^#\s/.test(block.text)) continue;
      output.push(plainText(block.text.replace(/\s*\[S\d+(?:\s*,\s*S\d+)*\]/g, "")));
      continue;
    }
    stats.blocks += 1;
    if (block.type === "code") {
      const lines = block.text.split("\n").map(normalize).filter(Boolean);
      const copied = lines.length > 0 && lines.every((line) => allContent.includes(line));
      if (block.language === "mermaid" || !copied) {
        stats.unmatchedCode += 1;
        continue;
      }
      output.push(`\`\`\`${block.language}\n${block.text}\n\`\`\``);
      stats.kept += 1;
      continue;
    }

    const cited = new Set<Source>();
    for (const match of block.text.matchAll(CITATION)) {
      for (const label of match[1]!.split(/\s*,\s*/)) {
        const source = byLabel.get(label);
        if (source) cited.add(source);
      }
    }
    if (cited.size === 0) {
      stats.uncited += 1;
      continue;
    }
    const citedContent = [...cited].map((source) => source.content).join("\n");
    const names = [...block.text.matchAll(INLINE_CODE)].map((match) => match[1]!.trim());
    const missing = names.filter((name) => !isGroundedName(name, citedContent, sourcePaths));
    if (missing.length > 0) {
      stats.unknownNames += 1;
      for (const name of missing) {
        if (stats.missingNames.length < 20) stats.missingNames.push(name);
      }
      continue;
    }
    const text = block.text.replace(CITATION, (_whole, labels: string) => {
      const links = labels
        .split(/\s*,\s*/)
        .map((label) => byLabel.get(label))
        .filter((source): source is Source => source !== undefined)
        .map((source) => {
          const citation = numberFor(source);
          return `[[${citation.number}]](${citation.url})`;
        });
      return links.join("");
    });
    output.push(plainText(text));
    stats.kept += 1;
  }

  // Headings left without any content below them are removed
  const markdown = output
    .filter((block, index) => {
      if (!/^#{2,6}\s/.test(block)) return true;
      const next = output[index + 1];
      return next !== undefined && !/^#{2,6}\s/.test(next);
    })
    .join("\n\n");
  return { markdown, citations: [...citations.values()], stats };
}
