import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import { useWorkspaceStore } from '../src/store/workspace';

const classId = 'pkg.custom_schema.Class';
const otherId = 'pkg.custom_schema.Other';
const subA = 'pkg.custom_schema.SubA';
const subB = 'pkg.custom_schema.SubB';
const section = (id: string, subclasses = 0) => ({ id, kind: 'section', label: id.split('.').pop(), subclasses });
const graph = {
  package: 'pkg.custom_schema',
  root: '',
  nodes: [section(classId, 2)],
  edges: [],
};
// The graph with Class and Other shown, then with Class's and Other's subclasses.
const twoRoots = { ...graph, nodes: [section(classId, 1), section(otherId, 1)] };
const withA = {
  ...twoRoots,
  nodes: [...twoRoots.nodes, section(subA)],
  edges: [{ source: subA, target: classId, type: 'inherits' }],
};
const withAB = {
  ...withA,
  nodes: [...withA.nodes, section(subB)],
  edges: [...withA.edges, { source: subB, target: otherId, type: 'inherits' }],
};

// /schema answers wait in this queue while `held` is set, so a test decides their order.
let held = false;
let schemaGraph: unknown = graph;
const queue: Array<{ params: Record<string, unknown>; answer: (data: unknown) => void }> = [];

const mockGet = vi.fn();
const mockPost = vi.fn();
const mockPut = vi.fn();

vi.mock('axios', () => {
  const create = () => ({
    get: mockGet,
    post: mockPost,
    put: mockPut,
    delete: vi.fn(),
    interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
  });
  return { default: Object.assign(create, { create, post: vi.fn() }) };
});

// What the canvas was given on each render.
const { renders } = vi.hoisted(() => ({
  renders: [] as Array<{ nodes: string[]; classes: string[]; layoutKey: unknown }>,
}));

// GraphView reduced to the subclass toggles and what it is given.
vi.mock('../src/GraphView', () => ({
  __esModule: true,
  default: ({ nodes, umlState, layoutKey, expandedClassIds, onToggleSubclasses }: {
    nodes: { id: string; kind: string }[];
    umlState?: { classes: { id: string }[] } | null;
    layoutKey?: unknown;
    expandedClassIds?: string[];
    onToggleSubclasses?: (id: string) => Promise<void> | void;
  }) => {
    const classes = (umlState?.classes ?? []).map((c) => c.id);
    renders.push({ nodes: nodes.filter((n) => n.kind === 'section').map((n) => n.id), classes, layoutKey });
    return (
      <div>
        <button type="button" onClick={() => void onToggleSubclasses?.(classId)}>Toggle subclasses</button>
        <button type="button" onClick={() => void onToggleSubclasses?.(otherId)}>Toggle other</button>
        <div data-testid="expanded">{(expandedClassIds ?? []).join(',')}</div>
        <div data-testid="classes">{classes.join(',')}</div>
      </div>
    );
  },
}));

const schemaCalls = () =>
  mockGet.mock.calls.filter(([url]) => url === '/schema').map(([, options]) => options?.params ?? {});

describe('App subclass toggle', () => {
  afterEach(cleanup);

  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
    mockPut.mockReset();
    mockPut.mockResolvedValue({ data: { workspace: { branch: 'main', package: 'pkg', base_namespace: 'pkg' } } });
    useWorkspaceStore.getState().setPkg('pkg');
    useWorkspaceStore.getState().setBaseNamespace('pkg');
    useWorkspaceStore.getState().setStartEmpty(true);
    window.localStorage.removeItem('schema-uml-audit');
    window.localStorage.setItem('schema-uml-token', 't0k');
    window.localStorage.setItem('schema-uml-username', 'user');
    held = false;
    schemaGraph = graph;
    queue.length = 0;
    renders.length = 0;
    mockGet.mockImplementation(async (url: string, options?: { params?: Record<string, unknown> }) => {
      if (url === '/workspace') {
        return { data: { workspace: { branch: 'main', package: 'pkg', base_namespace: 'pkg' }, user: { username: 'tester' } } };
      }
      if (url === '/schema') {
        if (!held) return { data: schemaGraph };
        return new Promise((resolve) => {
          queue.push({ params: options?.params ?? {}, answer: (data) => resolve({ data }) });
        });
      }
      if (url === '/git/branches') return { data: { branches: ['main'] } };
      if (url === '/git/packages') return { data: { packages: ['pkg'] } };
      if (url === '/roots') return { data: { sections: [] } };
      return { data: {} };
    });
  });

  it('asks for the graph with the class expanded, and without it on the second click', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: /\+ Start from empty canvas/i }));
    const toggle = await screen.findByRole('button', { name: 'Toggle subclasses' });
    expect(schemaCalls().at(-1)?.expand).toBeUndefined();

    await user.click(toggle);
    await waitFor(() => expect(screen.getByTestId('expanded').textContent).toBe(classId));
    expect(schemaCalls().at(-1)).toMatchObject({ expand: classId, package: 'pkg.custom_schema' });

    await user.click(toggle);
    await waitFor(() => expect(screen.getByTestId('expanded').textContent).toBe(''));
    expect(schemaCalls().at(-1)?.expand).toBeUndefined();
  });

  const startWithTwoClasses = async () => {
    schemaGraph = twoRoots;
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: /\+ Start from empty canvas/i }));
    await waitFor(() => expect(screen.getByTestId('classes').textContent).toBe(`${classId},${otherId}`));
    held = true;
    return user;
  };

  // Every render hands the canvas nodes and cards of one and the same graph.
  const expectConsistentRenders = () => {
    renders.forEach(({ nodes, classes }) => expect([...classes].sort()).toEqual([...nodes].sort()));
  };

  it('shows only the latest of two quick toggles, which builds on the first', async () => {
    const user = await startWithTwoClasses();
    const layoutKey = renders.at(-1)?.layoutKey;

    await user.click(screen.getByRole('button', { name: 'Toggle subclasses' }));
    await user.click(screen.getByRole('button', { name: 'Toggle other' }));
    expect(queue.map((q) => q.params.expand)).toEqual([classId, `${classId},${otherId}`]);

    // The second answer comes first; the first one, arriving late, is dropped.
    queue[1].answer(withAB);
    await waitFor(() => expect(screen.getByTestId('classes').textContent).toBe(`${classId},${otherId},${subA},${subB}`));
    queue[0].answer(withA);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByTestId('classes').textContent).toBe(`${classId},${otherId},${subA},${subB}`);
    expect(screen.getByTestId('expanded').textContent).toBe(`${classId},${otherId}`);

    // Expanding is not a new graph: the canvas keeps its layout.
    expect(new Set(renders.slice(renders.findIndex((r) => r.layoutKey === layoutKey)).map((r) => r.layoutKey))).toEqual(new Set([layoutKey]));
    expectConsistentRenders();
  });

  it('drops a toggle answer that arrives after another graph was loaded', async () => {
    const user = await startWithTwoClasses();
    const layoutKey = renders.at(-1)?.layoutKey;

    await user.click(screen.getByRole('button', { name: 'Toggle subclasses' }));
    await user.click(screen.getByRole('button', { name: 'Reset canvas' }));
    await waitFor(() => expect(queue).toHaveLength(2));
    expect(queue[1].params.expand).toBeUndefined();

    queue[1].answer(graph);
    await waitFor(() => expect(screen.getByTestId('classes').textContent).toBe(classId));
    queue[0].answer(withA);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByTestId('classes').textContent).toBe(classId);
    expect(screen.getByTestId('expanded').textContent).toBe('');
    // The new graph is laid out afresh.
    expect(renders.at(-1)?.layoutKey).not.toBe(layoutKey);
    expectConsistentRenders();
  });
});
