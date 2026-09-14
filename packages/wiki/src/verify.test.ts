import { describe, expect, it } from "vitest";
import type { Source } from "./sources.ts";
import { githubLink, isGroundedName, splitBlocks, verifyPage } from "./verify.ts";

const sources: Source[] = [
  {
    label: "S1",
    chunkId: 10,
    path: "src/store/store.ts",
    startLine: 1,
    endLine: 20,
    content:
      "import { create } from 'zustand';\nexport const useAppStore = create(() => ({ count: 0 }));",
  },
  {
    label: "S2",
    chunkId: 11,
    path: "src/utils/compression.ts",
    startLine: 5,
    endLine: 9,
    content:
      "export function compress(data: unknown) {\n  return LZString.compressToEncodedURIComponent(JSON.stringify(data));\n}",
  },
];

const link = (source: Source) => githubLink("acme/app", "abc123", source);

describe("verifyPage", () => {
  it("keeps cited prose, drops unsupported blocks and links citations to exact lines", () => {
    const raw = [
      "# Title the model should not add",
      "The app keeps state in `useAppStore` built with `Zustand` [S1].",
      "",
      "This paragraph has no source.",
      "## Sharing",
      "- `compress` encodes data for links, see `compression.ts` [S2]",
      "- It also uses `inventedHelper` [S2]",
      "```ts",
      "export function compress(data: unknown) {",
      "```",
      "## Empty section",
      "Unsupported claim [S9].",
      "```ts",
      "const made = 'up';",
      "```",
    ].join("\n");
    const page = verifyPage(raw, sources, link);

    expect(page.stats).toMatchObject({
      blocks: 7,
      kept: 3,
      uncited: 2,
      unknownNames: 1,
      unmatchedCode: 1,
    });
    expect(page.stats.missingNames).toEqual(["inventedHelper"]);
    expect(page.markdown).not.toContain("# Title");
    expect(page.markdown).not.toContain("Empty section");
    expect(page.markdown).toContain(
      "[[1]](https://github.com/acme/app/blob/abc123/src/store/store.ts#L1-L20)",
    );
    expect(page.citations.map((citation) => [citation.number, citation.chunkId])).toEqual([
      [1, 10],
      [2, 11],
    ]);
  });

  it("splits list items into their own blocks and keeps fenced code whole", () => {
    const blocks = splitBlocks("Intro [S1]\n- one\n- two\n\n```\na\n\nb\n```\n## H");
    expect(blocks.map((block) => block.type)).toEqual(["text", "text", "text", "code", "heading"]);
  });

  it("accepts names found in cited code regardless of case, and source file names", () => {
    const paths = ["src/ai/chatRelay.ts"];
    expect(isGroundedName("Zustand", "import 'zustand'", paths)).toBe(true);
    expect(isGroundedName("chatRelay", "", paths)).toBe(true);
    expect(isGroundedName("ai/chatRelay.ts", "", paths)).toBe(true);
    expect(isGroundedName("otherFile", "", paths)).toBe(false);
  });
});
