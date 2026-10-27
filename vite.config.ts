import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/**
 * The investigation console's build (ADR 0011): `pnpm ui:dev` serves it, `pnpm ui:build` writes
 * dist/ui/. No plugins: Vite's built-in transform handles TSX. Only the console is built; the
 * library and CLI still run from source.
 */
// The application's port: EOAI_PORT, as for `serve`, so the proxy follows it.
const rawPort = process.env['EOAI_PORT'];
const API_PORT = rawPort !== undefined && /^\d{1,5}$/.test(rawPort) ? Number(rawPort) : 8787;
const API_ORIGIN = `http://127.0.0.1:${String(API_PORT)}`;

interface ProxyRequest {
  getHeader(name: string): unknown;
  setHeader(name: string, value: string): unknown;
}

/**
 * The application serves only its own loopback Host names and accepts a browser POST only from its
 * own origin (`changeOrigin` rewrites Host to the target's). Behind this dev proxy the
 * browser's origin is the dev server's, so the proxied request carries the application's own.
 * The application's checks are unchanged.
 */
export function presentAsSameOrigin(proxy: {
  on(event: 'proxyReq', listener: (req: ProxyRequest) => void): unknown;
}) {
  proxy.on('proxyReq', (req) => {
    if (req.getHeader('origin') !== undefined) req.setHeader('origin', API_ORIGIN);
  });
}

export default defineConfig({
  root: fileURLToPath(new URL('./src/ui/', import.meta.url)),
  base: './',
  // Development only: forward the console's API calls to the local application (`pnpm serve`).
  server: {
    proxy: {
      '/api': { target: API_ORIGIN, changeOrigin: true, configure: presentAsSameOrigin },
      '/healthz': { target: API_ORIGIN, changeOrigin: true, configure: presentAsSameOrigin },
    },
  },
  build: {
    outDir: fileURLToPath(new URL('./dist/ui/', import.meta.url)),
    emptyOutDir: true,
  },
});
