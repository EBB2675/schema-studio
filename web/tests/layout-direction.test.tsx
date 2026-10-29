import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import GraphView from '../src/GraphView';
import type { UmlGraphState } from '../src/types/uml';
import {
  DEFAULT_LAYOUT_DIRECTION,
  initialLayoutDirection,
  LAYOUT_DIRECTIONS,
  type LayoutDirection,
} from '../src/utils/layoutDirection';
import { makeFakeCy, stubResizeObserver, type FakeCy } from './helpers/fakeCytoscape';

let fakeCy: FakeCy;

vi.mock('cytoscape', () => ({ __esModule: true, default: vi.fn(() => fakeCy) }));
vi.mock('cytoscape-elk', () => ({ __esModule: true, default: vi.fn() }));
vi.mock('elkjs/lib/elk.bundled.js', () => ({ __esModule: true, default: vi.fn() }));

const BASE = 'pkg.Base';
const SUB = 'pkg.Sub';
const state: UmlGraphState = {
  package: 'pkg',
  root: '',
  classes: [
    { id: BASE, name: 'Base', module: 'pkg', quantities: [] },
    { id: SUB, name: 'Sub', module: 'pkg', quantities: [] },
  ],
  edges: [{ source: SUB, target: BASE, type: 'inherits' }],
};

type ViewProps = Partial<React.ComponentProps<typeof GraphView>>;
const view = (props: ViewProps) => <GraphView nodes={[]} edges={[]} umlState={state} layoutKey={1} {...props} />;

const elkDirection = (index = fakeCy.stats.layoutOptions.length - 1) =>
  (fakeCy.stats.layoutOptions[index] as { elk: Record<string, unknown> }).elk['elk.direction'];

describe('initialLayoutDirection', () => {
  it('keeps a stored direction', () => {
    for (const { value } of LAYOUT_DIRECTIONS) expect(initialLayoutDirection(value)).toBe(value);
  });

  it('puts the root at the top when nothing valid is stored', () => {
    expect(DEFAULT_LAYOUT_DIRECTION).toBe('UP');
    for (const stored of [null, undefined, '', 'up', 'SIDEWAYS']) expect(initialLayoutDirection(stored)).toBe('UP');
  });
});

describe('GraphView layout direction', () => {
  beforeEach(() => {
    fakeCy = makeFakeCy();
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => cb(0));
    vi.stubGlobal('cancelAnimationFrame', () => {});
    vi.stubGlobal('ResizeObserver', stubResizeObserver().FakeResizeObserver);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('lays the canvas out with the root at the top by default', () => {
    render(view({}));
    expect(elkDirection()).toBe('UP');
  });

  it.each(LAYOUT_DIRECTIONS.map(({ value }) => value))('passes %s to ELK', (direction: LayoutDirection) => {
    render(view({ layoutDirection: direction }));
    expect(elkDirection()).toBe(direction);
  });

  it('lays out and fits again on a new direction, but leaves the selection alone', () => {
    const onLayoutReady = vi.fn();
    const { rerender } = render(view({ onLayoutReady }));
    act(() => fakeCy.finishLayout());
    expect(onLayoutReady).toHaveBeenCalledTimes(1);
    const fits = fakeCy.stats.fits;

    rerender(view({ onLayoutReady, layoutDirection: 'LEFT' }));
    expect(fakeCy.stats.layouts).toBe(2);
    expect(elkDirection()).toBe('LEFT');
    act(() => fakeCy.finishLayout());
    expect(fakeCy.stats.fits).toBeGreaterThan(fits);
    expect(onLayoutReady).toHaveBeenCalledTimes(1);

    rerender(view({ onLayoutReady, layoutDirection: 'LEFT' }));
    expect(fakeCy.stats.layouts).toBe(2);
  });

  it('keeps the selection when the direction changes again before the layout ends', () => {
    const onLayoutReady = vi.fn();
    const { rerender } = render(view({ onLayoutReady }));
    act(() => fakeCy.finishLayout());
    expect(onLayoutReady).toHaveBeenCalledTimes(1);

    rerender(view({ onLayoutReady, layoutDirection: 'LEFT' }));
    rerender(view({ onLayoutReady, layoutDirection: 'DOWN' }));
    expect(fakeCy.stats.layouts).toBe(3);
    expect(elkDirection()).toBe('DOWN');
    act(() => fakeCy.finishLayout());
    expect(onLayoutReady).toHaveBeenCalledTimes(1);
  });

  it('still reports a new graph whose layout a new direction replaced', () => {
    const onLayoutReady = vi.fn();
    const { rerender } = render(view({ onLayoutReady }));
    rerender(view({ onLayoutReady, layoutDirection: 'LEFT' }));
    act(() => fakeCy.finishLayout());
    expect(onLayoutReady).toHaveBeenCalledTimes(1);
  });
});
