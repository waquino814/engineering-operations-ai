import { describe, expect, it, vi } from 'vitest';
import config, { presentAsSameOrigin } from '../vite.config.ts';

/** The dev proxy forwards the console's calls to the local application (`pnpm serve`). */
describe('the dev proxy', () => {
  it('forwards /api and /healthz to the loopback application only', () => {
    const proxy = (config.server?.proxy ?? {}) as Record<
      string,
      { target: string; changeOrigin: boolean }
    >;
    expect(Object.keys(proxy).sort()).toEqual(['/api', '/healthz']);
    for (const p of Object.values(proxy)) {
      expect(p.target).toBe('http://127.0.0.1:8787');
      // Without it the Host header is the dev server's, which the application refuses.
      expect(p.changeOrigin).toBe(true);
    }
  });

  it('gives a proxied browser request the application’s own origin, and adds none otherwise', () => {
    let listener: (req: {
      getHeader(n: string): unknown;
      setHeader(n: string, v: string): unknown;
    }) => void = () => undefined;
    presentAsSameOrigin({ on: (_e, l) => void (listener = l) });
    const withOrigin = { getHeader: () => 'http://localhost:5180', setHeader: vi.fn() };
    listener(withOrigin);
    expect(withOrigin.setHeader).toHaveBeenCalledWith('origin', 'http://127.0.0.1:8787');
    const without = { getHeader: () => undefined, setHeader: vi.fn() };
    listener(without);
    expect(without.setHeader).not.toHaveBeenCalled();
  });
});
