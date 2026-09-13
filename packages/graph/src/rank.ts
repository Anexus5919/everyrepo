import { createRequire } from "node:module";
import { DirectedGraph } from "graphology";
import type { WeightedEdge } from "./references.ts";

type RankGraph = DirectedGraph<Record<string, never>, { weight: number }>;
type Pagerank = (
  graph: RankGraph,
  options: { getEdgeWeight: "weight"; alpha: number; maxIterations: number; tolerance: number },
) => Record<string, number>;

// The package ships CommonJS whose declarations do not match how Node loads it from ESM
const pagerank = createRequire(import.meta.url)(
  "graphology-metrics/centrality/pagerank.js",
) as Pagerank;

// Scores files by how much of the rest of the code depends on them
export function rankFiles(
  fileIds: readonly number[],
  edges: readonly WeightedEdge[],
): Map<number, number> {
  const graph = new DirectedGraph<Record<string, never>, { weight: number }>();
  for (const id of fileIds) graph.addNode(String(id));
  for (const edge of edges) {
    const src = String(edge.src);
    const dst = String(edge.dst);
    if (src === dst || !graph.hasNode(src) || !graph.hasNode(dst)) continue;
    graph.updateEdge(src, dst, (attributes) => ({
      weight: (attributes.weight ?? 0) + edge.weight,
    }));
  }
  if (graph.order === 0) return new Map();
  const scores = pagerank(graph, {
    getEdgeWeight: "weight",
    alpha: 0.85,
    maxIterations: 200,
    tolerance: 1e-8,
  });
  return new Map(Object.entries(scores).map(([id, score]) => [Number(id), score]));
}
