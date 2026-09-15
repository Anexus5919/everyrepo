// Draws the import diagrams stored in pages as layered SVG: importers on the left, what they import on the right

const escape = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export interface Graph {
  labels: string[];
  edges: Array<[number, number]>;
}

export function parseFlowchart(source: string): Graph | undefined {
  const labels: string[] = [];
  const edges: Array<[number, number]> = [];
  for (const line of source.split("\n")) {
    const node = /^\s*n(\d+)\["(.*)"\]\s*$/.exec(line);
    if (node) {
      labels[Number(node[1])] = node[2]!;
      continue;
    }
    const edge = /^\s*n(\d+)\s*-->\s*n(\d+)\s*$/.exec(line);
    if (edge) edges.push([Number(edge[1]), Number(edge[2])]);
  }
  const seen = new Set<string>();
  const valid = edges.filter(([from, to]) => {
    const key = `${from}>${to}`;
    if (from === to || seen.has(key) || labels[from] === undefined || labels[to] === undefined) {
      return false;
    }
    seen.add(key);
    return true;
  });
  // Two files and a single link say nothing a sentence would not
  return labels.length >= 3 && valid.length >= 2 ? { labels, edges: valid } : undefined;
}

const NODE_H = 44;
const ROW_GAP = 18;
const COL_GAP = 76;
const LANE_H = 4;
const LANE_GAP = 10;
const BUNDLE_GAP = 2;
const CHAR_W = 6.7;
const PAD = 12;

export interface DiagramLayout {
  width: number;
  height: number;
  nodes: Array<{ id: number; x: number; y: number; w: number; name: string; folder: string }>;
  edges: Array<{ from: number; to: number; back: boolean; d: string }>;
  // Lanes where long links pass through a column, kept clear of the boxes there
  lanes: Array<{ column: number; y: number }>;
  crossings: number;
}

// Links that close a cycle are drawn backwards so every other link can point rightward
function backEdges(count: number, edges: ReadonlyArray<[number, number]>): Set<number> {
  const out = Array.from({ length: count }, () => [] as Array<[number, number]>);
  edges.forEach(([from, to], index) => out[from]!.push([to, index]));
  const balance = new Array<number>(count).fill(0);
  for (const [from, to] of edges) {
    balance[from]! += 1;
    balance[to]! -= 1;
  }
  const state = new Array<number>(count).fill(0);
  const back = new Set<number>();
  const visit = (node: number) => {
    state[node] = 1;
    for (const [next, index] of out[node]!) {
      if (state[next] === 1) back.add(index);
      else if (state[next] === 0) visit(next);
    }
    state[node] = 2;
  };
  // Starting from the nodes that mostly import keeps the cycle breaks on the less typical links
  [...Array(count).keys()]
    .sort((a, b) => balance[b]! - balance[a]! || a - b)
    .forEach((node) => {
      if (state[node] === 0) visit(node);
    });
  return back;
}

// Longest path from the importers, then every node moves right until it sits just before what it imports
function assignLayers(count: number, edges: ReadonlyArray<[number, number]>): number[] {
  const out = Array.from({ length: count }, () => [] as number[]);
  const indegree = new Array<number>(count).fill(0);
  for (const [from, to] of edges) {
    out[from]!.push(to);
    indegree[to]! += 1;
  }
  const order: number[] = [];
  const queue = [...Array(count).keys()].filter((node) => indegree[node] === 0);
  while (queue.length > 0) {
    const node = queue.shift()!;
    order.push(node);
    for (const next of out[node]!) {
      indegree[next]! -= 1;
      if (indegree[next] === 0) queue.push(next);
    }
  }
  const layer = new Array<number>(count).fill(0);
  for (const node of order) {
    for (const next of out[node]!) layer[next] = Math.max(layer[next]!, layer[node]! + 1);
  }
  for (const node of [...order].reverse()) {
    if (out[node]!.length === 0) continue;
    layer[node] = Math.max(layer[node]!, Math.min(...out[node]!.map((next) => layer[next]!)) - 1);
  }
  // Then each node moves to the column that makes its own links shortest, until no move helps
  const into = Array.from({ length: count }, () => [] as number[]);
  for (const [from, to] of edges) into[to]!.push(from);
  for (let round = 0; round < 40; round += 1) {
    let moved = false;
    const last = Math.max(...layer);
    for (let node = 0; node < count; node += 1) {
      const low = into[node]!.length > 0 ? Math.max(...into[node]!.map((p) => layer[p]!)) + 1 : 0;
      const high =
        out[node]!.length > 0 ? Math.min(...out[node]!.map((next) => layer[next]!)) - 1 : last;
      const pull = into[node]!.length - out[node]!.length;
      const target = pull > 0 ? low : pull < 0 ? high : layer[node]!;
      const next = Math.min(Math.max(target, low), high);
      if (next !== layer[node]) {
        layer[node] = next;
        moved = true;
      }
    }
    if (!moved) break;
  }
  // Columns left empty by the moves are closed up
  const used = [...new Set(layer)].sort((a, b) => a - b);
  return layer.map((value) => used.indexOf(value));
}

// Minimizes the squared distance to each wanted centre while keeping the order and minimum gaps
function placeInOrder(wanted: readonly number[], gaps: readonly number[]): number[] {
  const offsets: number[] = [];
  let total = 0;
  wanted.forEach((_, index) => {
    if (index > 0) total += gaps[index - 1]!;
    offsets.push(total);
  });
  const blocks: Array<{ sum: number; count: number }> = [];
  for (const [index, value] of wanted.entries()) {
    blocks.push({ sum: value - offsets[index]!, count: 1 });
    while (blocks.length > 1) {
      const last = blocks[blocks.length - 1]!;
      const before = blocks[blocks.length - 2]!;
      if (before.sum / before.count <= last.sum / last.count) break;
      before.sum += last.sum;
      before.count += last.count;
      blocks.pop();
    }
  }
  const result: number[] = [];
  for (const block of blocks) {
    for (let step = 0; step < block.count; step += 1) {
      result.push(block.sum / block.count + offsets[result.length]!);
    }
  }
  return result;
}

export function layoutDiagram(graph: Graph): DiagramLayout {
  const count = graph.labels.length;
  const back = backEdges(count, graph.edges);
  const layoutEdges = graph.edges.map(
    ([from, to], index) => (back.has(index) ? [to, from] : [from, to]) as [number, number],
  );
  const realLayer = assignLayers(count, layoutEdges);

  // Links longer than one column get a lane point in every column they cross
  const layerOf = [...realLayer];
  const isLane: boolean[] = new Array<boolean>(count).fill(false);
  const chains = layoutEdges.map(([from, to]) => {
    const chain = [from];
    for (let column = realLayer[from]! + 1; column < realLayer[to]!; column += 1) {
      layerOf.push(column);
      isLane.push(true);
      chain.push(layerOf.length - 1);
    }
    chain.push(to);
    return chain;
  });
  const vertexCount = layerOf.length;
  const columns = Math.max(...layerOf) + 1;
  const laneChain: Array<number[] | undefined> = new Array(vertexCount).fill(undefined);
  const laneTarget = new Array<number>(vertexCount).fill(-1);
  chains.forEach((chain, index) => {
    const lanes = chain.slice(1, -1);
    // The box a link points at, whichever way the chain was laid out
    const target = back.has(index) ? chain[0]! : chain[chain.length - 1]!;
    for (const lane of lanes) {
      laneChain[lane] = lanes;
      laneTarget[lane] = target;
    }
  });
  const left = Array.from({ length: vertexCount }, () => [] as number[]);
  const right = Array.from({ length: vertexCount }, () => [] as number[]);
  for (const chain of chains) {
    for (let step = 1; step < chain.length; step += 1) {
      right[chain[step - 1]!]!.push(chain[step]!);
      left[chain[step]!]!.push(chain[step - 1]!);
    }
  }

  let order: number[][] = Array.from({ length: columns }, () => []);
  for (let vertex = 0; vertex < vertexCount; vertex += 1) order[layerOf[vertex]!]!.push(vertex);

  const positions = (current: number[][]) => {
    const position = new Array<number>(vertexCount).fill(0);
    current.forEach((column) => column.forEach((vertex, row) => (position[vertex] = row)));
    return position;
  };
  const crossingsBetween = (current: number[][], column: number, position: number[]) => {
    const links: Array<[number, number]> = [];
    for (const vertex of current[column]!) {
      for (const next of right[vertex]!) links.push([position[vertex]!, position[next]!]);
    }
    let crossings = 0;
    for (let a = 0; a < links.length; a += 1) {
      for (let b = a + 1; b < links.length; b += 1) {
        const [a1, a2] = links[a]!;
        const [b1, b2] = links[b]!;
        if ((a1 - b1) * (a2 - b2) < 0) crossings += 1;
      }
    }
    return crossings;
  };
  const totalCrossings = (current: number[][]) => {
    const position = positions(current);
    let total = 0;
    for (let column = 0; column < columns - 1; column += 1) {
      total += crossingsBetween(current, column, position);
    }
    return total;
  };

  // Alternate sweeps sort each column by the median row of its neighbours, keeping the best order seen
  const median = (rows: number[]) => {
    if (rows.length === 0) return -1;
    const sorted = [...rows].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  };
  let best = order.map((column) => [...column]);
  let bestCrossings = totalCrossings(order);
  for (let sweep = 0; sweep < 24 && bestCrossings > 0; sweep += 1) {
    const downward = sweep % 2 === 0;
    const sequence = [...Array(columns).keys()];
    if (!downward) sequence.reverse();
    for (const column of sequence) {
      const position = positions(order);
      const key = new Map<number, number>();
      order[column]!.forEach((vertex, row) => {
        const neighbours = (downward ? left : right)[vertex]!.map((other) => position[other]!);
        const value = median(neighbours);
        key.set(vertex, value < 0 ? row : value);
      });
      order[column]!.sort((a, b) => key.get(a)! - key.get(b)!);
    }
    // Swapping neighbours in a column is kept whenever it removes crossings
    let improved = true;
    for (let round = 0; improved && round < 8; round += 1) {
      improved = false;
      for (let column = 0; column < columns; column += 1) {
        for (let row = 0; row + 1 < order[column]!.length; row += 1) {
          const local = (current: number[][]) => {
            const position = positions(current);
            return (
              (column > 0 ? crossingsBetween(current, column - 1, position) : 0) +
              (column < columns - 1 ? crossingsBetween(current, column, position) : 0)
            );
          };
          const before = local(order);
          const swapped = order.map((items) => [...items]);
          [swapped[column]![row], swapped[column]![row + 1]] = [
            swapped[column]![row + 1]!,
            swapped[column]![row]!,
          ];
          if (local(swapped) < before) {
            order = swapped;
            improved = true;
          }
        }
      }
    }
    const crossings = totalCrossings(order);
    if (crossings < bestCrossings) {
      best = order.map((column) => [...column]);
      bestCrossings = crossings;
    }
  }
  order = best;

  // Vertical centres: each column settles near the average of its neighbours without overlapping
  const heightOf = (vertex: number) => (isLane[vertex] ? LANE_H : NODE_H);
  // Long links heading for the same box run as a tight bundle
  const gapBetween = (a: number, b: number) =>
    heightOf(a) / 2 +
    heightOf(b) / 2 +
    (isLane[a] && isLane[b] && laneTarget[a] === laneTarget[b]
      ? BUNDLE_GAP
      : isLane[a] || isLane[b]
        ? LANE_GAP
        : ROW_GAP);
  const centre = new Array<number>(vertexCount).fill(0);
  for (const column of order) {
    const gaps = column.slice(1).map((vertex, index) => gapBetween(column[index]!, vertex));
    placeInOrder(new Array<number>(column.length).fill(0), gaps).forEach((value, row) => {
      centre[column[row]!] = value;
    });
  }
  for (let pass = 0; pass < 20; pass += 1) {
    const sequence = [...Array(columns).keys()];
    if (pass % 2 === 1) sequence.reverse();
    for (const column of sequence) {
      const items = order[column]!;
      const wanted = items.map((vertex) => {
        const neighbours = [...left[vertex]!, ...right[vertex]!];
        if (neighbours.length === 0) return centre[vertex]!;
        let sum = 0;
        let weight = 0;
        for (const other of neighbours) {
          sum += centre[other]!;
          weight += 1;
        }
        // A long link aims for one height along its whole length, so it runs straight
        const lanes = laneChain[vertex];
        if (lanes) {
          for (const lane of lanes) {
            sum += centre[lane]! * 2;
            weight += 2;
          }
        }
        return sum / weight;
      });
      const gaps = items.slice(1).map((vertex, index) => gapBetween(items[index]!, vertex));
      placeInOrder(wanted, gaps).forEach((value, row) => {
        centre[items[row]!] = value;
      });
    }
  }
  const top = Math.min(
    ...[...Array(vertexCount).keys()].map((vertex) => centre[vertex]! - heightOf(vertex) / 2),
  );
  const shift = PAD - top;
  for (let vertex = 0; vertex < vertexCount; vertex += 1) centre[vertex]! += shift;
  const height =
    Math.max(
      ...[...Array(vertexCount).keys()].map((vertex) => centre[vertex]! + heightOf(vertex) / 2),
    ) + PAD;

  const names = graph.labels.map((label) => {
    const parts = label.split("/");
    const name = parts.pop() ?? label;
    return { name, folder: parts.join("/") };
  });
  const widths = order.map((column) =>
    Math.max(
      120,
      ...column
        .filter((vertex) => !isLane[vertex])
        .map(
          (vertex) =>
            Math.max(names[vertex]!.name.length, names[vertex]!.folder.length * 0.9) * CHAR_W + 28,
        ),
    ),
  );
  const columnX = widths.map((_, column) =>
    widths.slice(0, column).reduce((sum, width) => sum + width + COL_GAP, PAD),
  );
  const width = columnX[columns - 1]! + widths[columns - 1]! + PAD;

  // Link ends are spread along each side of a box, ordered by where the link comes from
  const ports = new Map<string, number>();
  const sides = new Map<string, Array<{ key: string; toward: number }>>();
  const attach = (vertex: number, side: "l" | "r", key: string, toward: number) => {
    const list = sides.get(`${vertex}${side}`) ?? [];
    list.push({ key, toward });
    sides.set(`${vertex}${side}`, list);
  };
  chains.forEach((chain, index) => {
    const first = chain[0]!;
    const last = chain[chain.length - 1]!;
    const isBack = back.has(index);
    attach(first, isBack ? "r" : "r", `${index}:start`, centre[chain[1]!]!);
    attach(last, "l", `${index}:end`, centre[chain[chain.length - 2]!]!);
  });
  for (const [side, list] of sides) {
    const vertex = Number(side.slice(0, -1));
    list.sort((a, b) => a.toward - b.toward);
    const spacing = list.length > 1 ? Math.min(9, (NODE_H - 16) / (list.length - 1)) : 0;
    list.forEach((item, position) => {
      ports.set(item.key, centre[vertex]! + (position - (list.length - 1) / 2) * spacing);
    });
  }

  const curve = (x1: number, y1: number, x2: number, y2: number) => {
    const bend = (x2 - x1) / 2;
    return Math.abs(y1 - y2) < 0.5
      ? `L${x2.toFixed(1)} ${y2.toFixed(1)}`
      : `C${(x1 + bend).toFixed(1)} ${y1.toFixed(1)} ${(x2 - bend).toFixed(1)} ${y2.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`;
  };
  const edges = chains.map((chain, index) => {
    const points: Array<[number, number]> = [];
    const first = chain[0]!;
    const last = chain[chain.length - 1]!;
    points.push([
      columnX[layerOf[first]!]! + widths[layerOf[first]!]!,
      ports.get(`${index}:start`)!,
    ]);
    for (const vertex of chain.slice(1, -1)) {
      const column = layerOf[vertex]!;
      points.push(
        [columnX[column]!, centre[vertex]!],
        [columnX[column]! + widths[column]!, centre[vertex]!],
      );
    }
    points.push([columnX[layerOf[last]!]! - 2, ports.get(`${index}:end`)!]);
    const isBack = back.has(index);
    // A link that closes a cycle is drawn from the importer back to the file further left
    if (isBack) points.reverse();
    let d = `M${points[0]![0].toFixed(1)} ${points[0]![1].toFixed(1)}`;
    for (let step = 1; step < points.length; step += 1) {
      d += ` ${curve(points[step - 1]![0], points[step - 1]![1], points[step]![0], points[step]![1])}`;
    }
    const [from, to] = graph.edges[index]!;
    return { from, to, back: isBack, d };
  });

  return {
    width,
    height,
    nodes: [...Array(count).keys()].map((vertex) => ({
      id: vertex,
      x: columnX[layerOf[vertex]!]!,
      y: centre[vertex]! - NODE_H / 2,
      w: widths[layerOf[vertex]!]!,
      ...names[vertex]!,
    })),
    edges,
    lanes: [...Array(vertexCount).keys()]
      .filter((vertex) => isLane[vertex])
      .map((vertex) => ({ column: layerOf[vertex]!, y: centre[vertex]! })),
    crossings: bestCrossings,
  };
}

// The drawing alone, for places that show a diagram without its buttons and caption
export function diagramSvg(source: string, label: string): string | undefined {
  const graph = parseFlowchart(source);
  if (!graph) return undefined;
  return svgFor(graph, layoutDiagram(graph), label);
}

function svgFor(graph: Graph, layout: DiagramLayout, label: string): string {
  const edgePaths = layout.edges
    .map(
      (edge) =>
        `<path class="edge${edge.back ? " back" : ""}" data-from="${edge.from}" data-to="${edge.to}" d="${edge.d}" marker-end="url(#arrow)"></path>`,
    )
    .join("");
  const nodeGroups = layout.nodes
    .map(
      (node) =>
        `<g class="node" data-node="${node.id}" transform="translate(${node.x.toFixed(1)} ${node.y.toFixed(1)})" tabindex="0"><title>${escape(graph.labels[node.id]!)}</title><rect width="${node.w.toFixed(1)}" height="${NODE_H}" rx="6"></rect><text class="node-name" x="12" y="${node.folder ? 19 : 27}">${escape(node.name)}</text>${node.folder ? `<text class="node-folder" x="12" y="34">${escape(node.folder)}</text>` : ""}</g>`,
    )
    .join("");
  const width = Math.ceil(layout.width);
  const height = Math.ceil(layout.height);
  return `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${escape(label)}"><defs><marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L8 4L0 8z"></path></marker></defs><g class="edges">${edgePaths}</g><g class="nodes">${nodeGroups}</g></svg>`;
}

export function renderDiagram(source: string): string | undefined {
  const graph = parseFlowchart(source);
  if (!graph) return undefined;
  const layout = layoutDiagram(graph);

  const svg = svgFor(graph, layout, "Import links between the files this page covers");
  const expandIcon = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path class="corner corner-a" d="M9.5 2.5H13.5V6.5M13.5 2.5L9 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path><path class="corner corner-b" d="M6.5 13.5H2.5V9.5M2.5 13.5L7 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path></svg>`;
  const askIcon = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 3.5h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H8l-3 2.5v-2.5H3a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"></path><path class="ask-lines" d="M5 6.5h6M5 9h4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"></path></svg>`;
  return `<figure class="diagram" data-diagram><div class="diagram-actions"><button class="diagram-ask" type="button" data-diagram-ask>${askIcon}Explain with AI</button><button class="diagram-expand" type="button" aria-label="Open the diagram larger">${expandIcon}Expand</button></div><div class="diagram-scroll">${svg}</div><figcaption>Import links between the most central files, taken from the code graph. Point at a file to see its links, open the diagram to explore it, or ask for a plain explanation.</figcaption></figure>`;
}
