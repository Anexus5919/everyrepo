import { createRequire } from "node:module";
import { UndirectedGraph } from "graphology";
import type { WeightedEdge } from "./references.ts";
import { dirOf, type GraphFile, type GraphModule } from "./types.ts";

type ClusterGraph = UndirectedGraph<Record<string, never>, { weight: number }>;
type Louvain = (
  graph: ClusterGraph,
  options: { getEdgeWeight: "weight"; rng: () => number },
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

const LEAF_TOKENS = 30_000;
const MIN_FILES_TO_SPLIT = 8;
const MIN_COMMUNITY_FILES = 3;

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

function commonDirectory(paths: readonly string[]): string {
  if (paths.length === 0) return "";
  const split = paths.map((path) => dirOf(path).split("/"));
  const first = split[0]!;
  let length = 0;
  while (length < first.length && split.every((parts) => parts[length] === first[length]))
    length += 1;
  return first.slice(0, length).join("/");
}

function mostCommonDirectory(paths: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const path of paths) counts.set(dirOf(path), (counts.get(dirOf(path)) ?? 0) + 1);
  return (
    [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? ""
  );
}

function communities(files: readonly GraphFile[], edges: ClusterEdges): number[][] {
  const graph = new UndirectedGraph<Record<string, never>, { weight: number }>();
  const ids = new Set(files.map((file) => file.id));
  for (const file of files) graph.addNode(String(file.id));
  const add = (edge: WeightedEdge, scale: number) => {
    if (edge.src === edge.dst || !ids.has(edge.src) || !ids.has(edge.dst)) return;
    graph.updateEdge(String(edge.src), String(edge.dst), (attributes) => ({
      weight: (attributes.weight ?? 0) + edge.weight * scale,
    }));
  };
  for (const edge of edges.imports) add(edge, 1);
  for (const edge of edges.references) add(edge, 0.1);
  for (const edge of edges.cochanges) add(edge, 2);
  // Files in the same directory get a light link so structure still matters without other signals
  const byDir = new Map<string, GraphFile[]>();
  for (const file of files)
    byDir.set(dirOf(file.path), [...(byDir.get(dirOf(file.path)) ?? []), file]);
  for (const siblings of byDir.values()) {
    for (let index = 1; index < siblings.length; index += 1) {
      add({ src: siblings[index - 1]!.id, dst: siblings[index]!.id, weight: 0.5 }, 1);
    }
  }
  if (graph.size === 0) return [files.map((file) => file.id)];

  const mapping = louvain(graph, { getEdgeWeight: "weight", rng: seededRandom(files.length) });
  const groups = new Map<number, number[]>();
  for (const [node, community] of Object.entries(mapping)) {
    groups.set(community, [...(groups.get(community) ?? []), Number(node)]);
  }
  return [...groups.values()];
}

export function clusterFiles(
  files: readonly GraphFile[],
  modules: readonly GraphModule[],
  edges: ClusterEdges,
  pagerank: ReadonlyMap<number, number>,
): Cluster[] {
  const moduleByPath = new Map(modules.map((module) => [module.path, module]));
  const byModule = new Map<string, GraphFile[]>();
  for (const file of files)
    byModule.set(file.modulePath, [...(byModule.get(file.modulePath) ?? []), file]);
  const fileById = new Map(files.map((file) => [file.id, file]));
  const clusters: Cluster[] = [];

  for (const [modulePath, moduleFiles] of [...byModule.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const module = moduleByPath.get(modulePath);
    if (!module) continue;
    const tokens = moduleFiles.reduce((sum, file) => sum + file.tokens, 0);
    let groups =
      tokens <= LEAF_TOKENS || moduleFiles.length < MIN_FILES_TO_SPLIT
        ? [moduleFiles.map((file) => file.id)]
        : communities(moduleFiles, edges);

    // Tiny communities are folded into the largest group sharing their directory
    const large = groups.filter((group) => group.length >= MIN_COMMUNITY_FILES);
    if (large.length > 0 && large.length < groups.length) {
      const dirOwner = new Map<string, number[]>();
      for (const group of large) {
        const dir = mostCommonDirectory(group.map((id) => fileById.get(id)!.path));
        if (!dirOwner.has(dir)) dirOwner.set(dir, group);
      }
      for (const group of groups.filter((candidate) => candidate.length < MIN_COMMUNITY_FILES)) {
        for (const id of group) {
          const path = fileById.get(id)!.path;
          let dir = dirOf(path);
          let target = dirOwner.get(dir);
          while (!target && dir) {
            dir = dirOf(dir);
            target = dirOwner.get(dir);
          }
          (target ?? large.reduce((a, b) => (a.length >= b.length ? a : b))).push(id);
        }
      }
      groups = large;
    }

    groups
      .map((group) => group.map((id) => fileById.get(id)!))
      .sort((a, b) =>
        commonDirectory(a.map((f) => f.path)).localeCompare(commonDirectory(b.map((f) => f.path))),
      )
      .forEach((group, index) => {
        const ranked = [...group].sort(
          (a, b) => (pagerank.get(b.id) ?? 0) - (pagerank.get(a.id) ?? 0),
        );
        const paths = group.map((file) => file.path);
        clusters.push({
          key: `${modulePath || "(root)"}#${index + 1}`,
          moduleId: module.id,
          label: commonDirectory(paths) || modulePath || "(root)",
          fileIds: group.map((file) => file.id),
          tokenCount: group.reduce((sum, file) => sum + file.tokens, 0),
          topFiles: ranked.slice(0, 5).map((file) => file.path),
        });
      });
  }
  return clusters;
}
