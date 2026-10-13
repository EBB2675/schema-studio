import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import { useWorkspaceStore } from '../src/store/workspace';

// The right panel holds Documentation and Under the hood and collapses to a
// thin rail; the Audit trail sits in the left sidebar.
const mockGet = vi.fn();

vi.mock('axios', () => {
  const create = () => ({
    get: mockGet,
    post: vi.fn(async () => ({ data: {} })),
    put: vi.fn(async () => ({ data: { workspace: { branch: 'main', package: 'pkg', base_namespace: 'pkg' } } })),
    delete: vi.fn(),
    interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
  });
  return { default: Object.assign(create, { create, post: vi.fn() }) };
});

vi.mock('../src/GraphView', () => ({
  __esModule: true,
  default: () => <div>graph</div>,
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
    window.localStorage.setItem('schema-uml-token', 't0k');
    window.localStorage.setItem('schema-uml-username', 'user');
    window.localStorage.removeItem('schema-uml-doc-collapsed');
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

  it('collapses and expands, and remembers the choice', async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/schema/profiles'));
    const right = document.getElementById('right-panel-sections')!;
    expect(right).toBeVisible();
    expect(screen.getByRole('separator', { name: /resize documentation panel/i })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Collapse right panel' }));
    expect(right).not.toBeVisible();
    expect(screen.queryByRole('separator', { name: /resize documentation panel/i })).toBeNull();
    expect(window.localStorage.getItem('schema-uml-doc-collapsed')).toBe('1');

    await user.click(screen.getByRole('button', { name: 'Expand right panel' }));
    expect(right).toBeVisible();
    expect(window.localStorage.getItem('schema-uml-doc-collapsed')).toBe('0');
  });
});
