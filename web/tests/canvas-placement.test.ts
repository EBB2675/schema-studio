import { describe, expect, it } from 'vitest';
import { placeNewNodes, type PlacedBox } from '../src/utils/canvasPlacement';

const box = (x: number, y: number): PlacedBox => ({ x, y, w: 200, h: 60 });
const node = (id: string) => ({ id, w: 200, h: 60 });

describe('placeNewNodes', () => {
  it('puts a subsection class right of the class that holds it', () => {
    const placed = placeNewNodes(new Map([['A', box(0, 0)]]), [node('T')], [{ source: 'A', target: 'T', type: 'hasSubSection' }]);
    expect(placed.get('T')).toEqual({ x: 290, y: 0 });
  });

  it('places a class linked only to another new class after that one', () => {
    const placed = placeNewNodes(
      new Map([['P', box(0, 0)]]),
      [node('Grandchild'), node('Child')],
      [
        { source: 'Child', target: 'P', type: 'inherits' },
        { source: 'Grandchild', target: 'Child', type: 'inherits' },
      ]
    );
    expect(placed.get('Child')).toEqual({ x: -290, y: 0 });
    expect(placed.get('Grandchild')).toEqual({ x: -580, y: 0 });
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
});
