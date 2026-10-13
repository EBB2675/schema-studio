// Positions are node centres in Cytoscape model coordinates.
export type Point = { x: number; y: number };
export type PlacedBox = Point & { w: number; h: number };
export type NewNode = { id: string; w: number; h: number };
type Link = { source: string; target: string; type: string };
type Side = "below" | "above" | "right" | "left";

const GAP_X = 40;
const GAP_Y = 50;
// Wide enough to clear a card's +/- and the gap the full layout keeps between columns.
const COLUMN_GAP = 90;
const MAX_PER_ROW = 4;
const STEP = 40;
const MAX_STEPS = 400;

const overlaps = (a: PlacedBox, b: PlacedBox) =>
  Math.abs(a.x - b.x) * 2 < a.w + b.w + GAP_X && Math.abs(a.y - b.y) * 2 < a.h + b.h + GAP_Y;

// Which side of a linked class a new class goes: subclasses under their parent (where
// its + is), a parent over its subclass, a subsection right of the class holding it.
function sideOf(node: string, link: Link): Side {
  if (link.type === "inherits") return link.source === node ? "below" : "above";
  return link.target === node ? "right" : "left";
}

/**
 * Where to put classes that join a canvas whose other classes keep their place.
 *
 * A class that was on the canvas before goes back where it was, if that spot is
 * still free. Every other class goes beside a class it is linked to, as `sideOf`
 * says: subclasses in rows of up to four, centred under their parent; other
 * classes in a column. A group that would cover a class moves further the same
 * way (further down, for subclasses) until it is free. Classes linked to nothing
 * on the canvas go right of everything.
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

  // Lays the nodes out in rows (or one column) and returns the boxes relative to the group's centre.
  const arrange = (nodes: NewNode[], perRow: number) => {
    const rows: NewNode[][] = [];
    for (let i = 0; i < nodes.length; i += perRow) rows.push(nodes.slice(i, i + perRow));
    const rowHeights = rows.map((row) => Math.max(...row.map((n) => n.h)));
    const height = rowHeights.reduce((sum, h) => sum + h, 0) + GAP_Y * (rows.length - 1);
    const rowWidths = rows.map((row) => row.reduce((sum, n) => sum + n.w, 0) + GAP_X * (row.length - 1));
    const width = Math.max(...rowWidths);
    const boxes: Array<{ node: NewNode; dx: number; dy: number }> = [];
    let top = -height / 2;
    rows.forEach((row, r) => {
      let left = -rowWidths[r] / 2;
      row.forEach((node) => {
        boxes.push({ node, dx: left + node.w / 2, dy: top + rowHeights[r] / 2 });
        left += node.w + GAP_X;
      });
      top += rowHeights[r] + GAP_Y;
    });
    return { boxes, width, height };
  };

  const placeGroup = (nodes: NewNode[], anchor: PlacedBox | null, side: Side) => {
    const vertical = side === "below" || side === "above";
    const { boxes, width, height } = arrange(nodes, vertical ? MAX_PER_ROW : 1);
    let cx: number;
    let cy: number;
    if (!anchor) {
      cx = occupied.length ? Math.max(...occupied.map((b) => b.x + b.w / 2)) + COLUMN_GAP + width / 2 : 0;
      cy = occupied.length ? occupied.reduce((sum, b) => sum + b.y, 0) / occupied.length : 0;
    } else if (vertical) {
      cx = anchor.x;
      cy = anchor.y + (side === "below" ? 1 : -1) * (anchor.h / 2 + GAP_Y + height / 2);
    } else {
      cx = anchor.x + (side === "right" ? 1 : -1) * (anchor.w / 2 + COLUMN_GAP + width / 2);
      cy = anchor.y;
    }
    const direction = { below: [0, 1], above: [0, -1], right: [1, 0], left: [-1, 0] }[anchor ? side : "right"];
    const at = (step: number) =>
      boxes.map(({ node, dx, dy }) => ({
        node,
        box: { x: cx + dx + direction[0] * step * STEP, y: cy + dy + direction[1] * step * STEP, w: node.w, h: node.h },
      }));
    let candidate = at(0);
    for (let step = 1; step < MAX_STEPS && candidate.some(({ box }) => occupied.some((o) => overlaps(o, box))); step += 1) {
      candidate = at(step);
    }
    candidate.forEach(({ node, box }) => put(node, { x: box.x, y: box.y }));
  };

  // Each round places the classes linked to one already on the canvas.
  while (pending.length) {
    const groups = new Map<string, { anchor: PlacedBox; side: Side; nodes: NewNode[] }>();
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
      const side = sideOf(node.id, link);
      const key = `${anchorId}|${side}`;
      const group = groups.get(key) ?? { anchor: placed.get(anchorId)!, side, nodes: [] };
      group.nodes.push(node);
      groups.set(key, group);
    }
    if (!groups.size) {
      placeGroup(later, null, "right");
      break;
    }
    groups.forEach(({ anchor, side, nodes }) => placeGroup(nodes, anchor, side));
    pending = later;
  }

  return result;
}
