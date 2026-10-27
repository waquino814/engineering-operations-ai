import { spawn, type ChildProcess } from 'node:child_process';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { claimPort } from './ports.ts';

/**
 * `pnpm dev` and `pnpm ui:dev`: the local application and the console's dev server together, with
 * nothing to export. The application listens on loopback (EOAI_PORT, default 8787) and keeps its
 * data under ~/.engineering-operations-ai; Vite starts only once the application answers, serves
 * the console on loopback (`--port`, or EOAI_UI_PORT, default 5173) and proxies /api to it.
 * If the application cannot start, its own message is shown and nothing else is started. Stopping
 * either stops both. No hosted AI provider is involved.
 */
const root = fileURLToPath(new URL('../', import.meta.url));
const apiPort = process.env['EOAI_PORT'] ?? '8787';
let uiPort = process.env['EOAI_UI_PORT'] ?? '5173';

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--strictPort') continue;
  if (args[i] === '--port' && args[i + 1] !== undefined) uiPort = args[++i] ?? uiPort;
  else {
    console.error(`unsupported argument "${args[i] ?? ''}"; supported: --port <n>`);
    process.exit(2);
  }
}

// Both ports are claimed before anything starts: free, or this repository's own previous
// instance (stopped), or an error that names the holder. Nothing else is ever stopped.
for (const [port, kind, label] of [
  [Number(apiPort), 'api', 'the application'],
  [Number(uiPort), 'ui', 'the console'],
] as const) {
  const claim = await claimPort(port, kind, root.replace(/\/$/, ''), label);
  if (!claim.ok) {
    console.error(claim.message);
    process.exit(1);
  }
  for (const o of claim.stopped)
    console.log(
      `stopped a previous instance of ${label} (pid ${String(o.pid)}) that held port ${String(port)}`,
    );
}

const children: ChildProcess[] = [];
const run = (name: string, scriptArgs: string[]): ChildProcess => {
  const child = spawn(process.execPath, scriptArgs, { cwd: root, stdio: 'inherit' });
  child.once('error', (e) => {
    console.error(`${name}: ${e.message}`);
  });
  children.push(child);
  return child;
};

let stopping = false as boolean;
const stop = (code: number) => {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
};
for (const sig of ['SIGINT', 'SIGTERM'] as const)
  process.once(sig, () => {
    stop(0);
  });

const probe = () =>
  new Promise<boolean>((resolve) => {
    const req = request(
      { host: '127.0.0.1', port: Number(apiPort), path: '/healthz', timeout: 1_000 },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on('error', () => {
      resolve(false);
    });
    req.on('timeout', () => {
      req.destroy();
    });
    req.end();
  });

/**
 * The application is supervised. A failure to start is fatal and shown (nothing else starts, so
 * there is never a console with a permanently dead API behind it). Once it has been up, a crash
 * or a stop restarts it after a short pause while the console stays up: the console shows
 * "not reachable" meanwhile and its Retry works as soon as the application is back. A crash loop
 * (more than five restarts in a minute) stops everything with an error.
 */
let ready = false as boolean;
const restarts: number[] = [];
function startApi(): void {
  const api = run('application', ['src/cli.ts', 'serve']);
  api.once('exit', (code, signal) => {
    if (stopping) return;
    if (!ready) {
      console.error(`the application stopped during startup (exit ${String(code ?? signal)})`);
      stop(code ?? 1);
      return;
    }
    const now = Date.now();
    restarts.push(now);
    while (restarts.length > 0 && now - (restarts[0] ?? now) > 60_000) restarts.shift();
    if (restarts.length > 5) {
      console.error('the application keeps stopping; giving up');
      stop(1);
      return;
    }
    console.error(`the application stopped (${String(code ?? signal)}); restarting it`);
    setTimeout(() => {
      if (!stopping) startApi();
    }, 500);
  });
}
startApi();

for (let i = 0; i < 100 && !ready && !stopping; i++) {
  ready = await probe();
  if (!ready) await new Promise((r) => setTimeout(r, 150));
}
if (!ready && !stopping) {
  console.error(`the application did not answer on 127.0.0.1:${apiPort} within 15 seconds`);
  stop(1);
}
if (ready) {
  const ui = run('console', [
    'node_modules/vite/bin/vite.js',
    '--host',
    '127.0.0.1',
    '--port',
    uiPort,
    '--strictPort',
  ]);
  ui.once('exit', (code) => {
    stop(code ?? 1);
  });
  console.log(`console: http://127.0.0.1:${uiPort}/  (application: http://127.0.0.1:${apiPort}/)`);
}
