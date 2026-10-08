import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import { useWorkspaceStore } from '../src/store/workspace';

const classId = 'pkg.custom_schema.Class';
const graph = {
  package: 'pkg.custom_schema',
  root: '',
  nodes: [{ id: classId, kind: 'section', label: 'Class', subclasses: 2 }],
  edges: [],
};

const mockGet = vi.fn();
const mockPost = vi.fn();
const mockPut = vi.fn();

vi.mock('axios', () => {
  const create = () => ({
    get: mockGet,
    post: mockPost,
    put: mockPut,
    delete: vi.fn(),
    interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
  });
  return { default: Object.assign(create, { create, post: vi.fn() }) };
});

// GraphView reduced to the subclass toggle and the set of expanded classes it is given.
vi.mock('../src/GraphView', () => ({
  __esModule: true,
  default: ({ expandedClassIds, onToggleSubclasses }: {
    expandedClassIds?: string[];
    onToggleSubclasses?: (id: string) => Promise<void> | void;
  }) => (
    <div>
      <button type="button" onClick={() => void onToggleSubclasses?.(classId)}>Toggle subclasses</button>
      <div data-testid="expanded">{(expandedClassIds ?? []).join(',')}</div>
    </div>
  ),
}));

const schemaCalls = () =>
  mockGet.mock.calls.filter(([url]) => url === '/schema').map(([, options]) => options?.params ?? {});

describe('App subclass toggle', () => {
  afterEach(cleanup);

  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
    mockPut.mockReset();
    mockPut.mockResolvedValue({ data: { workspace: { branch: 'main', package: 'pkg', base_namespace: 'pkg' } } });
    useWorkspaceStore.getState().setPkg('pkg');
    useWorkspaceStore.getState().setBaseNamespace('pkg');
    useWorkspaceStore.getState().setStartEmpty(true);
    window.localStorage.removeItem('schema-uml-audit');
    window.localStorage.setItem('schema-uml-token', 't0k');
    window.localStorage.setItem('schema-uml-username', 'user');
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

  it('asks for the graph with the class expanded, and without it on the second click', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: /\+ Start from empty canvas/i }));
    const toggle = await screen.findByRole('button', { name: 'Toggle subclasses' });
    expect(schemaCalls().at(-1)?.expand).toBeUndefined();

    await user.click(toggle);
    await waitFor(() => expect(screen.getByTestId('expanded').textContent).toBe(classId));
    expect(schemaCalls().at(-1)).toMatchObject({ expand: classId, package: 'pkg.custom_schema' });

    await user.click(toggle);
    await waitFor(() => expect(screen.getByTestId('expanded').textContent).toBe(''));
    expect(schemaCalls().at(-1)?.expand).toBeUndefined();
  });
});
