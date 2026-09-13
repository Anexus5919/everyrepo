import { existsSync } from "node:fs";
import { join } from "node:path";
import { formatRepoRef, repoDirName, type LocalConfig, type RepoRef } from "@kickstart/core";
import { git, gitOptional } from "./git.ts";

export interface RepoSource {
  ref: RepoRef;
  gitDir: string;
  remote: string;
  branch?: string;
  // Owned sources live under dataDir; others are the owner's clones and are only read or fetched
  owned: boolean;
}

export interface Snapshot {
  sha: string;
  branch: string;
  remoteRef: string;
}

export function resolveRepoSource(config: LocalConfig, ref: RepoRef): RepoSource {
  const local = config.localRepos[formatRepoRef(ref)];
  if (local) {
    return {
      ref,
      gitDir: local.path,
      remote: local.remote,
      ...(local.defaultBranch ? { branch: local.defaultBranch } : {}),
      owned: false,
    };
  }
  return {
    ref,
    gitDir: join(config.dataDir, "repos", repoDirName(ref)),
    remote: "origin",
    owned: true,
  };
}

export function hasClone(source: RepoSource): boolean {
  return existsSync(join(source.gitDir, ".git"));
}

export async function ensureClone(source: RepoSource): Promise<void> {
  if (hasClone(source)) return;
  if (!source.owned) {
    throw new Error(`Local clone not found at ${source.gitDir} for ${formatRepoRef(source.ref)}`);
  }
  const url = `https://github.com/${formatRepoRef(source.ref)}.git`;
  await git(["clone", "--filter=blob:none", "--no-checkout", url, source.gitDir]);
}

export async function resolveBranch(source: RepoSource): Promise<string> {
  if (source.branch) return source.branch;
  const head = await gitOptional(
    ["symbolic-ref", "--short", `refs/remotes/${source.remote}/HEAD`],
    source.gitDir,
  );
  if (head) return head.slice(source.remote.length + 1);
  const remoteHead = await git(["ls-remote", "--symref", source.remote, "HEAD"], source.gitDir);
  const match = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(remoteHead);
  if (!match?.[1]) {
    throw new Error(`Cannot determine the default branch of ${formatRepoRef(source.ref)}`);
  }
  return match[1];
}

// Only updates the remote-tracking ref; branches, working tree and stashes stay untouched
export async function fetchLatest(source: RepoSource, branch: string): Promise<void> {
  await git(["fetch", "--no-tags", source.remote, branch], source.gitDir);
}

export async function resolveSnapshot(source: RepoSource): Promise<Snapshot> {
  const branch = await resolveBranch(source);
  const remoteRef = `${source.remote}/${branch}`;
  const sha = await git(["rev-parse", `refs/remotes/${remoteRef}^{commit}`], source.gitDir);
  return { sha, branch, remoteRef };
}

// Partial clones need their blobs downloaded; a detached checkout fetches them in one batch
export async function ensureBlobs(source: RepoSource, sha: string): Promise<void> {
  const promisor = await gitOptional(
    ["config", "--get", `remote.${source.remote}.promisor`],
    source.gitDir,
  );
  if (promisor !== "true") return;
  if (!source.owned) {
    throw new Error(
      `${source.gitDir} is a partial clone owned by the user; blobs cannot be fetched without changing it`,
    );
  }
  await git(
    ["-c", "advice.detachedHead=false", "checkout", "--detach", "--force", sha],
    source.gitDir,
  );
}
