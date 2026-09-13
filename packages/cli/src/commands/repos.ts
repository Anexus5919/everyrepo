import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { Command } from "commander";
import { loadLocalConfig, parseRepoRef, repoDirName, testRepos } from "@everyrepo/core";

const run = promisify(execFile);

export function reposCommand(): Command {
  const repos = new Command("repos").description("Work with the test repository set");

  repos
    .command("list")
    .description("Show where each test repository is found locally and its upstream head")
    .action(async () => {
      const config = await loadLocalConfig();
      for (const { repo } of testRepos) {
        const local = config.localRepos[repo];
        const path = local?.path ?? join(config.dataDir, "repos", repoDirName(parseRepoRef(repo)));
        const remote = local?.remote ?? "origin";
        if (!(await exists(join(path, ".git")))) {
          console.log(`${repo.padEnd(36)} missing  ${path}`);
          continue;
        }
        const head = await upstreamHead(path, remote, local?.defaultBranch);
        console.log(`${repo.padEnd(36)} ${head.padEnd(28)} ${path}`);
      }
    });

  return repos;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// Reads the remote-tracking default branch without touching the working tree
async function upstreamHead(path: string, remote: string, branch?: string): Promise<string> {
  try {
    const ref = branch ? `${remote}/${branch}` : await remoteHeadRef(path, remote);
    const { stdout: sha } = await run("git", ["-C", path, "rev-parse", "--short", ref]);
    return `${ref}@${sha.trim()}`;
  } catch {
    return `${remote}/HEAD unknown`;
  }
}

async function remoteHeadRef(path: string, remote: string): Promise<string> {
  const { stdout } = await run("git", [
    "-C",
    path,
    "symbolic-ref",
    "--short",
    `refs/remotes/${remote}/HEAD`,
  ]);
  return stdout.trim();
}
