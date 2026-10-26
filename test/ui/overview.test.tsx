// @vitest-environment jsdom
import { act, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { InvestigationRecord } from '../../src/ui/data/types.ts';
import { deferred, fixtures, renderAt, sourceWith } from './support.tsx';

/** Screen A: recent investigations. */
describe('the investigations overview', () => {
  it('lists every fixture investigation, newest first, with outcome, root cause and run data', async () => {
    renderAt('#/investigations');
    const table = await screen.findByRole('table', { name: 'Investigations, newest first' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(fixtures.investigations.length);
    const text = rows.map((r) => r.textContent);
    // Newest first: fx-008 started last.
    expect(text[0]).toContain('fx-008');
    expect(text[0]).toContain('Not admitted');
    expect(text[0]).toContain('invalid_bundle');
    const completed = rows.find((r) => r.textContent.includes('2026-10-26 09:00:00 UTC'));
    expect(completed?.textContent).toContain('Completed');
    expect(completed?.textContent).toContain('payment-provider, worker');
    expect(completed?.textContent).toContain('6,610');
    expect(completed?.textContent).toContain('2026-10-26 09:00:00 UTC');
    expect(text.join('\n')).toContain('Inconclusive');
    expect(text.join('\n')).toContain('Budget exceeded');
    expect(text.join('\n')).toContain('provider_unavailable');
    // Every row is marked as fixture data.
    expect(rows.every((r) => r.textContent.includes('Fixture'))).toBe(true);
    // Each incident links to its detail page.
    expect(
      within(rows[0] as HTMLElement)
        .getByRole('link')
        .getAttribute('href'),
    ).toBe('#/investigations/fx-008');
  });

  it('offers a prominent New investigation action', async () => {
    renderAt('#/investigations');
    await screen.findByRole('table');
    expect(screen.getByRole('link', { name: 'New investigation' }).getAttribute('href')).toBe(
      '#/new',
    );
  });

  it('shows a loading state until the data source answers', async () => {
    const pending = deferred<InvestigationRecord[]>();
    renderAt('#/investigations', sourceWith({ listInvestigations: () => pending.promise }));
    expect(screen.getByRole('status').textContent).toContain('Loading investigations');
    await act(async () => {
      pending.resolve([]);
      await pending.promise;
    });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows an empty state with a way to start', async () => {
    renderAt('#/investigations', sourceWith({ listInvestigations: () => Promise.resolve([]) }));
    expect(await screen.findByText('No investigations yet')).toBeDefined();
    expect(screen.getAllByRole('link', { name: 'New investigation' })).toHaveLength(2);
  });

  it('shows an error with a retry that asks again', async () => {
    const list = vi
      .fn<() => Promise<InvestigationRecord[]>>()
      .mockRejectedValueOnce(new Error('fixture file unreadable'))
      .mockRejectedValueOnce('plain failure')
      .mockResolvedValueOnce([]);
    renderAt('#/investigations', sourceWith({ listInvestigations: list }));
    expect((await screen.findByRole('alert')).textContent).toContain('fixture file unreadable');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect((await screen.findByRole('alert')).textContent).toContain('plain failure');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No investigations yet')).toBeDefined();
    expect(list).toHaveBeenCalledTimes(3);
  });

  it('ignores an answer that arrives after the view is gone', async () => {
    const pending = deferred<InvestigationRecord[]>();
    const { unmount } = renderAt(
      '#/investigations',
      sourceWith({ listInvestigations: () => pending.promise }),
    );
    unmount();
    await act(async () => {
      pending.reject(new Error('late'));
      await pending.promise.catch(() => undefined);
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
