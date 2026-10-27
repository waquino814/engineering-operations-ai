import { request } from 'node:http';
import { describe, expect, it } from 'vitest';
import { createApplication } from '../../src/app/application.ts';
import {
  EVENT_FIELDS,
  emitEvent,
  jsonLinesSink,
  WITHHELD,
  type AppEvent,
} from '../../src/app/events.ts';
import { main } from '../../src/cli.ts';
import { ProviderError } from '../../src/investigation/provider.ts';
import { chatReply, ollamaStub, workspace } from './support.ts';

/** Operational events: what is reported, what never is, and that reporting cannot change a run. */
const collect = () => {
  const events: AppEvent[] = [];
  return { events, sink: (e: AppEvent) => void events.push(e) };
};
const NOW = Date.UTC(2026, 9, 27, 12, 30);

describe('events from the application', () => {
  it('reports a finished investigation with counts, accounting and a correlating run id, and nothing else', async () => {
    const w = await workspace();
    const { events, sink } = collect();
    const app = createApplication(w.env(), { fakeSteps: w.steps, now: () => NOW, events: sink });
    const out = await app.startInvestigation(w.excerptId);
    if (out.status !== 'done') throw new Error('did not run');
    expect(events).toHaveLength(1);
    const [e] = events as [AppEvent];
    expect(e).toMatchObject({
      event: 'investigation.finished',
      at: NOW,
      fields: {
        runId: out.runId,
        bundleId: w.excerptId,
        provider: 'fake',
        simulated: true,
        outcome: 'completed',
        failureClass: null,
        modelCalls: 1,
        repairs: 0,
        retries: 0,
      },
    });
    expect(Object.keys(e.fields).sort()).toEqual(
      [...EVENT_FIELDS['investigation.finished']].sort(),
    );
    // The run id is the stored run's name, so an event can be matched to its record.
    expect((await app.getRun(out.runId)).ok).toBe(true);
  });

  it('reports the failure class of a failed investigation, never its message', async () => {
    const w = await workspace();
    const { events, sink } = collect();
    const down = () => ({
      error: new ProviderError('unavailable', 'secret-host.internal refused'),
    });
    const app = createApplication(w.env(), {
      fakeSteps: [down(), down(), down()],
      sleep: () => Promise.resolve(),
      events: sink,
    });
    await app.startInvestigation(w.excerptId);
    expect(events[0]?.fields).toMatchObject({
      outcome: 'failed',
      failureClass: 'provider_unavailable',
    });
    expect(JSON.stringify(events)).not.toContain('secret-host');
    expect(JSON.stringify(events)).not.toContain(w.bundlesDir);
  });

  it('reports a refusal by reason when the bundle id is bad, unknown, or the provider is blocked', async () => {
    const w = await workspace();
    const { events, sink } = collect();
    const app = createApplication(w.env(), { fakeSteps: w.steps, events: sink });
    await app.startInvestigation('../x');
    await app.startInvestigation('nope');
    const blocked = createApplication(w.env({ EOAI_MODEL_PROVIDER: 'ollama' }), {
      ollamaFetch: ollamaStub({
        status: { body: { cloud: { disabled: false, source: 'none' } } },
        chat: () => chatReply('{}'),
      }).fetch,
      events: sink,
    });
    await blocked.startInvestigation(w.excerptId);
    expect(events.map((e) => [e.event, e.fields['reason']])).toEqual([
      ['investigation.refused', 'invalid_bundle_id'],
      ['investigation.refused', 'bundle_not_found'],
      ['investigation.refused', 'provider_blocked'],
    ]);
  });

  it('reports a finished evaluation with its reliability counts and whether it measures a model', async () => {
    const w = await workspace();
    const { events, sink } = collect();
    const app = createApplication(w.env(), { now: () => NOW, events: sink });
    const out = await app.startEvaluation({ suiteId: 'development', provider: 'scripted' });
    if (out.status !== 'done') throw new Error('did not run');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: 'evaluation.finished',
      fields: {
        evaluationId: out.run.id,
        suiteId: 'development',
        suiteVersion: '1',
        providerKind: 'scripted',
        measuresModelQuality: false,
        status: 'complete',
        cases: 8,
        harnessErrors: 0,
        answerLeaks: 0,
      },
    });
    await app.startEvaluation({ suiteId: 'nope', provider: 'scripted' });
    expect(events[1]).toMatchObject({
      event: 'evaluation.refused',
      fields: { reason: 'unknown_suite' },
    });
  });

  it('reports a blocked Ollama evaluation as a refusal and sends no prompt', async () => {
    const w = await workspace();
    const { events, sink } = collect();
    const stub = ollamaStub({
      status: { body: { cloud: { disabled: false, source: 'none' } } },
      chat: () => chatReply('{}'),
    });
    const app = createApplication(w.env(), { ollamaFetch: stub.fetch, events: sink });
    await app.startEvaluation({ suiteId: 'development', provider: 'ollama' });
    expect(events.map((e) => [e.event, e.fields['reason']])).toEqual([
      ['evaluation.refused', 'provider_blocked'],
    ]);
    expect(stub.calls.some((c) => c.path === '/api/chat')).toBe(false);
  });

  it('is unaffected by a sink that throws: the run still completes and is stored', async () => {
    const w = await workspace();
    const app = createApplication(w.env(), {
      fakeSteps: w.steps,
      events: () => {
        throw new Error('sink down');
      },
    });
    const out = await app.startInvestigation(w.excerptId);
    expect(out).toMatchObject({ status: 'done', result: { outcome: 'completed' } });
    expect(await app.listRuns()).toHaveLength(1);
  });

  it('emits nothing, and needs nothing, when no sink is given', () => {
    expect(() => {
      emitEvent(undefined, () => 0, 'evaluation.refused', { reason: 'x' });
    }).not.toThrow();
  });
});

describe('the JSON-lines sink', () => {
  const lines = (event: AppEvent['event'], fields: AppEvent['fields']) => {
    let text = '';
    jsonLinesSink({ write: (t) => (text += t) })({ event, at: NOW, fields });
    return text;
  };

  it('writes one versioned object per line with an ISO time and only the event’s fields', () => {
    const text = lines('investigation.refused', { reason: 'provider_blocked' });
    expect(text.endsWith('\n')).toBe(true);
    expect(JSON.parse(text)).toEqual({
      v: 1,
      event: 'investigation.refused',
      at: '2026-10-27T12:30:00.000Z',
      reason: 'provider_blocked',
    });
  });

  it('drops unknown fields and withholds anything that is not an identifier', () => {
    const parsed = JSON.parse(
      lines('investigation.finished', {
        runId: '20261027T123000Z-0123456789abcdef',
        bundleId: '/Users/me/bundles/provider-outage',
        provider: 'sk-live key with spaces',
        model: 'gemma4:12b',
        outcome: 'completed',
        failureClass: 'a\nnewline',
        durationMs: Number.POSITIVE_INFINITY,
        modelCalls: 2,
        simulated: false,
        message: 'free text with a path /etc/passwd',
        ollamaUrl: 'http://127.0.0.1:11434/',
      }),
    ) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      runId: '20261027T123000Z-0123456789abcdef',
      bundleId: WITHHELD,
      provider: WITHHELD,
      model: 'gemma4:12b',
      failureClass: WITHHELD,
      durationMs: null,
      modelCalls: 2,
      simulated: false,
    });
    expect(parsed).not.toHaveProperty('message');
    expect(parsed).not.toHaveProperty('ollamaUrl');
  });

  it('allows only fields of bounded cardinality: no field is free text', () => {
    for (const [event, names] of Object.entries(EVENT_FIELDS))
      for (const name of names)
        expect(name, `${event}.${name}`).not.toMatch(
          /message|text|prompt|reply|path|url|statement|rationale|key|token$/i,
        );
  });
});

describe('serve --events stderr', () => {
  const post = (port: number, body: unknown) =>
    new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          path: '/api/investigations',
          method: 'POST',
          headers: { 'content-type': 'application/json' },
        },
        (res) => {
          res.resume();
          res.on('end', () => {
            resolve(res.statusCode ?? 0);
          });
        },
      );
      req.on('error', reject);
      req.end(JSON.stringify(body));
    });

  const serveWith = async (args: string[]) => {
    const w = await workspace();
    let out = '';
    let err = '';
    let stop: () => Promise<void> = () => Promise.reject(new Error('not serving'));
    let exit: Promise<number> = Promise.resolve(-1);
    await new Promise<void>((resolve) => {
      exit = main(
        ['serve', '--port', '0', ...args],
        { write: (t) => (out += t) },
        { write: (t) => (err += t) },
        w.env(),
        {
          fakeSteps: w.steps,
          onServing: (fn) => {
            stop = fn;
            resolve();
          },
        },
      );
    });
    const port = Number(/http:\/\/127\.0\.0\.1:(\d+)\n/.exec(out)?.[1]);
    // `serve` also says on stderr when the console is not built, which depends on whether
    // `pnpm ui:build` has run (CI runs the tests first); only event lines are of interest here.
    const events = () =>
      err
        .split('\n')
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    return { w, port, stop, exit, err: () => err, events };
  };

  it('writes the application’s events to stderr as JSON lines when asked', async () => {
    const s = await serveWith(['--events', 'stderr']);
    expect(await post(s.port, { bundleId: s.w.excerptId })).toBe(201);
    await s.stop();
    expect(await s.exit).toBe(0);
    const lines = s.events();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ v: 1, event: 'investigation.finished', outcome: 'completed' });
    expect(s.err()).not.toContain(s.w.bundlesDir);
  });

  it('writes nothing to stderr by default', async () => {
    const s = await serveWith([]);
    expect(await post(s.port, { bundleId: s.w.excerptId })).toBe(201);
    await s.stop();
    await s.exit;
    expect(s.events()).toEqual([]);
    expect(s.err()).not.toContain('"event"');
  });
});
