import { isParseable, withSyntaxTree, type SyntaxNode } from "@everyrepo/parse";

export type ChunkKind = "code" | "markdown" | "text";

export interface LineChunk {
  // Zero-based, inclusive line range
  startLine: number;
  endLine: number;
  kind: ChunkKind;
  // Heading trail for markdown sections
  headings?: string[];
}

export const MAX_CHUNK_CHARS = 1_800;

// Prefix sums of non-whitespace characters per line give O(1) range sizes
function lineSizer(lines: readonly string[]) {
  const prefix = [0];
  for (const line of lines)
    prefix.push(prefix[prefix.length - 1]! + line.replace(/\s+/g, "").length);
  return (start: number, end: number) => prefix[end + 1]! - prefix[start]!;
}

function lineWindows(
  size: (start: number, end: number) => number,
  start: number,
  end: number,
): Array<[number, number]> {
  const windows: Array<[number, number]> = [];
  let windowStart = start;
  for (let line = start; line <= end; line += 1) {
    if (line > windowStart && size(windowStart, line) > MAX_CHUNK_CHARS) {
      windows.push([windowStart, line - 1]);
      windowStart = line;
    }
  }
  if (windowStart <= end) windows.push([windowStart, end]);
  return windows;
}

// Makes ranges contiguous from start to end so every line belongs to exactly one chunk
function fillGaps(
  ranges: Array<[number, number]>,
  start: number,
  end: number,
): Array<[number, number]> {
  const filled: Array<[number, number]> = [];
  let next = start;
  for (const [, rangeEnd] of ranges) {
    const to = Math.min(rangeEnd, end);
    // Ranges already covered are skipped; gap lines join the following range
    if (to < next) continue;
    filled.push([next, to]);
    next = to + 1;
    if (next > end) break;
  }
  if (filled.length === 0) return [[start, end]];
  filled[filled.length - 1]![1] = end;
  return filled;
}

function mergeGreedy(
  ranges: Array<[number, number]>,
  size: (start: number, end: number) => number,
): Array<[number, number]> {
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && size(last[0], range[1]) <= MAX_CHUNK_CHARS) last[1] = range[1];
    else merged.push([range[0], range[1]]);
  }
  return merged;
}

function splitNode(
  node: SyntaxNode,
  size: (start: number, end: number) => number,
  start: number,
  end: number,
): Array<[number, number]> {
  if (size(start, end) <= MAX_CHUNK_CHARS) return [[start, end]];
  const children = node.namedChildren.filter((child): child is SyntaxNode => child !== null);
  if (children.length === 0) return lineWindows(size, start, end);
  const parts = children.flatMap((child) => {
    const childStart = Math.max(child.startPosition.row, start);
    const childEnd = Math.min(child.endPosition.row, end);
    return childEnd < childStart ? [] : splitNode(child, size, childStart, childEnd);
  });
  const contiguous = fillGaps(parts, start, end);
  // Children that all sit on one oversized range cannot help, so fall back to line windows
  if (contiguous.length === 1) return lineWindows(size, start, end);
  return mergeGreedy(contiguous, size);
}

export async function chunkCode(language: string, source: string): Promise<LineChunk[]> {
  const lines = source.split(/\r?\n/);
  const size = lineSizer(lines);
  const lastLine = Math.max(0, lines.length - 1);
  if (!isParseable(language)) return chunkText(source);
  const ranges = await withSyntaxTree(language, source, (root) =>
    splitNode(root, size, 0, lastLine),
  );
  return ranges
    .filter(([start, end]) => size(start, end) > 0)
    .map(([startLine, endLine]) => ({ startLine, endLine, kind: "code" as const }));
}

export function chunkText(source: string): LineChunk[] {
  const lines = source.split(/\r?\n/);
  const size = lineSizer(lines);
  return lineWindows(size, 0, Math.max(0, lines.length - 1))
    .filter(([start, end]) => size(start, end) > 0)
    .map(([startLine, endLine]) => ({ startLine, endLine, kind: "text" as const }));
}

export function chunkMarkdown(source: string): LineChunk[] {
  const lines = source.split(/\r?\n/);
  const size = lineSizer(lines);
  const chunks: LineChunk[] = [];
  const trail: string[] = [];
  let sectionStart = 0;
  let sectionHeadings: string[] = [];
  let inFence = false;

  const flush = (end: number) => {
    if (end < sectionStart || size(sectionStart, end) === 0) return;
    for (const [startLine, endLine] of lineWindows(size, sectionStart, end)) {
      chunks.push({ startLine, endLine, kind: "markdown", headings: sectionHeadings });
    }
  };

  lines.forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const heading = inFence ? null : /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!heading) return;
    flush(index - 1);
    const depth = heading[1]!.length;
    trail.length = depth - 1;
    trail[depth - 1] = heading[2]!;
    sectionStart = index;
    sectionHeadings = trail.filter(Boolean);
  });
  flush(lines.length - 1);
  return chunks;
}

// Identifier parts help keyword search match camelCase and snake_case names from plain words
export function identifierTerms(text: string): string {
  const terms = new Set<string>();
  for (const identifier of text.match(/[A-Za-z_$][A-Za-z0-9_$]{2,}/g) ?? []) {
    const lower = identifier.toLowerCase();
    terms.add(lower);
    const parts = identifier
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .split(/[\s_$]+/)
      .filter((part) => part.length > 1);
    if (parts.length > 1) for (const part of parts) terms.add(part.toLowerCase());
  }
  return [...terms].join(" ");
}
