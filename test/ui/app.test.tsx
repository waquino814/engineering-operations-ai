// @vitest-environment jsdom
import { act, fireEvent, renderHook, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { href, parseRoute, useRoute } from '../../src/ui/router.ts';
import { fixtures, renderAt } from './support.tsx';

/** The console shell: navigation, routing and the read-only settings. */
const go = async (hash: string) => {
  await act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await Promise.resolve();
  });
};

describe('routes', () => {
  it('parse every view, defaulting to investigations', () => {
    expect(parseRoute('')).toEqual({ name: 'investigations' });
    expect(parseRoute('#/')).toEqual({ name: 'investigations' });
    expect(parseRoute('#/investigations')).toEqual({ name: 'investigations' });
    expect(parseRoute('#/investigations/fx-001')).toEqual({ name: 'investigation', id: 'fx-001' });
    expect(parseRoute('#/new')).toEqual({ name: 'new' });
    expect(parseRoute('#/settings')).toEqual({ name: 'settings' });
    expect(parseRoute('#/investigations/../x')).toEqual({
      name: 'not_found',
      path: '/investigations/../x',
    });
  });

  it('build links that parse back to the same route', () => {
    for (const route of [
      { name: 'investigations' },
      { name: 'investigation', id: 'fx-002' },
      { name: 'new' },
      { name: 'settings' },
    ] as const)
      expect(parseRoute(href(route))).toEqual(route);
  });

  it('follow hash changes', async () => {
    window.location.hash = '#/new';
    const { result, unmount } = renderHook(() => useRoute());
    expect(result.current).toEqual({ name: 'new' });
    await go('#/settings');
    expect(result.current).toEqual({ name: 'settings' });
    unmount();
  });
});

describe('the shell', () => {
  it('has the three sections in a labelled navigation, marking the current one', async () => {
    renderAt('#/investigations');
    const nav = screen.getByRole('navigation', { name: 'Main' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual([
      '≡Investigations',
      '+New Investigation',
      '⚙Settings',
    ]);
    expect(within(nav).getByRole('link', { name: 'Investigations' })).toHaveProperty(
      'ariaCurrent',
      'page',
    );
    await go('#/new');
    expect(within(nav).getByRole('link', { name: /New Investigation/ })).toHaveProperty(
      'ariaCurrent',
      'page',
    );
    expect(screen.getByRole('heading', { level: 1, name: 'New investigation' })).toBeDefined();
    await go('#/investigations/fx-001');
    // A detail page belongs to the investigations section.
    expect(within(nav).getByRole('link', { name: 'Investigations' })).toHaveProperty(
      'ariaCurrent',
      'page',
    );
  });

  it('moves between views when a navigation link is followed', async () => {
    renderAt('#/investigations');
    const settings = within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', {
      name: /Settings/,
    });
    fireEvent.click(settings);
    await go(settings.getAttribute('href') ?? '');
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeDefined();
  });

  it('says in the top bar that the data is fixture data, and offers a skip link', () => {
    renderAt('#/settings');
    expect(screen.getByRole('banner').textContent).toContain('Fixture');
    expect(screen.getByRole('link', { name: 'Skip to content' }).getAttribute('href')).toBe(
      '#main',
    );
    expect(screen.getByRole('main').id).toBe('main');
  });

  it('shows a not-found page for an unknown route', () => {
    renderAt('#/nowhere');
    expect(screen.getByText('Page not found')).toBeDefined();
    expect(screen.getByText('/nowhere')).toBeDefined();
    expect(screen.getByRole('link', { name: 'Go to investigations' }).getAttribute('href')).toBe(
      '#/investigations',
    );
  });
});

describe('settings', () => {
  it('are read-only and say where data comes from, with no provider configured', () => {
    renderAt('#/settings');
    const main = screen.getByRole('main');
    expect(main.textContent).toContain(fixtures.notice);
    expect(main.textContent).toContain('No runnable provider.');
    expect(main.textContent).toContain('No hosted model can be enabled here.');
    expect(main.textContent).toContain('investigation-result 0.1.0');
    expect(main.textContent).toContain('maxTotalTokens816,000');
    expect(within(main).queryAllByRole('textbox')).toEqual([]);
    expect(within(main).queryAllByRole('button')).toEqual([]);
  });
});
