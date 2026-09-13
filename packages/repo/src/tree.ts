import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { gitBuffer } from "./git.ts";

export interface TreeEntry {
  path: string;
  oid: string;
  bytes: number;
}

// Lists regular files at a commit straight from the object database, without a checkout
export async function listTree(gitDir: string, sha: string): Promise<TreeEntry[]> {
  const output = await gitBuffer(["ls-tree", "-r", "-l", "-z", "--full-tree", sha], gitDir);
  const entries: TreeEntry[] = [];
  for (const record of output.toString("utf8").split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    const [mode, type, oid, size] = record.slice(0, tab).split(/\s+/);
    // Skips submodules and symlinks
    if (type !== "blob" || mode === "120000" || !oid || !size) continue;
    entries.push({ path: record.slice(tab + 1), oid, bytes: Number(size) });
  }
  return entries;
}

interface PendingRead {
  oid: string;
  resolve: (content: Buffer) => void;
  reject: (error: Error) => void;
}

// Streams blob contents through one long-lived `git cat-file --batch` process
export class BlobReader {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending: PendingRead[] = [];
  private chunks: Buffer[] = [];
  private closed = false;

  constructor(gitDir: string) {
    this.child = spawn("git", ["cat-file", "--batch"], { cwd: gitDir, windowsHide: true });
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.chunks.push(chunk);
      this.drain();
    });
    this.child.on("error", (error) => this.failAll(error));
    this.child.on("close", () => this.failAll(new Error("git cat-file exited")));
  }

  read(oid: string): Promise<Buffer> {
    if (this.closed) return Promise.reject(new Error("BlobReader is closed"));
    return new Promise((resolve, reject) => {
      this.pending.push({ oid, resolve, reject });
      this.child.stdin.write(`${oid}\n`);
    });
  }

  async readText(oid: string): Promise<string> {
    return (await this.read(oid)).toString("utf8");
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    return new Promise((resolve) => {
      this.child.once("close", () => resolve());
      this.child.stdin.end();
    });
  }

  private drain(): void {
    let buffer = this.chunks.length === 1 ? this.chunks[0]! : Buffer.concat(this.chunks);
    while (this.pending.length > 0) {
      const newline = buffer.indexOf(10);
      if (newline < 0) break;
      const header = buffer.subarray(0, newline).toString("utf8");
      const request = this.pending[0]!;
      if (header.endsWith(" missing")) {
        this.pending.shift();
        buffer = buffer.subarray(newline + 1);
        request.reject(new Error(`Object ${request.oid} is missing`));
        continue;
      }
      const size = Number(header.split(" ")[2]);
      const end = newline + 1 + size;
      if (buffer.length < end + 1) break;
      this.pending.shift();
      request.resolve(Buffer.from(buffer.subarray(newline + 1, end)));
      buffer = buffer.subarray(end + 1);
    }
    this.chunks = buffer.length > 0 ? [buffer] : [];
  }

  private failAll(error: Error): void {
    this.closed = true;
    for (const request of this.pending.splice(0)) request.reject(error);
  }
}
