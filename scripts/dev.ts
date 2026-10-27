import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * `pnpm dev`: the local application and the console's dev server together, with nothing to
 * export. The application listens on loopback (EOAI_PORT, default 8787) and keeps its data under
 * ~/.engineering-operations-ai; Vite serves the console (EOAI_UI_PORT, default 5173) and proxies
 * /api to the application. Stopping either stops both. No AI provider is involved.
 */
const root = fileURLToPath(new URL('../', import.meta.url));
const uiPort = process.env['EOAI_UI_PORT'] ?? '5173';
const apiPort = process.env['EOAI_PORT'] ?? '8787';
const run = (name: string, args: string[]): ChildProcess => {
  const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit' });
  child.once('error', (e) => {
    console.error(`${name}: ${e.message}`);
  });
  return child;
};

const api = run('application', ['src/cli.ts', 'serve']);
const ui = run('console', [
  'node_modules/vite/bin/vite.js',
  '--host',
  '127.0.0.1',
  '--port',
  uiPort,
  '--strictPort',
]);
console.log(`console: http://127.0.0.1:${uiPort}/  (application: http://127.0.0.1:${apiPort}/)`);

let stopping = false;
const stop = (code: number) => {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of [api, ui]) if (child.exitCode === null) child.kill('SIGTERM');
};
for (const sig of ['SIGINT', 'SIGTERM'] as const)
  process.once(sig, () => {
    stop(0);
  });
// If one half stops by itself, stop the other and report failure unless it was a clean exit.
for (const child of [api, ui])
  child.once('exit', (code) => {
    stop(code ?? 1);
  });
