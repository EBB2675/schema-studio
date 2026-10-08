import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The sidebar is the same in both modes: a title, the appearance toggle and the
// schema families, without status chips. Dev Mode adds only what needs its server.
const mode = vi.hoisted(() => ({ static: false }));
const mockGet = vi.fn();

vi.mock('../src/constants/defaults', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/constants/defaults')>()),
  get STATIC_MODE() {
    return mode.static;
  },
}));

vi.mock('axios', () => {
  const create = () => ({
    defaults: {},
    get: mockGet,
    post: vi.fn(async () => ({ data: {} })),
    put: vi.fn(async () => ({ data: { workspace: { branch: 'main', package: 'pkg.a', base_namespace: 'pkg' } } })),
    delete: vi.fn(),
    interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
  });
  return { default: Object.assign(create, { create, post: vi.fn(), isAxiosError: () => false }) };
});

vi.mock('../src/GraphView', () => ({ __esModule: true, default: () => <div>graph</div> }));
vi.mock('../src/components/StaticSitePanel', () => ({ __esModule: true, default: () => <div>static panel</div> }));

const profile = {
  key: 'family-a', label: 'Family A', default_branch: 'main', default_package: 'pkg.a', default_base_namespace: 'pkg',
  default_root: 'Root', available: true, current: true, version: 'abc1234def', capabilities: [],
};

async function renderApp(staticMode: boolean) {
  mode.static = staticMode;
  vi.resetModules();
  const { default: App } = await import('../src/App');
  return render(<App />);
}

describe('sidebar layout', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem('schema-uml-token', 't0k');
    window.localStorage.setItem('schema-uml-username', 'user');
    mockGet.mockReset();
    mockGet.mockImplementation(async (url: string) => {
      if (url === '/workspace') {
        return { data: { workspace: { branch: 'main', package: 'pkg.a', base_namespace: 'pkg' }, user: { username: 'tester' } } };
      }
      if (url === '/schema/profiles') return { data: { profiles: mode.static ? [profile] : [], current_profile: 'family-a' } };
      if (url === '/git/branches') return { data: { branches: ['main', 'develop'] } };
      if (url === '/git/packages') return { data: { packages: ['pkg.a'] } };
      if (url === '/roots') return { data: { sections: ['Root'] } };
      return { data: {} };
    });
  });

  afterEach(() => cleanup());

  it.each([
    ['the static site', true],
    ['Dev Mode', false],
  ])('shows no status chips on %s', async (_name, staticMode) => {
    const { container } = await renderApp(staticMode);
    await screen.findByText('Explore and shape materials science schemas.');
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/git/packages', expect.anything()));
    const brand = container.querySelector('.brand-card');
    expect(brand?.querySelectorAll('.tag')).toHaveLength(0);
    for (const text of [/^Ready$/, /Single-user/, /^Schema [0-9a-f]/, /^Profile:/, /^Selected:/, /Light Mode/i]) {
      expect(screen.queryByText(text)).toBeNull();
    }
    expect(screen.queryByRole('button', { name: /Update schema|Bundled schema/ })).toBeNull();
  });

  it('lists the site profiles on the static site, without server controls', async () => {
    await renderApp(true);
    expect(await screen.findByRole('button', { name: 'Family A', hidden: true })).toBeInTheDocument();
    expect(screen.queryByText('Choose from branch')).toBeNull();
    expect(screen.queryByText('Compare branches')).toBeNull();
    expect(screen.queryByText('Signed in')).toBeNull();
  });

  it('adds sign-in, branches and compare in Dev Mode', async () => {
    await renderApp(false);
    expect(await screen.findByText('Signed in')).toBeInTheDocument();
    expect(screen.getByText('Choose from branch')).toBeInTheDocument();
    expect(screen.getAllByText('Compare branches').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'nomad-simulations', hidden: true })).toBeInTheDocument();
  });
});
