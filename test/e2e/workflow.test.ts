import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer as createHttpServer, request } from 'node:http';
import { createServer, connect } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

/**
 * A stand-in for the local Ollama runtime: a real loopback HTTP server in this process, speaking
 * the three endpoints the adapter uses. No model and no inference are involved.
 */
interface OllamaStubServer {
  port: number;
  chats: number;
  close(): Promise<void>;
}
async function startOllamaStub(chatText: () => string): Promise<OllamaStubServer> {
  const state = { chats: 0 };
  const server = createHttpServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      const send = (status: number, doc: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(doc));
      };
      if (req.url === '/api/status') {
        send(200, { cloud: { disabled: true, source: 'env' } });
        return;
      }
      if (req.url === '/api/tags') {
        send(200, {
          models: [
            {
              name: 'tiny:1b',
              model: 'tiny:1b',
              modified_at: '2026-01-01T00:00:00Z',
              size: 7_000_000_000,
              digest: 'abc',
              details: {},
              capabilities: [],
            },
          ],
        });
        return;
      }
      if (req.url === '/api/show') {
        send(200, { details: {}, model_info: { a: 1 }, capabilities: [] });
        return;
      }
      if (req.url === '/api/chat') {
        state.chats += 1;
        send(200, {
          message: { role: 'assistant', content: chatText() },
          done: true,
          prompt_eval_count: 100,
          eval_count: 50,
        });
        return;
      }
      send(404, {});
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as { port: number }).port,
    get chats() {
      return state.chats;
    },
    close: () =>
      new Promise<void>((r) => {
        server.close(() => {
          r();
        });
        server.closeAllConnections();
      }),
  };
}

let home: string;
let apiPort: number;
let uiPort: number;
let env: Record<string, string>;
let dev: Proc;
let readyMark = 0;
let fakeRunId = '';
let ollamaRunId = '';
let ollamaText = '';
let realEvaluationId = '';
let scriptedEvaluationId = '';

/** The application re-reads the cited records from the bundle: every citation verifies, no model runs. */
async function citationsRecheck(runId: string) {
  const r = await http(uiPort, 'GET', `/api/runs/${runId}/evidence`);
  expect(r.status).toBe(200);
  const body = r.json() as unknown as {
    status: string;
    citations: { status: string; excerpt: string }[];
  };
  expect(body.status).toBe('checked');
  expect(body.citations.length).toBeGreaterThan(0);
  expect(body.citations.every((c) => c.status === 'verified' && c.excerpt.length > 0)).toBe(true);
}

/** Every citation resolves to a real line of the bundle and quotes values found on it. */
async function citationsAreInTheBundle(result: InvestigationResult) {
  expect(result.findings.length).toBeGreaterThan(0);
  for (const finding of result.findings)
    for (const ref of finding.evidence) {
      const lines = (await readFile(join(data(), 'bundles', EXCERPT, ref.file), 'utf8')).split(
        '\n',
      );
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
}
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

  it('starts empty, with Fake selected and its output declared simulated', async () => {
    expect((await http(uiPort, 'GET', '/api/bundles')).json()).toEqual({ bundles: [] });
    expect((await http(uiPort, 'GET', '/api/runs')).json()).toEqual({ runs: [] });
    expect((await http(uiPort, 'GET', '/api/settings')).json()).toMatchObject({
      provider: 'fake',
      ollamaModel: null,
      pinned: false,
    });
    expect((await http(uiPort, 'GET', '/api/status')).json()).toMatchObject({
      selected: 'fake',
      runnable: true,
      simulated: true,
    });
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

  it('runs Fake end to end through the proxy: simulated, persisted, labelled', async () => {
    const r = await post(uiPort, JSON.stringify({ bundleId: EXCERPT }), {
      origin: `http://localhost:${String(uiPort)}`,
    });
    expect(r.status).toBe(201);
    fakeRunId = String(r.json()['runId']);
    const got = (await http(uiPort, 'GET', `/api/runs/${fakeRunId}`)).json();
    const read = readInvestigationResult(got.result);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.result.run).toMatchObject({
      provider: 'fake',
      model: 'simulated-deterministic-v1',
    });
    expect(read.result.limitations.join(' ')).toContain('SIMULATED');
    expect(read.result.findings.map((f) => f.kind)).toEqual(['symptom']);
    await citationsAreInTheBundle(read.result);
    await citationsRecheck(fakeRunId);
  });

  it('runs a scripted evaluation through the proxy, stores it, and labels it as a test double', async () => {
    const suites = (await http(uiPort, 'GET', '/api/evaluation-suites')).json()['suites'] as {
      id: string;
    }[];
    expect(suites.map((x) => x.id)).toEqual(['development', 'held-out']);
    const r = await http(uiPort, 'POST', '/api/evaluations', {
      body: JSON.stringify({ suiteId: 'development', provider: 'scripted' }),
      headers: { 'content-type': 'application/json', origin: `http://localhost:${String(uiPort)}` },
    });
    expect(r.status).toBe(201);
    scriptedEvaluationId = String(r.json()['id']);
    const doc = (await http(uiPort, 'GET', `/api/evaluations/${scriptedEvaluationId}`)).json()[
      'evaluation'
    ] as {
      provider: { kind: string; simulated: boolean };
      measuresModelQuality: boolean;
      suite: { split: string };
      metrics: { id: string; numerator: number | null; denominator: number }[];
    };
    expect(doc).toMatchObject({
      provider: { kind: 'scripted', simulated: true },
      measuresModelQuality: false,
      suite: { split: 'development' },
    });
    expect(doc.metrics.find((m) => m.id === 'root_cause_correct')).toMatchObject({
      numerator: 3,
      denominator: 7,
    });
  });

  it('rejects malformed requests, bad ids and missing things with structured errors', async () => {
    const cases: [Promise<Reply>, number, string][] = [
      [post(uiPort, '{oops'), 400, 'bad_request'],
      [post(uiPort, '{"bundleId":"a","extra":1}'), 400, 'bad_request'],
      [post(uiPort, JSON.stringify({ bundleId: '../x' })), 400, 'invalid_bundle_id'],
      [
        http(uiPort, 'PUT', '/api/settings', {
          body: '{"provider":"anthropic"}',
          headers: { 'content-type': 'application/json' },
        }),
        400,
        'bad_request',
      ],
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

  it('selects Ollama, keeps the choice across a restart, and runs through the local runtime', async () => {
    const stub = await startOllamaStub(() => ollamaText);
    try {
      // The application is restarted so that it reaches the stub runtime, as it would the real one.
      expect(await stop(dev)).toBe(0);
      env = { ...env, EOAI_OLLAMA_URL: `http://127.0.0.1:${String(stub.port)}` };
      await startDev();
      const put = await http(uiPort, 'PUT', '/api/settings', {
        body: '{"provider":"ollama","ollamaModel":null}',
        headers: { 'content-type': 'application/json' },
      });
      expect(put.json()).toMatchObject({ provider: 'ollama' });
      expect((await http(uiPort, 'GET', '/api/status')).json()).toMatchObject({
        selected: 'ollama',
        runnable: true,
        simulated: false,
        model: 'tiny:1b',
      });

      // The choice survives a restart.
      expect(await stop(dev)).toBe(0);
      await startDev();
      expect((await http(uiPort, 'GET', '/api/settings')).json()).toMatchObject({
        provider: 'ollama',
      });

      // A model reply that cites real records is accepted, stored, and labelled as Ollama's.
      const view = await openEvidence(join(data(), 'bundles', EXCERPT));
      ollamaText = JSON.stringify(goodOutput(view));
      const r = await post(uiPort, JSON.stringify({ bundleId: EXCERPT }));
      expect(r.status).toBe(201);
      ollamaRunId = String(r.json()['runId']);
      expect(stub.chats).toBe(1);
      const stored = readInvestigationResult(
        (await http(uiPort, 'GET', `/api/runs/${ollamaRunId}`)).json().result,
      );
      expect(stored.ok).toBe(true);
      if (!stored.ok) return;
      expect(stored.result.run).toMatchObject({ provider: 'ollama', model: 'tiny:1b' });
      expect(stored.result.outcome).toBe('completed');
      await citationsAreInTheBundle(stored.result);
      await citationsRecheck(ollamaRunId);

      // A reply that cites a record the bundle does not have is rejected, never repaired into success.
      const good = goodOutput(view);
      const [first] = good.findings;
      if (!first) throw new Error('the scripted output has a finding');
      ollamaText = JSON.stringify(
        goodOutput(view, {
          findings: [
            {
              ...first,
              evidence: [{ file: 'logs.jsonl', line: 999, time: 't', service: 'worker' }],
            },
          ],
        }),
      );
      const bad = await post(uiPort, JSON.stringify({ bundleId: EXCERPT }));
      expect(bad.status).toBe(201);
      const badRun = readInvestigationResult(
        (await http(uiPort, 'GET', `/api/runs/${String(bad.json()['runId'])}`)).json().result,
      );
      expect(badRun.ok && badRun.result.outcome).toBe('failed');
      expect(badRun.ok && badRun.result.findings).toEqual([]);

      // An evaluation of the held-out suite through the same verified runtime is recorded as a
      // real model's, and a reply that cites nothing real is a miss, not a success.
      const evaluated = await http(uiPort, 'POST', '/api/evaluations', {
        body: JSON.stringify({ suiteId: 'held-out', provider: 'ollama' }),
        headers: { 'content-type': 'application/json' },
      });
      expect(evaluated.status).toBe(201);
      realEvaluationId = String(evaluated.json()['id']);
      const doc = (await http(uiPort, 'GET', `/api/evaluations/${realEvaluationId}`)).json()[
        'evaluation'
      ] as {
        provider: { kind: string; model: string; simulated: boolean };
        measuresModelQuality: boolean;
        report: { cases: { summary: { outcome: string }; failure: { class: string } | null }[] };
      };
      expect(doc.provider).toEqual({
        kind: 'real_model',
        provider: 'ollama',
        model: 'tiny:1b',
        simulated: false,
      });
      expect(doc.measuresModelQuality).toBe(true);
      expect(doc.report.cases[0]?.summary.outcome).toBe('failed');
    } finally {
      await stub.close();
    }

    // The runtime is gone: selecting Ollama stays possible, the run is refused, nothing falls back.
    const before = (await http(uiPort, 'GET', '/api/runs')).json().runs.length;
    const status = (await http(uiPort, 'GET', '/api/status')).json();
    expect(status).toMatchObject({ selected: 'ollama', runnable: false });
    const refused = await post(uiPort, JSON.stringify({ bundleId: EXCERPT }));
    expect([refused.status, refused.json().error.code]).toEqual([409, 'provider_blocked']);
    const evalRefused = await http(uiPort, 'POST', '/api/evaluations', {
      body: JSON.stringify({ suiteId: 'development', provider: 'ollama' }),
      headers: { 'content-type': 'application/json' },
    });
    expect([evalRefused.status, evalRefused.json().error.code]).toEqual([409, 'provider_blocked']);
    expect((await http(uiPort, 'GET', '/api/runs')).json().runs.length).toBe(before);
  });

  it('switches back to Fake without touching earlier results, across a restart', async () => {
    await http(uiPort, 'PUT', '/api/settings', {
      body: '{"provider":"fake"}',
      headers: { 'content-type': 'application/json' },
    });
    expect(await stop(dev)).toBe(0);
    expect(await closed(apiPort)).toBe(true);
    expect(await closed(uiPort)).toBe(true);
    await startDev();
    expect((await http(uiPort, 'GET', '/api/settings')).json()).toMatchObject({ provider: 'fake' });
    const runs = (await http(uiPort, 'GET', '/api/runs')).json().runs;
    const byId = new Map(runs.map((r) => [r.id, r]));
    for (const id of [fakeRunId, ollamaRunId]) expect(byId.get(id)).toMatchObject({ ok: true });
    const providers = await Promise.all(
      [fakeRunId, ollamaRunId].map(async (id) => {
        const r = readInvestigationResult(
          (await http(uiPort, 'GET', `/api/runs/${id}`)).json().result,
        );
        return r.ok ? r.result.run.provider : null;
      }),
    );
    expect(providers).toEqual(['fake', 'ollama']);
    // Stored evaluations survive the restart too, and reopening one runs nothing.
    const evaluations = (await http(uiPort, 'GET', '/api/evaluations')).json()['evaluations'] as {
      id: string;
      ok: boolean;
      provider: { kind: string };
    }[];
    expect(
      evaluations
        .filter((e) => e.ok)
        .map((e) => [e.id, e.provider.kind])
        .sort(),
    ).toEqual(
      [
        [scriptedEvaluationId, 'scripted'],
        [realEvaluationId, 'real_model'],
      ].sort(),
    );
    const compare = await http(
      uiPort,
      'GET',
      `/api/evaluations/${scriptedEvaluationId}/compare/${scriptedEvaluationId}`,
    );
    expect(compare.status).toBe(200);
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
