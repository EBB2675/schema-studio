vi.mock('../src/components/StaticSitePanel', () => ({
  default: ({ onEditsChanged, onBackupRestored }: { onEditsChanged: () => void; onBackupRestored: () => void }) => (
    <div data-testid="static-site-panel">
      <button onClick={onEditsChanged}>Simulate additive import</button>
      <button onClick={onBackupRestored}>Simulate backup restore</button>
    </div>
  ),
}));
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import { useWorkspaceStore } from '../src/store/workspace';

const classId = 'pkg.custom_schema.AtomsState';

const graphWithApplied = {
  package: 'pkg.custom_schema',
  root: '',
  nodes: [
    { id: classId, kind: 'section', label: 'AtomsState' },
    { id: `${classId}.user_defined`, kind: 'quantity', label: 'user_defined', owner: classId },
  ],
  edges: [{ source: classId, target: `${classId}.user_defined`, type: 'hasQuantity' }],
  applied_edits: [
    {
      id: '1',
      op: 'add_attribute',
      target: classId,
      payload: { name: 'user_defined', kind: 'quantity', dtype: 'float' },
      package: 'pkg.custom_schema',
      profile: 'nomad-simulations',
      commit: 'c0ffee',
    },
  ],
};

const graphWithoutApplied = {
  package: 'pkg.custom_schema',
  root: '',
  nodes: [{ id: classId, kind: 'section', label: 'AtomsState' }],
  edges: [],
};

const mockGet = vi.fn();
const mockPost = vi.fn();
const mockPut = vi.fn();
const mockDelete = vi.fn();

vi.mock('../src/client', () => {
  const create = () => ({
    get: mockGet,
    post: mockPost,
    put: mockPut,
    delete: mockDelete,
    interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
  });
  return { createApiClient: create, apiFetch: vi.fn(async () => new Response("[]")) };
});

// Minimal FlowGraphView stub; isolates the canvas in tests.
vi.mock('../src/FlowGraphView', () => ({
  __esModule: true,
  default: () => <div>FlowGraphView</div>,
}));

const commonGet = (graphPayload: object) => async (url: string, options?: { params?: Record<string, unknown> }) => {
  if (url === '/workspace') {
    return { data: { workspace: { branch: 'develop', package: 'pkg.custom_schema', base_namespace: 'pkg' }, user: { username: 'tester' } } };
  }
  if (url === '/schema') {
    if (options?.params?.empty) return { data: graphPayload };
    return { data: graphPayload };
  }
  if (url === '/git/branches') return { data: { branches: ['develop'] } };
  if (url === '/git/packages') return { data: { packages: ['pkg.custom_schema'] } };
  if (url === '/roots') return { data: { sections: ['AtomsState'] } };
  return { data: {} };
};

const primeWorkspace = () => {
  useWorkspaceStore.getState().setPkg('pkg.custom_schema');
  useWorkspaceStore.getState().setBaseNamespace('pkg');
  useWorkspaceStore.getState().setStartEmpty(false);
};

describe('Audit trail seeding from applied edits', () => {
  afterEach(cleanup);
  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
    mockPut.mockReset();
    mockDelete.mockReset();
    window.localStorage.clear();
    primeWorkspace();

    if (!('ResizeObserver' in window)) {
      // @ts-expect-error happy-dom lacks ResizeObserver
      window.ResizeObserver = class {
        observe() {}
        disconnect() {}
      };
    }
  });

  it('hides server-applied edits from the audit trail', async () => {
    mockGet.mockImplementation(commonGet(graphWithApplied));
    mockPut.mockResolvedValue({ data: { workspace: { branch: 'develop', package: 'pkg.custom_schema', base_namespace: 'pkg' } } });

    render(<App />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: /\+ Start from empty canvas/i }));

    await waitFor(() =>
      expect(screen.queryByText(/No edits on this canvas yet/i)).toBeInTheDocument()
    );
    expect(
      screen.queryByText((_, node) =>
        node?.textContent?.includes('Persisted quantity user_defined on AtomsState') ?? false
      )
    ).not.toBeInTheDocument();
  });

  it('archives preexisting local audit entries when server sends no applied edits', async () => {
    const storedAudit = [
      {
        id: 'local-1',
        timestamp: new Date().toISOString(),
        description: 'Old local change',
        package: 'pkg.custom_schema',
        replayable: true,
        change: {
          type: 'add-class',
          cls: { id: classId, name: 'AtomsState', doc: null, module: 'pkg.custom_schema', path: null, line: null, quantities: [], parentId: null, parentRelation: null },
        },
      },
    ];
    window.localStorage.setItem('schema-uml-audit', JSON.stringify(storedAudit));

    mockGet.mockImplementation(commonGet(graphWithoutApplied));
    mockPut.mockResolvedValue({ data: { workspace: { branch: 'develop', package: 'pkg.custom_schema', base_namespace: 'pkg' } } });

    render(<App />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /\+ Start from empty canvas/i }));

    await waitFor(() => expect(screen.queryAllByText(/0 active edits/i).length).toBeGreaterThan(0));
    const archivedLocal = screen.getAllByText((_, node) => node?.textContent?.includes('Old local change') ?? false);
    expect(archivedLocal[0]).toHaveTextContent(/archived/i);
  });
  it.each(['restore', 'import'])('%s refreshes the graph and only replacement clears history across all schemas', async operation => {
    const storedAudit = ['pkg.custom_schema', 'other.schema'].map((pkg, index) => ({
      id: `local-${index}`,
      timestamp: new Date().toISOString(),
      description: `Old change in ${pkg}`,
      package: pkg,
      replayable: true,
      editIds: [String(index + 1)],
      change: {
        type: 'add-class',
        cls: { id: classId, name: 'AtomsState', doc: null, module: pkg, path: null, line: null, quantities: [], parentId: null, parentRelation: null },
      },
    }));
    window.localStorage.setItem('schema-uml-audit', JSON.stringify(storedAudit));
    mockGet.mockImplementation(commonGet(graphWithApplied));
    mockPut.mockResolvedValue({ data: { workspace: { branch: 'develop', package: 'pkg.custom_schema', base_namespace: 'pkg' } } });
    render(<App />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /\+ Start from empty canvas/i }));
    await user.click(screen.getByRole('button', { name: 'Show edit history' }));
    await screen.findByRole('button', { name: 'Simulate backup restore' });
    expect(JSON.parse(window.localStorage.getItem('schema-uml-audit')!).map((entry: { id: string }) => entry.id)).toEqual(['local-0', 'local-1']);
    const previousRequests = mockGet.mock.calls.filter(([url]) => url === '/schema').length;
    await user.click(screen.getByRole('button', { name: operation === 'restore' ? 'Simulate backup restore' : 'Simulate additive import' }));
    await waitFor(() => expect(mockGet.mock.calls.filter(([url]) => url === '/schema').length).toBeGreaterThan(previousRequests));
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem('schema-uml-audit')!).length).toBe(operation === 'restore' ? 0 : 2));
    if (operation === 'restore') {
      expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
      // Clearing the persisted history also prevents stale references after reopening.
      cleanup();
      render(<App />);
      await screen.findByRole('button', { name: 'Show edit history' });
      expect(JSON.parse(window.localStorage.getItem('schema-uml-audit')!)).toEqual([]);
    }
    expect(mockDelete).not.toHaveBeenCalled();
  });

});
