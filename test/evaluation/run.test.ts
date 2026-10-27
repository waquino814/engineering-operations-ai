import { describe, expect, it } from 'vitest';
import { compareRuns } from '../../src/evaluation/compare.ts';
import { readEvaluationRun } from '../../src/evaluation/document.ts';
import { runSuite, type EvaluationRun, type RunOptions } from '../../src/evaluation/run.ts';
import { SplitViolation, SUITES, type SuiteDefinition } from '../../src/evaluation/suites.ts';
import type { ModelRequest } from '../../src/investigation/provider.ts';
import { SimulatedProvider } from '../../src/investigation/simulated-provider.ts';

const [DEV, HELD] = SUITES as [SuiteDefinition, SuiteDefinition];
let tick = 0;
const options = (over: Partial<RunOptions> = {}): RunOptions => ({
  provider: { kind: 'scripted' },
  clock: () => (tick += 5),
  now: () => new Date('2026-10-27T12:00:00Z'),
  id: '20261027T120000Z-development-scripted',
  ...over,
});
const metric = (r: EvaluationRun, id: string) => r.metrics.find((m) => m.id === id);

describe('a scripted run of the development suite', () => {
  it('runs every declared case through the pipeline and says it is not a model', async () => {
    const run = await runSuite(DEV, options());
    expect(run.status).toBe('complete');
    expect(run.suite).toMatchObject({
      id: 'development',
      version: '1',
      split: 'development',
      synthetic: true,
    });
    expect(run.provider).toEqual({
      kind: 'scripted',
      provider: 'fake',
      model: 'scripted',
      simulated: true,
    });
    expect(run.measuresModelQuality).toBe(false);
    expect(run.report.cases.map((c) => c.id)).toEqual(DEV.cases.map((c) => c.id));
    expect(run.limitations.join(' ')).toContain('say nothing about any model');
    expect(run.limitations.join(' ')).toContain('Remediation is not scored');
    expect(run.limitations.join(' ')).toContain('Missing for a full held-out evaluation');
    expect(run.limitations.join(' ')).toContain('Development split');
    expect(readEvaluationRun(run)).toEqual({ ok: true, run });
  });

  it('scores with stated numerators and denominators, and does not hide the failures', async () => {
    const run = await runSuite(DEV, options());
    // Seven admitted cases; the tampered bundle is not admitted.
    expect(metric(run, 'root_cause_correct')).toMatchObject({ numerator: 3, denominator: 7 });
    expect(metric(run, 'root_cause_ambiguous')).toMatchObject({ numerator: 1, denominator: 7 });
    expect(metric(run, 'symptom_evidence')).toMatchObject({ numerator: 3, denominator: 7 });
    expect(metric(run, 'completion')).toMatchObject({ numerator: 6, denominator: 8 });
    expect(metric(run, 'citation_grounding')).toMatchObject({ numerator: 11, denominator: 11 });
    expect(metric(run, 'answer_leaks')).toMatchObject({ numerator: 0, denominator: 8 });
    expect(metric(run, 'remediation')).toMatchObject({ status: 'not_scored' });
    expect(run.reliability).toMatchObject({
      cases: 8,
      completed: 5,
      failed: 2,
      inconclusive: 1,
      notAdmitted: 1,
      timeouts: 0,
      harnessErrors: 0,
      failuresByClass: { evidence_verification_failed: 1, invalid_bundle: 1 },
    });
    expect(run.reliability.durationMsByCase.every((c) => typeof c.durationMs === 'number')).toBe(
      true,
    );
  });

  it('gives each failed or wrong case a reason and its failure', async () => {
    const run = await runSuite(DEV, options());
    const byId = new Map(run.report.cases.map((c) => [c.id, c]));
    expect(byId.get('excerpt-wrong-root-cause')?.rationale.join(' ')).toMatch(
      /Root cause incorrect: named orders-api; expected payment-provider/,
    );
    expect(byId.get('excerpt-conflicting-root-causes')?.rationale.join(' ')).toMatch(/ambiguous/);
    expect(byId.get('excerpt-fabricated-evidence')?.failure?.class).toBe(
      'evidence_verification_failed',
    );
    expect(byId.get('excerpt-fabricated-evidence')?.grounding).toEqual({
      citations: 0,
      verified: 0,
    });
    expect(byId.get('tampered-bundle')).toMatchObject({
      score: null,
      scenario: null,
      grounding: null,
      failure: { class: 'invalid_bundle' },
    });
  });

  it('records the scenario and seed for each case and groups the breakdown by scenario', async () => {
    const run = await runSuite(DEV, options());
    expect(run.report.cases.find((c) => c.id === 'excerpt-correct')?.scenario).toEqual({
      name: 'provider-outage',
      seed: 42,
    });
    expect(run.scenarios.map((s) => [s.scenario, s.seed, s.cases.length])).toEqual([
      [null, null, 1],
      ['provider-outage', 42, 7],
    ]);
  });

  it('is reproducible: the same suite gives the same report and metrics', async () => {
    const [a, b] = [await runSuite(DEV, options()), await runSuite(DEV, options())];
    expect(b.report).toEqual(a.report);
    expect(b.metrics).toEqual(a.metrics);
    expect(b.scenarios).toEqual(a.scenarios);
  });
});

describe('the held-out suite and the other provider kinds', () => {
  it('runs the invented scenario, labelled as the held-out split and as synthetic', async () => {
    const run = await runSuite(HELD, options({ id: '20261027T120000Z-held-out-scripted' }));
    expect(run.suite).toMatchObject({ id: 'held-out', split: 'held-out' });
    expect(run.report.cases.map((c) => c.scenario?.name)).toEqual([
      'synthetic-cache-saturation',
      'synthetic-cache-saturation',
    ]);
    expect(metric(run, 'root_cause_correct')).toMatchObject({ numerator: 1, denominator: 2 });
    expect(run.reliability.failuresByClass).toEqual({ provider_unavailable: 1 });
    expect(run.limitations.join(' ')).toContain('test of the split, not of generalization');
  });

  it('runs the simulated provider over each bundle and labels it as a pipeline check', async () => {
    const run = await runSuite(
      DEV,
      options({
        provider: { kind: 'simulated', provider: new SimulatedProvider() },
        id: '20261027T120000Z-development-simulated',
      }),
    );
    expect(run.provider).toMatchObject({
      kind: 'simulated',
      provider: 'fake',
      model: 'simulated-deterministic-v1',
      simulated: true,
    });
    expect(run.measuresModelQuality).toBe(false);
    expect(run.report.cases.map((c) => c.id)).toEqual([
      'bundle:development:excerpt-correct',
      'bundle:development:tampered-bundle',
    ]);
    // It cites by position and claims no root cause: never a correct root cause, always grounded.
    expect(metric(run, 'root_cause_correct')).toMatchObject({ numerator: 0, denominator: 1 });
    expect(metric(run, 'citation_grounding')).toMatchObject({ numerator: 3, denominator: 3 });
    expect(run.limitations.join(' ')).toContain('Simulated provider');
  });

  it('is the only kind that may claim to measure a model, and only a real_model provider does', async () => {
    const inner = new SimulatedProvider();
    const real = {
      provider: 'ollama',
      model: 'tiny:1b',
      complete: (r: ModelRequest, o: { signal: AbortSignal }) => inner.complete(r, o),
    };
    const run = await runSuite(
      HELD,
      options({
        provider: { kind: 'real_model', provider: real },
        id: '20261027T120000Z-held-out-real_model',
      }),
    );
    expect(run.provider).toEqual({
      kind: 'real_model',
      provider: 'ollama',
      model: 'tiny:1b',
      simulated: false,
    });
    expect(run.measuresModelQuality).toBe(true);
    expect(run.limitations.join(' ')).toContain('not an estimate of accuracy on real incidents');
    expect(readEvaluationRun(run).ok).toBe(true);
    // The document refuses a run whose flags disagree with its kind.
    expect(readEvaluationRun({ ...run, measuresModelQuality: false }).ok).toBe(false);
    expect(readEvaluationRun({ ...run, provider: { ...run.provider, simulated: true } }).ok).toBe(
      false,
    );
    const scripted = await runSuite(HELD, options({ id: '20261027T120000Z-held-out-scripted' }));
    expect(readEvaluationRun({ ...scripted, measuresModelQuality: true }).ok).toBe(false);
  });

  it('stops between cases when cancelled and says the run is incomplete', async () => {
    const controller = new AbortController();
    controller.abort();
    const run = await runSuite(DEV, options({ signal: controller.signal }));
    expect(run.status).toBe('incomplete');
    expect(run.report.cases).toEqual([]);
    expect(metric(run, 'completion')).toMatchObject({ status: 'not_applicable' });
  });

  it('throws a split violation if a case’s answer key names a scenario other than the declared one', async () => {
    const bad: SuiteDefinition = {
      ...DEV,
      cases: [{ id: 'fabricated-correct', scenario: 'provider-outage' }],
    };
    await expect(runSuite(bad, options())).rejects.toBeInstanceOf(SplitViolation);
  });
});

describe('the stored document', () => {
  it('rejects unknown fields, bad ids and damaged cases, and never repairs them', async () => {
    const run = await runSuite(HELD, options({ id: '20261027T120000Z-held-out-scripted' }));
    for (const bad of [
      { ...run, extra: 1 },
      { ...run, id: '../x' },
      { ...run, status: 'done' },
      { ...run, schemaVersion: '9' },
      { ...run, metrics: [{ id: 'm' }] },
      { ...run, report: { ...run.report, cases: [{ id: 'c' }] } },
      null,
      'text',
    ]) {
      const r = readEvaluationRun(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.problems.length).toBeGreaterThan(0);
    }
  });
});

describe('comparing two runs', () => {
  it('finds no change between a run and itself, and refuses different suites', async () => {
    const dev = await runSuite(DEV, options());
    const held = await runSuite(HELD, options({ id: '20261027T120000Z-held-out-scripted' }));
    const same = compareRuns(dev, { ...dev, id: '20261027T130000Z-development-scripted' });
    if (same === 'different_suite') throw new Error('same suite');
    expect(same.regressions + same.improvements).toBe(0);
    expect(same.sameProvider).toBe(true);
    expect(same.cases.every((c) => c.change === 'unchanged')).toBe(true);
    expect(compareRuns(dev, held)).toBe('different_suite');
  });

  it('flags a case that lost its root cause or its symptom series as a regression, and the reverse as an improvement', async () => {
    const dev = await runSuite(DEV, options());
    const worse = structuredClone(dev);
    worse.id = '20261027T130000Z-development-scripted';
    const correct = worse.report.cases.find((c) => c.id === 'excerpt-correct');
    if (!correct?.score) throw new Error('scored');
    correct.score.rootCause = 'incorrect';
    correct.score.symptomEvidence = 'not_covered';
    const wrong = worse.report.cases.find((c) => c.id === 'excerpt-wrong-root-cause');
    if (!wrong?.score) throw new Error('scored');
    wrong.score.rootCause = 'correct';
    worse.metrics = worse.metrics.map((m) =>
      m.id === 'root_cause_correct' ? { ...m, numerator: 2, value: 0.286 } : m,
    );
    const c = compareRuns(dev, worse);
    if (c === 'different_suite') throw new Error('same suite');
    expect(c.cases.find((x) => x.id === 'excerpt-correct')?.change).toBe('regressed');
    expect(c.cases.find((x) => x.id === 'excerpt-wrong-root-cause')?.change).toBe('improved');
    expect(c.regressions).toBe(1);
    expect(c.improvements).toBe(1);
    expect(c.metrics.find((m) => m.id === 'root_cause_correct')).toMatchObject({
      a: 0.429,
      b: 0.286,
      delta: -0.143,
    });
    // A case missing from one side, and a different provider, are reported as such.
    const trimmed = structuredClone(worse);
    trimmed.report.cases = trimmed.report.cases.slice(1);
    trimmed.provider = { kind: 'real_model', provider: 'ollama', model: 'm', simulated: false };
    const t = compareRuns(dev, trimmed);
    if (t === 'different_suite') throw new Error('same suite');
    expect(t.cases.find((x) => x.id === dev.report.cases[0]?.id)?.change).toBe('only_in_a');
    expect(t.sameProvider).toBe(false);
  });
});
