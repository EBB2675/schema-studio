import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import UnderTheHoodPanel from '../src/components/UnderTheHoodPanel';
import { useSelection } from '../src/store/selection';

// Class methods are not drawn on the canvas cards; the panel lists them next to the usage index.
vi.mock('../src/client', () => ({
  apiFetch: vi.fn(async () => new Response(JSON.stringify([
    { kind: 'normalize_method', qualname: 'pkg.Atoms.normalize', module: 'pkg', short_name: 'normalize', doc: 'Normalize.' },
  ]))),
}));

describe('UnderTheHoodPanel', () => {
  afterEach(() => {
    cleanup();
    useSelection.getState().setSelected(null);
  });

  it('lists methods the usage index does not cover, once each', async () => {
    useSelection.getState().setSelected({ id: 'pkg.Atoms', kind: 'class', name: 'Atoms', doc: '' });
    render(<UnderTheHoodPanel apiBase="" methods={['get_label', 'normalize']} />);
    expect(await screen.findByText('Section.normalize()')).toBeInTheDocument();
    expect(screen.getByText('Method')).toBeInTheDocument();
    expect(screen.getByText('get_label')).toBeInTheDocument();
    expect(screen.getAllByText('normalize')).toHaveLength(1);
  });
});
