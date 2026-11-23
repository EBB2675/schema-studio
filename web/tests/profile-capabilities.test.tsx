vi.mock('../src/components/StaticSitePanel', () => ({ default: () => <div data-testid="static-site-panel" /> }));
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import { useWorkspaceStore } from '../src/store/workspace';

// Profiles say what their source offers besides the schema: the under-the-hood
// panel needs "usage".
const mockGet = vi.fn();

vi.mock('../src/client', () => {
  const create = () => ({
    get: mockGet,
    post: vi.fn(async () => ({ data: {} })),
    put: vi.fn(async () => ({ data: { workspace: { branch: 'main', package: 'pkg', base_namespace: 'pkg' } } })),
    delete: vi.fn(),
    interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
  });
  return { createApiClient: create, apiFetch: vi.fn(async () => new Response("[]")) };
});

vi.mock('../src/FlowGraphView', () => ({
  __esModule: true,
  default: () => <div>graph view</div>,
}));

const profile = (key: string, capabilities: string[]) => ({
  key, label: key, default_branch: 'main', default_package: 'pkg', default_base_namespace: 'pkg', default_root: 'Root',
  available: true, current: true, linkml_export: true, capabilities,
});

const answer = (capabilities: string[]) =>
  mockGet.mockImplementation(async (url: string) => {
    if (url === '/workspace') {
      return { data: { workspace: { branch: 'main', package: 'pkg', base_namespace: 'pkg' }, user: { username: 'tester' } } };
    }
    if (url === '/schema/profiles') {
      return { data: { profiles: [profile('some-profile', capabilities)], current_profile: 'some-profile' } };
    }
    if (url === '/schema') return { data: { package: 'pkg', root: '', nodes: [], edges: [] } };
    return { data: {} };
  });

describe('profile capabilities', () => {
  beforeEach(() => {
    mockGet.mockReset();
    useWorkspaceStore.getState().setPkg('pkg');
    useWorkspaceStore.getState().setBaseNamespace('pkg');
    useWorkspaceStore.getState().setStartEmpty(true);
  });

  afterEach(() => cleanup());

  it('hides the under-the-hood panel when the source offers no usage', async () => {
    answer([]);
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/schema/profiles'));
    await user.click(await screen.findByRole('button', { name: /\+ Start from empty canvas/i }));
    expect(await screen.findByText('graph view')).toBeInTheDocument();
    expect(screen.queryByText('Under the hood')).toBeNull();
  });

  it('shows the under-the-hood panel when the source offers usage', async () => {
    answer(['methods', 'usage']);
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/schema/profiles'));
    await user.click(await screen.findByRole('button', { name: /\+ Start from empty canvas/i }));
    expect(await screen.findByText('graph view')).toBeInTheDocument();
    expect(screen.getByText('Under the hood')).toBeInTheDocument();
  });
});
