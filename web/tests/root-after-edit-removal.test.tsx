vi.mock('../src/components/StaticSitePanel', () => ({
  default: ({ onAllEditsDiscarded }: { onAllEditsDiscarded: () => void }) => (
    <button type="button" onClick={onAllEditsDiscarded}>Simulate discard all</button>
  ),
}));
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import { getBrowserEditStore } from '../src/static/editStore';
import { useWorkspaceStore } from '../src/store/workspace';

// After saved edits are removed, the open root may no longer exist (its rename or its
// creation was undone). The canvas must show the remaining schema, not a failed load.
const SIM = 'nomad_simulations.schema_packages';
const PKG = `${SIM}.model_method`;

// What the browser backend holds: the package's roots and the edits applied to them.
let sections: string[] = [];
let applied: Record<string, unknown>[] = [];

const mockGet = vi.fn();
const mockPut = vi.fn();
const mockDelete = vi.fn();

vi.mock('../src/client', () => {
  const create = () => ({
    get: mockGet,
    post: vi.fn(async () => ({ data: {} })),
    put: mockPut,
    delete: mockDelete,
    interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
  });
  return { createApiClient: create, apiFetch: vi.fn(async () => new Response('[]')) };
});

vi.mock('../src/FlowGraphView', () => ({
  __esModule: true,
  default: () => <div>graph view</div>,
}));

vi.mock('../src/components/OverviewGrid', () => ({
  __esModule: true,
  default: ({ onClassSelect }: { onClassSelect?: (pkg: string, cls: string) => void }) => (
    <div>
      {sections.map(name => (
        <button key={name} type="button" onClick={() => onClassSelect?.(PKG, name)}>Open {name}</button>
      ))}
    </div>
  ),
}));

const profile = {
  key: 'nomad-simulations', label: 'nomad-simulations', default_branch: 'main', default_package: PKG,
  default_base_namespace: SIM, default_root: 'ModelMethod', available: true, current: true, linkml_export: true, capabilities: [],
};

const schemaRequests = () => mockGet.mock.calls.filter(([url]) => url === '/schema').map(([, config]) => config.params.root);

beforeEach(() => {
  mockGet.mockReset();
  mockPut.mockReset();
  mockDelete.mockReset();
  window.localStorage.clear();
  mockPut.mockImplementation(async (_url: string, body: Record<string, unknown>) => ({
    data: { workspace: { branch: 'main', package: body.package ?? PKG, base_namespace: body.base_namespace ?? SIM } },
  }));
  mockGet.mockImplementation(async (url: string, config?: { params?: Record<string, unknown> }) => {
    if (url === '/workspace') return { data: { workspace: { branch: 'main', package: PKG, base_namespace: SIM }, user: { username: 'tester' } } };
    if (url === '/schema/profiles') return { data: { profiles: [profile], current_profile: profile.key } };
    if (url === '/roots') return { data: { sections } };
    if (url === '/schema') {
      const root = String(config?.params?.root ?? '');
      // As the core does: a root the edited schema does not have is an error.
      if (root && !sections.includes(root)) throw { response: { status: 400, data: { detail: `no root ${root}` } } };
      return {
        data: {
          package: PKG, root, nodes: [{ id: `${PKG}.${root}`, kind: 'section', label: root }], edges: [],
          applied_edits: applied, edit_generation: getBrowserEditStore().getGeneration(),
        },
      };
    }
    return { data: {} };
  });
  useWorkspaceStore.getState().setPkg(PKG);
  useWorkspaceStore.getState().setBaseNamespace(SIM);
  useWorkspaceStore.getState().setStartEmpty(false);
});
afterEach(cleanup);

const openRoot = async (name: string) => {
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole('button', { name: /^nomad-simulations/ }));
  await user.click(await screen.findByRole('button', { name: `Open ${name}` }));
  expect(await screen.findByText('graph view')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Show edit history' }));
  return user;
};

const expectCanvasAt = async (root: string) => {
  await waitFor(() => expect(schemaRequests().at(-1)).toBe(root));
  expect(screen.getByText('graph view')).toBeInTheDocument();
  expect(screen.queryByText(/no root/)).not.toBeInTheDocument();
};

const rename = { id: '1', op: 'rename_class', target: `${PKG}.ModelMethod`, payload: { new_name: 'RenamedForReview' }, package: PKG };
const added = { id: '1', op: 'add_class', target: '', payload: { name: 'AddedClass' }, package: PKG };

describe('the open root after saved edits are removed', () => {
  it.each(['Discard all', 'Undo'])('follows a removed rename of the open root back (%s)', async action => {
    sections = ['RenamedForReview', 'Other'];
    applied = [rename];
    const user = await openRoot('RenamedForReview');
    const removeRename = () => { sections = ['ModelMethod', 'Other']; applied = []; };
    const requestsBefore = schemaRequests().length;
    if (action === 'Undo') {
      mockDelete.mockImplementation(async () => { removeRename(); return { data: { deleted: 1 } }; });
      await user.click(within(await screen.findByTestId('older-saved-edit')).getByRole('button', { name: 'Undo' }));
    } else {
      removeRename();
      await user.click(screen.getByRole('button', { name: 'Simulate discard all' }));
    }
    await expectCanvasAt('ModelMethod');
    expect(schemaRequests().slice(requestsBefore)).not.toContain('RenamedForReview');
  });

  it('opens the package\'s first root when the open root was an added class', async () => {
    sections = ['AddedClass', 'ModelMethod'];
    applied = [added];
    const user = await openRoot('AddedClass');
    mockDelete.mockImplementation(async () => { sections = ['ModelMethod']; applied = []; return { data: { deleted: 1 } }; });
    const requestsBefore = schemaRequests().length;
    await user.click(within(await screen.findByTestId('older-saved-edit')).getByRole('button', { name: 'Undo' }));
    await expectCanvasAt('ModelMethod');
    expect(schemaRequests().slice(requestsBefore)).not.toContain('AddedClass');
  });

  it('keeps the open root when it still exists', async () => {
    sections = ['ModelMethod', 'Other'];
    applied = [{ ...added, payload: { name: 'Other' } }];
    const user = await openRoot('ModelMethod');
    mockDelete.mockImplementation(async () => { sections = ['ModelMethod']; applied = []; return { data: { deleted: 1 } }; });
    await user.click(within(await screen.findByTestId('older-saved-edit')).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(mockDelete).toHaveBeenCalled());
    await expectCanvasAt('ModelMethod');
  });
});
