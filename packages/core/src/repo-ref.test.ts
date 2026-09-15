import { describe, expect, it } from "vitest";
import {
  formatRepoRef,
  parseRepoRef,
  readRepoInput,
  readSearchInput,
  repoDirName,
  repoKey,
} from "./repo-ref.ts";

const ref = (owner: string, name: string) => ({ ok: true, ref: { owner, name } });

describe("parseRepoRef", () => {
  it("parses owner/name", () => {
    expect(parseRepoRef("mui/mui-x")).toEqual({ owner: "mui", name: "mui-x" });
  });

  it("accepts GitHub URLs with or without .git and trailing slash", () => {
    expect(parseRepoRef("https://github.com/jenkinsci/jenkins.git")).toEqual({
      owner: "jenkinsci",
      name: "jenkins",
    });
    expect(parseRepoRef("https://github.com/sugarlabs/www-v2/")).toEqual({
      owner: "sugarlabs",
      name: "www-v2",
    });
  });

  it("rejects malformed references", () => {
    for (const input of ["mui", "a/b/c", "../x", "owner/..", "own er/repo", ""]) {
      expect(() => parseRepoRef(input)).toThrow(/Invalid repository reference/);
    }
  });
});

describe("readRepoInput", () => {
  it("reads every common way of writing a GitHub repository", () => {
    const inputs = [
      "medusajs/medusa",
      "  medusajs/medusa  ",
      "medusajs/medusa.git",
      "github.com/medusajs/medusa",
      "www.github.com/medusajs/medusa",
      "https://github.com/medusajs/medusa",
      "http://www.github.com/medusajs/medusa/",
      "https://github.com/medusajs/medusa.git",
      "https://github.com/medusajs/medusa/tree/develop/packages/core",
      "https://github.com/medusajs/medusa/blob/develop/README.md#L10-L20",
      "https://github.com/medusajs/medusa/issues/12345",
      "https://github.com/medusajs/medusa/pulls?q=is%3Aopen",
      "https://github.com/medusajs/medusa?tab=readme-ov-file",
      "git@github.com:medusajs/medusa.git",
      "ssh://git@github.com/medusajs/medusa.git",
      "git://github.com/medusajs/medusa.git",
      "<https://github.com/medusajs/medusa>",
    ];
    for (const input of inputs) {
      expect(readRepoInput(input), input).toEqual(ref("medusajs", "medusa"));
    }
  });

  it("keeps the casing people typed and allows dots in repository names", () => {
    expect(readRepoInput("toeverything/AFFiNE")).toEqual(ref("toeverything", "AFFiNE"));
    expect(readRepoInput("https://github.com/vercel/next.js")).toEqual(ref("vercel", "next.js"));
  });

  it("explains what is wrong with text that is not a repository", () => {
    expect(readRepoInput("   ")).toEqual({ ok: false, problem: "empty" });
    expect(readRepoInput("https://gitlab.com/gitlab-org/gitlab")).toEqual({
      ok: false,
      problem: "other-host",
    });
    expect(readRepoInput("gitlab.com/gitlab-org/gitlab")).toMatchObject({ problem: "other-host" });
    expect(readRepoInput("git@bitbucket.org:team/app.git")).toMatchObject({
      problem: "other-host",
    });
    expect(readRepoInput("https://github.com/sugarlabs")).toEqual({
      ok: false,
      problem: "owner-only",
      owner: "sugarlabs",
    });
    expect(readRepoInput("https://github.com/orgs/jenkinsci/repositories")).toEqual({
      ok: false,
      problem: "owner-only",
      owner: "jenkinsci",
    });
    expect(readRepoInput("sugarlabs")).toMatchObject({ problem: "owner-only", owner: "sugarlabs" });
    expect(readRepoInput("orgs/jenkinsci")).toMatchObject({
      problem: "owner-only",
      owner: "jenkinsci",
    });
    expect(readRepoInput("topics/react")).toMatchObject({ problem: "not-a-repository" });
    for (const input of [
      "https://github.com",
      "https://github.com/topics/react",
      "https://github.com/settings/profile",
      "https://gist.github.com/someone/abc123",
    ]) {
      expect(readRepoInput(input), input).toMatchObject({ problem: "not-a-repository" });
    }
    for (const input of ["a/b/c", "-bad/name", "owner/..", "own er/repo", "owner/na me"]) {
      expect(readRepoInput(input), input).toMatchObject({ problem: "invalid" });
    }
  });
});

describe("formatting", () => {
  it("round-trips and builds directory names and keys", () => {
    const parsed = parseRepoRef("toeverything/AFFiNE");
    expect(formatRepoRef(parsed)).toBe("toeverything/AFFiNE");
    expect(repoDirName(parsed)).toBe("toeverything__AFFiNE");
    expect(repoKey(parsed)).toBe("toeverything/affine");
  });
});

describe("search input", () => {
  it("searches names while typing, and an owner's repositories after a slash", () => {
    expect(readSearchInput("reac")).toEqual({ kind: "text", text: "reac" });
    expect(readSearchInput(" next.js ")).toEqual({ kind: "text", text: "next.js" });
    expect(readSearchInput("vercel/")).toEqual({ kind: "owner", owner: "vercel", name: "" });
    expect(readSearchInput("vercel/ne")).toEqual({ kind: "owner", owner: "vercel", name: "ne" });
    expect(readSearchInput("https://github.com/sugarlabs")).toEqual({
      kind: "owner",
      owner: "sugarlabs",
      name: "",
    });
  });

  it("leaves pasted repository addresses, single letters and other text to the lookup", () => {
    for (const text of [
      "r",
      "",
      "https://github.com/vercel/next.js",
      "git@github.com:vercel/next.js.git",
      "vercel/next.js/tree/main",
      "search/x",
      "has space",
      "-bad/name",
    ]) {
      expect(readSearchInput(text)).toBeUndefined();
    }
  });
});
