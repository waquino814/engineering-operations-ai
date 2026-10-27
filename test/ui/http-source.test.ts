import { describe, expect, it, vi } from 'vitest';
import { ApiError, createHttpSource } from '../../src/ui/data/http-source.ts';
import type { UiFixtures } from '../../src/ui/data/types.ts';
import committed from '../../src/ui/fixtures/fixtures.json' with { type: 'json' };

const fixtures = committed as UiFixtures;

/** The console's HTTP data source, against a stubbed fetch: no server, no network. */
type Reply = { status?: number; body?: unknown; raw?: string } | Error;
function stub(routes: Record<string, Reply | Reply[]>) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    const entry = routes[url];
    const reply = Array.isArray(entry) ? entry.shift() : entry;
    if (reply === undefined) return Promise.reject(new Error(`unexpected request ${url}`));
    if (reply instanceof Error) return Promise.reject(reply);
    return Promise.resolve(
      new Response(reply.raw ?? JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200 }),
    );
  }) as typeof fetch;
  return { source: createHttpSource(fetchImpl), calls };
}
const [earlier, later] = fixtures.investigations
  .slice()
  .sort((x, y) => x.result.run.startedAt.localeCompare(y.result.run.startedAt));
if (!earlier || !later) throw new Error('the fixtures need two investigations');

describe('listing and reading investigations', () => {
  it('lists stored runs newest first, validating every result, and tags them as local', async () => {
    const { source, calls } = stub({
      '/api/runs': {
        body: {
          runs: [
            { id: 'old', ok: true },
            { id: 'bad', ok: false, problems: [] },
            { id: 'new', ok: true },
          ],
        },
      },
      '/api/runs/old': { body: { result: earlier.result } },
      '/api/runs/new': { body: { result: later.result } },
    });
    const list = await source.listInvestigations();
    expect(list.map((r) => r.id)).toEqual(['new', 'old']);
    expect(list.every((r) => r.origin === 'local')).toBe(true);
    // An unreadable run is not fetched and not shown as an investigation.
    expect(calls.map((c) => c.url)).not.toContain('/api/runs/bad');
    expect(source.description.mode).toBe('local');
  });

  it('shows an empty list as empty', async () => {
    const { source } = stub({ '/api/runs': { body: { runs: [] } } });
    expect(await source.listInvestigations()).toEqual([]);
  });

  it('returns null for a missing run and escapes the id', async () => {
    const { source, calls } = stub({
      '/api/runs/a%2Fb': {
        status: 404,
        body: { error: { code: 'run_not_found', message: 'no such run' } },
      },
    });
    expect(await source.getInvestigation('a/b')).toBeNull();
    expect(calls[0]?.url).toBe('/api/runs/a%2Fb');
  });

  it('rejects a result that fails the contract, rather than displaying it', async () => {
    const { source } = stub({
      '/api/runs/x': {
        body: { result: { ...earlier.result, outcome: 'completed', findings: 'nope' } },
      },
    });
    await expect(source.getInvestigation('x')).rejects.toThrow(/not a valid investigation result/);
  });

  it('reports a server error, an unreadable body and a malformed list as errors', async () => {
    const err = { error: { code: 'run_unreadable', message: 'the stored run could not be read' } };
    const a = stub({ '/api/runs/x': { status: 500, body: err } });
    await expect(a.source.getInvestigation('x')).rejects.toMatchObject({
      code: 'run_unreadable',
      message: err.error.message,
    });
    const b = stub({ '/api/runs': { raw: '<html>', status: 500 } });
    await expect(b.source.listInvestigations()).rejects.toThrow(/unreadable response \(HTTP 500\)/);
    const c = stub({ '/api/runs': { body: { runs: 'x' } } });
    await expect(c.source.listInvestigations()).rejects.toThrow(/malformed/);
    const d = stub({ '/api/runs': { raw: '[1]' } });
    await expect(d.source.listInvestigations()).rejects.toThrow(/unexpected response/);
    const e = stub({ '/api/runs': { status: 500, body: {} } });
    await expect(e.source.listInvestigations()).rejects.toThrow(/reported an error/);
  });

  it('explains an empty gateway error from a proxy in front of an absent application', async () => {
    // What Vite's dev proxy sends when nothing listens on the application's port.
    for (const status of [502, 503, 504]) {
      const { source } = stub({ '/api/runs': { status, raw: '' } });
      const error = await source.listInvestigations().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe('application_unreachable');
      expect((error as Error).message).toBe(
        `The local application is not reachable (HTTP ${String(status)}). Start it with "pnpm serve", then retry.`,
      );
    }
    // Other unreadable bodies keep the generic message, and a structured 502 is the server's own.
    const odd = stub({ '/api/runs': { status: 500, raw: '' } });
    await expect(odd.source.listInvestigations()).rejects.toThrow(
      /unreadable response \(HTTP 500\)/,
    );
    const own = stub({
      '/api/runs': { status: 502, body: { error: { code: 'x', message: 'structured' } } },
    });
    await expect(own.source.listInvestigations()).rejects.toThrow('structured');
  });

  it('reports a network failure as an error the views can show', async () => {
    const { source } = stub({ '/api/runs': new TypeError('Failed to fetch') });
    const error = await source.listInvestigations().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as Error).message).toMatch(/could not be reached/);
  });
});

describe('provider status and settings', () => {
  const status = {
    selected: 'ollama',
    pinned: false,
    runnable: false,
    simulated: false,
    model: 'gemma:12b',
    models: ['gemma:12b'],
    reason: 'Ollama is not reachable. Nothing was run.',
  };

  it('reads the selection and its readiness, and rejects a malformed status', async () => {
    const a = stub({ '/api/status': { body: status } });
    expect(await a.source.getProviderStatus()).toEqual(status);
    for (const bad of [
      { ...status, selected: 'anthropic' },
      { ...status, runnable: 'yes' },
      { ...status, models: [1] },
      { ...status, model: 3 },
      { ...status, reason: 3 },
      { ...status, pinned: null },
    ]) {
      const b = stub({ '/api/status': { body: bad } });
      await expect(b.source.getProviderStatus()).rejects.toThrow(/malformed/);
    }
    const d = stub({ '/api/status': { status: 502, raw: '' } });
    await expect(d.source.getProviderStatus()).rejects.toThrow(/not reachable/);
  });

  it('reads settings and saves a choice with a PUT of exactly the choice', async () => {
    const saved = { provider: 'ollama', ollamaModel: null, pinned: false };
    const { source, calls } = stub({
      '/api/settings': [{ body: { ...saved, provider: 'fake' } }, { body: saved }],
    });
    expect(await source.getSettings()).toEqual({ ...saved, provider: 'fake' });
    expect(await source.saveSettings({ provider: 'ollama', ollamaModel: null })).toEqual(saved);
    expect(calls[1]?.init?.method).toBe('PUT');
    expect(calls[1]?.init?.body).toBe('{"provider":"ollama","ollamaModel":null}');
  });

  it('reports a refused or malformed settings answer as an error', async () => {
    const refused = stub({
      '/api/settings': {
        status: 409,
        body: { error: { code: 'provider_pinned', message: 'fixed' } },
      },
    });
    await expect(
      refused.source.saveSettings({ provider: 'fake', ollamaModel: null }),
    ).rejects.toMatchObject({
      code: 'provider_pinned',
    });
    const bad = stub({
      '/api/settings': { body: { provider: 'anthropic', ollamaModel: null, pinned: false } },
    });
    await expect(bad.source.getSettings()).rejects.toThrow(/malformed/);
    const bad2 = stub({
      '/api/settings': { body: { provider: 'fake', ollamaModel: 4, pinned: false } },
    });
    await expect(bad2.source.getSettings()).rejects.toThrow(/malformed/);
  });
});

describe('bundles', () => {
  it('lists bundles and validates one', async () => {
    const check = { valid: true, schemaVersion: '1.0.0', issues: [], metadata: null };
    const { source } = stub({
      '/api/bundles': { body: { bundles: [{ id: 'b1' }, { nope: 1 }] } },
      '/api/bundles/b1/validation': { body: check },
    });
    expect(await source.listBundles()).toMatchObject([{ id: 'b1', label: 'b1', origin: 'local' }]);
    expect(await source.validateBundle('b1')).toEqual({ bundleId: 'b1', ...check });
  });

  it('rejects a malformed validation, and a missing bundle', async () => {
    const a = stub({ '/api/bundles/b/validation': { body: { valid: 'yes' } } });
    await expect(a.source.validateBundle('b')).rejects.toThrow(/malformed/);
    const b = stub({
      '/api/bundles/b/validation': {
        body: { valid: true, issues: [], schemaVersion: null, metadata: 3 },
      },
    });
    await expect(b.source.validateBundle('b')).rejects.toThrow(/malformed/);
    const c = stub({
      '/api/bundles': { body: {} },
      '/api/bundles/m/validation': {
        status: 404,
        body: { error: { code: 'bundle_not_found', message: 'no such bundle' } },
      },
    });
    await expect(c.source.listBundles()).rejects.toThrow(/malformed/);
    await expect(c.source.validateBundle('m')).rejects.toThrow('no such bundle');
  });

  it('does not support uploads and makes no request for one', async () => {
    const { source, calls } = stub({});
    const out = await source.uploadBundle([]);
    expect(out.status).toBe('unavailable');
    expect(calls).toEqual([]);
  });
});

describe('starting an investigation', () => {
  it('posts exactly the bundle id as JSON and returns the stored run', async () => {
    const { source, calls } = stub({
      '/api/investigations': { status: 201, body: { runId: 'r1', outcome: 'completed' } },
    });
    expect(await source.startInvestigation('b1')).toEqual({
      status: 'started',
      investigationId: 'r1',
    });
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.body).toBe('{"bundleId":"b1"}');
    expect(calls[0]?.init?.headers).toEqual({ 'content-type': 'application/json' });
  });

  it('treats the provider policy refusal as "nothing ran", never as a result', async () => {
    const message = 'no runnable provider is configured. Nothing was run.';
    const { source } = stub({
      '/api/investigations': {
        status: 409,
        body: { error: { code: 'no_runnable_provider', message } },
      },
    });
    const out = await source.startInvestigation('b1');
    expect(out).toEqual({ status: 'unavailable', reason: message, fixtureInvestigationIds: [] });
  });

  it('reports busy, server errors and a lost connection as errors', async () => {
    const busy = stub({
      '/api/investigations': {
        status: 429,
        body: { error: { code: 'busy', message: 'an investigation is already running' } },
      },
    });
    expect(await busy.source.startInvestigation('b')).toEqual({
      status: 'error',
      message: 'an investigation is already running',
    });
    const odd = stub({ '/api/investigations': { status: 201, body: {} } });
    expect((await odd.source.startInvestigation('b')).status).toBe('error');
    const down = stub({ '/api/investigations': new TypeError('Failed to fetch') });
    expect(await down.source.startInvestigation('b')).toMatchObject({
      status: 'error',
      message: expect.stringMatching(/could not be reached/) as string,
    });
  });

  it('uses the global fetch by default, against relative /api/ paths only', async () => {
    const spy = vi.fn(() => Promise.resolve(new Response('{"runs":[]}')));
    vi.stubGlobal('fetch', spy);
    try {
      await createHttpSource().listInvestigations();
      expect(spy).toHaveBeenCalledWith('/api/runs', undefined);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
