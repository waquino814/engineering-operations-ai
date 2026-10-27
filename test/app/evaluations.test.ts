import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApplication } from '../../src/app/application.ts';
import {
  getEvaluation,
  listEvaluations,
  saveEvaluation,
} from '../../src/app/evaluation-service.ts';
import { chatReply, ollamaStub, workspace } from './support.ts';

const INCONCLUSIVE = JSON.stringify({
  schemaVersion: '0.1.0',
  outcome: 'inconclusive',
  findings: [],
  remediation: [],
  limitations: ['Not enough evidence.'],
});
const make = async (
  extra: Record<string, string> = {},
  deps: Parameters<typeof createApplication>[1] = {},
) => {
  const w = await workspace();
  return { w, app: createApplication(w.env(extra), deps) };
};

describe('storing and reopening evaluations', () => {
  it('runs a scripted suite, stores it, and lists and reopens it without running anything', async () => {
    const { w, app } = await make();
    const out = await app.startEvaluation({ suiteId: 'development', provider: 'scripted' });
    if (out.status !== 'done') throw new Error('expected a stored run');
    expect(out.run.provider).toMatchObject({ kind: 'scripted', simulated: true });
    expect(out.run.id).toMatch(/^\d{8}T\d{6}Z-development-scripted$/);
    const files = await readdir(join(w.runsDir, '..', 'evaluations'));
    expect(files).toEqual([`${out.run.id}.json`]);

    const listed = await app.listEvaluations();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: out.run.id,
      ok: true,
      measuresModelQuality: false,
      provider: { kind: 'scripted' },
      suite: { id: 'development', split: 'development' },
      headline: { cases: 8, rootCauseCorrect: '3/7', completion: '6/8' },
    });
    // Reopening reads the file; a fresh application over the same data sees the same run.
    const again = createApplication(w.env());
    expect(await again.getEvaluation(out.run.id)).toEqual({ ok: true, run: out.run });
  });

  it('never replaces an earlier run and finds a free id', async () => {
    const { app } = await make();
    const [a, b] = [
      await app.startEvaluation({ suiteId: 'held-out', provider: 'scripted' }),
      await app.startEvaluation({ suiteId: 'held-out', provider: 'scripted' }),
    ];
    if (a.status !== 'done' || b.status !== 'done') throw new Error('stored');
    // Same second, same suite and kind: the second takes the next free id.
    expect(a.run.id).not.toBe(b.run.id);
    expect((await app.listEvaluations()).length).toBe(2);
  });

  it('reports damaged files as unreadable, rejects bad ids, and does not read a link or a stray file', async () => {
    const { w, app } = await make();
    const ok = await app.startEvaluation({ suiteId: 'held-out', provider: 'scripted' });
    if (ok.status !== 'done') throw new Error('stored');
    const dir = join(w.runsDir, '..', 'evaluations');
    const text = await readFile(join(dir, `${ok.run.id}.json`), 'utf8');
    const other = '20260101T000000Z-held-out-scripted';
    await writeFile(join(dir, `${other}.json`), text); // the stored id differs from the name
    await writeFile(join(dir, '20260101T000001Z-held-out-scripted.json'), '{oops');
    await writeFile(
      join(dir, '20260101T000002Z-held-out-scripted.json'),
      JSON.stringify({ ...JSON.parse(text), extra: 1 }),
    );
    await writeFile(join(dir, 'notes.txt'), 'ignored');
    const entries = await app.listEvaluations();
    expect(entries.map((e) => [e.id.slice(0, 16), e.ok])).toEqual([
      [ok.run.id.slice(0, 16), true],
      ['20260101T000002Z', false],
      ['20260101T000001Z', false],
      ['20260101T000000Z', false],
    ]);
    expect(await app.getEvaluation(other)).toMatchObject({ ok: false, reason: 'unreadable' });
    expect(await app.getEvaluation('../x')).toEqual({ ok: false, reason: 'invalid_id' });
    expect(await app.getEvaluation('20250101T000000Z-held-out-scripted')).toEqual({
      ok: false,
      reason: 'not_found',
    });
    expect(await listEvaluations(join(dir, 'missing'))).toEqual([]);
    expect(await getEvaluation(dir, '20260101T000001Z-held-out-scripted')).toMatchObject({
      problems: ['not valid JSON'],
    });
  });

  it('refuses to store a document that fails its schema', async () => {
    const { w } = await make();
    const dir = join(w.runsDir, '..', 'evaluations');
    await mkdir(dir, { recursive: true });
    await expect(
      saveEvaluation(dir, () => ({}) as never, '20261027T000000Z-development-scripted'),
    ).rejects.toThrow(/schema/);
    await expect(saveEvaluation(dir, () => ({}) as never, 'bad id')).rejects.toThrow(
      /valid evaluation id/,
    );
    expect(await readdir(dir)).toEqual([]);
  });

  it('compares two stored runs of a suite, and says why it cannot compare others', async () => {
    const { app } = await make();
    const dev1 = await app.startEvaluation({ suiteId: 'development', provider: 'scripted' });
    const dev2 = await app.startEvaluation({ suiteId: 'development', provider: 'simulated' });
    const held = await app.startEvaluation({ suiteId: 'held-out', provider: 'scripted' });
    if (dev1.status !== 'done' || dev2.status !== 'done' || held.status !== 'done')
      throw new Error('stored');
    const same = await app.compareEvaluations(dev1.run.id, dev1.run.id);
    expect(same).toMatchObject({
      status: 'ok',
      comparison: { regressions: 0, improvements: 0, sameProvider: true },
    });
    const cross = await app.compareEvaluations(dev1.run.id, dev2.run.id);
    if (cross.status !== 'ok') throw new Error('comparable');
    expect(cross.comparison.sameProvider).toBe(false);
    expect(await app.compareEvaluations(dev1.run.id, held.run.id)).toEqual({
      status: 'error',
      reason: 'different_suite',
    });
    expect(await app.compareEvaluations(dev1.run.id, '../x')).toEqual({
      status: 'error',
      reason: 'invalid_id',
    });
    expect(
      await app.compareEvaluations('20250101T000000Z-development-scripted', dev1.run.id),
    ).toEqual({ status: 'error', reason: 'not_found' });
  });
});

describe('starting an evaluation', () => {
  it('lists the suites, and refuses an unknown one', async () => {
    const { app } = await make();
    expect(app.listEvaluationSuites().map((s) => s.id)).toEqual(['development', 'held-out']);
    expect(await app.startEvaluation({ suiteId: 'nope', provider: 'scripted' })).toEqual({
      status: 'error',
      reason: 'unknown_suite',
    });
    expect(await app.listEvaluations()).toEqual([]);
  });

  it('runs the simulated provider and labels it as simulated', async () => {
    const { app } = await make();
    const out = await app.startEvaluation({ suiteId: 'development', provider: 'simulated' });
    if (out.status !== 'done') throw new Error('stored');
    expect(out.run.provider).toMatchObject({
      kind: 'simulated',
      model: 'simulated-deterministic-v1',
      simulated: true,
    });
    expect(out.run.measuresModelQuality).toBe(false);
  });

  it('cannot bypass the local-only check: Ollama is refused with the reason, nothing is run or stored, no prompt is sent', async () => {
    const stub = ollamaStub({
      status: { body: { cloud: { disabled: false, source: 'none' } } },
      chat: () => chatReply(INCONCLUSIVE),
    });
    const { app, w } = await make({}, { ollamaFetch: stub.fetch });
    // Even with Fake selected in settings, asking for an Ollama evaluation goes through the same check.
    const out = await app.startEvaluation({ suiteId: 'development', provider: 'ollama' });
    expect(out).toMatchObject({ status: 'refused', reason: 'provider_blocked' });
    if (out.status === 'refused') expect(out.message).toContain('cloud features are enabled');
    expect(stub.calls.some((c) => c.path === '/api/chat')).toBe(false);
    await expect(readdir(join(w.runsDir, '..', 'evaluations'))).rejects.toThrow();
    // Nor does an unreachable runtime fall back to anything else.
    const down = createApplication(w.env(), { ollamaFetch: ollamaStub({ down: true }).fetch });
    expect(await down.startEvaluation({ suiteId: 'held-out', provider: 'ollama' })).toMatchObject({
      status: 'refused',
    });
    expect(await down.listEvaluations()).toEqual([]);
  });

  it('refuses Ollama when the environment pins another provider', async () => {
    const stub = ollamaStub({ chat: () => chatReply(INCONCLUSIVE) });
    const { app } = await make({ EOAI_MODEL_PROVIDER: 'fake' }, { ollamaFetch: stub.fetch });
    const out = await app.startEvaluation({ suiteId: 'held-out', provider: 'ollama' });
    expect(out).toMatchObject({ status: 'refused' });
    if (out.status === 'refused') expect(out.message).toContain('fixed to fake');
    expect(stub.calls.some((c) => c.path === '/api/chat')).toBe(false);
  });

  it('runs a verified local model, records it as a real model, and keeps partial failures visible', async () => {
    const stub = ollamaStub({ chat: () => chatReply(INCONCLUSIVE) });
    const { app } = await make({}, { ollamaFetch: stub.fetch });
    const out = await app.startEvaluation({ suiteId: 'development', provider: 'ollama' });
    if (out.status !== 'done') throw new Error('stored');
    expect(out.run.provider).toEqual({
      kind: 'real_model',
      provider: 'ollama',
      model: 'tiny:1b',
      simulated: false,
    });
    expect(out.run.measuresModelQuality).toBe(true);
    expect(out.run.suite.id).toBe('development');
    // One call for the admitted bundle; the tampered one never reached the model.
    expect(stub.calls.filter((c) => c.path === '/api/chat')).toHaveLength(1);
    expect(out.run.report.cases.map((c) => [c.id, c.summary.outcome])).toEqual([
      ['bundle:development:excerpt-correct', 'inconclusive'],
      ['bundle:development:tampered-bundle', 'failed'],
    ]);
    // An inconclusive answer is a miss, and the run says so rather than averaging it away.
    expect(out.run.metrics.find((m) => m.id === 'root_cause_correct')).toMatchObject({
      numerator: 0,
      denominator: 1,
      value: 0,
    });
    expect(out.run.reliability).toMatchObject({ inconclusive: 1, failed: 1, notAdmitted: 1 });
  });

  it('records malformed model output and timeouts as failures of the case, not of the suite', async () => {
    const bad = ollamaStub({ chat: () => chatReply('{"oops": ') });
    const { app } = await make({}, { ollamaFetch: bad.fetch, sleep: () => Promise.resolve() });
    const out = await app.startEvaluation({ suiteId: 'held-out', provider: 'ollama' });
    if (out.status !== 'done') throw new Error('stored');
    expect(out.run.status).toBe('complete');
    expect(out.run.report.cases[0]).toMatchObject({
      summary: { outcome: 'failed' },
      failure: { class: 'malformed_provider_response' },
    });
    expect(out.run.reliability.failuresByClass).toEqual({ malformed_provider_response: 1 });
  });
});
