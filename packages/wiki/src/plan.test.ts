import { describe, expect, it } from "vitest";
import { validatePlan } from "./plan.ts";

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
            clusters: ["grid#1", "missing#9"],
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
            files: [],
          },
        ],
      },
      clusterModules,
      knownFiles,
    );

    expect(pages.map((page) => page.slug)).toEqual([
      "overview",
      "data-grid",
      "sorting",
      "sort-details",
      "other-code",
    ]);
    expect(pages.find((page) => page.slug === "sorting")?.parentSlug).toBe("data-grid");
    // A third level is lifted to the top-level ancestor
    expect(pages.find((page) => page.slug === "sort-details")?.parentSlug).toBe("data-grid");
    expect(dropped).toEqual({ clusters: 2, files: 1 });
    expect(unplaced).toBe(2);
    const grid = pages.find((page) => page.slug === "data-grid")!;
    expect(grid.clusters).toEqual(["grid#1", "grid#2"]);
    const placed = pages.flatMap((page) => page.clusters).sort();
    expect(placed).toEqual(["charts#1", "grid#1", "grid#2"]);
    expect(pages.find((page) => page.slug === "other-code")?.clusters).toEqual(["charts#1"]);
    expect(pages.map((page) => page.position)).toEqual([0, 1, 2, 3, 4]);
  });
});
