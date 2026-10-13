import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import GraphView from '../src/GraphView';
import type { UmlGraphState } from '../src/types/uml';
import { makeFakeCy } from './helpers/fakeCytoscape';

let fakeCy: ReturnType<typeof makeFakeCy>;

// Controllable requestAnimationFrame: GraphView coalesces viewport syncs into
// one frame, so the tests queue the callbacks and flush them explicitly.
let rafQueue: FrameRequestCallback[] = [];
const flushRaf = () => {
  const queued = rafQueue;
  rafQueue = [];
  queued.forEach((cb) => cb(0));
};

vi.mock('cytoscape', () => ({ __esModule: true, default: vi.fn(() => fakeCy) }));
vi.mock('cytoscape-elk', () => ({ __esModule: true, default: vi.fn() }));
vi.mock('elkjs/lib/elk.bundled.js', () => ({ __esModule: true, default: vi.fn() }));

const CLASS_A = 'pkg.custom_schema.Alpha';
const CLASS_B = 'pkg.custom_schema.Beta';

const umlState: UmlGraphState = {
  package: 'pkg.custom_schema',
  root: '',
  classes: [
    { id: CLASS_A, name: 'Alpha', module: 'pkg.custom_schema', quantities: [] },
    { id: CLASS_B, name: 'Beta', module: 'pkg.custom_schema', quantities: [] },
  ],
  edges: [{ source: CLASS_A, target: CLASS_B, type: 'inherits' }],
};

function renderGraph() {
  return render(
    <GraphView
      nodes={[
        { id: CLASS_A, kind: 'section', label: 'Alpha' },
        { id: CLASS_B, kind: 'section', label: 'Beta' },
      ]}
      edges={[]}
      umlState={umlState}
      editableMode
      onCreateQuantity={vi.fn().mockResolvedValue(undefined)}
      onCreateClass={vi.fn().mockResolvedValue(undefined)}
    />
  );
}

describe('GraphView overlay geometry vs. viewport synchronization', () => {
  beforeEach(() => {
    rafQueue = [];
    fakeCy = makeFakeCy();
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => rafQueue.push(cb));
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('measures initial geometry and renders overlay cards', () => {
    renderGraph();
    expect(new Set(fakeCy.stats.boundingBoxCalls)).toEqual(new Set([CLASS_A, CLASS_B]));
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
  });

  it('does not re-measure nodes on pan, zoom or render, but keeps the overlay transform aligned', () => {
    const { container } = renderGraph();
    const wrapper = container.querySelector('div[style*="translate"]') as HTMLElement;
    expect(wrapper).toBeTruthy();

    fakeCy.stats.boundingBoxCalls.length = 0;

    fakeCy.__pan = { x: 30, y: 40 };
    act(() => {
      fakeCy.emit('pan');
      flushRaf();
    });
    expect(fakeCy.stats.boundingBoxCalls).toEqual([]);
    expect(wrapper.style.transform).toContain('translate(30px, 40px)');

    fakeCy.__zoom = 2;
    act(() => {
      fakeCy.emit('zoom');
      flushRaf();
    });
    expect(fakeCy.stats.boundingBoxCalls).toEqual([]);
    expect(wrapper.style.transform).toContain('scale(2)');

    act(() => {
      fakeCy.emit('render');
      flushRaf();
    });
    expect(fakeCy.stats.boundingBoxCalls).toEqual([]);
  });

  it('coalesces multiple pan/zoom events in a frame into a single viewport sync', () => {
    const { container } = renderGraph();
    const wrapper = container.querySelector('div[style*="translate"]') as HTMLElement;

    rafQueue = [];
    fakeCy.__pan = { x: 12, y: 8 };
    fakeCy.__zoom = 1.5;

    act(() => {
      fakeCy.emit('pan');
      fakeCy.emit('zoom');
      fakeCy.emit('pan');
    });

    // One scheduled callback for three events, and no transform update yet.
    expect(rafQueue).toHaveLength(1);
    expect(wrapper.style.transform).not.toContain('translate(12px, 8px)');

    act(() => flushRaf());
    expect(wrapper.style.transform).toContain('translate(12px, 8px)');
    expect(wrapper.style.transform).toContain('scale(1.5)');
  });

  it('re-measures all nodes when the layout finishes', () => {
    renderGraph();
    fakeCy.stats.boundingBoxCalls.length = 0;

    act(() => fakeCy.emit('layoutstop'));

    expect(new Set(fakeCy.stats.boundingBoxCalls)).toEqual(new Set([CLASS_A, CLASS_B]));
  });

  it('rebuilds the card-box map without crashing when node ids change but the count does not', () => {
    renderGraph();
    fakeCy.stats.boundingBoxCalls.length = 0;

    // Same node count, entirely different ids (e.g. switching packages).
    fakeCy.__setNodes(['pkg.other.Gamma', 'pkg.other.Delta']);

    expect(() => act(() => fakeCy.emit('layoutstop'))).not.toThrow();
    expect(new Set(fakeCy.stats.boundingBoxCalls)).toEqual(
      new Set(['pkg.other.Gamma', 'pkg.other.Delta'])
    );
  });

  it('measures only the dragged node while dragging, not every node', () => {
    renderGraph();
    fakeCy.stats.boundingBoxCalls.length = 0;

    const card = screen.getByText('Alpha').closest('.uml-card') as HTMLElement;
    expect(card).toBeTruthy();

    fireEvent.mouseDown(card, { button: 0, clientX: 0, clientY: 0 });
    act(() => {
      fireEvent.mouseMove(window, { clientX: 25, clientY: 15 });
      fireEvent.mouseMove(window, { clientX: 60, clientY: 45 });
    });
    fireEvent.mouseUp(window);

    expect(fakeCy.stats.boundingBoxCalls.length).toBeGreaterThan(0);
    expect(new Set(fakeCy.stats.boundingBoxCalls)).toEqual(new Set([CLASS_A]));
  });

  it('keeps connector lines following the dragged card (edges are driven by cardBoxes)', () => {
    const { container } = renderGraph();
    const line = () => container.querySelector('.uml-edit-edges line') as SVGLineElement;
    expect(line()).toBeTruthy();
    const before = line().getAttribute('x1');

    const card = screen.getByText('Alpha').closest('.uml-card') as HTMLElement;
    fireEvent.mouseDown(card, { button: 0, clientX: 0, clientY: 0 });
    act(() => {
      fireEvent.mouseMove(window, { clientX: 140, clientY: 90 });
    });
    fireEvent.mouseUp(window);

    expect(line().getAttribute('x1')).not.toEqual(before);
  });
});

describe('GraphView card contents', () => {
  beforeEach(() => {
    fakeCy = makeFakeCy();
    vi.stubGlobal('requestAnimationFrame', () => 0);
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows only declared quantities on a card and leaves inherited ones to the docs panel', () => {
    const onSelectClass = vi.fn();
    const withQuantities: UmlGraphState = {
      ...umlState,
      classes: [
        {
          id: CLASS_A,
          name: 'Alpha',
          module: 'pkg.custom_schema',
          quantities: [
            { id: `${CLASS_A}.own_value`, name: 'own_value', ownerId: CLASS_A },
            {
              id: `${CLASS_A}::inherited::${CLASS_B}.base_value`,
              name: 'base_value',
              ownerId: CLASS_A,
              inherited: true,
              inheritedFromId: CLASS_B,
              inheritedFromName: 'Beta',
            },
          ],
        },
        {
          id: CLASS_B,
          name: 'Beta',
          module: 'pkg.custom_schema',
          quantities: [{ id: `${CLASS_B}.base_value`, name: 'base_value', ownerId: CLASS_B }],
        },
      ],
    };
    render(
      <GraphView
        nodes={[]}
        edges={[]}
        umlState={withQuantities}
        editableMode
        onSelectClass={onSelectClass}
        onCreateQuantity={vi.fn().mockResolvedValue(undefined)}
        onCreateClass={vi.fn().mockResolvedValue(undefined)}
      />
    );

    // Edit-mode overlay card.
    const alphaCard = screen.getByText('Alpha').closest('.uml-card') as HTMLElement;
    expect(alphaCard.textContent).toContain('own_value');
    expect(alphaCard.textContent).not.toContain('base_value');

    // Cytoscape label of the card.
    const alphaLabel = String(fakeCy.getElementById(CLASS_A).data('label') ?? '');
    expect(alphaLabel).toContain('own_value');
    expect(alphaLabel).not.toContain('base_value');

    // The docs panel still receives the inherited quantity.
    fireEvent.click(alphaCard);
    const selected = onSelectClass.mock.calls.at(-1)?.[0];
    expect(selected?.quantities.map((q: { name: string }) => q.name)).toEqual(['own_value', 'base_value']);
  });
});

describe('GraphView subclass toggle', () => {
  beforeEach(() => {
    fakeCy = makeFakeCy();
    vi.stubGlobal('requestAnimationFrame', () => 0);
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const withSubclasses: UmlGraphState = {
    ...umlState,
    classes: [
      { id: CLASS_A, name: 'Alpha', module: 'pkg.custom_schema', quantities: [], subclasses: 0 },
      { id: CLASS_B, name: 'Beta', module: 'pkg.custom_schema', quantities: [], subclasses: 3 },
    ],
  };

  it.each([false, true])('shows a + only on classes with subclasses (edit mode: %s) and reports clicks', (editableMode) => {
    const onToggleSubclasses = vi.fn();
    render(
      <GraphView
        nodes={[]}
        edges={[]}
        umlState={withSubclasses}
        editableMode={editableMode}
        onToggleSubclasses={onToggleSubclasses}
        onCreateQuantity={vi.fn().mockResolvedValue(undefined)}
        onCreateClass={vi.fn().mockResolvedValue(undefined)}
      />
    );
    expect(screen.queryByRole('button', { name: 'Show subclasses of Alpha' })).toBeNull();
    const toggle = screen.getByRole('button', { name: 'Show subclasses of Beta' });
    expect(toggle.textContent).toBe('+');
    expect(toggle.getAttribute('title')).toBe('Show 3 subclasses');
    fireEvent.click(toggle);
    expect(onToggleSubclasses).toHaveBeenCalledWith(CLASS_B);
  });

  it('shows a − on an expanded class and no toggle while inheritance is hidden', () => {
    const props = {
      nodes: [], edges: [], umlState: withSubclasses, expandedClassIds: [CLASS_B], onToggleSubclasses: vi.fn(),
    };
    const { unmount } = render(<GraphView {...props} />);
    const toggle = screen.getByRole('button', { name: 'Hide subclasses of Beta' });
    expect(toggle.textContent).toBe('−');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    unmount();

    render(<GraphView {...props} showInheritance={false} />);
    expect(screen.queryByRole('button', { name: /subclasses of Beta/ })).toBeNull();
  });
});

