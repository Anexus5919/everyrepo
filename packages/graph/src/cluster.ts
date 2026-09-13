import { createRequire } from "node:module";
import { UndirectedGraph } from "graphology";
import type { WeightedEdge } from "./references.ts";
import { dirOf, type GraphFile, type GraphModule } from "./types.ts";

type ClusterGraph = UndirectedGraph<Record<string, never>, { weight: number }>;
type Louvain = (
  graph: ClusterGraph,
  options: { getEdgeWeight: "weight"; rng: () => number; resolution: number },
) => Record<string, number>;

// The package ships CommonJS whose declarations do not match how Node loads it from ESM
const louvain = createRequire(import.meta.url)("graphology-communities-louvain") as Louvain;

export interface ClusterEdges {
  imports: readonly WeightedEdge[];
  references: readonly WeightedEdge[];
  cochanges: readonly WeightedEdge[];
}

export interface Cluster {
  key: string;
  moduleId: number;
  label: string;
  fileIds: number[];
  tokenCount: number;
  topFiles: string[];
}

// Groups up to this size are small enough to explain on one page
const LEAF_TOKENS = 30_000;
const MAX_CLUSTER_TOKENS = 60_000;
// Groups below this size are merged into a nearby group so topics stay meaningful
const MIN_CLUSTER_TOKENS = 8_000;
const MIN_FILES_TO_SPLIT = 8;
const MIN_COMMUNITY_FILES = 3;
const MAX_DEPTH = 4;

// Deterministic generator so the same snapshot always produces the same clusters
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const tokensOf = (files: readonly GraphFile[]) => files.reduce((sum, file) => sum + file.tokens, 0);

function commonDirectory(paths: readonly string[]): string {
  if (paths.length === 0) return "";
  const split = paths.map((path) => dirOf(path).split("/"));
  const first = split[0]!;
  let length = 0;
  while (length < first.length && split.every((parts) => parts[length] === first[length])) {
    length += 1;
  }
  return first.slice(0, length).join("/");
}

// The directory holding most of a group's code names it best
function heaviestDirectory(files: readonly GraphFile[]): string {
  const tokens = new Map<string, number>();
  for (const file of files)
    tokens.set(dirOf(file.path), (tokens.get(dirOf(file.path)) ?? 0) + file.tokens);
  return (
    [...tokens.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? ""
  );
}

function louvainGroups(
  files: readonly GraphFile[],
  edges: ClusterEdges,
  resolution: number,
): GraphFile[][] {
  const graph: ClusterGraph = new UndirectedGraph();
  const byId = new Map(files.map((file) => [file.id, file]));
  for (const file of files) graph.addNode(String(file.id));
  const add = (edge: WeightedEdge, scale: number) => {
    if (edge.src === edge.dst || !byId.has(edge.src) || !byId.has(edge.dst)) return;
    graph.updateEdge(String(edge.src), String(edge.dst), (attributes) => ({
      weight: (attributes.weight ?? 0) + edge.weight * scale,
    }));
  };
  for (const edge of edges.imports) add(edge, 1);
  for (const edge of edges.references) add(edge, 0.1);
  for (const edge of edges.cochanges) add(edge, 2);
  // Files in the same directory get a light link so structure still matters without other signals
  const byDir = new Map<string, GraphFile[]>();
  for (const file of files) {
    const siblings = byDir.get(dirOf(file.path));
    if (siblings) siblings.push(file);
    else byDir.set(dirOf(file.path), [file]);
  }
  for (const siblings of byDir.values()) {
    for (let index = 1; index < siblings.length; index += 1) {
      add({ src: siblings[index - 1]!.id, dst: siblings[index]!.id, weight: 0.5 }, 1);
    }
  }
  if (graph.size === 0) return [[...files]];

  const mapping = louvain(graph, {
    getEdgeWeight: "weight",
    rng: seededRandom(files.length),
    resolution,
  });
  const groups = new Map<number, GraphFile[]>();
  for (const [node, community] of Object.entries(mapping)) {
    const file = byId.get(Number(node))!;
    const group = groups.get(community);
    if (group) group.push(file);
    else groups.set(community, [file]);
  }
  return [...groups.values()];
}

// Tiny communities are folded into the group that owns the nearest directory
function mergeTinyGroups(groups: GraphFile[][]): GraphFile[][] {
  const large = groups.filter((group) => group.length >= MIN_COMMUNITY_FILES);
  if (large.length === 0 || large.length === groups.length) return groups;
  const owners = new Map<string, GraphFile[]>();
  for (const group of large) {
    const dir = heaviestDirectory(group);
    if (!owners.has(dir)) owners.set(dir, group);
  }
  const biggest = large.reduce((a, b) => (tokensOf(a) >= tokensOf(b) ? a : b));
  for (const group of groups.filter((candidate) => candidate.length < MIN_COMMUNITY_FILES)) {
    for (const file of group) {
      let dir = dirOf(file.path);
      let owner = owners.get(dir);
      while (!owner && dir) {
        dir = dirOf(dir);
        owner = owners.get(dir);
      }
      (owner ?? biggest).push(file);
    }
  }
  return large;
}

function directoryGroups(files: readonly GraphFile[]): GraphFile[][] {
  const common = commonDirectory(files.map((file) => file.path));
  const groups = new Map<string, GraphFile[]>();
  for (const file of files) {
    const rest = common ? file.path.slice(common.length + 1) : file.path;
    const key = rest.includes("/") ? rest.slice(0, rest.indexOf("/")) : "";
    const group = groups.get(key);
    if (group) group.push(file);
    else groups.set(key, [file]);
  }
  return [...groups.values()];
}

function partition(files: GraphFile[], edges: ClusterEdges, depth: number): GraphFile[][] {
  if (tokensOf(files) <= LEAF_TOKENS || files.length < MIN_FILES_TO_SPLIT || depth > MAX_DEPTH) {
    return [files];
  }
  // Higher resolution on deeper levels makes Louvain return smaller communities
  let groups = mergeTinyGroups(louvainGroups(files, edges, 1 + depth * 0.75));
  if (groups.length <= 1) groups = mergeTinyGroups(directoryGroups(files));
  if (groups.length <= 1) return [files];
  return groups.flatMap((group) =>
    tokensOf(group) > MAX_CLUSTER_TOKENS ? partition(group, edges, depth + 1) : [group],
  );
}

function sharedSegments(a: string, b: string): number {
  const left = a.split("/");
  const right = b.split("/");
  let count = 0;
  while (count < left.length && count < right.length && left[count] === right[count]) count += 1;
  return count;
}

// Repeatedly folds the smallest group into the group with the closest directory that still fits
function mergeSmallGroups(groups: GraphFile[][]): GraphFile[][] {
  const items = groups.map((files) => ({
    files: [...files],
    dir: heaviestDirectory(files),
    tokens: tokensOf(files),
    settled: false,
  }));
  for (;;) {
    items.sort((a, b) => a.tokens - b.tokens || a.dir.localeCompare(b.dir));
    const small = items.find((item) => !item.settled && item.tokens < MIN_CLUSTER_TOKENS);
    if (!small || items.length === 1) break;
    let target: (typeof items)[number] | undefined;
    let bestScore = 0;
    for (const other of items) {
      if (other === small || other.tokens + small.tokens > LEAF_TOKENS) continue;
      const score = sharedSegments(small.dir, other.dir);
      if (score > bestScore) {
        target = other;
        bestScore = score;
      }
    }
    if (!target) {
      // Nothing close enough can absorb it, so it stays as its own group
      small.settled = true;
      continue;
    }
    target.files.push(...small.files);
    target.tokens += small.tokens;
    target.dir = heaviestDirectory(target.files);
    items.splice(items.indexOf(small), 1);
  }
  return items.map((item) => item.files);
}

export function clusterFiles(
  files: readonly GraphFile[],
  modules: readonly GraphModule[],
  edges: ClusterEdges,
  pagerank: ReadonlyMap<number, number>,
): Cluster[] {
  const moduleByPath = new Map(modules.map((module) => [module.path, module]));
  const byModule = new Map<string, GraphFile[]>();
  for (const file of files) {
    const group = byModule.get(file.modulePath);
    if (group) group.push(file);
    else byModule.set(file.modulePath, [file]);
  }
  const clusters: Cluster[] = [];

  const modulePaths = [...byModule.keys()].sort((a, b) => a.localeCompare(b));
  for (const modulePath of modulePaths) {
    const module = moduleByPath.get(modulePath);
    if (!module) continue;
    const groups = mergeSmallGroups(partition(byModule.get(modulePath)!, edges, 0))
      .map((group) => ({ group, label: heaviestDirectory(group) || modulePath || "(root)" }))
      .sort((a, b) => a.label.localeCompare(b.label) || tokensOf(b.group) - tokensOf(a.group));

    groups.forEach(({ group, label }, index) => {
      const ranked = [...group].sort(
        (a, b) => (pagerank.get(b.id) ?? 0) - (pagerank.get(a.id) ?? 0),
      );
      clusters.push({
        key: `${modulePath || "(root)"}#${index + 1}`,
        moduleId: module.id,
        label,
        fileIds: group.map((file) => file.id),
        tokenCount: tokensOf(group),
        topFiles: ranked.slice(0, 5).map((file) => file.path),
      });
    });
  }
  return clusters;
}
