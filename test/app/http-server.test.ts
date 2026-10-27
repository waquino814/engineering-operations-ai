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
import { tempDir, workspace } from './support.ts';

/** The fields of the server's JSON bodies that the tests read. */
interface Doc {
  error: { code: string; message: string };
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
      expect(own.status).toBe(409);
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

  it('answers with a stable error, and runs nothing, when no provider is runnable', async () => {
    const { w, server } = await serve({ steps: 'none' });
    try {
      const r = await post(server, { bundleId: w.excerptId });
      expect(r.status).toBe(409);
      expect(r.json().error.code).toBe('no_runnable_provider');
      expect(r.json().error.message).toContain('Nothing was run');
      expect(r.json()).not.toHaveProperty('runId');
      await expect(readFile(w.runsDir)).rejects.toThrow();
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
