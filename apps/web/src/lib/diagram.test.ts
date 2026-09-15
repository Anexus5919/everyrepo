import { describe, expect, it } from "vitest";
import { layoutDiagram, parseFlowchart, renderDiagram } from "./diagram.ts";

// The package diagram from a real overview page, with two-way links between packages
const PACKAGES = `flowchart LR
  n0["@mui/x-charts"]
  n1["mui-x"]
  n2["@mui/x-date-pickers"]
  n3["@mui/x-internals"]
  n4["@mui/x-data-grid-pro"]
  n5["@mui/x-data-grid"]
  n6["@mui/x-charts-pro"]
  n7["@mui/x-scheduler-internals"]
  n8["@mui/x-data-grid-premium"]
  n9["@mui/x-codemod"]
  n10["@mui/x-charts-premium"]
  n11["@mui/x-scheduler"]
  n6 --> n0
  n10 --> n0
  n11 --> n7
  n5 --> n3
  n8 --> n4
  n2 --> n1
  n4 --> n5
  n8 --> n3
  n9 --> n2
  n0 --> n3
  n9 --> n0
  n4 --> n3
  n1 --> n2
  n10 --> n6
  n4 --> n1
  n11 --> n1
  n8 --> n1
  n7 --> n1
  n9 --> n5
  n1 --> n0
  n5 --> n1
  n9 --> n6
  n9 --> n8
  n8 --> n5
  n0 --> n1
  n2 --> n3
  n9 --> n4
  n6 --> n3`;

const NODE_H = 44;

describe("layoutDiagram", () => {
  const graph = parseFlowchart(PACKAGES)!;
  const layout = layoutDiagram(graph);
  const columns = [...new Set(layout.nodes.map((node) => node.x))].sort((a, b) => a - b);

  it("keeps every box and every link", () => {
    expect(layout.nodes).toHaveLength(12);
    expect(layout.edges).toHaveLength(graph.edges.length);
    expect(renderDiagram(PACKAGES)!.match(/class="node"/g)).toHaveLength(12);
  });

  it("never lets boxes in a column overlap", () => {
    for (const x of columns) {
      const sorted = layout.nodes.filter((node) => node.x === x).sort((a, b) => a.y - b.y);
      for (let index = 1; index < sorted.length; index += 1) {
        expect(sorted[index]!.y - sorted[index - 1]!.y).toBeGreaterThanOrEqual(NODE_H);
      }
    }
  });

  it("routes long links through lanes that stay clear of the boxes they pass", () => {
    for (const lane of layout.lanes) {
      const x = columns[lane.column]!;
      for (const node of layout.nodes.filter((item) => item.x === x)) {
        expect(lane.y > node.y - 2 && lane.y < node.y + NODE_H + 2).toBe(false);
      }
    }
  });

  it("orders columns to keep link crossings low", () => {
    expect(layout.crossings).toBeLessThanOrEqual(12);
  });

  it("draws one link of each two-way pair as a back link", () => {
    const pair = layout.edges.filter(
      (edge) => (edge.from === 0 && edge.to === 1) || (edge.from === 1 && edge.to === 0),
    );
    expect(pair.map((edge) => edge.back).sort()).toEqual([false, true]);
  });
});
