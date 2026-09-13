import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRepoRef } from "@everyrepo/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { git } from "./git.ts";
import { resolveRepoSource, resolveSnapshot } from "./source.ts";
import { BlobReader, listTree } from "./tree.ts";

let root: string;
let upstream: string;
let fork: string;

async function commit(dir: string, files: Record<string, string>, message: string): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  await git(["add", "-A"], dir);
  await git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", message], dir);
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "repo-test-"));
  upstream = join(root, "upstream");
  fork = join(root, "fork");
  await git(["init", "-q", "-b", "canary", upstream]);
  await commit(
    upstream,
    { "a.ts": "export const a = 1;\n", "big.txt": "x".repeat(70_000) },
    "first",
  );

  await git(["clone", "-q", upstream, fork]);
  await git(["remote", "rename", "origin", "upstream"], fork);
  await git(["checkout", "-q", "-b", "fix/local-work"], fork);
  writeFileSync(join(fork, "wip.ts"), "uncommitted\n");

  await commit(upstream, { "b.ts": "export const b = 2;\n" }, "second");
  await git(["fetch", "-q", "upstream", "canary"], fork);
}, 30_000);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("repository snapshots", () => {
  it("reads the upstream head of a user's clone without touching its working tree", async () => {
    const config = {
      dataDir: join(root, "data"),
      localRepos: { "acme/widgets": { path: fork, remote: "upstream", defaultBranch: "canary" } },
    };
    const source = resolveRepoSource(config, parseRepoRef("acme/widgets"));
    expect(source.owned).toBe(false);

    const snapshot = await resolveSnapshot(source);
    expect(snapshot.remoteRef).toBe("upstream/canary");
    expect(snapshot.sha).toBe(await git(["rev-parse", "HEAD"], upstream));

    const entries = await listTree(fork, snapshot.sha);
    expect(entries.map((entry) => entry.path).sort()).toEqual(["a.ts", "b.ts", "big.txt"]);

    const reader = new BlobReader(fork);
    const byPath = new Map(entries.map((entry) => [entry.path, entry]));
    expect(await reader.readText(byPath.get("b.ts")!.oid)).toBe("export const b = 2;\n");
    const big = await reader.read(byPath.get("big.txt")!.oid);
    expect(big.length).toBe(70_000);
    await expect(reader.read("0".repeat(40))).rejects.toThrow(/missing/);
    await reader.close();

    expect(await git(["rev-parse", "--abbrev-ref", "HEAD"], fork)).toBe("fix/local-work");
    expect(await git(["status", "--porcelain"], fork)).toBe("?? wip.ts");
  });

  it("detects the default branch from the remote when it is not configured", async () => {
    const config = { dataDir: join(root, "data"), localRepos: {} };
    const source = { ...resolveRepoSource(config, parseRepoRef("acme/widgets")), gitDir: fork };
    const snapshot = await resolveSnapshot({ ...source, remote: "upstream" });
    expect(snapshot.branch).toBe("canary");
  });
});
