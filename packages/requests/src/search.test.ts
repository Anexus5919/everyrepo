import { GithubError, type GithubClient, type GithubRepository } from "@everyrepo/github";
import { describe, expect, it } from "vitest";
import { createRepoSearch } from "./search.ts";

const repo = (fullName: string, stars: number): GithubRepository => {
  const [owner = "", name = ""] = fullName.split("/");
  return {
    id: stars,
    fullName,
    owner,
    name,
    description: `${name} description`,
    stars,
    language: "TypeScript",
    defaultBranch: "main",
    archived: false,
    disabled: false,
    private: false,
    fork: false,
    parent: null,
    license: null,
    sizeKb: 1,
    url: `https://github.com/${fullName}`,
    avatarUrl: "",
    pushedAt: null,
  };
};

function fakeGithub(answer: (query: string) => GithubRepository[] | Error) {
  const queries: string[] = [];
  const github: GithubClient = {
    repository: () => Promise.reject(new Error("unused")),
    fileList: () => Promise.reject(new Error("unused")),
    file: () => Promise.reject(new Error("unused")),
    async searchRepositories(query) {
      queries.push(query);
      const result = answer(query);
      if (result instanceof Error) throw result;
      return result;
    },
    async searchOwners(query) {
      queries.push(query);
      return [
        { login: "reactjs", kind: "organization" },
        { login: "react", kind: "organization" },
        { login: "the-react-crew", kind: "user" },
      ];
    },
  };
  return { github, queries };
}

describe("repository search", () => {
  it("puts names that start with the typed text first, then the most starred", async () => {
    const { github, queries } = fakeGithub(() => [
      repo("mkalten/reacTIVision", 900),
      repo("someone/my-react-app", 500_000),
      repo("react/react-native", 120_000),
      repo("react/react", 240_000),
    ]);
    const result = await createRepoSearch({ github }).search({ kind: "text", text: "reac" });
    expect(queries).toEqual(["reac in:name", "reac in:login"]);
    expect(result.repos.map((item) => item.repo)).toEqual([
      "react/react",
      "react/react-native",
      "mkalten/reacTIVision",
      "someone/my-react-app",
    ]);
    // Owners that only contain the text are left to the repository list
    expect(result.owners.map((owner) => owner.login)).toEqual(["reactjs", "react"]);
    expect(result.unavailable).toBe(false);
  });

  it("lists an owner's repositories, most starred first until a name is typed", async () => {
    const { github, queries } = fakeGithub((query) =>
      query.startsWith("user:")
        ? [repo("acme/widgets", 50), repo("acme/app", 10)]
        : [repo("acme/app-kit", 5), repo("acme/app", 10)],
    );
    const search = createRepoSearch({ github });
    expect((await search.search({ kind: "owner", owner: "acme", name: "" })).repos).toHaveLength(2);
    const typed = await search.search({ kind: "owner", owner: "Acme", name: "app" });
    expect(typed.repos.map((item) => item.repo)).toEqual(["acme/app", "acme/app-kit"]);
    expect(typed.owners).toEqual([]);
    expect(queries).toEqual(["user:acme", "app in:name user:Acme"]);
  });

  it("reuses answers, shares calls in flight and waits out GitHub's limit", async () => {
    let clock = 1_000;
    let limited = false;
    const { github, queries } = fakeGithub(() =>
      limited
        ? new GithubError("rate-limited", "limited", new Date(clock + 30_000))
        : [repo("acme/app", 1)],
    );
    const search = createRepoSearch({ github, now: () => clock, ttlMs: 60_000 });
    const input = { kind: "owner", owner: "acme", name: "ap" } as const;

    await Promise.all([search.search(input), search.search({ ...input, owner: "ACME" })]);
    await search.search(input);
    expect(queries).toHaveLength(1);

    limited = true;
    clock += 61_000;
    expect(await search.search(input)).toEqual({ owners: [], repos: [], unavailable: true });
    expect(queries).toHaveLength(2);
    // Until the limit resets nothing more is sent, and a limited answer is never reused later
    expect((await search.search({ ...input, name: "app" })).unavailable).toBe(true);
    expect(queries).toHaveLength(2);

    limited = false;
    clock += 31_000;
    expect((await search.search(input)).repos).toHaveLength(1);
    expect(queries).toHaveLength(3);
  });
});
