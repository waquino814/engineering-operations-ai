// @vitest-environment jsdom
import { act, fireEvent, renderHook, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ProviderSettings, ProviderStatus } from '../../src/ui/data/types.ts';
import { href, parseRoute, useRoute } from '../../src/ui/router.ts';
import { deferred, fixtures, providerStatus, renderAt, sourceWith } from './support.tsx';

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
  const settings = (over: Partial<ProviderSettings> = {}): ProviderSettings => ({
    provider: 'fake',
    ollamaModel: null,
    pinned: false,
    ...over,
  });
  /** A source with a mutable saved selection, as the application keeps it. */
  function live(initial: ProviderSettings, over: Partial<ProviderStatus> = {}) {
    let saved = initial;
    const save = vi.fn((input: { provider: 'fake' | 'ollama'; ollamaModel: string | null }) => {
      saved = { ...saved, ...input };
      return Promise.resolve(saved);
    });
    const source = sourceWith({
      getSettings: () => Promise.resolve(saved),
      saveSettings: save,
      getProviderStatus: () =>
        Promise.resolve(
          providerStatus(
            saved.provider === 'fake'
              ? {}
              : {
                  selected: 'ollama',
                  simulated: false,
                  model: 'gemma:12b',
                  models: ['gemma:12b', 'other:1b'],
                  ...over,
                },
          ),
        ),
    });
    return { source, save };
  }
  const radio = (name: RegExp) => screen.findByRole('radio', { name });

  it('shows where data comes from and that no hosted model can be enabled', async () => {
    renderAt('#/settings');
    const main = screen.getByRole('main');
    expect(main.textContent).toContain(fixtures.notice);
    expect(main.textContent).toContain(
      'Not available. No setting, request or control can enable one.',
    );
    expect(main.textContent).toContain('investigation-result 0.1.0');
    expect(main.textContent).toContain('maxTotalTokens816,000');
    // Fixtures fix the provider: the choice is shown but cannot be changed.
    expect(await within(main).findByText(/fixed outside the console/)).toBeDefined();
    expect(within(main).getByRole('button', { name: 'Save provider' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(within(main).getByRole('radio', { name: /Fake/ })).toHaveProperty('disabled', true);
  });

  it('lets the user choose Ollama while it is blocked, saves it, and keeps selection and readiness apart', async () => {
    const { source, save } = live(settings(), {
      runnable: false,
      reason: 'Ollama is not reachable at http://127.0.0.1:11434/. Nothing was run.',
    });
    renderAt('#/settings', source);
    const main = screen.getByRole('main');
    expect(await within(main).findByText('Ready to run')).toBeDefined();
    const ollama = await radio(/Ollama/);
    expect(within(main).getByRole('button', { name: 'Save provider' })).toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.click(ollama);
    expect(within(main).getByLabelText('Ollama model')).toBeDefined();
    fireEvent.click(within(main).getByRole('button', { name: 'Save provider' }));
    expect(await within(main).findByText(/Saved\. This choice is kept/)).toBeDefined();
    expect(save).toHaveBeenCalledWith({ provider: 'ollama', ollamaModel: null });
    // Selected and ready are separate: Ollama is selected and blocked, with the reason.
    expect(await within(main).findByText(/^Blocked: Ollama is not reachable/)).toBeDefined();
    expect(main.textContent).toContain('SelectedOllama (local model)');
  });

  it('offers the installed models and saves the chosen one', async () => {
    const { source, save } = live(settings({ provider: 'ollama' }));
    renderAt('#/settings', source);
    const select = await screen.findByLabelText('Ollama model');
    await within(select).findByRole('option', { name: 'other:1b' });
    fireEvent.change(select, { target: { value: 'other:1b' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save provider' }));
    await screen.findByText(/Saved\./);
    expect(save).toHaveBeenCalledWith({ provider: 'ollama', ollamaModel: 'other:1b' });
  });

  it('says so when no model is installed, and still allows selecting Ollama', async () => {
    const { source } = live(settings({ provider: 'ollama' }), {
      models: [],
      runnable: false,
      reason: 'no models',
    });
    renderAt('#/settings', source);
    expect(await screen.findByText(/No installed model was found/)).toBeDefined();
  });

  it('shows a refused save as an alert and does not claim it was saved', async () => {
    const source = sourceWith({
      getSettings: () => Promise.resolve(settings()),
      getProviderStatus: () => Promise.resolve(providerStatus()),
      saveSettings: () => Promise.reject(new Error('the request is not valid')),
    });
    renderAt('#/settings', source);
    fireEvent.click(await radio(/Ollama/));
    fireEvent.click(screen.getByRole('button', { name: 'Save provider' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Not saved: the request is not valid',
    );
    expect(screen.queryByText(/Saved\./)).toBeNull();
  });

  it('cannot change a provider that is pinned outside the console', async () => {
    const { source } = live(settings({ pinned: true }), { pinned: true });
    renderAt('#/settings', source);
    expect(await screen.findByText(/cannot be changed here/)).toBeDefined();
    expect(screen.getByRole('radio', { name: /Ollama/ })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Save provider' })).toHaveProperty('disabled', true);
  });

  it('declares Fake output simulated', async () => {
    const { source } = live(settings());
    renderAt('#/settings', source);
    expect(await screen.findByText(/simulated/, { selector: 'strong' })).toBeDefined();
  });

  it('shows the readiness as checking, unreadable, or without a reason, and can check again', async () => {
    const pending = deferred<ProviderStatus>();
    const status = vi.fn(() => pending.promise);
    renderAt('#/settings', sourceWith({ getProviderStatus: status }));
    expect(screen.getByRole('main').textContent).toContain('Loading provider status');
    pending.resolve(
      providerStatus({ selected: 'ollama', runnable: false, simulated: false, reason: null }),
    );
    expect(await screen.findByText('Blocked: not ready')).toBeDefined();
    status.mockImplementation(() => Promise.reject(new Error('down')));
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(await screen.findByText('down')).toBeDefined();
    status.mockImplementation(() => Promise.resolve(providerStatus()));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Ready to run')).toBeDefined();
  });

  it('shows a settings load failure with a retry', async () => {
    const getSettings = vi.fn(() => Promise.reject(new Error('settings down')));
    renderAt('#/settings', sourceWith({ getSettings }));
    expect(await screen.findByText('settings down')).toBeDefined();
    getSettings.mockImplementation(() => Promise.resolve(settings()) as never);
    fireEvent.click(screen.getAllByRole('button', { name: 'Retry' })[0] as HTMLElement);
    expect(await radio(/Fake/)).toBeDefined();
  });
});
