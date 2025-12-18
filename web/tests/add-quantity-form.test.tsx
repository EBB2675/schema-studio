import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AddQuantityForm from '../src/components/AddQuantityForm';

describe('AddQuantityForm', () => {
  afterEach(() => {
    cleanup();
  });

  it('disables controls and shows the blocked reason when editing is off', () => {
    const onSubmit = vi.fn();

    render(
      <AddQuantityForm
        enabled={false}
        targetClass={null}
        onSubmit={onSubmit}
        submitting={false}
        error={null}
        blockedReason="Read-only mode"
      />
    );

    expect(screen.getByText('Read-only mode')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add quantity/i })).toBeDisabled();
    expect(screen.getByLabelText(/Quantity name/i)).toBeDisabled();
    expect(screen.getByLabelText(/Type/i)).toBeDisabled();
    expect(screen.getByLabelText(/Docstring/i)).toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits trimmed form data when enabled', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);

    render(
      <AddQuantityForm
        enabled
        targetClass="Example.Section"
        onSubmit={onSubmit}
        submitting={false}
        error={null}
      />
    );

    await user.type(screen.getByLabelText(/Quantity name/i), '  new_quantity  ');
    await user.selectOptions(screen.getByLabelText(/Type/i), 'float');
    await user.type(screen.getByLabelText(/Docstring/i), '  describes value  ');

    await user.click(screen.getByRole('button', { name: /add quantity/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith({
      quantityName: 'new_quantity',
      dtype: 'float',
      docstring: 'describes value',
    });
  });
});
