// A small stand-in for a Cytoscape core: real element storage and a real event
// bus, plus counters for the calls that move the view (layout, fit, animate).
// Layouts never run on their own; finishLayout() places the nodes on a grid and
// emits `layoutstop` the way ELK would.

type Point = { x: number; y: number };
type Data = Record<string, unknown> & { id: string };
type Listener = (evt: unknown) => void;

export interface FakeElement {
  group(): 'nodes' | 'edges';
  isNode(): boolean;
  id(): string;
  data(arg?: string | Record<string, unknown>): unknown;
  position(next?: Point): Point | FakeElement;
  boundingBox(): { x1: number; y1: number; x2: number; y2: number; w: number; h: number };
  empty(): boolean;
  remove(): FakeElement;
  select(): FakeElement;
  unselect(): FakeElement;
  selected(): boolean;
  addClass(names: string): FakeElement;
  removeClass(names: string): FakeElement;
  hasClass(name: string): boolean;
}

const SIZE = { w: 120, h: 60 };

export function makeFakeCy() {
  const listeners: Record<string, Array<{ selector?: string; cb: Listener }>> = {};
  const elements = new Map<string, FakeElement>();
  const stats = { layouts: 0, layoutStops: 0, fits: 0, animations: 0, resizes: 0, destroyed: false, boundingBoxCalls: [] as string[], layoutOptions: [] as unknown[] };

  const make = (group: 'nodes' | 'edges', initial: Data, position: Point): FakeElement => {
    let data: Data = { ...initial };
    let pos = { ...position };
    let selected = false;
    const classes = new Set<string>();
    const ele: FakeElement = {
      group: () => group,
      isNode: () => group === 'nodes',
      id: () => data.id,
      data(arg?: string | Record<string, unknown>) {
        if (arg === undefined) return data;
        if (typeof arg === 'string') return data[arg];
        data = { ...data, ...arg };
        return ele;
      },
      position(next?: Point) {
        if (next) {
          pos = { ...next };
          return ele;
        }
        return pos;
      },
      boundingBox() {
        stats.boundingBoxCalls.push(data.id);
        return { x1: pos.x - SIZE.w / 2, y1: pos.y - SIZE.h / 2, x2: pos.x + SIZE.w / 2, y2: pos.y + SIZE.h / 2, ...SIZE };
      },
      empty: () => false,
      remove() {
        elements.delete(data.id);
        if (group === 'nodes') {
          [...elements.values()].forEach((e) => {
            if (e.group() === 'edges' && (e.data('source') === data.id || e.data('target') === data.id)) e.remove();
          });
        }
        return ele;
      },
      select: () => { selected = true; return ele; },
      unselect: () => { selected = false; return ele; },
      selected: () => selected,
      addClass: (names: string) => { names.split(/\s+/).forEach((n) => classes.add(n)); return ele; },
      removeClass: (names: string) => { names.split(/\s+/).forEach((n) => classes.delete(n)); return ele; },
      hasClass: (name: string) => classes.has(name),
    };
    return ele;
  };

  const EMPTY = { empty: () => true, id: () => '', data: () => ({}) } as unknown as FakeElement;

  type FakeCollection = ReturnType<typeof coll>;
  const coll = (arr: FakeElement[]) => {
    const c = {
      __elements: arr,
      union: (other: { __elements: FakeElement[] }) => coll([...arr, ...other.__elements]),
      layout: (options: Parameters<typeof cy.layout>[0] = {}) => cy.layout({ ...options, eles: c }),
      forEach: (f: (e: FakeElement) => void) => arr.forEach(f),
      filter: (f: (e: FakeElement) => boolean) => coll(arr.filter(f)),
      map: <T,>(f: (e: FakeElement) => T) => arr.map(f),
      first: () => arr[0] ?? EMPTY,
      empty: () => arr.length === 0,
      length: arr.length,
      removeClass: (names: string) => { arr.forEach((e) => e.removeClass(names)); return c; },
      unselect: () => { arr.forEach((e) => e.unselect()); return c; },
    };
    return c;
  };

  const layouts: Array<{ finish: () => void }> = [];
  const all = () => [...elements.values()];
  const nodes = () => all().filter((e) => e.isNode());
  const edges = () => all().filter((e) => !e.isNode());

  const cy = {
    __pan: { x: 0, y: 0 } as Point,
    __zoom: 1,
    stats,
    destroy: () => { stats.destroyed = true; },
    destroyed: () => stats.destroyed,
    resize: () => { stats.resizes += 1; },
    fit: () => { stats.fits += 1; },
    center: () => {},
    png: () => null,
    animate: () => { stats.animations += 1; },
    style: () => {},
    batch: (fn: () => void) => fn(),
    minZoom: () => 0.2,
    maxZoom: () => 3.5,
    pan: (next?: Point) => {
      if (next) cy.__pan = { ...next };
      return cy.__pan;
    },
    zoom: (next?: number) => {
      if (typeof next === 'number') cy.__zoom = next;
      return cy.__zoom;
    },
    nodes: () => coll(nodes()),
    edges: () => coll(edges()),
    $: (sel: string) => {
      if (sel === ':selected') return coll(all().filter((e) => e.selected()));
      if (sel === 'edge') return coll(edges());
      if (sel === 'node') return coll(nodes());
      return coll(all());
    },
    getElementById: (id: string) => elements.get(id) ?? EMPTY,
    add(def: { group: 'nodes' | 'edges'; data: Data; position?: Point }) {
      const ele = make(def.group, def.data, def.position ?? { x: 0, y: 0 });
      elements.set(def.data.id, ele);
      return ele;
    },
    // Like ELK: a layout lays out the nodes there were when it was made (or those in
    // `eles`), cannot be stopped, and runs its result through the `transform` option.
    layout(options: { eles?: FakeCollection; transform?: (node: FakeElement, pos: Point) => Point } = {}) {
      stats.layouts += 1;
      stats.layoutOptions.push(options);
      const own: Listener[] = [];
      const laidOut = options.eles ? options.eles.__elements.filter((e) => e.isNode()) : nodes();
      const layout = {
        run: () => layout,
        stop: () => layout,
        one: (ev: string, cb: Listener) => {
          if (ev === 'layoutstop') own.push(cb);
          return layout;
        },
        finish() {
          laidOut.forEach((n, i) => {
            const pos = { x: (i % 4) * 300, y: Math.floor(i / 4) * 200 };
            n.position(options.transform ? options.transform(n, pos) : pos);
          });
          stats.layoutStops += 1;
          own.splice(0).forEach((cb) => cb({ target: layout }));
          cy.emit('layoutstop');
        },
      };
      layouts.push(layout);
      return layout;
    },
    ready: (cb: () => void) => cb(),
    on(ev: string, a: unknown, b?: unknown) {
      const cb = (b ?? a) as Listener;
      const selector = b ? (a as string) : undefined;
      ev.split(/\s+/).forEach((name) => (listeners[name] ||= []).push({ selector, cb }));
    },
    off(ev: string, a: unknown, b?: unknown) {
      const cb = (b ?? a) as Listener;
      ev.split(/\s+/).forEach((name) => {
        listeners[name] = (listeners[name] || []).filter((l) => l.cb !== cb);
      });
    },
    one(ev: string, cb: Listener) {
      const wrap = (evt: unknown) => {
        cy.off(ev, wrap);
        cb(evt);
      };
      cy.on(ev, wrap);
    },
    emit(ev: string, evt?: unknown) {
      ev.split(/\s+/).forEach((name) => {
        (listeners[name] || []).slice().forEach((l) => l.cb(evt ?? { target: cy }));
      });
    },
    // What ELK would do when a layout (by default the latest) ends: its nodes get a
    // spot on a grid, then layoutstop.
    finishLayout(index = layouts.length - 1) {
      layouts[index]?.finish();
    },
    // Replaces the nodes behind GraphView's back, as a layout of another graph would.
    __setNodes(ids: string[]) {
      nodes().forEach((n) => n.remove());
      ids.forEach((id) => cy.add({ group: 'nodes', data: { id, label: id, rawName: id, module: '' } }));
    },
  };

  return cy;
}

export type FakeCy = ReturnType<typeof makeFakeCy>;

// Captures ResizeObserver callbacks so a test can resize the canvas container.
export function stubResizeObserver() {
  const callbacks: Array<() => void> = [];
  class FakeResizeObserver {
    constructor(cb: () => void) {
      callbacks.push(cb);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  return { FakeResizeObserver, resizeAll: () => callbacks.forEach((cb) => cb()) };
}
