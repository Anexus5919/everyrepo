import type { WeightedEdge } from "./references.ts";

// A control character on its own line cannot collide with a file path
export const COMMIT_MARKER = "\u0001";
export const COMMIT_FORMAT = "%x01";
const MAX_FILES_PER_COMMIT = 50;
const MIN_SHARED_COMMITS = 2;
const MIN_JACCARD = 0.1;
const MAX_PARTNERS = 10;

// Splits `git log --format=%x01 --name-only` output into the file lists of each commit
export function parseNameOnlyLog(output: string): string[][] {
  const commits: string[][] = [];
  let current: string[] | undefined;
  for (const raw of output.split(/\r?\n/)) {
    if (raw === COMMIT_MARKER) {
      current = [];
      commits.push(current);
      continue;
    }
    const line = raw.trim();
    if (line && current) current.push(line);
  }
  return commits.filter((files) => files.length > 0);
}

// Files that repeatedly change together are related even without an import between them
export function cochangeEdges(
  commits: readonly string[][],
  fileIds: ReadonlyMap<string, number>,
): WeightedEdge[] {
  const commitCounts = new Map<number, number>();
  const pairCounts = new Map<string, number>();

  for (const commit of commits) {
    if (commit.length > MAX_FILES_PER_COMMIT) continue;
    const ids = [
      ...new Set(
        commit.map((path) => fileIds.get(path)).filter((id): id is number => id !== undefined),
      ),
    ].sort((a, b) => a - b);
    for (const id of ids) commitCounts.set(id, (commitCounts.get(id) ?? 0) + 1);
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const key = `${ids[i]}:${ids[j]}`;
        pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
      }
    }
  }

  const byFile = new Map<number, WeightedEdge[]>();
  for (const [key, shared] of pairCounts) {
    if (shared < MIN_SHARED_COMMITS) continue;
    const [a, b] = key.split(":").map(Number) as [number, number];
    const jaccard = shared / ((commitCounts.get(a) ?? 0) + (commitCounts.get(b) ?? 0) - shared);
    if (jaccard < MIN_JACCARD) continue;
    const edge = { src: a, dst: b, weight: jaccard };
    byFile.set(a, [...(byFile.get(a) ?? []), edge]);
    byFile.set(b, [...(byFile.get(b) ?? []), edge]);
  }

  const kept = new Map<string, WeightedEdge>();
  for (const list of byFile.values()) {
    for (const edge of list.sort((x, y) => y.weight - x.weight).slice(0, MAX_PARTNERS)) {
      kept.set(`${edge.src}:${edge.dst}`, edge);
    }
  }
  return [...kept.values()];
}
