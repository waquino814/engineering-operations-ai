// @vitest-environment jsdom
import { act, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFixtureSource } from '../../src/ui/data/fixture-source.ts';
import { fixtures } from './support.tsx';

/** The entry point mounts the console over the local application, or over fixtures on request. */
afterEach(() => {
  document.body.innerHTML = '';
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('the entry point', () => {
  it('mounts the console over the local application by default', async () => {
    const fetchSpy = vi.fn(() => Promise.resolve(new Response('{"runs":[]}')));
    vi.stubGlobal('fetch', fetchSpy);
    document.body.innerHTML = '<div id="root"></div>';
    await act(async () => {
      await import('../../src/ui/main.tsx');
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Investigations' })).toBeDefined();
    expect(screen.getByRole('banner').textContent).toContain('Local');
    expect(await screen.findByText('No investigations yet')).toBeDefined();
    expect(fetchSpy).toHaveBeenCalledWith('/api/runs', undefined);
  });

  it('shows a failed request as an error, not as an empty or successful list', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')));
    document.body.innerHTML = '<div id="root"></div>';
    await act(async () => {
      await import('../../src/ui/main.tsx');
    });
    expect(await screen.findByText(/could not be reached/)).toBeDefined();
    expect(screen.queryByText('No investigations yet')).toBeNull();
  });

  it('mounts over the committed fixtures when asked to', async () => {
    vi.stubEnv('VITE_EOAI_SOURCE', 'fixture');
    document.body.innerHTML = '<div id="root"></div>';
    await act(async () => {
      await import('../../src/ui/main.tsx');
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Investigations' })).toBeDefined();
    expect(screen.getByRole('banner').textContent).toContain('Fixture');
  });

  it('does nothing on a page without #root, and can mount anywhere', async () => {
    const { mount } = await import('../../src/ui/main.tsx');
    expect(document.body.children).toHaveLength(0);
    const element = document.createElement('div');
    document.body.append(element);
    let root: ReturnType<typeof mount> | undefined;
    await act(async () => {
      root = mount(element, createFixtureSource(fixtures));
      await Promise.resolve();
    });
    expect(element.textContent).toContain('Investigation console');
    act(() => {
      root?.unmount();
    });
  });
});
