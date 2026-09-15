import type { RepoSearch } from "@everyrepo/core/requests";
import { describe, expect, it } from "vitest";
import { buildSuggestions, compactCount, covers, narrow, type KnownWiki } from "./suggestions.ts";

const known: KnownWiki[] = [
  { repo: "mui/mui-x", status: "ready", summary: null, pages: 30 },
  { repo: "unjs/ufo", status: "ready", summary: null, pages: 9 },
  { repo: "medusajs/medusa", status: "queued", summary: null, pages: 0 },
];

const found = (repos: string[], owners: string[] = []): RepoSearch => ({
  owners: owners.map((login) => ({ login, kind: "organization" })),
  repos: repos.map((repo) => ({
    repo,
    description: null,
    stars: 1,
    language: null,
    archived: false,
  })),
  unavailable: false,
});

const labels = (text: string, result?: RepoSearch) =>
  buildSuggestions(
    text,
    text.includes("/")
      ? { kind: "owner", owner: text.split("/")[0]!, name: text.split("/")[1]! }
      : text.length > 1
        ? { kind: "text", text }
        : undefined,
    known,
    result,
  ).map((group) => [group.label, group.items.length]);

describe("repository box suggestions", () => {
  it("offers written wikis first, then GitHub repositories and owners", () => {
    expect(labels("")).toEqual([["Written wikis", 2]]);
    expect(
      labels("mu", found(["mui/mui-x", "mui/material-ui", "sugarlabs/musicblocks"], ["mui"])),
    ).toEqual([
      ["Written wikis", 1],
      ["Repositories on GitHub", 2],
      ["Owners", 1],
    ]);
    expect(labels("medusajs/", found(["medusajs/medusa"]))).toEqual([
      ["Repositories from medusajs", 1],
    ]);
  });

  it("offers an owner first when the text is exactly their name", () => {
    expect(labels("vercel", found(["vercel/next.js"], ["vercel", "vercel-labs"]))).toEqual([
      ["Owners", 2],
      ["Repositories on GitHub", 1],
    ]);
  });

  it("marks repositories whose wiki is being written", () => {
    const [group] = buildSuggestions(
      "medusajs/med",
      { kind: "owner", owner: "medusajs", name: "med" },
      known,
      found(["medusajs/medusa"]),
    );
    expect(group!.items[0]).toMatchObject({ kind: "repo", wiki: { status: "queued" } });
  });

  it("keeps earlier answers on screen only while they still match the typed text", () => {
    const earlier = { kind: "text", text: "rea" } as const;
    expect(covers(earlier, { kind: "text", text: "react" })).toBe(true);
    expect(covers(earlier, { kind: "text", text: "re" })).toBe(false);
    expect(
      covers(
        { kind: "owner", owner: "acme", name: "" },
        { kind: "owner", owner: "ACME", name: "a" },
      ),
    ).toBe(true);

    const narrowed = narrow(found(["react/react", "someone/reason"], ["reactjs", "reason"]), {
      kind: "text",
      text: "reac",
    });
    expect(narrowed.repos.map((item) => item.repo)).toEqual(["react/react"]);
    expect(narrowed.owners.map((owner) => owner.login)).toEqual(["reactjs"]);
  });

  it("writes star counts compactly", () => {
    expect([950, 1_234, 12_900, 240_512, 1_250_000].map(compactCount)).toEqual([
      "950",
      "1.2k",
      "12k",
      "240k",
      "1.2m",
    ]);
  });
});
