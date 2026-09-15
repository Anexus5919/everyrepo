// Draws the import diagrams stored in pages as layered SVG: importers on the left, what they import on the right

const escape = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

interface Graph {
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
  const valid = edges.filter(
    ([from, to]) => labels[from] !== undefined && labels[to] !== undefined,
  );
  // Two files and a single link say nothing a sentence would not
  return labels.length >= 3 && valid.length >= 2 ? { labels, edges: valid } : undefined;
}

// Longest path layering over the graph with cycle edges ignored, so every edge points rightward where possible
function layers(count: number, edges: ReadonlyArray<[number, number]>): number[] {
  const out = Array.from({ length: count }, () => [] as number[]);
  for (const [from, to] of edges) if (from !== to) out[from]!.push(to);
  const state = new Array<number>(count).fill(0);
  const depth = new Array<number>(count).fill(0);
  const visit = (node: number): number => {
    if (state[node] === 2) return depth[node]!;
    if (state[node] === 1) return -1;
    state[node] = 1;
    let best = 0;
    for (const next of out[node]!) {
      const below = visit(next);
      if (below >= 0) best = Math.max(best, below + 1);
    }
    state[node] = 2;
    depth[node] = best;
    return best;
  };
  for (let node = 0; node < count; node += 1) visit(node);
  const deepest = Math.max(...depth);
  return depth.map((value) => deepest - value);
}

const NODE_H = 44;
const ROW_GAP = 14;
const COL_GAP = 52;
const CHAR_W = 6.7;

export function renderDiagram(source: string): string | undefined {
  const graph = parseFlowchart(source);
  if (!graph) return undefined;
  const count = graph.labels.length;
  const layer = layers(count, graph.edges);
  const columns = Math.max(...layer) + 1;

  // Within a column, nodes sit near the average row of the nodes they connect to
  const order: number[][] = Array.from({ length: columns }, () => []);
  graph.labels.forEach((_, node) => order[layer[node]!]!.push(node));
  const neighbours = Array.from({ length: count }, () => [] as number[]);
  for (const [from, to] of graph.edges) {
    neighbours[from]!.push(to);
    neighbours[to]!.push(from);
  }
  for (let sweep = 0; sweep < 4; sweep += 1) {
    const position = new Map<number, number>();
    order.forEach((column) => column.forEach((node, row) => position.set(node, row)));
    for (const column of order) {
      column.sort((a, b) => {
        const centre = (node: number) => {
          const rows = neighbours[node]!.map((other) => position.get(other) ?? 0);
          return rows.length > 0 ? rows.reduce((sum, row) => sum + row, 0) / rows.length : 0;
        };
        return centre(a) - centre(b);
      });
    }
  }

  const names = graph.labels.map((label) => {
    const parts = label.split("/");
    const name = parts.pop() ?? label;
    return { name, folder: parts.join("/") };
  });
  const widths = order.map((column) =>
    Math.max(
      120,
      ...column.map(
        (node) =>
          Math.max(names[node]!.name.length, names[node]!.folder.length * 0.9) * CHAR_W + 28,
      ),
    ),
  );
  const tallest = Math.max(...order.map((column) => column.length));
  const height = tallest * NODE_H + (tallest - 1) * ROW_GAP + 16;
  const x = widths.map((_, column) =>
    widths.slice(0, column).reduce((sum, width) => sum + width + COL_GAP, 8),
  );
  const width = x[columns - 1]! + widths[columns - 1]! + 8;
  const box = new Map<number, { x: number; y: number; w: number }>();
  order.forEach((column, index) => {
    const offset = (height - (column.length * NODE_H + (column.length - 1) * ROW_GAP)) / 2;
    column.forEach((node, row) => {
      box.set(node, { x: x[index]!, y: offset + row * (NODE_H + ROW_GAP), w: widths[index]! });
    });
  });

  const edgePaths = graph.edges
    .filter(([from, to]) => from !== to)
    .map(([from, to]) => {
      const a = box.get(from)!;
      const b = box.get(to)!;
      const forward = b.x > a.x;
      const sx = forward ? a.x + a.w : a.x + a.w / 2;
      const sy = forward ? a.y + NODE_H / 2 : a.y + NODE_H;
      const tx = forward ? b.x : b.x + b.w / 2;
      const ty = forward ? b.y + NODE_H / 2 : b.y + NODE_H;
      const d = forward
        ? `M${sx} ${sy} C${sx + COL_GAP / 2} ${sy} ${tx - COL_GAP / 2} ${ty} ${tx - 6} ${ty}`
        : `M${sx} ${sy} C${sx} ${sy + 36} ${tx} ${ty + 36} ${tx} ${ty + 6}`;
      return `<path class="edge${forward ? "" : " back"}" data-from="${from}" data-to="${to}" d="${d}" marker-end="url(#arrow)"></path>`;
    })
    .join("");

  const nodeGroups = [...box.entries()]
    .map(([node, place]) => {
      const { name, folder } = names[node]!;
      return `<g class="node" data-node="${node}" transform="translate(${place.x} ${place.y})" tabindex="0"><title>${escape(graph.labels[node]!)}</title><rect width="${place.w}" height="${NODE_H}" rx="6"></rect><text class="node-name" x="12" y="${folder ? 19 : 27}">${escape(name)}</text>${folder ? `<text class="node-folder" x="12" y="34">${escape(folder)}</text>` : ""}</g>`;
    })
    .join("");

  const extraBottom = graph.edges.some(([from, to]) => box.get(to)!.x <= box.get(from)!.x) ? 40 : 0;
  const total = height + extraBottom;
  return `<figure class="diagram" data-diagram><div class="diagram-scroll"><svg viewBox="0 0 ${width} ${total}" width="${width}" height="${total}" role="img" aria-label="Import links between the files this page covers"><defs><marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L8 4L0 8z"></path></marker></defs><g class="edges">${edgePaths}</g><g class="nodes">${nodeGroups}</g></svg></div><figcaption>Import links between the most central files, taken from the code graph. Point at a file to see what it imports and what imports it.</figcaption></figure>`;
}
