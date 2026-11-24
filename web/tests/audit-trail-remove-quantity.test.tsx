vi.mock('../src/components/StaticSitePanel', () => ({ default: () => <div data-testid="static-site-panel" /> }));
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import { useWorkspaceStore } from '../src/store/workspace';

const classId = 'pkg.custom_schema.AtomsState';
const qtyId = `${classId}.atomic_number`;

const graphWithQuantity = {
  package: 'pkg.custom_schema',
  root: '',
  nodes: [
    { id: classId, kind: 'section', label: 'AtomsState' },
    { id: qtyId, kind: 'quantity', label: 'atomic_number', owner: classId },
  ],
  edges: [{ source: classId, target: qtyId, type: 'hasQuantity' }],
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

// Minimal FlowGraphView stub to isolate the canvas in tests.
vi.mock('../src/FlowGraphView', () => ({
  __esModule: true,
  default: () => <div>FlowGraphView</div>,
}));

vi.mock('../src/components/DocPanel', () => ({
  default: ({ onRemoveQuantity }: { onRemoveQuantity: (id: string) => Promise<void> }) => (
    <button onClick={() => void onRemoveQuantity(qtyId)}>Remove test quantity</button>
  ),
}));

const commonGet = (graphPayload: object) => async (url: string, options?: { params?: Record<string, unknown> }) => {
  if (url === '/workspace') {
    return { data: { workspace: { branch: 'main', package: 'pkg', base_namespace: 'pkg' }, user: { username: 'tester' } } };
  }
  if (url === '/schema') {
    if (options?.params?.empty) return { data: graphPayload };
    return { data: graphPayload };
  }
  if (url === '/git/branches') return { data: { branches: ['main'] } };
  if (url === '/git/packages') return { data: { packages: ['pkg'] } };
  if (url === '/roots') return { data: { sections: ['AtomsState'] } };
  return { data: {} };
};

const primeWorkspace = () => {
  useWorkspaceStore.getState().setPkg('pkg');
  useWorkspaceStore.getState().setBaseNamespace('pkg');
  useWorkspaceStore.getState().setStartEmpty(true);
};

describe('Audit trail — archived quantity removals', () => {
  afterEach(cleanup);
  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
    mockPut.mockReset();
    mockPut.mockResolvedValue({ data: { workspace: { branch: "main", package: "pkg", base_namespace: "pkg" } } });
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

  it('keeps removal history archived when starting a new canvas', async () => {
    // Starting a new canvas intentionally archives the previous local history.
    const storedAudit = [
      {
        id: 'local-remove-1',
        timestamp: new Date().toISOString(),
        description: 'Removed quantity atomic_number from AtomsState',
        package: 'pkg.custom_schema',
        replayable: true,
        change: {
          type: 'remove-quantity',
          classId,
          quantity: {
            id: qtyId,
            name: 'atomic_number',
            dtype: 'int',
            shape: null,
            card: null,
            doc: null,
            path: null,
            line: null,
            ownerId: classId,
          },
        },
      },
    ];
    window.localStorage.setItem('schema-uml-audit', JSON.stringify(storedAudit));

    mockGet.mockImplementation(commonGet(graphWithQuantity));
    mockPut.mockResolvedValue({ data: { workspace: { branch: 'main', package: 'pkg', base_namespace: 'pkg' } } });

    render(<App />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: /\+ Start from empty canvas/i }));

    const saved = JSON.parse(window.localStorage.getItem('schema-uml-audit') ?? '[]');
    expect(saved[0].replayable).toBe(false);
    expect(screen.queryByTitle('Undo this change')).not.toBeInTheDocument();
  });
  it('keeps persisted removal history archived after reset and reload', async () => {
    mockGet.mockImplementation(commonGet(graphWithQuantity));
    const removal = { id: '7', op: 'remove_attribute', target: classId, payload: { attribute: 'atomic_number' }, package: 'pkg.custom_schema' };
    mockPost.mockResolvedValue({ data: {
      ...graphWithQuantity, nodes: graphWithQuantity.nodes.slice(0, 1), edges: [],
      persisted_edits: [removal], applied_edits: [removal],
    } });
    mockDelete.mockResolvedValue({ data: { deleted: 1 } });
    const user = userEvent.setup();
    const view = render(<App />);
    await user.click(await screen.findByRole('button', { name: /Start from empty canvas/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove test quantity', hidden: true }));
    const readAudit = () => JSON.parse(window.localStorage.getItem('schema-uml-audit') ?? '[]');
    await waitFor(() => expect(readAudit()).toEqual(expect.arrayContaining([
      expect.objectContaining({ editIds: ['7'], replayable: true, change: expect.objectContaining({ type: 'remove-quantity' }) }),
    ])));
    await user.click(screen.getByRole('button', { name: 'Reset canvas' }));
    await screen.findByText('Canvas reset to empty.');
    expect(readAudit()).toEqual(expect.arrayContaining([expect.objectContaining({ editIds: ['7'], replayable: false })]));
    view.unmount();
    render(<App />);
    await screen.findByRole('button', { name: /Start from empty canvas/ });
    expect(readAudit()).toEqual(expect.arrayContaining([expect.objectContaining({ editIds: ['7'], replayable: false })]));
    expect(screen.queryByTitle('Undo this change')).not.toBeInTheDocument();
  });

});
