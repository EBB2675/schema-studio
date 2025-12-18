import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import QuantityEditPanel from '../src/components/QuantityEditPanel';
import { useSelection } from '../src/store/selection';
import type { Selected } from '../src/store/selection';

type QuantitySelection = Exclude<Selected, null>;

const setSelectedQuantity = (overrides: Partial<QuantitySelection> = {}) => {
  const base: QuantitySelection = {
    id: 'pkg.Class.qty',
    kind: 'quantity',
    name: 'qty',
    doc: 'original doc',
    owner: 'pkg.Class',
    dtype: 'int',
    path: 'schema.py',
    line: 10,
  };

  useSelection.getState().setSelected({ ...base, ...overrides });
};

describe('QuantityEditPanel', () => {
  afterEach(() => {
    cleanup();
    useSelection.getState().setSelected(null);
    vi.restoreAllMocks();
  });

  it('disables actions when blocked and shows reason', () => {
    setSelectedQuantity();

    render(
      <QuantityEditPanel
        editableMode={false}
        blockedReason="Locked by workspace"
        actionError={null}
        clearActionError={() => {}}
        onEditQuantity={vi.fn()}
        onRemoveQuantity={vi.fn()}
      />
    );

    expect(screen.getByText('Locked by workspace')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Save changes/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Remove/i })).toBeDisabled();
  });

  it('commits edits for the selected quantity', async () => {
    setSelectedQuantity({ dtype: 'float64', doc: 'old doc' });
    const onEditQuantity = vi.fn();
    const clearActionError = vi.fn();
    const user = userEvent.setup();

    render(
      <QuantityEditPanel
        editableMode
        clearActionError={clearActionError}
        onEditQuantity={onEditQuantity}
        onRemoveQuantity={vi.fn()}
      />
    );

    const nameInput = screen.getByLabelText(/Name/i);
    await user.clear(nameInput);
    await user.type(nameInput, 'updated_qty');
    await user.selectOptions(screen.getByLabelText(/Type/i), 'int32');
    await user.clear(screen.getByLabelText(/Docstring/i));
    await user.type(screen.getByLabelText(/Docstring/i), 'new description');

    await user.click(screen.getByRole('button', { name: /Save changes/i }));

    expect(onEditQuantity).toHaveBeenCalledWith('pkg.Class.qty', {
      quantityName: 'updated_qty',
      dtype: 'int32',
      docstring: 'new description',
    });
    expect(clearActionError).toHaveBeenCalled();
  });

  it('removes quantity after user confirms', async () => {
    setSelectedQuantity();
    const onRemoveQuantity = vi.fn();
    const confirmSpy = vi.fn().mockReturnValue(true);
    vi.stubGlobal('confirm', confirmSpy);
    const user = userEvent.setup();

    render(
      <QuantityEditPanel
        editableMode
        clearActionError={() => {}}
        onEditQuantity={vi.fn()}
        onRemoveQuantity={onRemoveQuantity}
      />
    );

    await user.click(screen.getByRole('button', { name: /Remove/i }));

    expect(confirmSpy).toHaveBeenCalled();
    expect(onRemoveQuantity).toHaveBeenCalledWith('pkg.Class.qty');
  });
});
