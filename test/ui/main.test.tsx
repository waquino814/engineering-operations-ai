// @vitest-environment jsdom
import { act, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** The entry point mounts the console over the committed fixtures. */
afterEach(() => {
  document.body.innerHTML = '';
  vi.resetModules();
});

describe('the entry point', () => {
  it('mounts the console into #root when the page has one', async () => {
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
      root = mount(element);
      await Promise.resolve();
    });
    expect(element.textContent).toContain('Investigation console');
    act(() => {
      root?.unmount();
    });
  });
});
