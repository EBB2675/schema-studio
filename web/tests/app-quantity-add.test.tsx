import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import { useWorkspaceStore } from '../src/store/workspace';

const classId = 'pkg.custom_schema.Class';
const baseGraph = {
  package: 'pkg.custom_schema',
  root: '',
  nodes: [{ id: classId, kind: 'section', label: 'Class' }],
  edges: [],
};

const graphWithQuantity = {
  package: 'pkg.custom_schema',
  root: '',
  nodes: [
    { id: classId, kind: 'section', label: 'Class' },
    { id: `${classId}.new_qty`, kind: 'quantity', label: 'new_qty', owner: classId },
  ],
  edges: [{ source: `${classId}.new_qty`, target: classId, type: 'hasQuantity' }],
};

// Stub axios to drive App's API interactions.
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

  const axios = Object.assign(create, {
    create,
    post: vi.fn(), // login, unused here
  });

  return { default: axios };
});

// Simplify GraphView to expose a trigger for the add-quantity handler.
vi.mock('../src/GraphView', () => {
  return {
    __esModule: true,
    default: ({ onCreateQuantity }: { onCreateQuantity?: (classId: string, data: { quantityName: string; dtype: string; docstring: string }) => Promise<void> | void }) => (
      <div>
        <button
          type="button"
          onClick={() => {
            Promise.resolve(
              onCreateQuantity?.(classId, {
                quantityName: 'new_qty',
                dtype: 'float',
                docstring: 'desc',
              })
            ).catch(() => {});
          }}
        >
          Trigger quantity add
        </button>
        <button
          type="button"
          onClick={() => {
            Promise.resolve(
              onCreateQuantity?.(classId, {
                quantityName: 'bad_qty',
                dtype: 'int',
                docstring: '',
              })
            ).catch(() => {});
          }}
        >
          Trigger quantity add failure
        </button>
      </div>
    ),
  };
});

describe('App editable quantity add flow', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
    mockPut.mockReset();
    mockDelete.mockReset();
    mockPut.mockResolvedValue({
      data: {
        workspace: { branch: 'main', package: 'pkg', base_namespace: 'pkg' },
      },
    });

    // Ensure deterministic workspace + scratch package.
    useWorkspaceStore.getState().setPkg('pkg');
    useWorkspaceStore.getState().setBaseNamespace('pkg');
    useWorkspaceStore.getState().setStartEmpty(true);

    // Prime localStorage with a token so App skips login form.
    window.localStorage.setItem('schema-uml-token', 't0k');
    window.localStorage.setItem('schema-uml-username', 'user');

    if (!('ResizeObserver' in window)) {
      // minimal stub for layout observer
      // @ts-expect-error - happy-dom lacks ResizeObserver
      window.ResizeObserver = class {
        observe() {}
        disconnect() {}
      };
    }

    mockGet.mockImplementation(async (url: string, options?: { params?: Record<string, unknown> }) => {
      if (url === '/workspace') {
        return {
          data: {
            workspace: { branch: 'main', package: 'pkg', base_namespace: 'pkg' },
            user: { username: 'tester' },
          },
        };
      }
      if (url === '/schema') {
        if (options?.params?.empty) {
          return { data: baseGraph };
        }
        return { data: baseGraph };
      }
      if (url === '/git/branches') {
        return { data: { branches: ['main'] } };
      }
      if (url === '/git/packages') {
        return { data: { packages: ['pkg'] } };
      }
      if (url === '/roots') {
        return { data: { sections: [] } };
      }
      return { data: {} };
    });

    // First custom-quantity call succeeds, second fails.
    mockPost
      .mockImplementationOnce(async (url: string) => {
        if (url === '/schema/custom-quantity') {
          return { data: graphWithQuantity };
        }
        return { data: {} };
      })
      .mockImplementationOnce(async (url: string) => {
        if (url === '/schema/custom-quantity') {
          throw { response: { data: { detail: 'boom fail' } } };
        }
        return { data: {} };
      });
  });

  it('submits quantity add requests and surfaces API errors', async () => {
    const user = userEvent.setup();

    render(<App />);

    // Build an empty canvas graph.
    await user.click(await screen.findByRole('button', { name: /\+ Start from empty canvas/i }));

    // Enable editable mode.
    const editToggle =
      (
        await screen.findAllByRole('button', {
          name: /^Edit$/i,
        })
      ).find((btn) => btn.getAttribute('title')?.includes('Toggle editing')) ?? (await screen.findByRole('button', { name: /^Edit$/i }));
    await user.click(editToggle);

    // First call succeeds.
    await user.click(await screen.findByRole('button', { name: /^Trigger quantity add$/i }));

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith(
        '/schema/custom-quantity',
        expect.objectContaining({
          class_name: 'Class',
          quantity_name: 'new_qty',
          dtype: 'float',
        }),
        expect.any(Object)
      )
    );

    // New quantity should show up in the doc panel selection.
    expect(await screen.findByText('new_qty')).toBeInTheDocument();

    // Next call rejects; error should bubble into the doc panel.
    await user.click(screen.getByRole('button', { name: /Trigger quantity add failure/i }));

    expect(await screen.findByText(/boom fail/i)).toBeInTheDocument();
  });
});
