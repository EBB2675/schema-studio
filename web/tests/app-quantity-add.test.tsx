vi.mock('../src/components/StaticSitePanel', () => ({ default: () => <div data-testid="static-site-panel" /> }));
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import { useWorkspaceStore } from '../src/store/workspace';
import { AUDIT_STORAGE_KEY } from '../src/utils/storageKeys';

const classId = 'pkg.custom_schema.Class';
const baseGraph = {
  package: 'pkg.custom_schema',
  root: '',
  nodes: [{ id: classId, kind: 'section', label: 'Class' }],
  edges: [],
};

const graphWithQuantity = {
  package: 'pkg.custom_schema',
  root: '',
  nodes: [
    { id: classId, kind: 'section', label: 'Class' },
    { id: `${classId}.new_qty`, kind: 'quantity', label: 'new_qty', owner: classId },
  ],
  edges: [{ source: `${classId}.new_qty`, target: classId, type: 'hasQuantity' }],
  persisted_edits: [
    {
      id: '7',
      op: 'add_attribute',
      target: classId,
      payload: { name: 'new_qty', kind: 'quantity', dtype: 'float' },
      package: 'pkg.custom_schema',
    },
  ],
  applied_edits: [
    {
      id: '7',
      op: 'add_attribute',
      target: classId,
      payload: { name: 'new_qty', kind: 'quantity', dtype: 'float' },
      package: 'pkg.custom_schema',
    },
  ],
};

// Stub axios to drive App's API interactions.
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

// Simplify FlowGraphView to expose a trigger for the add-quantity handler.
vi.mock('../src/FlowGraphView', () => {
  return {
    __esModule: true,
    default: ({ onCreateQuantity, onToggleSubclasses, nodes, selectedClassId, creatingQuantityFor, expandedClassIds }: {
      onCreateQuantity?: (classId: string, data: { quantityName: string; dtype: string; docstring: string }) => Promise<void> | void;
      onToggleSubclasses?: (id: string) => Promise<void> | void;
      nodes: { id: string }[];
      selectedClassId?: string | null;
      creatingQuantityFor?: string | null;
      expandedClassIds?: string[];
    }) => (
      <div>
        <div data-testid="expanded">{expandedClassIds?.join(",")}</div>
        <div data-testid="visible-nodes">{nodes.map(node => node.id).join(',')}</div>
        <div data-testid="selected-class">{selectedClassId}</div>
        <div data-testid="quantity-progress">{creatingQuantityFor}</div>
        <button onClick={() => void onToggleSubclasses?.(classId)}>Toggle subclasses</button>
        <button
          type="button"
          onClick={() => {
            Promise.resolve(
              onCreateQuantity?.(classId, {
                quantityName: 'new_qty',
                dtype: 'float',
                docstring: 'desc',
              })
            ).catch(() => {});
          }}
        >
          Trigger quantity add
        </button>
        <button
          type="button"
          onClick={() => {
            Promise.resolve(
              onCreateQuantity?.(classId, {
                quantityName: 'bad_qty',
                dtype: 'int',
                docstring: '',
              })
            ).catch(() => {});
          }}
        >
          Trigger quantity add failure
        </button>
      </div>
    ),
  };
});

describe('App editable quantity add flow', () => {
  afterEach(cleanup);

  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
    mockPut.mockReset();
    mockDelete.mockReset();
    mockPut.mockImplementation(async (_url, updates) => ({
      data: {
        workspace: { branch: 'main', package: 'pkg', base_namespace: 'pkg', ...updates },
      },
    }));

    // Ensure deterministic workspace + scratch package.
    useWorkspaceStore.getState().setBranch('main');
    useWorkspaceStore.getState().setPkg('pkg');
    useWorkspaceStore.getState().setBaseNamespace('pkg');
    useWorkspaceStore.getState().setStartEmpty(true);

    // No audit trail from earlier tests.
    window.localStorage.removeItem(AUDIT_STORAGE_KEY);

    if (!('ResizeObserver' in window)) {
      // minimal stub for layout observer
      // @ts-expect-error - happy-dom lacks ResizeObserver
      window.ResizeObserver = class {
        observe() {}
        disconnect() {}
      };
    }

    mockGet.mockImplementation(async (url: string, options?: { params?: Record<string, unknown> }) => {
      if (url === '/workspace') {
        return {
          data: {
            workspace: { branch: 'main', package: 'pkg', base_namespace: 'pkg' },
            user: { username: 'tester' },
          },
        };
      }
      if (url === '/schema') {
        if (options?.params?.empty) {
          return { data: baseGraph };
        }
        return { data: baseGraph };
      }
      if (url === '/git/branches') {
        return { data: { branches: ['main'] } };
      }
      if (url === '/git/packages') {
        return { data: { packages: ['pkg'] } };
      }
      if (url === '/roots') {
        return { data: { sections: [] } };
      }
      return { data: {} };
    });

    // First edit call succeeds, second fails.
    mockPost
      .mockImplementationOnce(async (url: string) => {
        if (url === '/schema/edits') {
          return { data: graphWithQuantity };
        }
        return { data: {} };
      })
      .mockImplementationOnce(async (url: string) => {
        if (url === '/schema/edits') {
          throw { response: { data: { detail: 'boom fail' } } };
        }
        return { data: {} };
      });
  });

  it('submits quantity add requests and surfaces API errors', async () => {
    const user = userEvent.setup();

    render(<App />);

    // Build an empty canvas graph.
    await user.click(await screen.findByRole('button', { name: /\+ Start from empty canvas/i }));
    await waitFor(() => expect(screen.getByTestId('visible-nodes')).toHaveTextContent(classId));

    // Editing is available without a mode switch.
    expect(screen.queryByRole('button', { name: /^UML$/i })).not.toBeInTheDocument();

    // First call succeeds.
    await user.click(await screen.findByRole('button', { name: /^Trigger quantity add$/i }));

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith(
        '/schema/edits',
        {
          package: 'pkg.custom_schema',
          edits: [
            {
              op: 'add_attribute',
              target: classId,
              payload: { name: 'new_qty', kind: 'quantity', dtype: 'float', description: 'desc' },
            },
          ],
        },
        expect.any(Object)
      )
    );

    // New quantity should show up in the doc panel selection.
    expect(await screen.findByText('new_qty')).toBeInTheDocument();

    // Next call rejects; error should bubble into the doc panel.
    await user.click(screen.getByRole('button', { name: /Trigger quantity add failure/i }));

    expect(await screen.findByText(/boom fail/i)).toBeInTheDocument();
  });

  const addOneQuantity = async (user: ReturnType<typeof userEvent.setup>) => {
    render(<App />);
    await user.click(await screen.findByRole('button', { name: /\+ Start from empty canvas/i }));
    await waitFor(() => expect(screen.getByTestId('visible-nodes')).toHaveTextContent(classId));
    expect(screen.queryByRole('button', { name: /^UML$/i })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: /^Trigger quantity add$/i }));
    // The audit trail starts closed; open it to reach its undo and clear buttons.
    await user.click(screen.getByRole('button', { name: 'Show edit history' }));
  };

  it('undo deletes the stored edits of a change in one request', async () => {
    const user = userEvent.setup();
    mockDelete.mockResolvedValue({ data: { deleted: 1 } });
    await addOneQuantity(user);

    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() =>
      expect(mockDelete).toHaveBeenCalledWith('/schema/edits', { params: { package: undefined }, data: { ids: ['7'] } })
    );
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument());
  });

  it.each([false, true])('concurrent Undo keeps both completed removals (reverse completion: %s)', async reverse => {
    const user = userEvent.setup();
    await addOneQuantity(user);
    mockPost.mockReset();
    const secondGraph = JSON.parse(JSON.stringify(graphWithQuantity).replaceAll('new_qty', 'bad_qty').replaceAll('"7"', '"8"'));
    mockPost.mockResolvedValue({ data: secondGraph });
    await user.click(screen.getByRole('button', { name: /Trigger quantity add failure/i }));
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Undo' })).toHaveLength(2));

    const complete: (() => void)[] = [];
    mockDelete.mockImplementation(() => new Promise(resolve => {
      complete.push(() => resolve({ data: { deleted: 1 } }));
    }));
    const buttons = screen.getAllByRole('button', { name: 'Undo' });
    await user.click(buttons[0]);
    await user.click(buttons[1]);
    expect(mockDelete).toHaveBeenCalledTimes(2);
    expect(mockDelete.mock.calls.map(call => call[1].data.ids)).toEqual([['8'], ['7']]);
    if (reverse) complete.reverse();
    await act(async () => complete[0]());
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Undo' })).toHaveLength(1));
    await act(async () => complete[1]());
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument());
    expect(JSON.parse(window.localStorage.getItem(AUDIT_STORAGE_KEY) || '[]')).toEqual([]);
  });

  it('a failed undo keeps the change so it can be tried again', async () => {
    const user = userEvent.setup();
    mockDelete.mockRejectedValue({ response: { data: { detail: 'offline' } } });
    await addOneQuantity(user);

    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    expect(await screen.findByText(/Undo failed: offline/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
  });

  it('clear deletes this module\'s edits and the edits its entries made', async () => {
    const user = userEvent.setup();
    mockDelete.mockResolvedValue({ data: { deleted: 1 } });
    await addOneQuantity(user);
    await screen.findByRole('button', { name: 'Undo' });

    await user.click(screen.getByLabelText('History actions'));
    await user.click(screen.getByRole('button', { name: /^Clear$/ }));
    await waitFor(() =>
      expect(mockDelete).toHaveBeenCalledWith('/schema/edits', {
        params: { package: 'pkg.custom_schema' },
        data: { ids: ['7'] },
      })
    );
  });
  it('records a completed save without reopening the canvas after Home', async () => {
    let finish!: (value: unknown) => void;
    mockPost.mockReset().mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: /Start from empty canvas/ }));
    await waitFor(() => expect(screen.getByTestId('visible-nodes')).toHaveTextContent(classId));
    await user.click(await screen.findByRole('button', { name: 'Trigger quantity add' }));
    await user.click(screen.getByRole('button', { name: 'Back to home' }));
    await act(async () => finish({ data: graphWithQuantity }));
    expect(screen.queryByRole('button', { name: 'Trigger quantity add' })).not.toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem(AUDIT_STORAGE_KEY) ?? '[]')).toEqual(
      expect.arrayContaining([expect.objectContaining({ editIds: ['7'] })])
    );
  });

  it.each([['Toggle subclasses', true, false], ['Toggle subclasses', false, false], ['Build graph', true, false], ['Build graph', false, false], ['Build graph', true, true], ['Build graph', false, true]] as const)('reconciles a save overlapping %s (read first: %s, imported: %s)', async (refreshButton, readFirst, imported) => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: /Start from empty canvas/ }));
    await waitFor(() => expect(screen.getByTestId('visible-nodes')).toHaveTextContent(classId));
    if (imported) {
      const input = document.querySelector<HTMLInputElement>('input[type="file"][accept="application/json"]')!;
      fireEvent.change(input, { target: { files: [new File([JSON.stringify(baseGraph)], 'graph.json', { type: 'application/json' })] } });
      await screen.findByText('Imported graph.json');
    }
    let save!: (value: unknown) => void;
    mockPost.mockReset().mockImplementation(() => new Promise(resolve => { save = resolve; }));
    const reads: Array<(value: unknown) => void> = [];
    const originalGet = mockGet.getMockImplementation()!;
    mockGet.mockImplementation((url, options) => url === '/schema'
      ? new Promise(resolve => reads.push(resolve)) : originalGet(url, options));
    await user.click(screen.getByRole('button', { name: 'Trigger quantity add' }));
    await user.click(screen.getByRole('button', { name: refreshButton }));
    if (readFirst) await act(async () => reads[0]({ data: baseGraph }));
    await act(async () => { save({ data: graphWithQuantity }); });
    expect(reads).toHaveLength(2);
    const calls = mockGet.mock.calls.filter(([url]) => url === '/schema');
    expect(calls.at(-1)?.[1]?.params.expand).toBe(refreshButton === 'Toggle subclasses' ? classId : undefined);
    await act(async () => reads[1]({ data: graphWithQuantity }));
    if (!readFirst) await act(async () => reads[0]({ data: baseGraph }));
    expect(screen.getByTestId('visible-nodes')).toHaveTextContent(`${classId}.new_qty`);
  });

  it.each([true, false])('old edit completion leaves a newer canvas operation alone (success: %s)', async success => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: /Start from empty canvas/ }));
    await waitFor(() => expect(screen.getByTestId('visible-nodes')).toHaveTextContent(classId));
    const saves: Array<{ resolve: (value: unknown) => void; reject: (error: unknown) => void }> = [];
    mockPost.mockReset().mockImplementation(() => new Promise((resolve, reject) => saves.push({ resolve, reject })));
    await user.click(screen.getByRole('button', { name: 'Trigger quantity add' }));
    await user.click(screen.getByRole('button', { name: 'Back to home' }));
    await user.click(screen.getByRole('button', { name: /Start from empty canvas/ }));
    await waitFor(() => expect(screen.getByTestId('visible-nodes')).toHaveTextContent(classId));
    await user.click(screen.getByRole('button', { name: 'Trigger quantity add' }));
    await act(async () => success ? saves[0].resolve({ data: graphWithQuantity }) : saves[0].reject(new Error('old error')));
    expect(screen.getByTestId('quantity-progress')).toHaveTextContent(classId);
    expect(screen.getByTestId('selected-class')).toBeEmptyDOMElement();
    expect(screen.queryByText('old error')).not.toBeInTheDocument();
    await act(async () => saves[1].resolve({ data: graphWithQuantity }));
    expect(screen.getByTestId('quantity-progress')).toBeEmptyDOMElement();
  });

  it('a delayed reset preserves audit entries added after it started', async () => {
    const user = userEvent.setup();
    await addOneQuantity(user);
    let finish!: () => void;
    mockDelete.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    await user.click(screen.getByRole('button', { name: 'Reset canvas' }));
    await user.click(screen.getByRole('button', { name: 'Back to home' }));
    await user.click(screen.getByRole('button', { name: /Start from empty canvas/ }));
    await waitFor(() => expect(screen.getByTestId('visible-nodes')).toHaveTextContent(classId));
    mockPost.mockReset().mockResolvedValue({ data: { ...graphWithQuantity, persisted_edits: [{ ...graphWithQuantity.persisted_edits[0], id: '8' }] } });
    await user.click(screen.getByRole('button', { name: 'Trigger quantity add' }));
    await act(async () => finish());
    const audit = JSON.parse(window.localStorage.getItem(AUDIT_STORAGE_KEY) ?? '[]');
    expect(audit).toEqual(expect.arrayContaining([expect.objectContaining({ editIds: ['8'], replayable: true })]));
  });

  it.each(['undo', 'clear'])('reconciles %s after an overlapping subclass read', async action => {
    const user = userEvent.setup();
    await addOneQuantity(user);
    let remove!: () => void;
    mockDelete.mockImplementation(() => new Promise<void>(resolve => { remove = resolve; }));
    const reads: Array<(value: unknown) => void> = [];
    const originalGet = mockGet.getMockImplementation()!;
    mockGet.mockImplementation((url, options) => url === '/schema'
      ? new Promise(resolve => reads.push(resolve)) : originalGet(url, options));
    if (action === 'undo') await user.click(screen.getByRole('button', { name: 'Undo' }));
    else {
      await user.click(screen.getByLabelText('History actions'));
      await user.click(screen.getByRole('button', { name: /^Clear$/ }));
    }
    await user.click(screen.getByRole('button', { name: 'Toggle subclasses' }));
    await act(async () => remove());
    expect(reads).toHaveLength(2);
    await act(async () => reads[1]({ data: baseGraph }));
    await act(async () => reads[0]({ data: graphWithQuantity }));
    expect(screen.getByTestId('visible-nodes')).not.toHaveTextContent(`${classId}.new_qty`);
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });

  it.each([true, false])('a rejected save preserves a pending expansion (read finishes first: %s)', async readFirst => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: /Start from empty canvas/ }));
    await waitFor(() => expect(screen.getByTestId('visible-nodes')).toHaveTextContent(classId));
    const reads: Array<(value: unknown) => void> = [];
    const originalGet = mockGet.getMockImplementation()!;
    mockGet.mockImplementation((url, options) => url === '/schema'
      ? new Promise(resolve => reads.push(resolve)) : originalGet(url, options));
    let rejectSave!: (error: unknown) => void;
    mockPost.mockReset().mockImplementation(() => new Promise((_resolve, reject) => { rejectSave = reject; }));
    await user.click(screen.getByRole('button', { name: 'Toggle subclasses' }));
    await user.click(screen.getByRole('button', { name: 'Trigger quantity add' }));
    if (readFirst) await act(async () => reads[0]({ data: baseGraph }));
    await act(async () => rejectSave(new Error('save rejected')));
    if (!readFirst) await act(async () => reads[0]({ data: baseGraph }));
    expect(screen.getByTestId('expanded')).toHaveTextContent(classId);
    await user.click(screen.getByRole('button', { name: 'Toggle subclasses' }));
    const calls = mockGet.mock.calls.filter(([url]) => url === '/schema');
    expect(calls.at(-1)?.[1]?.params.expand).toBeUndefined();
    await act(async () => reads[1]({ data: baseGraph }));
    expect(screen.getByTestId('expanded')).toBeEmptyDOMElement();
  });

  it.each([true, false])('reset waits until a pending save settles (success: %s)', async success => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: /Start from empty canvas/ }));
    await waitFor(() => expect(screen.getByTestId('visible-nodes')).toHaveTextContent(classId));
    let resolveSave!: (value: unknown) => void;
    let rejectSave!: (error: unknown) => void;
    mockPost.mockReset().mockImplementation(() => new Promise((resolve, reject) => { resolveSave = resolve; rejectSave = reject; }));
    await user.click(screen.getByRole('button', { name: 'Trigger quantity add' }));
    const reset = screen.getByRole('button', { name: 'Reset canvas' });
    expect(reset).toBeDisabled();
    await user.click(reset);
    expect(mockDelete).not.toHaveBeenCalled();
    await act(async () => success ? resolveSave({ data: graphWithQuantity }) : rejectSave(new Error('save rejected')));
    expect(reset).toBeEnabled();
    mockDelete.mockResolvedValue({ data: { deleted: success ? 1 : 0 } });
    await user.click(reset);
    await screen.findByText('Canvas reset to empty.');
    const audit = JSON.parse(window.localStorage.getItem(AUDIT_STORAGE_KEY) ?? '[]');
    expect(audit.filter((entry: { replayable: boolean }) => entry.replayable)).toEqual([]);
    if (success) expect(audit).toEqual(expect.arrayContaining([expect.objectContaining({ editIds: ['7'], replayable: false })]));
  });

  it('reset stays disabled until every pending save settles', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: /Start from empty canvas/ }));
    await waitFor(() => expect(screen.getByTestId('visible-nodes')).toHaveTextContent(classId));
    const saves: Array<(value: unknown) => void> = [];
    mockPost.mockReset().mockImplementation(() => new Promise(resolve => saves.push(resolve)));
    await user.click(screen.getByRole('button', { name: 'Trigger quantity add' }));
    await user.click(screen.getByRole('button', { name: 'Trigger quantity add' }));
    await act(async () => saves[0]({ data: graphWithQuantity }));
    expect(screen.getByRole('button', { name: 'Reset canvas' })).toBeDisabled();
    await act(async () => saves[1]({ data: graphWithQuantity }));
    expect(screen.getByRole('button', { name: 'Reset canvas' })).toBeEnabled();
  });

  it.each([true, false])('history Clear waits for a pending save (success: %s)', async success => {
    const user = userEvent.setup();
    await addOneQuantity(user);
    let resolveSave!: (value: unknown) => void;
    let rejectSave!: (error: unknown) => void;
    mockPost.mockReset().mockImplementation(() => new Promise((resolve, reject) => { resolveSave = resolve; rejectSave = reject; }));
    await user.click(screen.getByRole('button', { name: 'Trigger quantity add failure' }));
    await user.click(screen.getByLabelText('History actions'));
    const clear = screen.getByRole('button', { name: /^Clear$/ });
    expect(clear).toBeDisabled();
    await user.click(clear);
    expect(mockDelete).not.toHaveBeenCalled();
    const secondGraph = JSON.parse(JSON.stringify(graphWithQuantity).replaceAll('new_qty', 'bad_qty').replaceAll('"7"', '"8"'));
    await act(async () => success ? resolveSave({ data: secondGraph }) : rejectSave(new Error('save rejected')));
    expect(clear).toBeEnabled();
    mockDelete.mockResolvedValue({ data: { deleted: success ? 2 : 1 } });
    await user.click(clear);
    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith('/schema/edits', {
      params: { package: 'pkg.custom_schema' }, data: { ids: success ? ['7', '8'] : ['7'] },
    }));
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem(AUDIT_STORAGE_KEY) ?? '[]')).toEqual([]));
  });

});
