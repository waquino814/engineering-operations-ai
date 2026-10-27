import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/**
 * The investigation console's build (ADR 0011): `pnpm ui:dev` serves it, `pnpm ui:build` writes
 * dist/ui/. No plugins: Vite's built-in transform handles TSX. Only the console is built; the
 * library and CLI still run from source.
 */
export default defineConfig({
  root: fileURLToPath(new URL('./src/ui/', import.meta.url)),
  base: './',
  // Development only: forward the console's API calls to the local application (`pnpm serve`).
  server: { proxy: { '/api': 'http://127.0.0.1:8787', '/healthz': 'http://127.0.0.1:8787' } },
  build: {
    outDir: fileURLToPath(new URL('./dist/ui/', import.meta.url)),
    emptyOutDir: true,
  },
});
