vi.mock('../src/components/StaticSitePanel', () => ({ default: () => <div data-testid="static-site-panel" /> }));
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import { useWorkspaceStore } from '../src/store/workspace';

// The right panel holds Documentation and Under the hood, starts collapsed to a
// labelled tab, and opens from it; the Audit trail sits in the left sidebar.
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
  default: ({ onInspect }: { onInspect?: () => void }) => <button onClick={onInspect}>Inspect canvas class</button>,
}));

const profile = {
  key: 'some-profile', label: 'some-profile', default_branch: 'main', default_package: 'pkg',
  default_base_namespace: 'pkg', default_root: 'Root', available: true, current: true,
  linkml_export: true, capabilities: ['usage'],
};

describe('right panel', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockGet.mockImplementation(async (url: string) => {
      if (url === '/workspace') {
        return { data: { workspace: { branch: 'main', package: 'pkg', base_namespace: 'pkg' }, user: { username: 'tester' } } };
      }
      if (url === '/schema/profiles') return { data: { profiles: [profile], current_profile: 'some-profile' } };
      if (url === '/schema') return { data: { package: 'pkg', root: '', nodes: [], edges: [] } };
      return { data: {} };
    });
    useWorkspaceStore.getState().setPkg('pkg');
    useWorkspaceStore.getState().setBaseNamespace('pkg');
    useWorkspaceStore.getState().setStartEmpty(true);
  });

  afterEach(() => cleanup());

  it('puts Under the hood below Documentation on the right and the Audit trail on the left', async () => {
    render(<App />);
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/schema/profiles'));
    const right = document.getElementById('right-panel-sections')!;
    const documentation = document.getElementById('section-documentation')!;
    const under = await waitFor(() => {
      const el = document.getElementById('section-under');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(right.contains(documentation)).toBe(true);
    expect(right.contains(under)).toBe(true);
    expect(documentation.compareDocumentPosition(under) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.querySelector('aside.sidebar')!.contains(document.getElementById('section-audit'))).toBe(true);
  });

  it('keeps setup inert until opened from the navigation rail', async () => {
    const user = userEvent.setup();
    render(<App />);
    const toggle = screen.getByRole('button', { name: 'Toggle workspace settings' });
    const sidebar = document.getElementById('mobile-workspace')!;
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(sidebar).toHaveAttribute('inert');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(sidebar).not.toHaveAttribute('inert');
    await user.click(toggle);
    expect(sidebar).toHaveAttribute('inert');
  });

  it('opens the inspector when a canvas class is inspected', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: /\+ Start from empty canvas/i }));
    await user.click(await screen.findByRole('button', { name: 'Inspect canvas class' }));
    expect(document.getElementById('right-panel-sections')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Collapse right panel' })).toBeInTheDocument();
  });

  it('switches between dedicated Workspace and History panels', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: 'Toggle workspace settings' }));
    expect(document.getElementById('section-workspace')).toBeVisible();
    expect(document.getElementById('section-audit')).not.toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Show edit history' }));
    expect(document.getElementById('section-audit')).toBeVisible();
    expect(document.getElementById('section-workspace')).not.toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Toggle workspace settings' }));
    expect(document.getElementById('section-workspace')).toBeVisible();
    expect(document.getElementById('mobile-workspace')).not.toHaveAttribute('inert');
  });

  it('starts collapsed and opens from the labelled tab', async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/schema/profiles'));
    const right = document.getElementById('right-panel-sections')!;
    expect(right).not.toBeVisible();
    expect(screen.queryByRole('separator', { name: /resize documentation panel/i })).toBeNull();

    await user.click(screen.getByTitle('Open Documentation'));
    expect(right).toBeVisible();
    expect(screen.getByRole('separator', { name: /resize documentation panel/i })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Collapse right panel' }));
    expect(right).not.toBeVisible();
  });
});
