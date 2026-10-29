import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import GraphView from '../src/GraphView';
import type { UmlClassNode, UmlGraphState } from '../src/types/uml';
import { makeFakeCy, stubResizeObserver, type FakeCy } from './helpers/fakeCytoscape';

let fakeCy: FakeCy;

vi.mock('cytoscape', () => ({ __esModule: true, default: vi.fn(() => fakeCy) }));
vi.mock('cytoscape-elk', () => ({ __esModule: true, default: vi.fn() }));
vi.mock('elkjs/lib/elk.bundled.js', () => ({ __esModule: true, default: vi.fn() }));

let rafQueue: FrameRequestCallback[] = [];
const flushRaf = () => {
  const queued = rafQueue;
  rafQueue = [];
  queued.forEach((cb) => cb(0));
};

const PARENT = 'pkg.Parent';
const OTHER = 'pkg.Other';
const SHARED = 'pkg.Shared';
const CHILD_1 = 'pkg.ChildOne';
const CHILD_2 = 'pkg.ChildTwo';

const cls = (id: string, extra: Partial<UmlClassNode> = {}): UmlClassNode => ({
  id, name: id.split('.').pop() ?? id, module: 'pkg', quantities: [], ...extra,
});

// The graph before and after PARENT's subclasses are shown. SHARED is a subsection of
// OTHER and of CHILD_1, so it stays when PARENT is collapsed again.
const collapsed: UmlGraphState = {
  package: 'pkg',
  root: '',
  classes: [cls(PARENT, { subclasses: 2 }), cls(OTHER), cls(SHARED)],
  edges: [{ source: OTHER, target: SHARED, type: 'hasSubSection' }],
};
const expanded: UmlGraphState = {
  ...collapsed,
  classes: [...collapsed.classes, cls(CHILD_1), cls(CHILD_2)],
  edges: [
    ...collapsed.edges,
    { source: CHILD_1, target: PARENT, type: 'inherits' },
    { source: CHILD_2, target: PARENT, type: 'inherits' },
    { source: CHILD_1, target: SHARED, type: 'hasSubSection' },
  ],
};

type ViewProps = Partial<React.ComponentProps<typeof GraphView>>;
const view = (props: ViewProps) => (
  <GraphView nodes={[]} edges={[]} umlState={collapsed} layoutKey={1} onToggleSubclasses={vi.fn()} {...props} />
);

const pos = (id: string) => ({ ...(fakeCy.getElementById(id).position() as { x: number; y: number }) });
const cytoscapeMock = async () => (await import('cytoscape')).default as unknown as ReturnType<typeof vi.fn>;

describe('GraphView updates the canvas in place', () => {
  let resizeAll: () => void;

  beforeEach(async () => {
    fakeCy = makeFakeCy();
    rafQueue = [];
    (await cytoscapeMock()).mockClear();
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => rafQueue.push(cb));
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const observer = stubResizeObserver();
    resizeAll = observer.resizeAll;
    vi.stubGlobal('ResizeObserver', observer.FakeResizeObserver);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  // Renders the collapsed graph, lets the first layout finish, then moves the view and a class
  // the way a user would.
  const renderLaidOut = (props: ViewProps = {}) => {
    const result = render(view(props));
    act(() => {
      fakeCy.finishLayout();
      flushRaf();
    });
    fakeCy.__pan = { x: 140, y: -60 };
    fakeCy.__zoom = 0.7;
    fakeCy.getElementById(OTHER).position({ x: 900, y: 700 }); // dragged by the user
    fakeCy.getElementById(PARENT).select();
    return result;
  };

  it('lays out and fits a new graph once', async () => {
    renderLaidOut();
    expect(await cytoscapeMock()).toHaveBeenCalledTimes(1);
    expect(fakeCy.stats.layouts).toBe(1);
    expect(fakeCy.stats.fits).toBeGreaterThan(0);
  });

  it('shows subclasses beside their parent without a new canvas, layout or fit, and keeps the view', async () => {
    const { rerender } = renderLaidOut();
    const fits = fakeCy.stats.fits;
    const parentAt = pos(PARENT);

    rerender(view({ umlState: expanded, expandedClassIds: [PARENT] }));
    act(() => flushRaf());

    expect(await cytoscapeMock()).toHaveBeenCalledTimes(1);
    expect(fakeCy.stats.destroyed).toBe(false);
    expect(fakeCy.stats.layouts).toBe(1);
    expect(fakeCy.stats.fits).toBe(fits);
    expect(fakeCy.stats.animations).toBe(0);
    expect(fakeCy.__pan).toEqual({ x: 140, y: -60 });
    expect(fakeCy.__zoom).toBe(0.7);
    expect(pos(PARENT)).toEqual(parentAt);
    expect(pos(OTHER)).toEqual({ x: 900, y: 700 });
    expect(fakeCy.getElementById(PARENT).selected()).toBe(true);

    // Subclasses go in a row under their parent, where its + is.
    const one = pos(CHILD_1);
    const two = pos(CHILD_2);
    for (const child of [one, two]) {
      expect(child.y).toBeGreaterThan(parentAt.y);
      expect(child.y - parentAt.y).toBeLessThan(200);
      expect(Math.abs(child.x - parentAt.x)).toBeLessThan(300);
    }
    expect(one.y).toBe(two.y);
    expect(Math.abs(one.x - two.x)).toBeGreaterThanOrEqual(200);

    // Inheritance and subsection edges have ids named after the link, not a position in a list.
    expect(fakeCy.getElementById(`inherits:${CHILD_1}->${PARENT}`).empty()).toBe(false);
    expect(fakeCy.getElementById(`hasSubSection:${OTHER}->${SHARED}`).empty()).toBe(false);
  });

  it('keeps a class the collapsed graph still needs, and brings subclasses back to their spot', () => {
    const { rerender } = renderLaidOut();
    const shared = fakeCy.getElementById(SHARED);
    const sharedAt = pos(SHARED);

    rerender(view({ umlState: expanded, expandedClassIds: [PARENT] }));
    const childOneAt = pos(CHILD_1);
    const childTwoAt = pos(CHILD_2);

    rerender(view({ umlState: collapsed, expandedClassIds: [] }));
    expect(fakeCy.getElementById(CHILD_1).empty()).toBe(true);
    expect(fakeCy.getElementById(CHILD_2).empty()).toBe(true);
    expect(fakeCy.getElementById(`hasSubSection:${CHILD_1}->${SHARED}`).empty()).toBe(true);
    expect(fakeCy.getElementById(SHARED)).toBe(shared);
    expect(pos(SHARED)).toEqual(sharedAt);
    expect(pos(OTHER)).toEqual({ x: 900, y: 700 });

    rerender(view({ umlState: expanded, expandedClassIds: [PARENT] }));
    expect(pos(CHILD_1)).toEqual(childOneAt);
    expect(pos(CHILD_2)).toEqual(childTwoAt);
    expect(fakeCy.stats.layouts).toBe(1);
    expect(fakeCy.__zoom).toBe(0.7);
  });

  it('places a new class off any class it would cover', () => {
    const { rerender } = renderLaidOut();
    // A class sits exactly where the row of subclasses would go first.
    const parentAt = pos(PARENT);
    fakeCy.getElementById(OTHER).position({ x: parentAt.x, y: parentAt.y + 110 });

    rerender(view({ umlState: expanded, expandedClassIds: [PARENT] }));

    const boxes = [PARENT, OTHER, SHARED, CHILD_1, CHILD_2].map((id) => ({ id, ...pos(id) }));
    for (const a of boxes) {
      for (const b of boxes) {
        if (a.id >= b.id) continue;
        const apart = Math.abs(a.x - b.x) >= 200 || Math.abs(a.y - b.y) >= 60;
        expect(apart, `${a.id} and ${b.id} overlap`).toBe(true);
      }
    }
  });

  it('keeps the view through other renders, selection, theme changes and canvas resizes', async () => {
    const { rerender } = renderLaidOut();
    const fits = fakeCy.stats.fits;

    rerender(view({ selectedClassId: PARENT }));
    rerender(view({ selectedClassId: OTHER, theme: 'light' }));
    rerender(view({ selectedClassId: OTHER, theme: 'light', showQuantityMetadata: false }));
    act(() => {
      resizeAll();
      flushRaf();
    });

    expect(fakeCy.stats.resizes).toBeGreaterThan(0);
    expect(await cytoscapeMock()).toHaveBeenCalledTimes(1);
    expect(fakeCy.stats.layouts).toBe(1);
    expect(fakeCy.stats.fits).toBe(fits);
    expect(fakeCy.__pan).toEqual({ x: 140, y: -60 });
    expect(fakeCy.__zoom).toBe(0.7);
    expect(pos(OTHER)).toEqual({ x: 900, y: 700 });
  });

  it('lays out and fits again for a new layoutKey', () => {
    const { rerender } = renderLaidOut();
    const fits = fakeCy.stats.fits;

    rerender(view({ layoutKey: 2 }));
    expect(fakeCy.stats.layouts).toBe(2);
    act(() => fakeCy.finishLayout());
    expect(fakeCy.stats.fits).toBeGreaterThan(fits);
  });

  it('lays out classes that come while the first layout runs with it, and lets the outdated run move nothing', () => {
    const { rerender } = render(view({}));
    // Layout still running; the user expands a class.
    rerender(view({ umlState: expanded, expandedClassIds: [PARENT] }));
    expect(fakeCy.stats.layouts).toBe(2);

    act(() => {
      fakeCy.finishLayout(1);
      flushRaf();
    });
    const fits = fakeCy.stats.fits;
    const laidOut = [PARENT, CHILD_1, CHILD_2].map(pos);

    // ELK cannot be stopped, so the first run ends too, later.
    act(() => {
      fakeCy.finishLayout(0);
      flushRaf();
    });
    expect([PARENT, CHILD_1, CHILD_2].map(pos)).toEqual(laidOut);
    expect(fakeCy.stats.fits).toBe(fits);
  });

  it('drops the follow-up fit of a finished layout once the canvas changed', () => {
    const { rerender } = render(view({}));
    act(() => fakeCy.finishLayout());
    const fits = fakeCy.stats.fits;
    expect(rafQueue.length).toBeGreaterThan(0);

    rerender(view({ umlState: expanded, expandedClassIds: [PARENT] }));
    act(() => flushRaf());
    expect(fakeCy.stats.fits).toBe(fits);
  });

  it('ignores a layout of the previous graph that finishes after switching graphs', () => {
    const onLayoutReady = vi.fn();
    const { rerender } = render(view({ onLayoutReady }));
    rerender(view({ onLayoutReady, layoutKey: 2, umlState: expanded }));

    act(() => {
      fakeCy.finishLayout(1);
      flushRaf();
    });
    expect(onLayoutReady).toHaveBeenCalledTimes(1);
    fakeCy.__pan = { x: 5, y: 5 };
    fakeCy.getElementById(PARENT).position({ x: -42, y: 42 });
    const fits = fakeCy.stats.fits;

    act(() => {
      fakeCy.finishLayout(0);
      flushRaf();
    });
    expect(pos(PARENT)).toEqual({ x: -42, y: 42 });
    expect(fakeCy.stats.fits).toBe(fits);
    expect(fakeCy.__pan).toEqual({ x: 5, y: 5 });
    expect(onLayoutReady).toHaveBeenCalledTimes(1);
  });

  it('publishes one handle for the life of the canvas', () => {
    const onReady = vi.fn();
    const { rerender, unmount } = renderLaidOut({ onReady });
    rerender(view({ onReady, umlState: expanded }));
    rerender(view({ onReady, layoutKey: 2 }));
    expect(onReady.mock.calls.filter(([h]) => h !== null)).toHaveLength(1);
    unmount();
    expect(onReady).toHaveBeenLastCalledWith(null);
  });

  it('places subclasses that join later on the side away from the root', () => {
    const { rerender } = renderLaidOut({ layoutDirection: 'RIGHT' });
    const parent = pos(PARENT);
    rerender(view({ layoutDirection: 'RIGHT', umlState: expanded, expandedClassIds: [PARENT] }));
    expect(fakeCy.stats.layouts).toBe(1);
    [CHILD_1, CHILD_2].forEach((id) => expect(pos(id).x).toBeLessThan(parent.x));
  });
});
