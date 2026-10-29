import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import { useWorkspaceStore } from '../src/store/workspace';

// The Workspace panel offers one button per database; a button opens that
// database's bird's-eye view, and a class there opens its diagram.
const mockGet = vi.fn();
const mockPut = vi.fn();

vi.mock('axios', () => {
  const create = () => ({
    get: mockGet,
    post: vi.fn(async () => ({ data: {} })),
    put: mockPut,
    delete: vi.fn(),
    interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
  });
  return { default: Object.assign(create, { create, post: vi.fn() }) };
});

vi.mock('../src/GraphView', () => ({
  __esModule: true,
  default: () => <div>graph view</div>,
}));

vi.mock('../src/components/OverviewGrid', () => ({
  __esModule: true,
  default: ({ base, onClassSelect }: { base: string; onClassSelect?: (pkg: string, cls: string) => void }) => (
    <div>
      <div>overview of {base}</div>
      <button type="button" onClick={() => onClassSelect?.(`${base}.base_objects`, 'Entity')}>Entity</button>
    </div>
  ),
}));

const SIM = 'nomad_simulations.schema_packages';
const V1 = 'bam_masterdata.datamodel.v1';

const profile = (key: string, label: string, namespace: string, extra: Record<string, unknown> = {}) => ({
  key, label, default_branch: 'main', default_package: `${namespace}.base_objects`, default_base_namespace: namespace,
  default_root: 'Root', available: true, current: false, linkml_export: true, capabilities: [], ...extra,
});

const PROFILES = [
  profile('nomad-simulations', 'nomad-simulations', SIM, { current: true }),
  profile('bam-masterdata-v0', 'bam-masterdata v0', 'bam_masterdata.datamodel.v0'),
  profile('bam-masterdata-v1', 'bam-masterdata v1', V1),
];

// The server reports the profile of the stored workspace as the current one.
let storedNamespace = SIM;

const answer = (profiles: { key: string; default_base_namespace: string }[] | null) =>
  mockGet.mockImplementation(async (url: string, config?: { params?: Record<string, unknown> }) => {
    if (url === '/workspace') {
      return { data: { workspace: { branch: 'main', package: `${SIM}.model_method`, base_namespace: SIM }, user: { username: 'tester' } } };
    }
    if (url === '/schema/profiles') {
      if (!profiles) throw new Error('Not Found');
      const current = profiles.find((entry) => entry.default_base_namespace === storedNamespace)?.key;
      return { data: { profiles, current_profile: current } };
    }
    if (url === '/roots') return { data: { sections: ['Root', 'Entity'] } };
    if (url === '/schema') {
      return { data: { package: config?.params?.package, root: config?.params?.root, nodes: [], edges: [] } };
    }
    return { data: {} };
  });

// A button's name also holds the schema's state ("ready") where the server reports it.
const database = (label: string) => new RegExp(`^${label}`);

const openWorkspace = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(await screen.findByRole('button', { name: /Explore the data model/ }));
};

describe('Workspace databases', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPut.mockReset();
    storedNamespace = SIM;
    mockPut.mockImplementation(async (_url: string, body: Record<string, unknown>) => {
      if (typeof body.base_namespace === 'string') storedNamespace = body.base_namespace;
      return { data: { workspace: { branch: 'main', package: body.package, base_namespace: body.base_namespace } } };
    });
    useWorkspaceStore.getState().setPkg(`${SIM}.model_method`);
    useWorkspaceStore.getState().setBaseNamespace(SIM);
    useWorkspaceStore.getState().setStartEmpty(false);
    window.localStorage.setItem('schema-uml-token', 't0k');
    window.localStorage.setItem('schema-uml-username', 'user');
  });

  afterEach(() => cleanup());

  it('shows one button per database and no package or root dropdowns', async () => {
    answer(PROFILES);
    const user = userEvent.setup();
    render(<App />);
    await openWorkspace(user);
    const selected = await screen.findByRole('button', { name: database('nomad-simulations') });
    expect(selected.className).toBe('btn ');
    expect(screen.getByRole('button', { name: database('bam-masterdata v1') }).className).toBe('btn secondary');
    expect(screen.queryByText('Choose package')).toBeNull();
    expect(screen.queryByText('Root section')).toBeNull();
    expect(screen.queryByText('Custom package...')).toBeNull();
  });

  it('opens the bird\'s-eye view of the clicked database, and a class there opens its diagram', async () => {
    answer(PROFILES);
    const user = userEvent.setup();
    render(<App />);
    await openWorkspace(user);
    await user.click(await screen.findByRole('button', { name: database('bam-masterdata v1') }));
    expect(await screen.findByText(`overview of ${V1}`)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: database('bam-masterdata v1') }).className).toBe('btn ');
    expect(mockPut).toHaveBeenCalledWith('/workspace', expect.objectContaining({ base_namespace: V1 }));

    await user.click(screen.getByRole('button', { name: 'Entity' }));
    expect(await screen.findByText('graph view')).toBeInTheDocument();
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/schema', expect.objectContaining({
      params: expect.objectContaining({ package: `${V1}.base_objects`, root: 'Entity', base_namespace: V1 }),
    })));
  });

  it('disables a database that has no classes yet, with a note', async () => {
    answer([...PROFILES.slice(0, 2), { ...PROFILES[2], empty: true }]);
    const user = userEvent.setup();
    render(<App />);
    await openWorkspace(user);
    expect(await screen.findByRole('button', { name: database('bam-masterdata v1') })).toBeDisabled();
    expect(screen.getByRole('button', { name: database('bam-masterdata v0') })).toBeEnabled();
    expect(screen.getByText(/bam-masterdata v1: not released on the tracked branch yet/)).toBeInTheDocument();
  });

  it('offers the four databases when the server lists no profiles, as in Dev Mode', async () => {
    answer(null);
    const user = userEvent.setup();
    render(<App />);
    await openWorkspace(user);
    for (const label of ['nomad-simulations', 'nomad-measurements', 'bam-masterdata v0', 'bam-masterdata v1']) {
      expect(await screen.findByRole('button', { name: database(label) })).toBeEnabled();
    }
  });
});
