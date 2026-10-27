import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import { createFixtureSource } from '../../src/ui/data/fixture-source.ts';
import { createHttpSource } from '../../src/ui/data/http-source.ts';
import type { EvaluationDetailView, UiFixtures } from '../../src/ui/data/types.ts';
import committed from '../../src/ui/fixtures/fixtures.json' with { type: 'json' };

/** The console's data source for evaluations, against a stubbed fetch and a real stored document. */
let run: EvaluationDetailView;
beforeAll(async () => {
  const out = await promisify(execFile)(
    process.execPath,
    [join(process.cwd(), 'test/ui/make-evaluations.ts')],
    { maxBuffer: 20_000_000 },
  );
  run = (JSON.parse(out.stdout) as { scripted: EvaluationDetailView }).scripted;
}, 60_000);

type Reply = { status?: number; body?: unknown } | Error;
function stub(routes: Record<string, Reply>) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    const reply = routes[url];
    if (reply === undefined) return Promise.reject(new Error(`unexpected request ${url}`));
    if (reply instanceof Error) return Promise.reject(reply);
    return Promise.resolve(
      new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200 }),
    );
  }) as typeof fetch;
  return { source: createHttpSource(fetchImpl), calls };
}
const err = (code: string, message: string) => ({ error: { code, message } });
const entry = () => ({
  id: run.id,
  ok: true,
  suite: run.suite,
  provider: run.provider,
  measuresModelQuality: false,
  startedAt: run.startedAt,
  status: 'complete',
  headline: { cases: 8, rootCauseCorrect: '3/7', completion: '6/8' },
});

describe('evaluation suites and the stored list', () => {
  it('reads the suites and the stored evaluations, including an unreadable one', async () => {
    const suite = {
      id: 'development',
      version: '1',
      split: 'development',
      description: 'd',
      cases: [],
    };
    const { source } = stub({
      '/api/evaluation-suites': { body: { suites: [suite] } },
      '/api/evaluations': {
        body: { evaluations: [entry(), { id: 'bad', ok: false, problems: ['not valid JSON', 3] }] },
      },
    });
    expect(await source.listEvaluationSuites()).toEqual([suite]);
    const list = await source.listEvaluations();
    expect(list[0]).toMatchObject({ id: run.id, ok: true, provider: { kind: 'scripted' } });
    expect(list[1]).toEqual({ id: 'bad', ok: false, problems: ['not valid JSON'] });
  });

  it.each([
    ['suites', '/api/evaluation-suites', { suites: 'x' }],
    ['suites', '/api/evaluation-suites', { suites: [{ id: 'a' }] }],
    [
      'suites',
      '/api/evaluation-suites',
      { suites: [{ id: 'a', version: '1', split: 'other', description: 'd', cases: [] }] },
    ],
    ['list', '/api/evaluations', { evaluations: 'x' }],
    ['list', '/api/evaluations', { evaluations: [{ id: 'a' }] }],
    ['list', '/api/evaluations', () => ({ evaluations: [{ ...entry(), headline: { cases: 1 } }] })],
    [
      'list',
      '/api/evaluations',
      () => ({ evaluations: [{ ...entry(), provider: { kind: 'real' } }] }),
    ],
    ['list', '/api/evaluations', () => ({ evaluations: [{ ...entry(), suite: { id: 'a' } }] })],
  ])('rejects a malformed %s answer %#', async (what, path, body) => {
    const { source } = stub({ [path]: { body: typeof body === 'function' ? body() : body } });
    await expect(
      what === 'suites' ? source.listEvaluationSuites() : source.listEvaluations(),
    ).rejects.toThrow(/malformed/);
  });
});

describe('opening, starting and comparing', () => {
  it('opens a stored evaluation, validating its shape, and returns null for a missing one', async () => {
    const { source, calls } = stub({
      [`/api/evaluations/${run.id}`]: { body: { evaluation: run } },
      '/api/evaluations/a%2Fb': {
        status: 404,
        body: err('evaluation_not_found', 'no such evaluation'),
      },
    });
    expect(await source.getEvaluation(run.id)).toMatchObject({
      id: run.id,
      provider: { kind: 'scripted', simulated: true },
      measuresModelQuality: false,
    });
    expect(await source.getEvaluation('a/b')).toBeNull();
    expect(calls[1]?.url).toBe('/api/evaluations/a%2Fb');
  });

  it.each([
    ['not an object', () => 'x'],
    ['no metrics', () => ({ ...run, metrics: 'x' })],
    ['a bad metric', () => ({ ...run, metrics: [{ id: 'm' }] })],
    ['a bad status', () => ({ ...run, status: 'done' })],
    ['a bad provider', () => ({ ...run, provider: { ...run.provider, kind: 'other' } })],
    ['a bad suite', () => ({ ...run, suite: { ...run.suite, split: 'both' } })],
    ['a bad case', () => ({ ...run, report: { cases: [{ id: 'c' }] } })],
    ['cases that are not a list', () => ({ ...run, report: { cases: 'x' } })],
  ])('rejects an evaluation with %s', async (_why, evaluation) => {
    const { source } = stub({ '/api/evaluations/x': { body: { evaluation: evaluation() } } });
    await expect(source.getEvaluation('x')).rejects.toThrow(/malformed/);
  });

  it('reports a server error while opening as an error', async () => {
    const { source } = stub({
      '/api/evaluations/x': {
        status: 500,
        body: err('evaluation_unreadable', 'the stored evaluation could not be read'),
      },
    });
    await expect(source.getEvaluation('x')).rejects.toMatchObject({
      code: 'evaluation_unreadable',
    });
  });

  it('starts an evaluation with exactly the suite and provider, and tells a refusal from an error', async () => {
    const ok = stub({
      '/api/evaluations': { status: 201, body: { id: run.id, status: 'complete' } },
    });
    expect(
      await ok.source.startEvaluation({ suiteId: 'development', provider: 'scripted' }),
    ).toEqual({ status: 'started', id: run.id });
    expect(ok.calls[0]?.init?.method).toBe('POST');
    expect(ok.calls[0]?.init?.body).toBe('{"suiteId":"development","provider":"scripted"}');
    const blocked = stub({
      '/api/evaluations': {
        status: 409,
        body: err('provider_blocked', 'Ollama is blocked. Nothing was run.'),
      },
    });
    expect(
      await blocked.source.startEvaluation({ suiteId: 'held-out', provider: 'ollama' }),
    ).toEqual({ status: 'refused', message: 'Ollama is blocked. Nothing was run.' });
    const busy = stub({
      '/api/evaluations': { status: 429, body: err('busy', 'an investigation is already running') },
    });
    expect(
      await busy.source.startEvaluation({ suiteId: 'held-out', provider: 'scripted' }),
    ).toEqual({ status: 'error', message: 'an investigation is already running' });
    const odd = stub({ '/api/evaluations': { status: 201, body: {} } });
    expect((await odd.source.startEvaluation({ suiteId: 'x', provider: 'scripted' })).status).toBe(
      'error',
    );
    const down = stub({ '/api/evaluations': new TypeError('Failed to fetch') });
    expect(await down.source.startEvaluation({ suiteId: 'x', provider: 'scripted' })).toMatchObject(
      { status: 'error', message: expect.stringMatching(/could not be reached/) as string },
    );
  });

  it('compares two stored evaluations and rejects a malformed comparison', async () => {
    const comparison = {
      suite: { id: 'development', version: '1' },
      a: { id: 'a', provider: run.provider },
      b: { id: 'b', provider: run.provider },
      sameProvider: true,
      metrics: [],
      cases: [],
      regressions: 0,
      improvements: 0,
    };
    const { source } = stub({
      '/api/evaluations/a/compare/b': { body: comparison },
      '/api/evaluations/a/compare/c': { body: { ...comparison, regressions: 'x' } },
      '/api/evaluations/a/compare/d': {
        status: 409,
        body: err('different_suite', 'the two evaluations are of different suites or versions'),
      },
    });
    expect(await source.compareEvaluations('a', 'b')).toEqual(comparison);
    await expect(source.compareEvaluations('a', 'c')).rejects.toThrow(/malformed/);
    await expect(source.compareEvaluations('a', 'd')).rejects.toThrow('different suites');
  });
});

describe('the fixture source', () => {
  it('has no evaluations, and refuses to run one', async () => {
    const source = createFixtureSource(committed as UiFixtures);
    expect(await source.listEvaluationSuites()).toEqual([]);
    expect(await source.listEvaluations()).toEqual([]);
    expect(await source.getEvaluation('x')).toBeNull();
    expect(
      await source.startEvaluation({ suiteId: 'development', provider: 'scripted' }),
    ).toMatchObject({ status: 'refused' });
    await expect(source.compareEvaluations('a', 'b')).rejects.toThrow(/no evaluations/);
  });
});
