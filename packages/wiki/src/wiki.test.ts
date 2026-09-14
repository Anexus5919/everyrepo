import { describe, expect, it } from "vitest";
import { cleanClusterSummary } from "./cluster-summary.ts";
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
