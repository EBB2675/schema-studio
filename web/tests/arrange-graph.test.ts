import { describe, expect, it } from 'vitest';
import { arrangeGraph } from '../src/utils/arrangeGraph';
import { LAYOUT_DIRECTIONS } from '../src/utils/layoutDirection';

const boxes = [{ id: 'child', width: 290, height: 180 }, { id: 'root', width: 290, height: 90 }];
const edges = [{ source: 'child', target: 'root' }];
describe('React Flow card arrangement', () => {
  it.each(LAYOUT_DIRECTIONS.map(item => item.value))('places base classes at %s', direction => {
    const positions = arrangeGraph(boxes, edges, direction);
    const root = positions.get('root')!;
    const child = positions.get('child')!;
    if (direction === 'UP') expect(root.y + 90).toBeLessThan(child.y);
    if (direction === 'DOWN') expect(child.y + 180).toBeLessThan(root.y);
    if (direction === 'LEFT') expect(root.x + 290).toBeLessThan(child.x);
    if (direction === 'RIGHT') expect(child.x + 290).toBeLessThan(root.x);
  });
  it('keeps cycles, disconnected classes and mixed card heights finite and separate', () => {
    const nodes = [...boxes, { id: 'other', width: 290, height: 700 }];
    const positions = arrangeGraph(nodes, [...edges, { source: 'root', target: 'child' }, { source: 'other', target: 'missing' }], 'UP');
    expect(positions.size).toBe(3);
    for (const [i, a] of nodes.entries()) {
      const p = positions.get(a.id)!;
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
      for (const b of nodes.slice(i + 1)) {
        const q = positions.get(b.id)!;
        expect(p.x + a.width <= q.x || q.x + b.width <= p.x || p.y + a.height <= q.y || q.y + b.height <= p.y).toBe(true);
      }
    }
    expect(arrangeGraph([], [], 'UP').size).toBe(0);
  });
});
