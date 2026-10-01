/**
 * Layered layout for the dependency graph, as pure numbers.
 *
 * The previous graph measured rendered DOM nodes and drew curves between the
 * measurements. That drifted every time a node changed height (opening an
 * editor moved the nodes but not the lines) and it could not route around
 * anything: an edge from column 1 to column 3 was drawn straight across column
 * 2's nodes. This layout decides every coordinate up front instead, so the
 * lines and the nodes cannot disagree, and long edges get a reserved slot in
 * each column they cross (a "dummy" node, as in Sugiyama-style layered
 * drawings) so they pass between nodes rather than behind them.
 *
 * Direction: an edge runs from a dependency (source) to the application that
 * depends on it (target), left to right, so roots - things nothing else feeds
 * - are on the left and the outermost consumers on the right.
 */

export interface LayoutEdge {
  readonly source: string;
  readonly target: string;
}

export interface LaidOutNode {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly layer: number;
}

export interface LaidOutEdge {
  readonly source: string;
  readonly target: string;
  /** Points the edge passes through, source anchor first, target anchor last. */
  readonly points: readonly { readonly x: number; readonly y: number }[];
}

export interface GraphLayout {
  readonly nodes: readonly LaidOutNode[];
  readonly edges: readonly LaidOutEdge[];
  readonly width: number;
  readonly height: number;
  /** Applications with no edge in either direction; drawn outside the canvas. */
  readonly isolated: readonly string[];
}

export const NODE_WIDTH = 168;
// Measured, not guessed: a node showing all 3 lines (name/text-body 22px
// line-height, status/text-label 20px, lastCheck/text-meta 20px, read from
// src/styles/index.css) plus the button's own py-2 padding (16px) and
// border (2px) comes to 62 + 16 + 2 = 80px. 52px only ever fit the 2-line
// case (name + status); the 025d90f lastCheck line overflowed it by 28px,
// more than the 16px ROW_GAP between nodes, which is what stacked the
// application column in the reported screenshot.
export const NODE_HEIGHT = 80;
const COLUMN_GAP = 64;
const ROW_GAP = 16;
/** Height of the slot a long edge reserves in a column it crosses. */
const LANE_HEIGHT = 14;

/** Longest-path layering, tolerant of a cycle (the server rejects them, but a
 * stale client should still draw something). */
export function computeLayers(
  ids: readonly string[],
  edges: readonly LayoutEdge[],
): Map<string, number> {
  const dependenciesOf = new Map<string, string[]>();
  for (const edge of edges) {
    const list = dependenciesOf.get(edge.target) ?? [];
    list.push(edge.source);
    dependenciesOf.set(edge.target, list);
  }
  const layer = new Map<string, number>();
  const visiting = new Set<string>();
  const resolve = (id: string): number => {
    const known = layer.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const deps = (dependenciesOf.get(id) ?? []).filter((dep) => dep !== id);
    const value = deps.length === 0 ? 0 : 1 + Math.max(...deps.map(resolve));
    visiting.delete(id);
    layer.set(id, value);
    return value;
  };
  ids.forEach(resolve);
  return layer;
}

interface Slot {
  readonly key: string;
  readonly kind: 'node' | 'lane';
  order: number;
}

export function layoutGraph(ids: readonly string[], edges: readonly LayoutEdge[]): GraphLayout {
  const known = new Set(ids);
  const usable = edges.filter(
    (edge) => known.has(edge.source) && known.has(edge.target) && edge.source !== edge.target,
  );
  const connected = new Set<string>();
  usable.forEach((edge) => {
    connected.add(edge.source);
    connected.add(edge.target);
  });
  const isolated = ids.filter((id) => !connected.has(id));
  const nodeIds = ids.filter((id) => connected.has(id));
  if (nodeIds.length === 0) return { nodes: [], edges: [], width: 0, height: 0, isolated };

  const layers = computeLayers(nodeIds, usable);
  const layerCount = Math.max(...nodeIds.map((id) => layers.get(id) ?? 0)) + 1;

  // One slot list per column: real nodes plus a lane slot for every edge that
  // crosses the column without touching it.
  const columns: Slot[][] = Array.from({ length: layerCount }, () => []);
  nodeIds.forEach((id) => columns[layers.get(id) ?? 0]!.push({ key: id, kind: 'node', order: 0 }));
  const laneKey = (edge: LayoutEdge, layer: number) => `${edge.source}=>${edge.target}@${layer}`;
  for (const edge of usable) {
    const from = layers.get(edge.source) ?? 0;
    const to = layers.get(edge.target) ?? 0;
    for (let layer = from + 1; layer < to; layer += 1) {
      columns[layer]!.push({ key: laneKey(edge, layer), kind: 'lane', order: 0 });
    }
  }
  columns.forEach((column) => column.forEach((slot, index) => (slot.order = index)));

  // Crossing reduction: a few barycentre sweeps. Each slot moves toward the
  // mean position of its neighbours in the adjacent column.
  const neighbours = (key: string, layer: number, direction: -1 | 1): string[] => {
    const out: string[] = [];
    for (const edge of usable) {
      const from = layers.get(edge.source) ?? 0;
      const to = layers.get(edge.target) ?? 0;
      if (layer < from || layer > to) continue;
      const at = layer === from ? edge.source : layer === to ? edge.target : laneKey(edge, layer);
      if (at !== key) continue;
      const nextLayer = layer + direction;
      if (nextLayer < from || nextLayer > to) continue;
      out.push(
        nextLayer === from
          ? edge.source
          : nextLayer === to
            ? edge.target
            : laneKey(edge, nextLayer),
      );
    }
    return out;
  };
  const sweep = (layer: number, direction: -1 | 1) => {
    const column = columns[layer]!;
    const adjacent = columns[layer + direction];
    if (!adjacent) return;
    const position = new Map(adjacent.map((slot) => [slot.key, slot.order]));
    const score = new Map<string, number>();
    column.forEach((slot) => {
      const near = neighbours(slot.key, layer, direction)
        .map((key) => position.get(key))
        .filter((value): value is number => value !== undefined);
      score.set(
        slot.key,
        near.length > 0 ? near.reduce((a, b) => a + b, 0) / near.length : slot.order,
      );
    });
    column.sort((a, b) => score.get(a.key)! - score.get(b.key)! || a.order - b.order);
    column.forEach((slot, index) => (slot.order = index));
  };
  for (let pass = 0; pass < 4; pass += 1) {
    for (let layer = 1; layer < layerCount; layer += 1) sweep(layer, -1);
    for (let layer = layerCount - 2; layer >= 0; layer -= 1) sweep(layer, 1);
  }

  // Coordinates. Columns are vertically centred on the tallest one so a short
  // column does not hug the top edge.
  const heightOf = (column: Slot[]) =>
    column.reduce((sum, slot) => sum + (slot.kind === 'node' ? NODE_HEIGHT : LANE_HEIGHT), 0) +
    Math.max(0, column.length - 1) * ROW_GAP;
  const height = Math.max(...columns.map(heightOf));
  const width = layerCount * NODE_WIDTH + (layerCount - 1) * COLUMN_GAP;

  const centre = new Map<string, number>();
  columns.forEach((column) => {
    let y = (height - heightOf(column)) / 2;
    for (const slot of column) {
      const h = slot.kind === 'node' ? NODE_HEIGHT : LANE_HEIGHT;
      centre.set(slot.key, y + h / 2);
      y += h + ROW_GAP;
    }
  });

  const columnX = (layer: number) => layer * (NODE_WIDTH + COLUMN_GAP);
  const nodes: LaidOutNode[] = nodeIds.map((id) => {
    const layer = layers.get(id) ?? 0;
    return { id, layer, x: columnX(layer), y: centre.get(id)! - NODE_HEIGHT / 2 };
  });

  // Anchors: several edges leaving or entering one node fan out along its
  // side instead of stacking on the centre line.
  const spread = (list: LayoutEdge[], centreY: number, edge: LayoutEdge) => {
    const index = list.indexOf(edge);
    const span = Math.min(NODE_HEIGHT - 16, (list.length - 1) * 10);
    return list.length === 1 ? centreY : centreY - span / 2 + (span * index) / (list.length - 1);
  };
  const leaving = new Map<string, LayoutEdge[]>();
  const entering = new Map<string, LayoutEdge[]>();
  const orderOfTarget = (edge: LayoutEdge) => centre.get(edge.target)!;
  const orderOfSource = (edge: LayoutEdge) => centre.get(edge.source)!;
  usable.forEach((edge) => {
    leaving.set(edge.source, [...(leaving.get(edge.source) ?? []), edge]);
    entering.set(edge.target, [...(entering.get(edge.target) ?? []), edge]);
  });
  leaving.forEach((list) => list.sort((a, b) => orderOfTarget(a) - orderOfTarget(b)));
  entering.forEach((list) => list.sort((a, b) => orderOfSource(a) - orderOfSource(b)));

  const laidOutEdges: LaidOutEdge[] = usable.map((edge) => {
    const from = layers.get(edge.source) ?? 0;
    const to = layers.get(edge.target) ?? 0;
    const points: { x: number; y: number }[] = [
      {
        x: columnX(from) + NODE_WIDTH,
        y: spread(leaving.get(edge.source)!, centre.get(edge.source)!, edge),
      },
    ];
    for (let layer = from + 1; layer < to; layer += 1) {
      const y = centre.get(laneKey(edge, layer))!;
      points.push({ x: columnX(layer), y }, { x: columnX(layer) + NODE_WIDTH, y });
    }
    points.push({
      x: columnX(to),
      y: spread(entering.get(edge.target)!, centre.get(edge.target)!, edge),
    });
    return { source: edge.source, target: edge.target, points };
  });

  return { nodes, edges: laidOutEdges, width, height, isolated };
}

/** SVG path through the points: horizontal tangents at every point, so a
 * lane crossing reads as a straight run and the bends happen in the gaps. */
export function edgePath(points: LaidOutEdge['points']): string {
  const [first, ...rest] = points;
  if (!first) return '';
  let d = `M${first.x} ${first.y}`;
  let previous = first;
  for (const point of rest) {
    const half = (point.x - previous.x) / 2;
    d += ` C ${previous.x + half} ${previous.y}, ${point.x - half} ${point.y}, ${point.x} ${point.y}`;
    previous = point;
  }
  return d;
}
