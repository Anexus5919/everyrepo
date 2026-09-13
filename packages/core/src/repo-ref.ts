export interface RepoRef {
  owner: string;
  name: string;
}

const SEGMENT = /^[A-Za-z0-9_.-]+$/;

export function parseRepoRef(input: string): RepoRef {
  const path = input
    .trim()
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  const parts = path.split("/");
  const valid =
    parts.length === 2 && parts.every((part) => SEGMENT.test(part) && !/^\.+$/.test(part));
  if (!valid) {
    throw new Error(`Invalid repository reference: ${input}`);
  }
  const [owner, name] = parts as [string, string];
  return { owner, name };
}

export function formatRepoRef(ref: RepoRef): string {
  return `${ref.owner}/${ref.name}`;
}

// Filesystem-safe directory name, for example mui__mui-x
export function repoDirName(ref: RepoRef): string {
  return `${ref.owner}__${ref.name}`;
}
