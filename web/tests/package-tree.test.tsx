import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import OverviewGrid from '../src/components/OverviewGrid';
import { apiFetch } from '../src/client';

vi.mock('../src/client', () => ({ apiFetch: vi.fn(async () => new Response(JSON.stringify({
  branch: 'main', base: 'schema', items: [
    { package: 'schema.model', classes: ['Model', 'Symmetry'] },
    { package: 'schema.outputs', classes: ['Result'] },
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
