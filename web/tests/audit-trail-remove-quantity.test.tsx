import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

vi.mock('axios', () => {
  const create = () => ({
    get: mockGet,
    post: mockPost,
    put: mockPut,
    delete: mockDelete,
    interceptors: { request: { use: vi.fn() } },
  });
  const axios = Object.assign(create, { create, post: vi.fn() });
  return { default: axios };
});

// Minimal GraphView stub to avoid cytoscape in tests.
vi.mock('../src/GraphView', () => ({
  __esModule: true,
  default: () => <div>GraphView</div>,
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
  window.localStorage.setItem('schema-uml-token', 'tok');
  window.localStorage.setItem('schema-uml-username', 'tester');
};

describe('Audit trail — remove quantity stays active', () => {
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

  it('keeps a remove-quantity entry active (not archived) when baseline still contains the quantity', async () => {
    // Seed local audit with a removal that should remain active.
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
    mockPut.mockResolvedValue({ data: { workspace: { branch: 'develop', package: 'pkg.custom_schema', base_namespace: 'pkg' } } });

    render(<App />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: /\+ Start from empty canvas/i }));

    const removalEntry = await screen.findByText((_, node) => node?.textContent === 'Removed quantity atomic_number from AtomsState');
    expect(removalEntry).not.toHaveTextContent(/archived/i);
    const undoButtons = screen.getAllByTitle('Undo this change');
    expect(undoButtons.some((btn) => !btn.hasAttribute('disabled'))).toBe(true);
  });
});
