import { useEffect } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import type { GraphExportHandle } from '../src/types/graph';
import { useWorkspaceStore } from '../src/store/workspace';

const { capture, save, loaded } = vi.hoisted(() => ({ capture: vi.fn(), save: vi.fn(), loaded: vi.fn() }));
vi.mock('../src/utils/exportPdf', () => { loaded(); return { savePngPdf: save }; });
vi.mock('../src/components/StaticSitePanel', () => ({ default: () => null }));
vi.mock('../src/FlowGraphView', () => ({ default: function MockCanvas({ onReady }: { onReady?: (handle: GraphExportHandle | null) => void }) {
  useEffect(() => {
    onReady?.({ toPng: capture, focusNode: () => false, refit: () => {} });
    return () => onReady?.(null);
  }, [onReady]);
  return <div data-testid="canvas" />;
} }));
vi.mock('../src/client', () => ({
  createApiClient: () => ({
    get: vi.fn(async (url: string) => {
      if (url === '/workspace') return { data: { workspace: { branch: 'main', package: 'pkg', base_namespace: 'pkg' } } };
      if (url === '/schema') return { data: { package: 'pkg.custom_schema', root: '', nodes: [], edges: [] } };
      if (url === '/git/packages') return { data: { packages: ['pkg'] } };
      if (url === '/roots') return { data: { sections: [] } };
      return { data: {} };
    }),
    put: vi.fn(async () => ({ data: {} })),
    interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
  }),
  apiFetch: vi.fn(async () => new Response('[]')),
}));

async function openCanvas() {
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole('button', { name: /\+ Start from empty canvas/i }));
  await screen.findByTestId('canvas');
  return user;
}

beforeEach(() => {
  localStorage.clear();
  useWorkspaceStore.getState().setPkg('pkg');
  useWorkspaceStore.getState().setBaseNamespace('pkg');
  useWorkspaceStore.getState().setStartEmpty(true);
  capture.mockReset().mockResolvedValue('captured-png');
  save.mockReset();
});
afterEach(cleanup);

describe('on-demand PDF export', () => {
  it('loads PDF code only after an export is requested', async () => {
    const user = await openCanvas();
    expect(loaded).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Export PDF' }));
    await waitFor(() => expect(save).toHaveBeenCalledWith('captured-png', 'pkg.custom_schema_all.pdf'));
    expect(loaded).toHaveBeenCalledOnce();
  });

  it('does not save when there is no canvas image', async () => {
    capture.mockResolvedValue(null);
    const user = await openCanvas();
    await user.click(screen.getByRole('button', { name: 'Export PDF' }));
    expect(capture).toHaveBeenCalledOnce();
    expect(save).not.toHaveBeenCalled();
  });

  it.each(['capture', 'save'])('shows %s failures in the UI', async stage => {
    if (stage === 'capture') capture.mockRejectedValue(new Error('Export unavailable'));
    else save.mockImplementation(() => { throw new Error('Export unavailable'); });
    const user = await openCanvas();
    await user.click(screen.getByRole('button', { name: 'Export PDF' }));
    expect(await screen.findByText('PDF export failed: Export unavailable')).toBeInTheDocument();
  });
});
