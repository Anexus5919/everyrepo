import { describe, expect, it } from "vitest";
import { cleanClusterSummary } from "./cluster-summary.ts";
import { normalizeClusterKey } from "./plan.ts";
import { sectionMarkdown } from "./reading-order.ts";
import { importShare } from "./sources.ts";
import { plainText } from "./text.ts";

describe("plainText", () => {
  it("replaces long dashes and removes emoji", () => {
    expect(plainText("Stores state \u2014 and syncs it \u2013 quickly \u{1F680}")).toBe(
      "Stores state, and syncs it, quickly",
    );
  });
});

describe("cleanClusterSummary", () => {
  it("drops key files outside the cluster and cleans every string", () => {
    const summary = cleanClusterSummary(
      {
        title: "State store \u2014 core",
        purpose: "Keeps application state and restores shared links.",
        responsibilities: ["Load state"],
        keyFiles: [
          { path: "src/store.ts", role: "Defines the store" },
          { path: "src/invented.ts", role: "Does not exist" },
        ],
        concepts: ["Store"],
      },
      ["src/store.ts", "src/app.ts"],
    );
    expect(summary.title).toBe("State store, core");
    expect(summary.keyFiles).toEqual([{ path: "src/store.ts", role: "Defines the store" }]);
  });
});

describe("section pages and source selection", () => {
  it("builds a section page from child pages and reading order", () => {
    const markdown = sectionMarkdown(
      {
        slug: "charts",
        title: "Charts",
        purpose: "How the chart packages fit together.",
        clusters: [],
        files: [],
      },
      [
        {
          slug: "charts-pro",
          title: "Charts Pro",
          purpose: "Zoom and export.",
          clusters: ["pro#1"],
          files: [],
        },
      ],
      [
        {
          path: "packages/x-charts/src/index.ts",
          role: "Entry point",
          url: "https://example.test/index.ts",
        },
      ],
      undefined,
    );
    expect(markdown).toContain("- [Charts Pro](charts-pro.md): Zoom and export.");
    expect(markdown).toContain(
      "[`packages/x-charts/src/index.ts`](https://example.test/index.ts): Entry point",
    );
  });

  it("measures how much of a chunk only imports other code", () => {
    expect(
      importShare("import a from 'a';\nimport { b } from 'b';\nexport const c = a + b;"),
    ).toBeCloseTo(2 / 3);
    expect(importShare("function add(a, b) {\n  return a + b;\n}")).toBe(0);
  });

  it("normalizes cluster keys copied with list wording", () => {
    expect(normalizeClusterKey("cluster src#1")).toBe("src#1");
    expect(normalizeClusterKey("`charts#2`")).toBe("charts#2");
  });
});
