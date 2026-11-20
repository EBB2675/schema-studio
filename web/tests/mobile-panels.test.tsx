import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMobilePanels } from '../src/hooks/useMobilePanels';

let change: (() => void) | undefined;
let matches = true;
function Harness() {
  const { isMobile, mobilePanel, setMobilePanel } = useMobilePanels(true);
  return <><span>{isMobile ? 'Phone' : 'Desktop'}</span><button onClick={() => setMobilePanel('workspace')}>Open workspace</button><button onClick={() => setMobilePanel('details')}>Open details</button>
    {mobilePanel && <div role="dialog" data-mobile-panel={mobilePanel} tabIndex={-1}><button onClick={() => setMobilePanel(null)}>Close {mobilePanel}</button><input aria-label="Field" /></div>}
  </>;
}
beforeEach(() => {
  matches = true;
  vi.stubGlobal('matchMedia', () => ({ get matches() { return matches; }, addEventListener: (_: string, fn: () => void) => { change = fn; }, removeEventListener: vi.fn() }));
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{ width: 44, height: 44 }] as unknown as DOMRectList);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('mobile panel lifecycle', () => {
  it('opens one panel, focuses it, and Escape restores the trigger', async () => {
    const user = userEvent.setup(); render(<Harness />);
    const open = screen.getByRole('button', { name: 'Open workspace' });
    await user.click(open);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close workspace' })).toHaveFocus());
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(open).toHaveFocus();
  });
  it('wraps keyboard focus within the open panel', async () => {
    const user = userEvent.setup(); render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open details' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close details' })).toHaveFocus());
    await user.tab({ shift: true }); expect(screen.getByLabelText('Field')).toHaveFocus();
    await user.tab(); expect(screen.getByRole('button', { name: 'Close details' })).toHaveFocus();
  });
  it('closes the mobile layer when the viewport returns to desktop', async () => {
    const user = userEvent.setup(); render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open workspace' }));
    matches = false;
    act(() => change?.());
    expect(screen.getByText('Desktop')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
