import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
      edit_type: 'quantity',
      class_name: 'AtomsState',
      quantity_name: 'user_defined',
      dtype: 'float',
      package: 'pkg.custom_schema',
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

// Minimal GraphView stub; avoids cytoscape in tests.
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

describe('Audit trail seeding from applied edits', () => {
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

  it('shows applied edits as archived and reports 0 active edits', async () => {
    mockGet.mockImplementation(commonGet(graphWithApplied));
    mockPut.mockResolvedValue({ data: { workspace: { branch: 'develop', package: 'pkg.custom_schema', base_namespace: 'pkg' } } });

    render(<App />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: /\+ Start from empty canvas/i }));

    await waitFor(() => expect(screen.queryAllByText(/0 active edits/i).length).toBeGreaterThan(0));
    const persisted = screen.getAllByText((_, node) => node?.textContent?.includes('Persisted quantity user_defined on AtomsState') ?? false);
    expect(persisted[0]).toHaveTextContent(/archived/i);
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
});
