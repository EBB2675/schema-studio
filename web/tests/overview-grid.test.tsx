import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import OverviewGrid from '../src/components/OverviewGrid';

vi.mock('../src/client', () => ({ apiFetch: (...args: unknown[]) => fetch(...args as [RequestInfo, RequestInit?]) }));

const sampleResponse = {
  branch: 'develop',
  base: 'pkg.base',
  items: [
    { package: 'pkg.one', classes: ['Alpha', 'Beta'] },
    { package: 'pkg.two', classes: ['Gamma'] },
  ],
};

describe('OverviewGrid', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders fetched packages, filters them, and emits class selection', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => sampleResponse,
    });
    vi.stubGlobal('fetch', fetchMock);

    const onClassSelect = vi.fn();
    const user = userEvent.setup();

    render(
      <OverviewGrid

        branch="develop"
        base="pkg.base"

        onClassSelect={onClassSelect}
      />
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/overview?branch=develop&base=pkg.base');

    expect(await screen.findByText('pkg.one')).toBeInTheDocument();
    expect(screen.getByText('pkg.two')).toBeInTheDocument();

    const search = screen.getByPlaceholderText(/Filter package or class/i);
    await user.type(search, 'gamma');

    expect(screen.queryByText('pkg.one')).not.toBeInTheDocument();
    expect(screen.getByText('pkg.two')).toBeInTheDocument();

    await user.clear(search);
    await user.type(search, 'beta');
    await user.click(screen.getByRole('button', { name: 'Beta' }));

    expect(onClassSelect).toHaveBeenCalledWith('pkg.one', 'Beta');
  });

  it('shows loading and error states', async () => {
    const pending = new Promise(() => {});
    const fetchMock = vi.fn().mockReturnValue(pending);
    vi.stubGlobal('fetch', fetchMock);

    render(
      <OverviewGrid

        branch="develop"
      />
    );

    expect(await screen.findByText(/Loading…/i)).toBeInTheDocument();

    fetchMock.mockReset();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')));

    render(
      <OverviewGrid

        branch="develop"
      />
    );

    await expect(screen.findByText(/boom/)).resolves.toBeInTheDocument();
  });
});
