vi.mock('../src/components/StaticSitePanel', () => ({
  default: ({ onEditsChanged, onBackupRestored }: { onEditsChanged: () => void; onBackupRestored: () => void }) => (
    <div data-testid="static-site-panel">
      <button onClick={onEditsChanged}>Simulate additive import</button>
      <button onClick={onBackupRestored}>Simulate backup restore</button>
    </div>
  ),
}));
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import { createEditStore, EDITS_STORAGE_KEY, getBrowserEditStore } from '../src/static/editStore';
import { writePreference } from '../src/utils/browserStorage';
import { useWorkspaceStore } from '../src/store/workspace';
import { AUDIT_STORAGE_KEY } from '../src/utils/storageKeys';

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
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });
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

  it('lists applied edits without a History entry as older saved edits', async () => {
    mockGet.mockImplementation(commonGet(graphWithApplied));
    mockPut.mockResolvedValue({ data: { workspace: { branch: 'develop', package: 'pkg.custom_schema', base_namespace: 'pkg' } } });

    render(<App />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: /\+ Start from empty canvas/i }));

    await user.click(screen.getByRole('button', { name: 'Show edit history' }));
    expect(await screen.findByText('Older saved edit: add attribute user_defined on AtomsState')).toBeInTheDocument();
    expect(screen.getByText('1 older saved edit')).toBeInTheDocument();
    expect(screen.queryByText(/No edits on this canvas yet/i)).not.toBeInTheDocument();
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
    window.localStorage.setItem(AUDIT_STORAGE_KEY, JSON.stringify(storedAudit));

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
    window.localStorage.setItem(AUDIT_STORAGE_KEY, JSON.stringify(storedAudit));
    mockGet.mockImplementation(commonGet(graphWithApplied));
    mockPut.mockResolvedValue({ data: { workspace: { branch: 'develop', package: 'pkg.custom_schema', base_namespace: 'pkg' } } });
    render(<App />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /\+ Start from empty canvas/i }));
    await user.click(screen.getByRole('button', { name: 'Show edit history' }));
    await screen.findByRole('button', { name: 'Simulate backup restore' });
    expect(JSON.parse(window.localStorage.getItem(AUDIT_STORAGE_KEY)!).map((entry: { id: string }) => entry.id)).toEqual(['local-0', 'local-1']);
    const previousRequests = mockGet.mock.calls.filter(([url]) => url === '/schema').length;
    // The panel calls back after the store replaced the log, which always starts a new generation.
    if (operation === 'restore') await getBrowserEditStore().restoreLog({ format: 'schema-studio-edits', version: 1, edits: [] });
    await user.click(screen.getByRole('button', { name: operation === 'restore' ? 'Simulate backup restore' : 'Simulate additive import' }));
    await waitFor(() => expect(mockGet.mock.calls.filter(([url]) => url === '/schema').length).toBeGreaterThan(previousRequests));
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem(AUDIT_STORAGE_KEY)!).length).toBe(operation === 'restore' ? 0 : 2));
    if (operation === 'restore') {
      expect(screen.queryByText(/Old change in/)).not.toBeInTheDocument();
      // The edit still applied to the graph stays visible without its History entry.
      expect(screen.getAllByTestId('older-saved-edit')).toHaveLength(1);
      // Clearing the persisted history also prevents stale references after reopening.
      cleanup();
      render(<App />);
      await screen.findByRole('button', { name: 'Show edit history' });
      expect(JSON.parse(window.localStorage.getItem(AUDIT_STORAGE_KEY)!)).toEqual([]);
    }
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it.each([undefined, 'legacy'])('discards stale history after a failed restore and edit-only retry (history generation: %s)', async editGeneration => {
    const storage = window.localStorage;
    const store = createEditStore(storage);
    const edit = { id: 1, profile: 'p', package: 'pkg.custom_schema', commit: null, op: 'add_class', target: '', payload: { name: 'A' }, created_at: null };
    await store.transaction(tx => tx.add([edit]));
    const oldHistory = [{
      id: 'undo-A', timestamp: new Date().toISOString(), description: 'Undo class A',
      package: 'pkg.custom_schema', replayable: true, editIds: ['1'], editGeneration,
      change: { type: 'add-class', cls: { id: classId, name: 'AtomsState', module: 'pkg.custom_schema', quantities: [] } },
    }];
    const oldHistoryJson = JSON.stringify(oldHistory);
    storage.setItem(AUDIT_STORAGE_KEY, oldHistoryJson);
    const setItem = storage.setItem.bind(storage);
    const writes = vi.spyOn(storage, 'setItem').mockImplementation(() => { throw new DOMException('Full', 'QuotaExceededError'); });
    await store.restoreLog({ format: 'schema-studio-edits', version: 1, edits: [{ ...edit, payload: { name: 'B' } }] });
    writePreference(AUDIT_STORAGE_KEY, '[]');
    expect(storage.getItem(AUDIT_STORAGE_KEY)).toBe(oldHistoryJson);
    // Only edit persistence recovers. Audit persistence continues to fail, even on reload.
    writes.mockImplementation((key, value) => {
      if (key === AUDIT_STORAGE_KEY) throw new DOMException('Full', 'QuotaExceededError');
      setItem(key, value);
    });
    expect(await store.retrySave()).toBe(true);
    expect(JSON.parse(storage.getItem(EDITS_STORAGE_KEY)!).edits[0].payload.name).toBe('B');
    expect(storage.getItem(AUDIT_STORAGE_KEY)).toBe(oldHistoryJson);
    mockGet.mockImplementation(commonGet(graphWithApplied));
    mockPut.mockResolvedValue({ data: { workspace: { branch: 'develop', package: 'pkg.custom_schema', base_namespace: 'pkg' } } });
    for (let reload = 0; reload < 2; reload++) {
      render(<App />);
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: /\+ Start from empty canvas/i }));
      await user.click(screen.getByRole('button', { name: 'Show edit history' }));
      // The stale History entry is dropped; the applied edit is still listed on its own.
      expect(screen.queryByText('Undo class A')).not.toBeInTheDocument();
      expect(await screen.findAllByTestId('older-saved-edit')).toHaveLength(1);
      expect(storage.getItem(AUDIT_STORAGE_KEY)).toBe(oldHistoryJson);
      cleanup();
    }
    expect(mockDelete).not.toHaveBeenCalled();
    writes.mockImplementation(setItem);
  });

  const openHistory = async () => {
    render(<App />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /\+ Start from empty canvas/i }));
    await user.click(screen.getByRole('button', { name: 'Show edit history' }));
    return user;
  };
  const workspaceAnswer = { data: { workspace: { branch: 'develop', package: 'pkg.custom_schema', base_namespace: 'pkg' } } };
  const addX = { id: '1', op: 'add_attribute', target: classId, payload: { name: 'x', kind: 'quantity', dtype: 'float' }, package: 'pkg.custom_schema' };
  const renameX = { id: '2', op: 'rename_attribute', target: classId, payload: { attribute: 'x', new_name: 'y' }, package: 'pkg.custom_schema' };

  it('undoes an older saved edit by its id alone, never by package', async () => {
    let current: object = { ...graphWithoutApplied, applied_edits: [addX] };
    mockGet.mockImplementation(async (url: string, options?: { params?: Record<string, unknown> }) => commonGet(current)(url, options));
    mockPut.mockResolvedValue(workspaceAnswer);
    mockDelete.mockImplementation(async () => { current = graphWithoutApplied; return { data: { deleted: 1 } }; });
    const user = await openHistory();

    const row = await screen.findByTestId('older-saved-edit');
    expect(row).toHaveTextContent('Older saved edit: add attribute x on AtomsState');
    await user.click(within(row).getByRole('button', { name: 'Undo' }));

    expect(mockDelete).toHaveBeenCalledOnce();
    expect(mockDelete).toHaveBeenCalledWith('/schema/edits', { params: { package: undefined }, data: { ids: ['1'] } });
    await waitFor(() => expect(screen.queryByTestId('older-saved-edit')).not.toBeInTheDocument());
    expect(screen.getByText(/No edits on this canvas yet/i)).toBeInTheDocument();
  });

  it('lists an applied edit without an id, explains it cannot be undone and points to Discard all', async () => {
    const withoutId = { ...addX, id: undefined };
    mockGet.mockImplementation(commonGet({ ...graphWithoutApplied, applied_edits: [withoutId] }));
    mockPut.mockResolvedValue(workspaceAnswer);
    await openHistory();

    const row = await screen.findByTestId('older-saved-edit');
    expect(row).toHaveTextContent('Older saved edit: add attribute x on AtomsState');
    expect(within(row).queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
    expect(row).toHaveTextContent(/cannot be undone on its own/);
    expect(row).toHaveTextContent(/Discard all saved edits/);
  });

  it('shows a later edit that depended on an undone one as a conflict instead of dropping it', async () => {
    // Graph answers as the core gives them: once "add x" is deleted, replaying "rename x"
    // fails and comes back as an edit conflict (see api/sources/tests/test_edits.py).
    let current: object = { ...graphWithoutApplied, applied_edits: [addX, renameX] };
    mockGet.mockImplementation(async (url: string, options?: { params?: Record<string, unknown> }) => commonGet(current)(url, options));
    mockPut.mockResolvedValue(workspaceAnswer);
    mockDelete.mockImplementation(async () => {
      current = {
        ...graphWithoutApplied,
        edit_conflicts: [{ edit: renameX, reason: 'not_found', detail: "AtomsState has no attribute 'x'", applied: false }],
      };
      return { data: { deleted: 1 } };
    });
    const user = await openHistory();

    const rows = await screen.findAllByTestId('older-saved-edit');
    expect(rows.map(row => row.textContent)).toEqual([
      expect.stringContaining('rename attribute x to y on AtomsState'),
      expect.stringContaining('add attribute x on AtomsState'),
    ]);
    await user.click(within(rows[1]).getByRole('button', { name: 'Undo' }));
    expect(mockDelete).toHaveBeenCalledWith('/schema/edits', { params: { package: undefined }, data: { ids: ['1'] } });

    // The rename no longer applies, so it is no longer an older saved edit, but it is still shown.
    await waitFor(() => expect(screen.queryByTestId('older-saved-edit')).not.toBeInTheDocument());
    const conflicts = screen.getByText(/stored edit\(s\) could not be applied/).closest('[role="status"]')!;
    expect(conflicts).toHaveTextContent('1 stored edit(s) could not be applied');
    expect(conflicts).toHaveTextContent("rename_attribute AtomsState: AtomsState has no attribute 'x' (not_found)");
  });

  it('a restore in another tab neither hides the restored edit nor keeps counting stale History', async () => {
    // This tab's History: edit 1 of package X, in the log it was mounted with.
    const store = getBrowserEditStore();
    const stale = [{
      id: 'local-x', timestamp: new Date().toISOString(), description: 'Added class in X', package: 'other.module',
      replayable: true, editIds: ['1'], editGeneration: store.getGeneration(),
      change: { type: 'add-class', cls: { id: 'other.module.X', name: 'X', module: 'other.module', quantities: [] } },
    }];
    window.localStorage.setItem(AUDIT_STORAGE_KEY, JSON.stringify(stale));
    let current: object = graphWithoutApplied;
    mockGet.mockImplementation(async (url: string, options?: { params?: Record<string, unknown> }) => commonGet(current)(url, options));
    mockPut.mockResolvedValue({ data: { workspace: { branch: 'develop', package: 'pkg.custom_schema', base_namespace: 'pkg' } } });
    const user = await openHistory();
    expect(JSON.parse(window.localStorage.getItem(AUDIT_STORAGE_KEY)!).map((entry: { id: string }) => entry.id)).toEqual(['local-x']);

    // Another tab restores a backup in which id 1 is an attribute of this package.
    const restoredEdit = { id: 1, profile: 'p', package: 'pkg.custom_schema', commit: null, op: 'add_attribute', target: classId, payload: { name: 'restored_attr', kind: 'quantity', dtype: 'float' }, created_at: null };
    await createEditStore(window.localStorage).restoreLog({ format: 'schema-studio-edits', version: 1, edits: [restoredEdit] });
    const generation = store.getGeneration();
    current = { ...graphWithApplied, applied_edits: [{ ...restoredEdit, id: '1' }], edit_generation: generation };
    await user.click(screen.getByRole('button', { name: 'Simulate additive import' }));

    const row = await screen.findByTestId('older-saved-edit');
    expect(row).toHaveTextContent('Older saved edit: add attribute restored_attr on AtomsState');
    expect(screen.queryByText(/No edits on this canvas yet/i)).not.toBeInTheDocument();
    // The stale entry is retired, so it no longer counts anywhere.
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem(AUDIT_STORAGE_KEY)!)).toEqual([]));
  });

  it('says where an applied edit is listed when its History entry belongs to another package', async () => {
    const generation = getBrowserEditStore().getGeneration();
    window.localStorage.setItem(AUDIT_STORAGE_KEY, JSON.stringify([{
      id: 'in-a', timestamp: new Date().toISOString(), description: 'Added quantity in A', package: 'other.module',
      replayable: true, editIds: ['1'], editGeneration: generation,
      change: { type: 'add-class', cls: { id: 'other.module.X', name: 'X', module: 'other.module', quantities: [] } },
    }]));
    mockGet.mockImplementation(commonGet({ ...graphWithApplied, edit_generation: generation }));
    mockPut.mockResolvedValue({ data: { workspace: { branch: 'develop', package: 'pkg.custom_schema', base_namespace: 'pkg' } } });
    await openHistory();
    expect(await screen.findByText('1 applied edit is listed in the History of other.module')).toBeInTheDocument();
    expect(screen.queryByText(/No edits on this canvas yet/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId('older-saved-edit')).not.toBeInTheDocument();
  });
});
