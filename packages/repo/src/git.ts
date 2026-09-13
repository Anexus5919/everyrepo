import { spawn } from "node:child_process";

export class GitError extends Error {
  constructor(
    message: string,
    readonly args: string[],
    readonly stderr: string,
  ) {
    super(message);
  }
}

// Runs git and collects stdout as a Buffer; large outputs such as full tree listings are expected
export function gitBuffer(args: string[], cwd?: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(out));
      } else {
        const stderr = Buffer.concat(err).toString("utf8").trim();
        reject(new GitError(`git ${args.join(" ")} failed: ${stderr}`, args, stderr));
      }
    });
  });
}

export async function git(args: string[], cwd?: string): Promise<string> {
  return (await gitBuffer(args, cwd)).toString("utf8").trim();
}

export async function gitOptional(args: string[], cwd?: string): Promise<string | undefined> {
  try {
    return await git(args, cwd);
  } catch (error) {
    if (error instanceof GitError) return undefined;
    throw error;
  }
}
