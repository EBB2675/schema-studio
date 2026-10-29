import { describe, expect, it } from 'vitest';
import { placeNewNodes, subsectionOnly, type PlacedBox } from '../src/utils/canvasPlacement';

const box = (x: number, y: number): PlacedBox => ({ x, y, w: 200, h: 60 });
const node = (id: string) => ({ id, w: 200, h: 60 });
const inherits = (source: string, target: string) => ({ source, target, type: 'inherits' });

describe('placeNewNodes', () => {
  it('puts subclasses in a row under their parent, centred on it', () => {
    const placed = placeNewNodes(new Map([['P', box(0, 0)]]), [node('A'), node('B')], [inherits('A', 'P'), inherits('B', 'P')]);
    expect(placed.get('A')).toEqual({ x: -120, y: 110 });
    expect(placed.get('B')).toEqual({ x: 120, y: 110 });
  });

  it('wraps many subclasses into rows of four', () => {
    const ids = ['A', 'B', 'C', 'D', 'E', 'F'];
    const placed = placeNewNodes(new Map([['P', box(0, 0)]]), ids.map(node), ids.map((id) => inherits(id, 'P')));
    const ys = ids.map((id) => placed.get(id)!.y);
    expect(new Set(ys.slice(0, 4)).size).toBe(1);
    expect(new Set(ys.slice(4)).size).toBe(1);
    expect(ys[4]).toBeGreaterThan(ys[0]);
    ids.forEach((id) => expect(placed.get(id)!.y).toBeGreaterThan(0));
  });

  it('moves subclasses further down, never sideways, when something is in the way', () => {
    const placed = placeNewNodes(
      new Map([['P', box(0, 0)], ['Below', box(0, 110)]]),
      [node('A')],
      [inherits('A', 'P')]
    );
    expect(placed.get('A')!.x).toBe(0);
    expect(placed.get('A')!.y).toBeGreaterThanOrEqual(110 + 60 + 50);
  });

  it('puts a subsection class right of the class that holds it', () => {
    const placed = placeNewNodes(new Map([['A', box(0, 0)]]), [node('T')], [{ source: 'A', target: 'T', type: 'hasSubSection' }]);
    expect(placed.get('T')).toEqual({ x: 290, y: 0 });
  });

  it('places a class linked only to another new class after that one', () => {
    const placed = placeNewNodes(
      new Map([['P', box(0, 0)]]),
      [node('Grandchild'), node('Child')],
      [inherits('Child', 'P'), inherits('Grandchild', 'Child')]
    );
    expect(placed.get('Child')).toEqual({ x: 0, y: 110 });
    expect(placed.get('Grandchild')).toEqual({ x: 0, y: 220 });
  });

  it('puts unlinked classes right of everything, and the first class of an empty canvas at the origin', () => {
    const placed = placeNewNodes(new Map([['A', box(0, 0)], ['B', box(500, 100)]]), [node('Free')], []);
    expect(placed.get('Free')).toEqual({ x: 790, y: 50 });
    expect(placeNewNodes(new Map(), [node('First')], []).get('First')).toEqual({ x: 0, y: 0 });
  });

  it('returns a class to where it was unless that spot is taken now', () => {
    const remembered = new Map([['Back', { x: -400, y: 300 }], ['Blocked', { x: 0, y: 0 }]]);
    const placed = placeNewNodes(new Map([['A', box(0, 0)]]), [node('Back'), node('Blocked')], [], remembered);
    expect(placed.get('Back')).toEqual({ x: -400, y: 300 });
    expect(placed.get('Blocked')).not.toEqual({ x: 0, y: 0 });
  });

  it.each([
    ['UP', { x: 0, y: 110 }, { x: 0, y: 220 }],
    ['DOWN', { x: 0, y: -110 }, { x: 0, y: -220 }],
    ['LEFT', { x: 290, y: 0 }, { x: 580, y: 0 }],
    ['RIGHT', { x: -290, y: 0 }, { x: -580, y: 0 }],
  ] as const)('puts subclasses away from the root when it is %s', (direction, child, grandchild) => {
    const placed = placeNewNodes(
      new Map([['P', box(0, 0)]]),
      [node('Child'), node('Grandchild')],
      [inherits('Child', 'P'), inherits('Grandchild', 'Child')],
      new Map(),
      direction
    );
    expect(placed.get('Child')).toEqual(child);
    expect(placed.get('Grandchild')).toEqual(grandchild);
  });

  it('stacks subclasses in a column beside the parent when the root is on a side', () => {
    const placed = placeNewNodes(
      new Map([['P', box(0, 0)]]),
      [node('A'), node('B')],
      [inherits('A', 'P'), inherits('B', 'P')],
      new Map(),
      'LEFT'
    );
    expect(placed.get('A')).toEqual({ x: 290, y: -55 });
    expect(placed.get('B')).toEqual({ x: 290, y: 55 });
  });

  it('puts a new parent on the root side of its subclass', () => {
    const placed = placeNewNodes(new Map([['C', box(0, 0)]]), [node('P')], [inherits('C', 'P')], new Map(), 'RIGHT');
    expect(placed.get('P')).toEqual({ x: 290, y: 0 });
  });

  it('keeps subsections right of the class holding them in every direction', () => {
    for (const direction of ['UP', 'DOWN', 'LEFT', 'RIGHT'] as const) {
      const placed = placeNewNodes(
        new Map([['A', box(0, 0)]]),
        [node('T')],
        [{ source: 'A', target: 'T', type: 'hasSubSection' }],
        new Map(),
        direction
      );
      expect(placed.get('T')).toEqual({ x: 290, y: 0 });
    }
  });
});

describe('subsectionOnly', () => {
  const holds = (source: string, target: string) => ({ source, target, type: 'hasSubSection' });

  it('picks the held classes that are in no inheritance link', () => {
    const links = [inherits('Sub', 'Base'), holds('Sub', 'Held'), holds('Held', 'Deeper'), holds('Base', 'Sub')];
    expect(subsectionOnly(['Base', 'Sub', 'Held', 'Deeper', 'Free'], links)).toEqual(new Set(['Held', 'Deeper']));
  });

  it('leaves every class to the layout when all of them would be left out', () => {
    expect(subsectionOnly(['A', 'B'], [holds('A', 'B'), holds('B', 'A')])).toEqual(new Set());
  });
});
