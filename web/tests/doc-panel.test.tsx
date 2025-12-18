import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DocPanel from '../src/components/DocPanel';
import { useSelection, type Selected } from '../src/store/selection';

const classSelection: Selected = {
  id: 'pkg.Class',
  kind: 'class',
  name: 'Class',
  doc: 'class docs',
  quantities: [
    { id: 'pkg.Class.a', name: 'Alpha', owner: 'pkg.Class' },
    { id: 'pkg.Class.b', name: 'Beta', owner: 'pkg.Class', dtype: 'float' },
  ],
};

const setSelection = (sel: Selected | null) => {
  useSelection.getState().setSelected(sel);
};

describe('DocPanel', () => {
  afterEach(() => {
    cleanup();
    setSelection(null);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('switches from class view to quantity view and back', async () => {
    setSelection(classSelection);
    const clearActionError = vi.fn();
    const user = userEvent.setup();

    render(
      <DocPanel
        editableMode
        onRemoveQuantity={vi.fn()}
        onEditQuantity={vi.fn()}
        clearActionError={clearActionError}
      />
    );

    expect(screen.getAllByText('Class').length).toBeGreaterThan(0);
    expect(screen.getByText('Quantities')).toBeInTheDocument();
    expect(clearActionError).toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /Beta/ }));
    expect(screen.getByText('Quantity')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Back/ })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: /Back/ }));
    expect(screen.getAllByText('Class').length).toBeGreaterThan(0);
  });

  it('asks for confirmation before removing a quantity', async () => {
    setSelection(classSelection);
    const onRemoveQuantity = vi.fn();
    const confirmSpy = vi.fn().mockReturnValue(true);
    vi.stubGlobal('confirm', confirmSpy);
    const user = userEvent.setup();

    render(
      <DocPanel
        editableMode
        onRemoveQuantity={onRemoveQuantity}
        onEditQuantity={vi.fn()}
        clearActionError={() => {}}
      />
    );

    await user.click(screen.getAllByRole('button', { name: /Remove/ })[0]);

    expect(confirmSpy).toHaveBeenCalled();
    expect(onRemoveQuantity).toHaveBeenCalledWith('pkg.Class.a');
  });
});
