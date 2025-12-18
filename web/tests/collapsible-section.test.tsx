import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import CollapsibleSection from '../src/components/CollapsibleSection';

describe('CollapsibleSection', () => {
  it('toggles visibility and aria state', async () => {
    const user = userEvent.setup();

    render(
      <CollapsibleSection title="Details">
        <div>Hidden content</div>
      </CollapsibleSection>
    );

    const toggle = screen.getByRole('button', { name: /Details/ });
    const body = screen.getByText('Hidden content');

    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(body).not.toBeVisible();

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(body).toBeVisible();

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(body).not.toBeVisible();
  });

  it('can start open when requested', () => {
    render(
      <CollapsibleSection title="Docs" defaultOpen>
        <div>Starting open</div>
      </CollapsibleSection>
    );

    expect(screen.getByText('Starting open')).toBeVisible();
    expect(screen.getByRole('button', { name: /Docs/ })).toHaveAttribute('aria-expanded', 'true');
  });
});
