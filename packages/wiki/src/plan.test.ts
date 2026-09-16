import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openEngineDb } from "@everyrepo/db";
import type { LlmRouter } from "@everyrepo/llm";
import { describe, expect, it } from "vitest";
import { pageRange, planWiki, validatePlan } from "./plan.ts";

const clusterModules = new Map([
  ["grid#1", "@acme/grid"],
  ["grid#2", "@acme/grid"],
  ["charts#1", "@acme/charts"],
]);
const knownFiles = new Set(["packages/grid/src/Grid.tsx", "packages/charts/src/Chart.tsx"]);

describe("validatePlan", () => {
  it("repairs slugs, parents, clusters and files and places every cluster", () => {
    const { pages, unplaced, dropped } = validatePlan(
      {
        pages: [
          {
            slug: "Data Grid",
            title: "Data grid",
            parent: null,
            purpose: "How rows and columns are rendered.",
            clusters: ["cluster grid#1", "missing#9"],
            files: ["packages/grid/src/Grid.tsx", "packages/grid/src/Invented.tsx"],
          },
          {
            slug: "sorting",
            title: "Sorting",
            parent: "Data Grid",
            purpose: "How the grid sorts rows.",
            clusters: ["grid#1"],
            files: [],
          },
          {
            slug: "sort-details",
            title: "Sort details",
            parent: "sorting",
            purpose: "Deep dive on comparators.",
            clusters: [],
            files: ["packages/charts/src/Chart.tsx"],
          },
        ],
      },
      clusterModules,
      knownFiles,
    );

    // Sorting's only cluster already belongs to the grid page, which leaves it nothing to cite
    expect(pages.map((page) => page.slug)).toEqual([
      "overview",
      "data-grid",
      "sort-details",
      "other-code",
    ]);
    // A third level is lifted to the top-level ancestor
    expect(pages.find((page) => page.slug === "sort-details")?.parentSlug).toBe("data-grid");
    expect(dropped).toEqual({ clusters: 2, files: 1, pages: ["sorting"] });
    expect(unplaced).toBe(2);
    const grid = pages.find((page) => page.slug === "data-grid")!;
    expect(grid.clusters).toEqual(["grid#1", "grid#2"]);
    const placed = pages.flatMap((page) => page.clusters).sort();
    expect(placed).toEqual(["charts#1", "grid#1", "grid#2"]);
    expect(pages.find((page) => page.slug === "other-code")?.clusters).toEqual(["charts#1"]);
    expect(pages.map((page) => page.position)).toEqual([0, 1, 2, 3]);
  });

  it("leaves out pages with nothing to cite but keeps pages that group child pages", () => {
    const known = new Set([...knownFiles, ".github/workflows/ci.yml", "docs/persist.md"]);
    const citable = new Set([...knownFiles, "docs/persist.md"]);
    const { pages, dropped } = validatePlan(
      {
        pages: [
          {
            slug: "overview",
            title: "Overview",
            parent: null,
            purpose: "What this is.",
            clusters: [],
            files: [],
          },
          {
            slug: "guides",
            title: "Guides",
            parent: null,
            purpose: "Groups the guides.",
            clusters: [],
            files: [],
          },
          {
            slug: "persist",
            title: "Persist",
            parent: "guides",
            purpose: "Saving state.",
            clusters: [],
            files: ["docs/persist.md"],
          },
          {
            slug: "ci",
            title: "CI",
            parent: null,
            purpose: "How checks run.",
            clusters: [],
            files: [".github/workflows/ci.yml"],
          },
          {
            slug: "grid",
            title: "Grid",
            parent: null,
            purpose: "Rows.",
            clusters: ["grid#1", "grid#2", "charts#1"],
            files: [],
          },
        ],
      },
      clusterModules,
      known,
      citable,
    );
    expect(pages.map((page) => page.slug)).toEqual(["overview", "guides", "persist", "grid"]);
    expect(dropped.pages).toEqual(["ci"]);
    expect(pages.map((page) => page.position)).toEqual([0, 1, 2, 3]);
  });
});

describe("pageRange", () => {
  it("asks more pages of small repositories that have much to cite", () => {
    expect(pageRange("S", 8)).toEqual([4, 10]);
    expect(pageRange("S", 46)).toEqual([6, 10]);
    expect(pageRange("S", 500)).toEqual([8, 10]);
    expect(pageRange("L", 70)).toEqual([21, 40]);
    expect(pageRange("unknown", 0)).toEqual([8, 20]);
  });
});

describe("planWiki", () => {
  it("keeps the existing plan when only chosen pages are written again", async () => {
    const folder = mkdtempSync(join(tmpdir(), "everyrepo-plan-"));
    const enginePath = join(folder, "engine.sqlite");
    const engine = openEngineDb(enginePath);
    engine.$client
      .prepare(
        `INSERT INTO wiki_page (slug, parent_slug, position, title, purpose, clusters, files, status, markdown, updated_at)
         VALUES ('overview', NULL, 0, 'Overview', 'What it is.', '[]', '[]', 'written', 'Text [S1]', 1)`,
      )
      .run();
    engine.$client.close();
    const router = {
      completeJson: () => Promise.reject(new Error("no model call expected")),
    } as unknown as LlmRouter;
    const logs: string[] = [];
    try {
      const kept = await planWiki({
        enginePath,
        repo: "acme/app",
        router,
        log: (line) => logs.push(line),
        keepExisting: true,
      });
      expect(kept).toMatchObject({ pages: 1, reused: true });
      expect(logs).toEqual(["kept the existing plan of 1 pages"]);
      const reopened = openEngineDb(enginePath).$client;
      expect(reopened.prepare("SELECT status, markdown FROM wiki_page").get()).toEqual({
        status: "written",
        markdown: "Text [S1]",
      });
      reopened.close();
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
