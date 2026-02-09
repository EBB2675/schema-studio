import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
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

  it('honors controlled open and only changes when parent updates it', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();

    const Controlled = () => (
      <CollapsibleSection title="Controlled" open={false} onToggle={onToggle}>
        <div>Controlled content</div>
      </CollapsibleSection>
    );

    render(<Controlled />);

    const toggle = screen.getByRole('button', { name: /Controlled/ });
    const body = screen.getByText('Controlled content');

    expect(body).not.toBeVisible();
    await user.click(toggle);
    expect(onToggle).toHaveBeenCalledWith(true);
    expect(body).not.toBeVisible();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('calls onToggle with the next state in uncontrolled mode', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();

    render(
      <CollapsibleSection title="Not Controlled" onToggle={onToggle}>
        <div>Content</div>
      </CollapsibleSection>
    );

    const toggle = screen.getByRole('button', { name: /Not Controlled/ });

    await user.click(toggle);
    await user.click(toggle);

    expect(onToggle).toHaveBeenNthCalledWith(1, true);
    expect(onToggle).toHaveBeenNthCalledWith(2, false);
    expect(onToggle).toHaveBeenCalledTimes(2);
  });

  it('wires aria-controls to the body id when id is provided', () => {
    render(
      <CollapsibleSection title="Docs with id" id="section-docs">
        <div>Body</div>
      </CollapsibleSection>
    );

    const toggle = screen.getByRole('button', { name: /Docs with id/ });
    const body = document.getElementById('section-docs-body');

    expect(toggle).toHaveAttribute('aria-controls', 'section-docs-body');
    expect(body).not.toBeNull();
    expect(body!).toHaveAttribute('id', 'section-docs-body');
  });
});
