import { describe, expect, it } from "vitest";
import { formatRepoRef, parseRepoRef, repoDirName } from "./repo-ref.ts";

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

describe("formatting", () => {
  it("round-trips and builds directory names", () => {
    const ref = parseRepoRef("toeverything/AFFiNE");
    expect(formatRepoRef(ref)).toBe("toeverything/AFFiNE");
    expect(repoDirName(ref)).toBe("toeverything__AFFiNE");
  });
});
