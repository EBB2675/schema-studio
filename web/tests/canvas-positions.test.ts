import { beforeEach, describe, expect, it } from 'vitest';
import { canvasPositionKey, createCanvasPositionStore, readCanvasPositions } from '../src/utils/canvasPositions';
const key = canvasPositionKey('nomad', 'pkg', 'UP');
beforeEach(() => localStorage.clear());

describe('saved canvas positions', () => {
  it('restores exact coordinates including negative and fractional positions', () => {
    const store = createCanvasPositionStore(key);
    store.positions.set('pkg.Class', { x: -142.5, y: 899.25 });
    expect(store.save()).toBe(true);
    expect(createCanvasPositionStore(key).positions.get('pkg.Class')).toEqual({ x: -142.5, y: 899.25 });
    expect(createCanvasPositionStore(key).restoredIds.has('pkg.Class')).toBe(true);
  });
  it('separates profiles, packages and layout directions', () => {
    const store = createCanvasPositionStore(key);
    store.positions.set('pkg.Class', { x: 100, y: 200 }); store.save();
    for (const other of [canvasPositionKey('other', 'pkg', 'UP'), canvasPositionKey('nomad', 'other', 'UP'), canvasPositionKey('nomad', 'pkg', 'LEFT')]) {
      expect(readCanvasPositions(other).size).toBe(0);
    }
  });
  it('retains a hidden class while saving a moved visible class', () => {
    const store = createCanvasPositionStore(key);
    store.positions.set('pkg.Hidden', { x: 10, y: 20 });
    store.positions.set('pkg.Visible', { x: 30, y: 40 }); store.save();
    const reopened = createCanvasPositionStore(key);
    reopened.positions.set('pkg.Visible', { x: 90, y: 100 }); reopened.save();
    expect([...readCanvasPositions(key)]).toEqual([['pkg.Hidden', { x: 10, y: 20 }], ['pkg.Visible', { x: 90, y: 100 }]]);
  });
  it('overwrites the arrangement when positions are deliberately replaced', () => {
    const store = createCanvasPositionStore(key);
    store.positions.set('pkg.Class', { x: 900, y: 400 }); store.save();
    store.positions.set('pkg.Class', { x: 0, y: 0 }); store.save();
    expect(readCanvasPositions(key).get('pkg.Class')).toEqual({ x: 0, y: 0 });
  });
  it('ignores malformed caches and rejects invalid coordinates', () => {
    localStorage.setItem(key, '{broken'); expect(readCanvasPositions(key).size).toBe(0);
    localStorage.setItem(key, JSON.stringify({ version: 2, positions: [['old', { x: 1, y: 2 }]] })); expect(readCanvasPositions(key).size).toBe(0);
    localStorage.setItem(key, JSON.stringify({ version: 1, positions: [null, ['bad', { x: '1', y: 2 }], ['null', { x: null, y: 0 }], ['ok', { x: 1, y: 2 }]] }));
    expect([...readCanvasPositions(key)]).toEqual([['ok', { x: 1, y: 2 }]]);
  });
  it('reports blocked storage without breaking in-memory positions', () => {
    const storage = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('quota'); } };
    const store = createCanvasPositionStore(key, storage);
    store.positions.set('pkg.Class', { x: 1, y: 2 });
    expect(store.save()).toBe(false);
    expect(store.positions.get('pkg.Class')).toEqual({ x: 1, y: 2 });
  });
  it('does not rewrite unchanged coordinates after selection or measurement updates', () => {
    let writes = 0;
    const store = createCanvasPositionStore(key, { getItem: () => null, setItem: () => { writes++; } });
    store.positions.set('pkg.Class', { x: 1, y: 2 }); store.save(); store.save();
    store.positions.set('pkg.Class', { x: 1, y: 2 }); store.save();
    expect(writes).toBe(1);
  });
});
