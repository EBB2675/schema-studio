// Positions are node centres in Cytoscape model coordinates.
export type Point = { x: number; y: number };
export type PlacedBox = Point & { w: number; h: number };
export type NewNode = { id: string; w: number; h: number };
type Link = { source: string; target: string; type: string };

// Same spacing as the full layout, so placed classes sit like laid-out ones.
const GAP_X = 90;
const GAP_Y = 26;
const MAX_COLUMN_TRIES = 40;

const overlaps = (a: PlacedBox, b: PlacedBox) =>
  Math.abs(a.x - b.x) * 2 < a.w + b.w + GAP_Y && Math.abs(a.y - b.y) * 2 < a.h + b.h + GAP_Y;

/**
 * Where to put classes that join a canvas whose other classes keep their place.
 *
 * A class that was on the canvas before goes back where it was, if that spot
 * is still free. Every other class goes in a column beside a class it is
 * linked to: left of it when it points at that class (a subclass, or a class
 * holding it as a subsection), right of it otherwise, as the full layout draws
 * them. A column that would cover a class moves further out until it is free.
 * Classes linked to nothing on the canvas go in a column right of everything.
 */
export function placeNewNodes(
  existing: Map<string, PlacedBox>,
  added: NewNode[],
  links: Link[],
  remembered: Map<string, Point> = new Map()
): Map<string, Point> {
  const placed = new Map(existing);
  const occupied = [...existing.values()];
  const result = new Map<string, Point>();
  const put = (node: NewNode, at: Point) => {
    const box = { ...at, w: node.w, h: node.h };
    placed.set(node.id, box);
    occupied.push(box);
    result.set(node.id, at);
  };

  let pending: NewNode[] = [];
  for (const node of added) {
    const at = remembered.get(node.id);
    if (at && !occupied.some((box) => overlaps(box, { ...at, w: node.w, h: node.h }))) put(node, at);
    else pending.push(node);
  }

  const placeColumn = (nodes: NewNode[], anchor: PlacedBox | null, side: 1 | -1) => {
    const colW = Math.max(...nodes.map((n) => n.w));
    const colH = nodes.reduce((sum, n) => sum + n.h, 0) + GAP_Y * (nodes.length - 1);
    let startX: number;
    let centreY: number;
    if (anchor) {
      startX = anchor.x + side * (anchor.w / 2 + GAP_X + colW / 2);
      centreY = anchor.y;
    } else if (occupied.length) {
      startX = Math.max(...occupied.map((b) => b.x + b.w / 2)) + GAP_X + colW / 2;
      centreY = occupied.reduce((sum, b) => sum + b.y, 0) / occupied.length;
    } else {
      startX = 0;
      centreY = 0;
    }
    const boxesAt = (x: number) => {
      let top = centreY - colH / 2;
      return nodes.map((n) => {
        const box = { x, y: top + n.h / 2, w: n.w, h: n.h };
        top += n.h + GAP_Y;
        return box;
      });
    };
    let boxes = boxesAt(startX);
    for (let i = 1; i < MAX_COLUMN_TRIES && boxes.some((b) => occupied.some((o) => overlaps(o, b))); i += 1) {
      boxes = boxesAt(startX + side * i * (colW + GAP_X));
    }
    nodes.forEach((n, i) => put(n, { x: boxes[i].x, y: boxes[i].y }));
  };

  // Each round places the classes linked to one already on the canvas.
  while (pending.length) {
    const columns = new Map<string, { anchor: PlacedBox; side: 1 | -1; nodes: NewNode[] }>();
    const later: NewNode[] = [];
    for (const node of pending) {
      const link =
        links.find((l) => l.type === "inherits" && l.source === node.id && placed.has(l.target)) ??
        links.find((l) => (l.source === node.id && placed.has(l.target)) || (l.target === node.id && placed.has(l.source)));
      if (!link) {
        later.push(node);
        continue;
      }
      const anchorId = link.source === node.id ? link.target : link.source;
      const side: 1 | -1 = link.source === node.id ? -1 : 1;
      const key = `${anchorId}|${side}`;
      const column = columns.get(key) ?? { anchor: placed.get(anchorId)!, side, nodes: [] };
      column.nodes.push(node);
      columns.set(key, column);
    }
    if (!columns.size) {
      placeColumn(later, null, 1);
      break;
    }
    columns.forEach(({ anchor, side, nodes }) => placeColumn(nodes, anchor, side));
    pending = later;
  }

  return result;
}
