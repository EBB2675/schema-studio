import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InlineName, QuantityForm, type FlowGraphProps } from '../src/FlowGraphView';
import type { UmlClassNode } from '../src/types/uml';

const cls: UmlClassNode = { id: 'pkg.Sample', name: 'Sample', module: 'pkg', quantities: [] };
const props = (): FlowGraphProps => ({ nodes: [], edges: [], editableMode: true, onRenameClass: vi.fn(), onEditQuantity: vi.fn().mockResolvedValue(true), onCreateQuantity: vi.fn().mockResolvedValue(undefined) });
afterEach(cleanup);

describe('inline class rename', () => {
  it('saves on Enter once even when the input also blurs', async () => {
    const user = userEvent.setup();
    let finish!: () => void;
    const save = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const close = vi.fn();
    render(<InlineName name="Sample" onSave={save} onClose={close} />);
    const input = screen.getByLabelText('Class name');
    await user.clear(input); await user.type(input, 'Renamed{Enter}');
    fireEvent.blur(input);
    expect(save).toHaveBeenCalledExactlyOnceWith('Renamed');
    expect(close).not.toHaveBeenCalled();
    finish(); await waitFor(() => expect(close).toHaveBeenCalledOnce());
  });
  it('keeps a rejected rename available for correction and supports Escape', async () => {
    const user = userEvent.setup();
    const save = vi.fn().mockRejectedValue(new Error('A class with that name already exists'));
    const close = vi.fn();
    render(<InlineName name="Sample" onSave={save} onClose={close} />);
    await user.clear(screen.getByLabelText('Class name'));
    await user.type(screen.getByLabelText('Class name'), 'Existing{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('already exists');
    expect(close).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Class name')).toHaveValue('Existing');
    await user.type(screen.getByLabelText('Class name'), '{Escape}');
    expect(close).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledOnce();
  });
});

describe('canvas quantity editing', () => {
  it('sends changed fields to the existing operation and waits for success', async () => {
    const user = userEvent.setup(); const editor = props(); const close = vi.fn();
    render(<QuantityForm cls={cls} quantity={{ id: 'pkg.Sample.mass', ownerId: cls.id, name: 'mass', dtype: 'float', doc: 'Weight' }} props={editor} onClose={close} />);
    await user.clear(screen.getByLabelText('Name')); await user.type(screen.getByLabelText('Name'), 'weight');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(editor.onEditQuantity).toHaveBeenCalledWith('pkg.Sample.mass', expect.objectContaining({ quantityName: 'weight', dtype: 'float', docstring: 'Weight' }));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
  });
  it('does not close or discard a draft when schema validation rejects an edit', async () => {
    const user = userEvent.setup(); const editor = props(); editor.onEditQuantity = vi.fn().mockResolvedValue(false); const close = vi.fn();
    render(<QuantityForm cls={cls} quantity={{ id: 'pkg.Sample.mass', ownerId: cls.id, name: 'mass', dtype: 'float' }} props={editor} onClose={close} />);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save');
    expect(close).not.toHaveBeenCalled(); expect(screen.getByLabelText('Name')).toHaveValue('mass');
  });
  it('retains a new quantity after a failed save and allows a successful retry', async () => {
    const user = userEvent.setup(); const editor = props(); editor.onCreateQuantity = vi.fn().mockRejectedValueOnce(new Error('Duplicate quantity')).mockResolvedValueOnce(undefined); const close = vi.fn();
    render(<QuantityForm cls={cls} props={editor} onClose={close} />);
    await user.type(screen.getByLabelText('Name'), 'mass');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Duplicate quantity');
    expect(close).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
  });
});
