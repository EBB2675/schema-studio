import type { LayoutDirection } from './layoutDirection';

type Box = { id: string; width: number; height: number };
type Edge = { source: string; target: string };

/** Place cards in layers toward their targets, including disconnected and cyclic graphs. */
export function arrangeGraph(boxes: Box[], edges: Edge[], direction: LayoutDirection) {
  const ids = new Set(boxes.map(box => box.id));
  const outgoing = new Map(boxes.map(box => [box.id, new Set<string>()]));
  for (const { source, target } of edges) {
    if (source === target || !ids.has(source) || !ids.has(target)) continue;
    outgoing.get(source)!.add(target);
  }
  const rank = new Map<string, number>();
  const pending = new Set(ids);
  // Peel target layers. If a component contains a cycle, choose a stable anchor
  // and continue peeling; no card is dropped and traversal always terminates.
  while (pending.size) {
    let layer = [...pending].filter(id => ![...outgoing.get(id)!].some(target => pending.has(target)));
    if (!layer.length) layer = [[...pending].sort()[0]];
    for (const id of layer) {
      const targets = [...outgoing.get(id)!].filter(target => rank.has(target));
      rank.set(id, targets.length ? 1 + Math.max(...targets.map(target => rank.get(target)!)) : 0);
      pending.delete(id);
    }
  }
  const layers = new Map<number, Box[]>();
  for (const box of boxes) {
    const level = rank.get(box.id)!;
    const layer = layers.get(level) ?? [];
    layer.push(box); layers.set(level, layer);
  }
  const horizontal = direction === 'LEFT' || direction === 'RIGHT';
  const reverse = direction === 'RIGHT' || direction === 'DOWN';
  const positions = new Map<string, { x: number; y: number }>();
  let primary = 0;
  for (const [, layer] of [...layers].sort(([a], [b]) => a - b)) {
    const span = layer.reduce((sum, box) => sum + (horizontal ? box.height : box.width), 0) + 70 * (layer.length - 1);
    let secondary = -span / 2;
    for (const box of layer) {
      const size = horizontal ? box.width : box.height;
      const axis = reverse ? -primary - size : primary;
      positions.set(box.id, horizontal ? { x: axis, y: secondary } : { x: secondary, y: axis });
      secondary += (horizontal ? box.height : box.width) + 70;
    }
    primary += Math.max(...layer.map(box => horizontal ? box.width : box.height)) + 100;
  }
  return positions;
}
