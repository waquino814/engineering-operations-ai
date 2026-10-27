import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { request } from 'node:http';
import { createServer, connect } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApplication } from '../../src/app/application.ts';
import { openEvidence } from '../../src/index.ts';
import { readInvestigationResult, type InvestigationResult } from '../../src/index.ts';
import { goodOutput } from '../investigation/support.ts';

/**
 * End to end, with real processes: `pnpm dev`'s script starts the application and Vite, and the
 * tests talk to them over loopback HTTP, through Vite's proxy as the browser does. HOME points at
 * a temporary directory, so the default data location is exercised without touching the real one
 * and no EOAI_* path is set. Every process started here is stopped, even on failure. No browser
 * is driven (the console's views are covered by jsdom tests), and no AI provider is involved.
 */
const root = new URL('../../', import.meta.url).pathname;
const run = promisify(execFile);
const children = new Set<ChildProcess>();
const EXCERPT = 'provider-outage-42-20261026T122230Z';
const TAMPERED = 'tampered-42-20260101T000000Z';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => {
        resolve(port);
      });
    });
  });
}

/** The fields of the application's JSON bodies that the tests read. */
interface Doc {
  bundles: { id: string }[];
  runs: { id: string; ok: boolean }[];
  result: unknown;
  error: { code: string };
  [key: string]: unknown;
}
interface Reply {
  status: number;
  type: string;
  text: string;
  json: () => Doc;
}
function http(
  port: number,
  method: string,
  path: string,
  opts: { body?: string; headers?: Record<string, string>; host?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: opts.host ?? '127.0.0.1', port, method, path, headers: opts.headers },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          text += c;
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            type: res.headers['content-type'] ?? '',
            text,
            json: () => JSON.parse(text) as Doc,
          });
        });
      },
    );
    req.on('error', reject);
    req.end(opts.body);
  });
}
const post = (port: number, body: string, headers: Record<string, string> = {}) =>
  http(port, 'POST', '/api/investigations', {
    body,
    headers: { 'content-type': 'application/json', ...headers },
  });

async function until<T>(what: string, probe: () => Promise<T | null>, ms = 40_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const v = await probe();
      if (v !== null) return v;
    } catch {
      // not ready yet
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

interface Proc {
  child: ChildProcess;
  log: () => string;
  exited: Promise<number | null>;
}
function start(args: string[], env: Record<string, string>): Proc {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: { PATH: process.env['PATH'] ?? '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  let out = '';
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (c: Buffer) => {
      out += c.toString();
    });
  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => {
      children.delete(child);
      resolve(code);
    });
  });
  return { child, log: () => out, exited };
}
async function stop(p: Proc): Promise<number | null> {
  p.child.kill('SIGTERM');
  return Promise.race([
    p.exited,
    new Promise<null>((r) => {
      setTimeout(() => {
        r(null);
      }, 15_000);
    }),
  ]);
}
const closed = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = connect({ host: '127.0.0.1', port });
    s.once('connect', () => {
      s.destroy();
      resolve(false);
    });
    s.once('error', () => {
      resolve(true);
    });
  });

let home: string;
let apiPort: number;
let uiPort: number;
let env: Record<string, string>;
let dev: Proc;
let readyMark = 0;
const data = () => join(home, '.engineering-operations-ai');

async function startDev() {
  dev = start(['scripts/dev.ts'], env);
  await until('the console through the proxy', async () => {
    const r = await http(uiPort, 'GET', '/healthz');
    return r.status === 200 ? r : null;
  });
  // Vite may log proxy errors while the probe above polls before the application is listening;
  // that is expected, and only what is logged from here on counts.
  readyMark = dev.log().length;
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'eoai-e2e-'));
  [apiPort, uiPort] = [await freePort(), await freePort()];
  env = { HOME: home, EOAI_PORT: String(apiPort), EOAI_UI_PORT: String(uiPort) };
});
afterAll(async () => {
  for (const c of children) c.kill('SIGKILL');
  await rm(home, { recursive: true, force: true });
});

describe('local workflow, as real processes', { timeout: 120_000 }, () => {
  it('starts cleanly with no path exports, creates private data directories, and loads the console', async () => {
    await startDev();
    for (const d of ['bundles', 'runs']) {
      const s = await stat(join(data(), d));
      expect(s.isDirectory()).toBe(true);
      expect(s.mode & 0o077).toBe(0);
    }
    const page = await http(uiPort, 'GET', '/');
    expect(page.status).toBe(200);
    expect(page.text).toContain('<div id="root">');
    const entry = /src="([^"]*main\.tsx[^"]*)"/.exec(page.text)?.[1] ?? '';
    expect(entry).not.toBe('');
    const mod = await http(uiPort, 'GET', entry.replace(/^\./, ''));
    expect(mod.status).toBe(200);
    expect(mod.type).toContain('javascript');
  });

  it('is honest while empty: no bundles, no runs, and no runnable provider', async () => {
    expect((await http(uiPort, 'GET', '/api/bundles')).json()).toEqual({ bundles: [] });
    expect((await http(uiPort, 'GET', '/api/runs')).json()).toEqual({ runs: [] });
    const status = (await http(uiPort, 'GET', '/api/status')).json();
    expect(status).toMatchObject({ provider: 'fake', runnable: false });
    expect(String(status['reason'])).toContain('Nothing was run');
  });

  it('seeds the synthetic bundles once, never overwriting, then lists and validates them', async () => {
    const first = await run(process.execPath, ['scripts/seed-demo.ts'], { cwd: root, env });
    expect(first.stdout).toContain(`added: ${EXCERPT}`);
    const again = await run(process.execPath, ['scripts/seed-demo.ts'], { cwd: root, env });
    expect(again.stdout).toContain(`skipped (exists): ${EXCERPT}`);
    expect(again.stdout).not.toContain('added:');

    const ids = (await http(uiPort, 'GET', '/api/bundles')).json().bundles.map((b) => b.id);
    expect(ids).toEqual(expect.arrayContaining([EXCERPT, TAMPERED]));

    const ok = await http(uiPort, 'GET', `/api/bundles/${EXCERPT}/validation`);
    expect(ok.json()).toMatchObject({
      valid: true,
      issues: [],
      metadata: { caseId: expect.any(String) as string },
    });
    const bad = await http(uiPort, 'GET', `/api/bundles/${TAMPERED}/validation`);
    expect(bad.json()).toMatchObject({ valid: false, metadata: null });
    for (const r of [ok, bad]) {
      expect(r.text).not.toContain(home);
      expect(r.text).not.toContain('ground_truth');
    }
  });

  it('refuses to start an investigation with no runnable provider, and stores nothing', async () => {
    const r = await post(uiPort, JSON.stringify({ bundleId: EXCERPT }), {
      origin: `http://localhost:${String(uiPort)}`,
    });
    expect(r.status).toBe(409);
    expect(r.json()).toMatchObject({ error: { code: 'no_runnable_provider' } });
    expect(r.json()).not.toHaveProperty('runId');
    expect((await http(uiPort, 'GET', '/api/runs')).json()).toEqual({ runs: [] });
  });

  it('rejects malformed requests, bad ids and missing things with structured errors', async () => {
    const cases: [Promise<Reply>, number, string][] = [
      [post(uiPort, '{oops'), 400, 'bad_request'],
      [post(uiPort, '{"bundleId":"a","extra":1}'), 400, 'bad_request'],
      // The provider gate answers before the id is even looked at.
      [post(uiPort, JSON.stringify({ bundleId: '../x' })), 409, 'no_runnable_provider'],
      [
        http(uiPort, 'POST', '/api/investigations', {
          body: '{}',
          headers: { 'content-type': 'text/plain' },
        }),
        415,
        'unsupported_media_type',
      ],
      [http(uiPort, 'GET', '/api/runs/..%2f..%2fetc'), 400, 'invalid_run_id'],
      [http(uiPort, 'GET', '/api/runs/20261027T000000Z-nocase'), 404, 'run_not_found'],
      [http(uiPort, 'GET', '/api/bundles/nope/validation'), 404, 'bundle_not_found'],
      [http(uiPort, 'PUT', '/api/runs'), 405, 'method_not_allowed'],
    ];
    for (const [pending, status, code] of cases) {
      const r = await pending;
      expect([r.status, r.json().error.code]).toEqual([status, code]);
      expect(r.text).not.toContain(home);
    }
  });

  it('enforces Host and Origin on the application itself and binds to loopback only', async () => {
    const evilHost = await http(apiPort, 'GET', '/healthz', { headers: { host: 'evil.example' } });
    expect(evilHost.status).toBe(403);
    const foreign = await post(apiPort, JSON.stringify({ bundleId: EXCERPT }), {
      host: `127.0.0.1:${String(apiPort)}`,
      origin: 'http://evil.example',
    });
    expect(foreign.status).toBe(403);
    const lan = Object.values(networkInterfaces())
      .flat()
      .find((i) => i && i.family === 'IPv4' && !i.internal);
    if (lan) expect(await closed2(lan.address, apiPort)).toBe(true);
  });

  it('keeps a stored run across navigation and restart, citing only evidence that is in the bundle', async () => {
    // A run made by the application layer with a scripted fake provider, as the tests do:
    // the CLI has no scripted replies, so no investigation can be produced by the product itself.
    const bundles = join(data(), 'bundles');
    const view = await openEvidence(join(bundles, EXCERPT));
    const app = createApplication(
      { EOAI_BUNDLES_DIR: bundles, EOAI_RUNS_DIR: join(data(), 'runs') },
      { fakeSteps: [{ reply: goodOutput(view) }] },
    );
    const started = await app.startInvestigation(EXCERPT);
    if (started.status !== 'done') throw new Error('expected a stored run');

    const check = async () => {
      const list = (await http(uiPort, 'GET', '/api/runs')).json().runs;
      expect(list.map((r) => r.id)).toEqual([started.runId]);
      const got = (await http(uiPort, 'GET', `/api/runs/${started.runId}`)).json();
      const read = readInvestigationResult(got.result);
      expect(read.ok).toBe(true);
      return read.ok ? read.result : null;
    };
    const before = await check();
    await check(); // navigating away and back
    expect(await stop(dev)).toBe(0);
    expect(await closed(apiPort)).toBe(true);
    expect(await closed(uiPort)).toBe(true);
    await startDev();
    expect(await check()).toEqual(before);

    // Every citation resolves to a real line of the bundle and quotes values found on it.
    const result = before as InvestigationResult;
    expect(result.run.provider).toBe('fake');
    expect(result.findings.length).toBeGreaterThan(0);
    for (const finding of result.findings)
      for (const ref of finding.evidence) {
        const lines = (await readFile(join(bundles, EXCERPT, ref.file), 'utf8')).split('\n');
        const text = lines[ref.line - 1] ?? '';
        expect(text, `${ref.file}:${String(ref.line)}`).not.toBe('');
        const quoted = [
          ref.time,
          ref.service,
          ref.traceId,
          ref.spanId,
          ref.series?.name,
          ...Object.values(ref.series?.labels ?? {}),
        ];
        for (const q of quoted) if (q !== undefined) expect(text).toContain(q);
      }
  });

  it('shuts down cleanly and leaves no listener behind', async () => {
    expect(await stop(dev)).toBe(0);
    expect(dev.child.exitCode).toBe(0);
    expect(await closed(apiPort)).toBe(true);
    expect(await closed(uiPort)).toBe(true);
    expect(dev.log().slice(readyMark)).not.toMatch(/error/i);
  });
});

describe(
  'unavailable application and recovery, through the dev proxy',
  { timeout: 120_000 },
  () => {
    it('answers 502 while the application is down and recovers when it returns', async () => {
      const dataDir = await mkdtemp(join(tmpdir(), 'eoai-e2e-rec-'));
      await mkdir(dataDir, { recursive: true });
      const [api, ui] = [await freePort(), await freePort()];
      const e = { HOME: dataDir, EOAI_PORT: String(api) };
      const vite = start(
        [
          'node_modules/vite/bin/vite.js',
          '--host',
          '127.0.0.1',
          '--port',
          String(ui),
          '--strictPort',
        ],
        e,
      );
      let server: Proc | undefined;
      try {
        await until('vite', async () =>
          (await http(ui, 'GET', '/')).status === 200 ? true : null,
        );
        const down = await http(ui, 'GET', '/api/runs');
        expect(down.status).toBe(502);
        server = start(['src/cli.ts', 'serve'], e);
        const up = await until('the application', async () => {
          const r = await http(ui, 'GET', '/api/runs');
          return r.status === 200 ? r : null;
        });
        expect(up.json()).toEqual({ runs: [] });
        expect(await stop(server)).toBe(0);
        expect((await http(ui, 'GET', '/api/runs')).status).toBe(502);
      } finally {
        for (const p of [server, vite]) p?.child.kill('SIGKILL');
        await rm(dataDir, { recursive: true, force: true });
      }
    });
  },
);

function closed2(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host, port });
    s.once('connect', () => {
      s.destroy();
      resolve(false);
    });
    s.once('error', () => {
      resolve(true);
    });
  });
}
