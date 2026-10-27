import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppConfigError } from '../../src/app/config.ts';
import {
  resolveListenHost,
  resolveListenPort,
  ServerConfigError,
  startServer,
  type RunningServer,
} from '../../src/app/http-server.ts';
import { ProviderPolicyError } from '../../src/app/provider-gate.ts';
import { readInvestigationResult } from '../../src/investigation/result.ts';
import { ollamaStub, tempDir, workspace } from './support.ts';

/** The fields of the server's JSON bodies that the tests read. */
interface Doc {
  error: { code: string; message: string };
  [key: string]: unknown;
  runs: unknown;
  bundles: unknown;
  result: unknown;
  runId: string;
  outcome: string;
  valid: boolean;
  metadata: unknown;
}

/** Talks to the real loopback server with node:http (the suite stubs global fetch to throw). */
function call(
  server: RunningServer,
  method: string,
  path: string,
  opts: { body?: string | Buffer; headers?: Record<string, string>; host?: string } = {},
): Promise<{ status: number; headers: Record<string, unknown>; text: string; json: () => Doc }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: server.host,
        port: server.port,
        method,
        path,
        headers: { host: opts.host ?? `127.0.0.1:${String(server.port)}`, ...opts.headers },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          text += c;
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
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
const post = (s: RunningServer, body: unknown, headers: Record<string, string> = {}) =>
  call(s, 'POST', '/api/investigations', {
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
  });

async function serve(
  extra: Partial<Parameters<typeof startServer>[0]> & { steps?: 'good' | 'none' } = {},
) {
  const w = await workspace();
  const server = await startServer({
    env: w.env(),
    port: 0,
    ...(extra.steps === 'none' ? {} : { appDeps: { fakeSteps: w.steps } }),
    ...extra,
  });
  return { w, server };
}

describe('listen address', () => {
  it('accepts loopback literals and the localhost alias only', () => {
    expect(resolveListenHost(undefined)).toBe('127.0.0.1');
    expect(resolveListenHost('::1')).toBe('::1');
    expect(resolveListenHost('localhost')).toBe('127.0.0.1');
    for (const h of [
      '0.0.0.0',
      '::',
      '192.168.1.5',
      '10.0.0.1',
      'example.com',
      '',
      '127.0.0.2',
      '127.0.0.1 ',
    ])
      expect(() => resolveListenHost(h)).toThrow(ServerConfigError);
    expect(resolveListenPort(undefined)).toBe(8787);
    for (const p of [-1, 65_536, 1.5, Number.NaN])
      expect(() => resolveListenPort(p)).toThrow(ServerConfigError);
  });

  it('binds to loopback and fails closed on a bad host before listening', async () => {
    const { server } = await serve();
    try {
      expect(server.host).toBe('127.0.0.1');
      expect(server.port).toBeGreaterThan(0);
    } finally {
      await server.close();
    }
    const w = await workspace();
    await expect(startServer({ env: w.env(), host: '0.0.0.0', port: 0 })).rejects.toThrow(
      ServerConfigError,
    );
  });
});

describe('startup policy', () => {
  it.each([['anthropic'], ['local'], ['unknown'], ['Fake']])(
    'does not start for provider %s, and nothing is created',
    async (name) => {
      const w = await workspace();
      await expect(
        startServer({ env: w.env({ EOAI_MODEL_PROVIDER: name, ANTHROPIC_API_KEY: 'k' }), port: 0 }),
      ).rejects.toThrow(ProviderPolicyError);
      await expect(readFile(w.runsDir)).rejects.toThrow();
    },
  );

  it('does not start with an invalid configuration', async () => {
    await expect(startServer({ env: {}, port: 0 })).rejects.toThrow(AppConfigError);
  });
});

describe('request validation', () => {
  it('serves liveness without touching bundles, runs or providers', async () => {
    const { w, server } = await serve({ steps: 'none' });
    try {
      const r = await call(server, 'GET', '/healthz');
      expect(r.status).toBe(200);
      expect(r.json()).toEqual({ status: 'ok' });
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      await expect(readFile(w.runsDir)).rejects.toThrow();
    } finally {
      await server.close();
    }
  });

  it('rejects an unexpected Host header (DNS rebinding) on every route', async () => {
    const { server } = await serve();
    try {
      for (const host of [
        'evil.example',
        `evil.example:${String(server.port)}`,
        '127.0.0.1:1',
        '0.0.0.0',
      ])
        for (const path of ['/healthz', '/api/runs', '/api/bundles'])
          expect((await call(server, 'GET', path, { host })).status).toBe(403);
      const alias = await call(server, 'GET', '/healthz', {
        host: `localhost:${String(server.port)}`,
      });
      expect(alias.status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it('rejects wrong methods, content types, bodies and ids with stable errors', async () => {
    const { server } = await serve();
    try {
      for (const m of ['PUT', 'DELETE', 'PATCH', 'OPTIONS'])
        expect((await call(server, m, '/api/runs')).status).toBe(405);
      expect((await call(server, 'POST', '/healthz')).status).toBe(405);
      expect((await call(server, 'POST', '/api/runs')).status).toBe(405);
      expect((await call(server, 'GET', '/api/investigations')).status).toBe(405);
      expect((await call(server, 'GET', '/nope')).status).toBe(404);
      expect((await call(server, 'GET', '/api/nope')).status).toBe(404);

      const wrongType = await call(server, 'POST', '/api/investigations', {
        body: '{"bundleId":"x"}',
        headers: { 'content-type': 'text/plain' },
      });
      expect(wrongType.status).toBe(415);
      expect((await call(server, 'POST', '/api/investigations', { body: '{}' })).status).toBe(415);

      for (const body of [
        '{oops',
        '',
        '[]',
        '"x"',
        'null',
        '{}',
        '{"bundleId":1}',
        '{"bundleId":"a","extra":1}',
        '{"extra":1}',
      ])
        expect((await post(server, body)).status).toBe(400);

      const big = await post(server, JSON.stringify({ bundleId: 'x'.repeat(20_000) }));
      expect(big.status).toBe(413);
      expect(big.json().error.code).toBe('payload_too_large');

      for (const p of [
        '/api/runs/..%2f..%2fetc',
        '/api/runs/%E0%A4%A',
        '/api/runs/x',
        '/api/runs/a%00b',
      ])
        expect((await call(server, 'GET', p)).status).toBe(400);
      for (const p of [
        '/api/bundles/..%2f..%2fetc/validation',
        '/api/bundles/%E0%A4%A/validation',
        '/api/bundles/.hidden/validation',
      ])
        expect((await call(server, 'GET', p)).status).toBe(400);
      expect((await call(server, 'GET', '/api/runs/20261027T000000Z-nocase')).status).toBe(404);
      expect((await call(server, 'GET', '/api/bundles/missing/validation')).status).toBe(404);
      expect((await post(server, { bundleId: '../x' })).json().error.code).toBe(
        'invalid_bundle_id',
      );
    } finally {
      await server.close();
    }
  });

  it('refuses a cross-origin browser POST but accepts the console’s own origin', async () => {
    const { server } = await serve({ steps: 'none' });
    try {
      const foreign = await post(server, { bundleId: 'x' }, { origin: 'http://evil.example' });
      expect(foreign.status).toBe(403);
      const own = await post(
        server,
        { bundleId: 'x' },
        { origin: `http://127.0.0.1:${String(server.port)}` },
      );
      // Past the origin check; the bundle does not exist.
      expect(own.status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it('never discloses paths, stack traces, environment values or raw exception text', async () => {
    const w = await workspace();
    const server = await startServer({
      env: w.env({ ANTHROPIC_API_KEY: 'sk-ant-leak-check' }),
      port: 0,
      appDeps: {
        fakeSteps: w.steps,
        now: () => {
          throw new Error(`boom at ${w.bundlesDir} sk-ant-leak-check`);
        },
      },
    });
    try {
      const failures = [
        await post(server, { bundleId: w.excerptId }),
        await call(server, 'GET', '/api/runs/20261027T000000Z-nocase'),
        await post(server, '{oops'),
        await call(server, 'GET', '/nope'),
      ];
      expect(failures[0]?.status).toBe(500);
      expect(failures[0]?.json()).toEqual({
        error: { code: 'internal_error', message: 'unexpected error' },
      });
      for (const f of failures) {
        expect(Object.keys(f.json())).toEqual(['error']);
        for (const secret of [
          w.bundlesDir,
          w.runsDir,
          'sk-ant-leak-check',
          'boom',
          ' at ',
          'node_modules',
          '.ts:',
        ])
          expect(f.text).not.toContain(secret);
      }
    } finally {
      await server.close();
    }
  });
});

describe('status and settings', () => {
  it('keeps the selection and its readiness apart, without paths or secrets', async () => {
    const { w, server } = await serve({ steps: 'none' });
    try {
      const r = await call(server, 'GET', '/api/status');
      expect(r.status).toBe(200);
      expect(r.json()).toMatchObject({
        selected: 'fake',
        pinned: false,
        runnable: true,
        simulated: true,
        reason: null,
      });
      expect(r.text).not.toContain(w.bundlesDir);
      expect((await call(server, 'POST', '/api/status')).status).toBe(405);
    } finally {
      await server.close();
    }
  });

  it('saves a valid selection, validates it on the server, and keeps it across a restart', async () => {
    const w = await workspace();
    const stub = ollamaStub({ models: [{ name: 'tiny:1b' }] });
    const start = () =>
      startServer({ env: w.env(), port: 0, appDeps: { ollamaFetch: stub.fetch } });
    let server = await start();
    try {
      expect((await call(server, 'GET', '/api/settings')).json()).toMatchObject({
        provider: 'fake',
        ollamaModel: null,
        pinned: false,
      });
      const put = (body: string, headers: Record<string, string> = {}) =>
        call(server, 'PUT', '/api/settings', {
          body,
          headers: { 'content-type': 'application/json', ...headers },
        });
      for (const bad of [
        '{oops',
        '{}',
        '[]',
        '{"provider":"anthropic"}',
        '{"provider":"local"}',
        '{"provider":"Fake"}',
        '{"provider":"fake","extra":1}',
        '{"provider":"ollama","ollamaModel":"x-cloud"}',
        '{"provider":"ollama","ollamaModel":"../../etc"}',
        '{"provider":"ollama","ollamaModel":7}',
      ])
        expect([bad, (await put(bad)).status]).toEqual([bad, 400]);
      expect((await put('{"provider":"fake"}', { origin: 'http://evil.example' })).status).toBe(
        403,
      );
      expect(
        (
          await call(server, 'PUT', '/api/settings', {
            body: '{"provider":"fake"}',
            headers: { 'content-type': 'text/plain' },
          })
        ).status,
      ).toBe(415);
      // Nothing invalid was stored.
      expect((await call(server, 'GET', '/api/settings')).json()).toMatchObject({
        provider: 'fake',
      });

      const saved = await put('{"provider":"ollama","ollamaModel":null}');
      expect(saved.status).toBe(200);
      expect(saved.json()).toMatchObject({ provider: 'ollama', ollamaModel: null, pinned: false });
      expect((await call(server, 'GET', '/api/status')).json()).toMatchObject({
        selected: 'ollama',
        runnable: true,
        simulated: false,
        model: 'tiny:1b',
        models: ['tiny:1b'],
      });
      await server.close();
      server = await start();
      expect((await call(server, 'GET', '/api/settings')).json()).toMatchObject({
        provider: 'ollama',
      });
      const file = await readFile(join(w.runsDir, '..', 'settings.json'), 'utf8');
      expect(JSON.parse(file)).toEqual({ version: 1, provider: 'ollama', ollamaModel: null });
    } finally {
      await server.close();
    }
  });

  it('selecting Ollama while it is unavailable is saved, and then reported as blocked', async () => {
    const w = await workspace();
    const server = await startServer({
      env: w.env(),
      port: 0,
      appDeps: { ollamaFetch: ollamaStub({ down: true }).fetch },
    });
    try {
      const put = await call(server, 'PUT', '/api/settings', {
        body: '{"provider":"ollama"}',
        headers: { 'content-type': 'application/json' },
      });
      expect(put.status).toBe(200);
      const status = (await call(server, 'GET', '/api/status')).json();
      expect(status).toMatchObject({ selected: 'ollama', runnable: false });
      expect(String(status['reason'])).toContain('not reachable');
    } finally {
      await server.close();
    }
  });

  it('cannot change a provider that the environment pins, and reports a damaged file', async () => {
    const w = await workspace();
    const pinned = await startServer({ env: w.env({ EOAI_MODEL_PROVIDER: 'fake' }), port: 0 });
    try {
      const r = await call(pinned, 'PUT', '/api/settings', {
        body: '{"provider":"ollama"}',
        headers: { 'content-type': 'application/json' },
      });
      expect([r.status, r.json().error.code]).toEqual([409, 'provider_pinned']);
      expect((await call(pinned, 'GET', '/api/settings')).json()).toMatchObject({ pinned: true });
    } finally {
      await pinned.close();
    }
    await writeFile(join(w.runsDir, '..', 'settings.json'), '{"secret":"hunter2"}');
    const server = await startServer({ env: w.env(), port: 0 });
    try {
      for (const path of ['/api/settings', '/api/status']) {
        const r = await call(server, 'GET', path);
        expect([r.status, r.json().error.code]).toEqual([500, 'settings_unreadable']);
        expect(r.text).not.toContain('hunter2');
      }
      const run = await post(server, { bundleId: 'x' });
      expect(run.status).toBe(409);
      expect(run.json().error.code).toBe('provider_blocked');
    } finally {
      await server.close();
    }
  });
});

describe('investigations', () => {
  it('stores a run through the application and lists and reads it back, validated', async () => {
    const { w, server } = await serve();
    try {
      const started = await post(server, { bundleId: w.excerptId });
      expect(started.status).toBe(201);
      const { runId, outcome } = started.json();
      expect(outcome).toBe('completed');
      expect((await call(server, 'GET', '/api/runs')).json().runs).toMatchObject([
        { id: runId, ok: true, summary: { outcome: 'completed' } },
      ]);
      const got = (await call(server, 'GET', `/api/runs/${runId}`)).json();
      expect(readInvestigationResult(got.result).ok).toBe(true);
      expect(JSON.stringify(got)).not.toContain(w.bundlesDir);
      expect(JSON.stringify(got)).not.toContain(w.excerptId);
    } finally {
      await server.close();
    }
  });

  it('answers with a stable error, and runs nothing, when the selected provider is blocked', async () => {
    const w = await workspace();
    const server = await startServer({
      env: w.env({ EOAI_MODEL_PROVIDER: 'ollama' }),
      port: 0,
      appDeps: { ollamaFetch: ollamaStub({ down: true }).fetch },
    });
    try {
      const r = await post(server, { bundleId: w.excerptId });
      expect(r.status).toBe(409);
      expect(r.json().error.code).toBe('provider_blocked');
      expect(r.json().error.message).toContain('Nothing was run');
      expect(r.json()).not.toHaveProperty('runId');
      // No silent fallback: nothing was stored, from any provider.
      await expect(readFile(w.runsDir)).rejects.toThrow();
    } finally {
      await server.close();
    }
  });

  it('runs the simulated provider when Fake is selected, and labels the stored result', async () => {
    const w = await workspace();
    const server = await startServer({ env: w.env(), port: 0 });
    try {
      const started = await post(server, { bundleId: w.excerptId });
      expect(started.status).toBe(201);
      const got = (await call(server, 'GET', `/api/runs/${started.json().runId}`)).json();
      const result = readInvestigationResult(got.result);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.result.run).toMatchObject({
        provider: 'fake',
        model: 'simulated-deterministic-v1',
      });
      expect(result.result.limitations.join(' ')).toContain('SIMULATED');
      expect(result.result.findings.every((f) => f.statement.startsWith('SIMULATED'))).toBe(true);
      // Never claims a root cause: it is not an investigator.
      expect(result.result.findings.map((f) => f.kind)).toEqual(['symptom']);
    } finally {
      await server.close();
    }
  });

  it('cancels a run when the client goes away, and stores it as cancelled', async () => {
    const w = await workspace();
    const server = await startServer({
      env: w.env(),
      port: 0,
      appDeps: { fakeSteps: [{ hang: true }] },
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const req = request(
          {
            host: server.host,
            port: server.port,
            method: 'POST',
            path: '/api/investigations',
            headers: {
              host: `127.0.0.1:${String(server.port)}`,
              'content-type': 'application/json',
            },
          },
          () => {
            reject(new Error('the run should not have answered'));
          },
        );
        req.on('error', () => undefined);
        req.end(JSON.stringify({ bundleId: w.excerptId }));
        setTimeout(() => {
          req.destroy();
          resolve();
        }, 400);
      });
      let runs: { ok: boolean; summary?: { outcome: string; failureClass: string } }[] = [];
      for (let i = 0; i < 100 && runs.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 50));
        runs = (await call(server, 'GET', '/api/runs')).json().runs as typeof runs;
      }
      expect(runs[0]?.summary).toMatchObject({ outcome: 'failed', failureClass: 'cancelled' });
      // The server is free again.
      expect((await post(server, { bundleId: 'x' })).status).not.toBe(429);
    } finally {
      await server.close();
    }
  });

  it('re-checks a run’s citations over HTTP and answers a missing run with a structured error', async () => {
    const { w, server } = await serve();
    try {
      const { runId } = (await post(server, { bundleId: w.excerptId })).json();
      const r = await call(server, 'GET', `/api/runs/${runId}/evidence`);
      expect(r.status).toBe(200);
      const checked = r.json() as unknown as { status: string; citations: { status: string }[] };
      expect(checked.status).toBe('checked');
      expect(checked.citations.length).toBeGreaterThan(0);
      expect(checked.citations.every((c) => c.status === 'verified')).toBe(true);
      expect(r.text).not.toContain(w.bundlesDir);
      expect((await call(server, 'GET', '/api/runs/20261027T000000Z-nocase/evidence')).status).toBe(
        404,
      );
      expect((await call(server, 'GET', '/api/runs/..%2fx/evidence')).status).toBe(400);
      expect((await call(server, 'POST', `/api/runs/${runId}/evidence`)).status).toBe(405);
    } finally {
      await server.close();
    }
  });

  it('reports a damaged run as unreadable without leaking its content', async () => {
    const { w, server } = await serve();
    try {
      await mkdir(w.runsDir, { recursive: true });
      await writeFile(join(w.runsDir, '20261027T000000Z-nocase.json'), '{"secret":"hunter2"}');
      const r = await call(server, 'GET', '/api/runs/20261027T000000Z-nocase');
      expect(r.status).toBe(500);
      expect(r.json().error.code).toBe('run_unreadable');
      expect(r.text).not.toContain('hunter2');
    } finally {
      await server.close();
    }
  });

  it('lists bundles and validates one without exposing directory paths', async () => {
    const { w, server } = await serve();
    try {
      const bundles = (await call(server, 'GET', '/api/bundles')).json().bundles as {
        id: string;
      }[];
      const list = bundles.map((b) => b.id);
      expect(list).toContain(w.excerptId);
      const ok = await call(server, 'GET', `/api/bundles/${w.excerptId}/validation`);
      expect(ok.json()).toMatchObject({
        valid: true,
        issues: [],
        metadata: { caseId: expect.stringMatching(/^[0-9a-f]{16}$/) as string },
      });
      const bad = await call(server, 'GET', `/api/bundles/${w.tamperedId}/validation`);
      expect(bad.json().valid).toBe(false);
      expect(bad.json().metadata).toBeNull();
      for (const r of [ok, bad]) {
        expect(r.text).not.toContain(w.bundlesDir);
        expect(r.text).not.toContain('bundleDir');
      }
    } finally {
      await server.close();
    }
  });

  it('runs one investigation at a time and answers a second with a stable busy response', async () => {
    const w = await workspace();
    const server = await startServer({
      env: w.env(),
      port: 0,
      appDeps: { fakeSteps: [{ hang: true }] },
    });
    try {
      const first = post(server, { bundleId: w.excerptId });
      // Wait until the first request is inside the application.
      let busy;
      for (let i = 0; i < 100 && busy?.status !== 429; i++) {
        busy = await post(server, { bundleId: w.excerptId });
        if (busy.status !== 429) await new Promise((r) => setTimeout(r, 20));
      }
      expect(busy?.status).toBe(429);
      expect(busy?.json().error.code).toBe('busy');
      // Shutdown aborts the hung run, so the first request finishes with a stored result.
      await server.close();
      expect((await first).status).toBe(201);
    } finally {
      await server.close();
    }
  });
});

describe('evaluations', () => {
  const put = (server: RunningServer, body: unknown, headers: Record<string, string> = {}) =>
    call(server, 'POST', '/api/evaluations', {
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...headers },
    });
  interface Ev {
    suites: { id: string; split: string }[];
    evaluations: { id: string; ok: boolean; provider: { kind: string } }[];
    evaluation: {
      id: string;
      provider: { kind: string; simulated: boolean };
      measuresModelQuality: boolean;
    };
    id: string;
    regressions: number;
    sameProvider: boolean;
  }
  const json = (r: { json(): unknown }): Ev => r.json() as Ev;

  it('lists suites, runs one, stores it, and reopens and compares stored evaluations', async () => {
    const { server } = await serve({ steps: 'none' });
    try {
      expect(
        json(await call(server, 'GET', '/api/evaluation-suites')).suites.map((s) => [
          s.id,
          s.split,
        ]),
      ).toEqual([
        ['development', 'development'],
        ['held-out', 'held-out'],
      ]);
      expect(json(await call(server, 'GET', '/api/evaluations')).evaluations).toEqual([]);
      const a = await put(server, { suiteId: 'development', provider: 'scripted' });
      const b = await put(server, { suiteId: 'development', provider: 'simulated' });
      expect([a.status, b.status]).toEqual([201, 201]);
      const [ida, idb] = [json(a).id, json(b).id];
      const list = json(await call(server, 'GET', '/api/evaluations')).evaluations;
      expect(list.map((e) => e.provider.kind).sort()).toEqual(['scripted', 'simulated']);
      const got = json(await call(server, 'GET', `/api/evaluations/${ida}`)).evaluation;
      expect(got).toMatchObject({
        id: ida,
        provider: { kind: 'scripted', simulated: true },
        measuresModelQuality: false,
      });
      const cmp = json(await call(server, 'GET', `/api/evaluations/${ida}/compare/${idb}`));
      expect(cmp.sameProvider).toBe(false);
      expect((await call(server, 'GET', `/api/evaluations/${ida}/compare/${ida}`)).status).toBe(
        200,
      );
    } finally {
      await server.close();
    }
  });

  it('rejects malformed requests, unknown suites and ids, and refuses cross-origin starts', async () => {
    const { server } = await serve({ steps: 'none' });
    try {
      for (const bad of [
        '{oops',
        '[]',
        '{}',
        '{"suiteId":"development"}',
        '{"suiteId":1,"provider":"scripted"}',
        '{"suiteId":"development","provider":"anthropic"}',
        '{"suiteId":"development","provider":"local"}',
        '{"suiteId":"development","provider":"scripted","x":1}',
      ])
        expect([bad, (await put(server, bad)).status]).toEqual([bad, 400]);
      expect((await put(server, { suiteId: 'nope', provider: 'scripted' })).json().error.code).toBe(
        'unknown_suite',
      );
      expect(
        (
          await put(
            server,
            { suiteId: 'development', provider: 'scripted' },
            { origin: 'http://evil.example' },
          )
        ).status,
      ).toBe(403);
      expect((await call(server, 'GET', '/api/evaluations/..%2fx')).status).toBe(400);
      expect(
        (await call(server, 'GET', '/api/evaluations/20250101T000000Z-development-scripted'))
          .status,
      ).toBe(404);
      expect(
        (
          await call(
            server,
            'GET',
            '/api/evaluations/..%2fx/compare/20250101T000000Z-development-scripted',
          )
        ).status,
      ).toBe(400);
      expect((await call(server, 'PUT', '/api/evaluations')).status).toBe(405);
      expect((await call(server, 'POST', '/api/evaluation-suites')).status).toBe(405);
      expect(
        (await call(server, 'POST', '/api/evaluations/20250101T000000Z-development-scripted'))
          .status,
      ).toBe(405);
      // Nothing was stored by any of the above.
      expect(json(await call(server, 'GET', '/api/evaluations')).evaluations).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it('cannot start an Ollama evaluation while the runtime reports cloud features enabled', async () => {
    const w = await workspace();
    const stub = ollamaStub({ status: { body: { cloud: { disabled: false, source: 'none' } } } });
    const server = await startServer({
      env: w.env(),
      port: 0,
      appDeps: { ollamaFetch: stub.fetch },
    });
    try {
      const r = await put(server, { suiteId: 'held-out', provider: 'ollama' });
      expect(r.status).toBe(409);
      expect(r.json().error.code).toBe('provider_blocked');
      expect(r.json().error.message).toContain('OLLAMA_NO_CLOUD=1');
      expect(stub.calls.some((c) => c.path === '/api/chat')).toBe(false);
      expect(json(await call(server, 'GET', '/api/evaluations')).evaluations).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it('reports a damaged stored evaluation without leaking its content', async () => {
    const { w, server } = await serve({ steps: 'none' });
    try {
      const dir = join(w.runsDir, '..', 'evaluations');
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, '20260101T000000Z-development-scripted.json'),
        '{"secret":"hunter2"}',
      );
      const r = await call(server, 'GET', '/api/evaluations/20260101T000000Z-development-scripted');
      expect([r.status, r.json().error.code]).toEqual([500, 'evaluation_unreadable']);
      expect(r.text).not.toContain('hunter2');
      const compare = await call(
        server,
        'GET',
        '/api/evaluations/20260101T000000Z-development-scripted/compare/20260101T000000Z-development-scripted',
      );
      expect(compare.status).toBe(500);
    } finally {
      await server.close();
    }
  });

  it('runs one evaluation at a time with investigations, answering the second with busy', async () => {
    const w = await workspace();
    const server = await startServer({
      env: w.env(),
      port: 0,
      appDeps: { fakeSteps: [{ hang: true }] },
    });
    try {
      const first = post(server, { bundleId: w.excerptId });
      let busy;
      for (let i = 0; i < 100 && busy?.status !== 429; i++) {
        busy = await put(server, { suiteId: 'held-out', provider: 'scripted' });
        if (busy.status !== 429) await new Promise((r) => setTimeout(r, 20));
      }
      expect(busy?.status).toBe(429);
      await server.close();
      await first;
    } finally {
      await server.close();
    }
  });
});

describe('static console and shutdown', () => {
  it('serves a built console by exact path only', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'assets'));
    await writeFile(join(dir, 'index.html'), '<!doctype html><p>console</p>');
    await writeFile(join(dir, 'assets', 'app.js'), 'export {}');
    await writeFile(join(dir, 'secret.txt'), 'nope');
    const { server } = await serve({ staticDir: dir });
    try {
      expect(server.consoleServed).toBe(true);
      const index = await call(server, 'GET', '/');
      expect(index.text).toContain('console');
      expect(index.headers['content-type']).toContain('text/html');
      expect((await call(server, 'GET', '/assets/app.js')).headers['content-type']).toContain(
        'javascript',
      );
      for (const p of [
        '/secret.txt',
        '/%2e%2e/etc/passwd',
        '/assets/../secret.txt',
        '/assets',
        '/assets/missing.js',
      ])
        expect((await call(server, 'GET', p)).status).toBe(404);
      expect((await call(server, 'POST', '/')).status).toBe(405);
    } finally {
      await server.close();
    }
  });

  it('serves the API alone when there is no built console', async () => {
    const { server } = await serve({ staticDir: join(await tempDir(), 'absent') });
    try {
      expect(server.consoleServed).toBe(false);
      expect((await call(server, 'GET', '/')).status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it('releases the listener on close, and closing twice is safe', async () => {
    const { server } = await serve();
    await server.close();
    await expect(call(server, 'GET', '/healthz')).rejects.toThrow(/ECONNREFUSED/);
    await server.close();
  });
});
