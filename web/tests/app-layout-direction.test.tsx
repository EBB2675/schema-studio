vi.mock('../src/components/StaticSitePanel', () => ({ default: () => <div data-testid="static-site-panel" /> }));
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import { useWorkspaceStore } from '../src/store/workspace';
import { LAYOUT_DIRECTION_STORAGE_KEY } from '../src/utils/layoutDirection';

const classId = 'pkg.custom_schema.Class';
const graph = {
  package: 'pkg.custom_schema',
  root: '',
  nodes: [{ id: classId, kind: 'section', label: 'Class', subclasses: 0 }],
  edges: [],
};

const mockGet = vi.fn();

vi.mock('../src/client', () => {
  const create = () => ({
    get: mockGet,
    post: vi.fn(),
    put: vi.fn(async () => ({ data: { workspace: { branch: 'main', package: 'pkg', base_namespace: 'pkg' } } })),
    delete: vi.fn(),
    interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
  });
  return { createApiClient: create, apiFetch: vi.fn(async () => new Response("[]")) };
});

// FlowGraphView reduced to the direction it is given.
vi.mock('../src/FlowGraphView', () => ({
  __esModule: true,
  default: ({ layoutDirection }: { layoutDirection?: string }) => <div data-testid="direction">{layoutDirection}</div>,
}));

const openCanvas = async () => {
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole('button', { name: /\+ Start from empty canvas/i }));
  await screen.findByTestId('direction');
  return user;
};

describe('App layout direction', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  beforeEach(() => {
    useWorkspaceStore.getState().setPkg('pkg');
    useWorkspaceStore.getState().setBaseNamespace('pkg');
    useWorkspaceStore.getState().setStartEmpty(true);
    window.localStorage.removeItem(LAYOUT_DIRECTION_STORAGE_KEY);
    mockGet.mockReset();
    mockGet.mockImplementation(async (url: string) => {
      if (url === '/workspace') {
        return { data: { workspace: { branch: 'main', package: 'pkg', base_namespace: 'pkg' }, user: { username: 'tester' } } };
      }
      if (url === '/schema') return { data: graph };
      if (url === '/git/branches') return { data: { branches: ['main'] } };
      if (url === '/git/packages') return { data: { packages: ['pkg'] } };
      if (url === '/roots') return { data: { sections: [] } };
      return { data: {} };
    });
  });

  it('starts with the root at the top', async () => {
    await openCanvas();
    expect(screen.getByTestId('direction').textContent).toBe('UP');
    expect(screen.getByRole('combobox', { name: 'Layout direction' })).toHaveProperty('value', 'UP');
  });

  it('passes the chosen direction to the canvas and keeps it after a reload', async () => {
    const user = await openCanvas();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Layout direction' }), 'Root at left');
    expect(screen.getByTestId('direction').textContent).toBe('LEFT');
    expect(window.localStorage.getItem(LAYOUT_DIRECTION_STORAGE_KEY)).toBe('LEFT');

    cleanup();
    await openCanvas();
    expect(screen.getByTestId('direction').textContent).toBe('LEFT');
  });
  it.each(["getter", "read", "write"])("keeps rendering and changing preferences after a storage %s failure", async failure => {
    const blocked = () => { throw new DOMException("Blocked", "SecurityError"); };
    if (failure === "getter") vi.spyOn(window, "localStorage", "get").mockImplementation(blocked);
    else vi.spyOn(window.localStorage, failure === "read" ? "getItem" : "setItem").mockImplementation(blocked);
    const user = await openCanvas();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Layout direction' }), 'Root at left');
    expect(screen.getByTestId('direction').textContent).toBe('LEFT');
    await user.click(screen.getByRole('button', { name: /Switch to .* theme/ }));
    expect(screen.getByTestId('direction')).toBeInTheDocument();
  });

});
