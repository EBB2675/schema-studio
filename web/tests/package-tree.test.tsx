import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import OverviewGrid from '../src/components/OverviewGrid';
import { apiFetch } from '../src/client';
import { getBrowserEditStore } from '../src/static/editStore';

vi.mock('../src/client', () => ({ apiFetch: vi.fn(async () => new Response(JSON.stringify({
  branch: 'main', base: 'schema', items: [
    { package: 'schema.model', classes: ['Model', 'Symmetry'] },
    { package: 'schema.outputs', classes: ['Result'] },
    { package: 'nomad_measurements.xrd.schema', classes: ['XRD'] },
    { package: 'nomad_measurements.transmission.schema', classes: ['Transmission'] },
  ],
}))) }));
afterEach(cleanup);

it('expands packages, searches classes, and selects through the existing callback without refetching', async () => {
  const user = userEvent.setup();
  const select = vi.fn();
  vi.mocked(apiFetch).mockClear();
  render(<OverviewGrid branch="main" base="schema" layout="tree" onClassSelect={select} />);
  const modelPackage = await screen.findByRole('button', { name: /model/ });
  expect(screen.getByTitle('schema.model')).toHaveTextContent(/^model$/);
  expect(modelPackage).toHaveAttribute('aria-expanded', 'false');
  expect(screen.getByLabelText('2 classes')).toBeInTheDocument();
  await user.click(modelPackage);
  await user.click(screen.getByRole('button', { name: 'Model', exact: true }));
  expect(select).toHaveBeenCalledWith('schema.model', 'Model');
  const search = screen.getByRole('textbox', { name: 'Find package or class' });
  await user.type(search, 'sym');
  expect(screen.getByRole('button', { name: 'Symmetry' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Model', exact: true })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /outputs/ })).not.toBeInTheDocument();
  await user.click(modelPackage);
  expect(search).toHaveValue('sym');
  expect(screen.queryByRole('button', { name: 'Symmetry' })).not.toBeInTheDocument();
  await user.clear(search);
  await user.type(search, 'outputs');
  expect(screen.getByRole('button', { name: 'Result' })).toBeInTheDocument();
  await user.clear(search);
  await user.type(search, 'missing');
  expect(screen.getByText('No packages or classes match.')).toBeInTheDocument();
  expect(apiFetch).toHaveBeenCalledTimes(1);
});

it('keeps colliding module names distinct and accessible, including after filtering', async () => {
  const user = userEvent.setup();
  render(<OverviewGrid branch="main" layout="tree" />);
  const xrd = await screen.findByRole('button', { name: 'nomad_measurements.xrd.schema, 1 classes' });
  expect(xrd).toHaveTextContent('xrd.schema');
  expect(screen.getByRole('button', { name: 'nomad_measurements.transmission.schema, 1 classes' })).toHaveTextContent('transmission.schema');
  await user.type(screen.getByRole('textbox'), 'xrd');
  expect(xrd).toHaveTextContent('xrd.schema');
});

it('refreshes the mounted catalog on save, undo, import, and backup replacement', async () => {
  const store = getBrowserEditStore();
  const empty = { format: 'schema-studio-edits', version: 1, edits: [] };
  await store.restoreLog(empty);
  const reply = (name: string) => vi.mocked(apiFetch).mockResolvedValueOnce(new Response(JSON.stringify({
    branch: 'main', base: 'schema', items: [{ package: 'schema.model', classes: [name] }],
  })));
  reply('Model');
  render(<OverviewGrid branch="main" base="schema" layout="tree" query="model" />);
  expect(await screen.findByRole('button', { name: 'Model', exact: true })).toBeVisible();
  const edit = { id: 1, profile: 'test', package: 'schema.model', commit: null, op: 'rename_class', target: 'schema.model.Model', payload: { new_name: 'RenamedModel' }, created_at: null };
  reply('RenamedModel');
  await act(async () => { await store.transaction(tx => tx.add([edit])); });
  expect(await screen.findByRole('button', { name: 'RenamedModel', exact: true })).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Model', exact: true })).not.toBeInTheDocument();
  const backup = store.exportLog();
  reply('Model');
  await act(async () => { await store.remove([1]); });
  expect(await screen.findByRole('button', { name: 'Model', exact: true })).toBeVisible();
  reply('RenamedModel');
  await act(async () => { await store.importLog(backup); });
  expect(await screen.findByRole('button', { name: 'RenamedModel', exact: true })).toBeVisible();
  reply('Model');
  await act(async () => { await store.restoreLog(empty); });
  expect(await screen.findByRole('button', { name: 'Model', exact: true })).toBeVisible();
});

it('ignores description and quantity edits and preserves the list, scroll, and search focus during class refreshes', async () => {
  const store = getBrowserEditStore();
  await store.restoreLog({ format: 'schema-studio-edits', version: 1, edits: [] });
  vi.mocked(apiFetch).mockClear();
  const user = userEvent.setup();
  const view = render(<OverviewGrid branch="main" base="schema" layout="tree" />);
  await user.click(await screen.findByRole('button', { name: /schema.model/ }));
  const list = view.container.querySelector('.package-list')!;
  list.scrollTop = 120;
  const search = screen.getByRole('textbox');
  search.focus();
  const edit = { profile: 'test', package: 'schema.model', commit: null, target: 'schema.model.Model', payload: {}, created_at: null };
  await act(async () => { await store.transaction(tx => tx.add([
    { ...edit, id: 1, op: 'set_description' }, { ...edit, id: 2, op: 'add_attribute' },
  ])); });
  expect(apiFetch).toHaveBeenCalledTimes(1);
  await act(async () => { await store.remove([1, 2]); });
  expect(apiFetch).toHaveBeenCalledTimes(1);

  let finish!: (response: Response) => void;
  vi.mocked(apiFetch).mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
  await act(async () => { await store.transaction(tx => tx.add([{ ...edit, id: 3, op: 'rename_class' }])); });
  await screen.findByText('Updating classes…');
  expect(view.container.querySelector('.package-list')).toBe(list);
  expect(list.scrollTop).toBe(120);
  expect(search).toHaveFocus();
  expect(screen.getByRole('button', { name: 'Model', exact: true })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Model', exact: true })).toBeDisabled();
  await act(async () => finish(new Response(JSON.stringify({ branch: 'main', base: 'schema', items: [
    { package: 'schema.model', classes: ['RenamedModel', 'Symmetry'] },
    { package: 'schema.outputs', classes: ['Result'] },
  ] }))));
  expect(await screen.findByRole('button', { name: 'RenamedModel', exact: true })).toBeEnabled();
  expect(view.container.querySelector('.package-list')).toBe(list);
  expect(list.scrollTop).toBe(120);
  expect(search).toHaveFocus();
  expect(screen.getByRole('button', { name: /schema.model/ })).toHaveAttribute('aria-expanded', 'true');

  // A failed background request also leaves the catalog in place, with an error.
  vi.mocked(apiFetch).mockRejectedValueOnce(new Error('offline'));
  await act(async () => { await store.remove([3]); });
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Could not refresh classes: offline'));
  expect(view.container.querySelector('.package-list')).toBe(list);
  expect(list.scrollTop).toBe(120);
});
