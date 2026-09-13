import { describe, expect, it } from "vitest";
import {
  chunkCode,
  chunkMarkdown,
  chunkText,
  identifierTerms,
  MAX_CHUNK_CHARS,
  type LineChunk,
} from "./chunk.ts";

function assertCovers(chunks: LineChunk[], lineCount: number) {
  expect(chunks[0]?.startLine).toBe(0);
  expect(chunks[chunks.length - 1]?.endLine).toBe(lineCount - 1);
  for (let index = 1; index < chunks.length; index += 1) {
    expect(chunks[index]!.startLine).toBe(chunks[index - 1]!.endLine + 1);
  }
}

function sizeOf(source: string, chunk: LineChunk) {
  return source
    .split("\n")
    .slice(chunk.startLine, chunk.endLine + 1)
    .join("")
    .replace(/\s+/g, "").length;
}

describe("chunkCode", () => {
  it("keeps a small file in one chunk", async () => {
    const source = "export function add(a: number, b: number) {\n  return a + b;\n}\n";
    expect(await chunkCode("typescript", source)).toEqual([
      { startLine: 0, endLine: 3, kind: "code" },
    ]);
  });

  it("splits large files on syntax boundaries with full, non-overlapping coverage", async () => {
    const method = (name: string) =>
      `  ${name}(value: number): number {\n${Array.from({ length: 12 }, (_, i) => `    const step${i} = value * ${i} + this.offset${i};`).join("\n")}\n    return value;\n  }\n`;
    const source = `import { thing } from "./thing";\n\nexport class Calculator {\n${["alpha", "beta", "gamma", "delta", "epsilon", "zeta"].map(method).join("\n")}}\n\nexport const done = true;\n`;
    const chunks = await chunkCode("typescript", source);
    const lineCount = source.split("\n").length;
    expect(chunks.length).toBeGreaterThan(1);
    assertCovers(chunks, lineCount);
    for (const chunk of chunks) expect(sizeOf(source, chunk)).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    const methodStarts = source
      .split("\n")
      .flatMap((line, index) => (/^\s{2}\w+\(value/.test(line) ? [index] : []));
    // Chunks begin at method boundaries rather than in the middle of a method body
    for (const chunk of chunks.slice(1)) {
      const startsAtMethod =
        methodStarts.includes(chunk.startLine) ||
        source.split("\n")[chunk.startLine]!.trim() === "";
      expect(startsAtMethod).toBe(true);
    }
  });

  it("falls back to line windows for unsupported languages and oversized statements", async () => {
    const long = Array.from({ length: 400 }, (_, i) => `x${i} = ${i}`).join("\n");
    const kotlin = await chunkCode("kotlin", long);
    expect(kotlin.every((chunk) => chunk.kind === "text")).toBe(true);
    assertCovers(kotlin, 400);
    const array = `export const data = [\n${Array.from({ length: 600 }, (_, i) => `  ${i},`).join("\n")}\n];\n`;
    const chunks = await chunkCode("typescript", array);
    assertCovers(chunks, array.split("\n").length);
    for (const chunk of chunks) expect(sizeOf(array, chunk)).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
  });
});

describe("chunkMarkdown and chunkText", () => {
  it("splits markdown by headings and keeps the heading trail, ignoring fenced code", () => {
    const source =
      "# Data Grid\nIntro\n## Filtering\nText\n```md\n# not a heading\n```\n### Quick filter\nMore\n## Sorting\nEnd";
    const chunks = chunkMarkdown(source);
    expect(
      chunks.map((chunk) => [chunk.startLine, chunk.endLine, chunk.headings?.join(" > ")]),
    ).toEqual([
      [0, 1, "Data Grid"],
      [2, 6, "Data Grid > Filtering"],
      [7, 8, "Data Grid > Filtering > Quick filter"],
      [9, 10, "Data Grid > Sorting"],
    ]);
  });

  it("windows plain text and skips empty chunks", () => {
    expect(chunkText("\n\n")).toEqual([]);
    expect(chunkText("hello\nworld")).toEqual([{ startLine: 0, endLine: 1, kind: "text" }]);
  });
});

describe("identifierTerms", () => {
  it("adds lowercase identifiers and their camelCase and snake_case parts", () => {
    const terms = identifierTerms(
      "const apiRef = useGridApiRef(); parse_json_value(HTMLElement)",
    ).split(" ");
    expect(terms).toEqual(
      expect.arrayContaining([
        "usegridapiref",
        "use",
        "grid",
        "api",
        "ref",
        "parse_json_value",
        "parse",
        "json",
        "value",
        "htmlelement",
        "html",
        "element",
      ]),
    );
  });
});
