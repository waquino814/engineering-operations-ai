import { beforeAll, describe, expect, it } from 'vitest';
import {
  baselineFindings,
  baselineProblems,
  formatFinding,
  inconsistencies,
  integrityFindings,
  METRIC_DIRECTION,
  regressionFindings,
  type GateFinding,
} from '../../src/evaluation/gate.ts';
import { aggregateMetrics } from '../../src/evaluation/metrics.ts';
import type { EvaluationRun } from '../../src/evaluation/run.ts';
import { SimulatedProvider } from '../../src/investigation/simulated-provider.ts';
import { copyOf, reaggregate, suiteRun } from './support.ts';

/** `expect.stringContaining`, typed as the string it stands in for. */
const containing = (text: string): string => expect.stringContaining(text) as string;

let development: EvaluationRun;
let heldOut: EvaluationRun;
beforeAll(async () => {
  development = await suiteRun('development');
  heldOut = await suiteRun('held-out');
});

const fresh = (run: EvaluationRun) => copyOf(run);
const caseOf = (run: EvaluationRun, id: string) => {
  const found = run.report.cases.find((c) => c.id === id);
  if (found === undefined) throw new Error(`fixture changed: no case ${id}`);
  return found;
};
const codes = (findings: GateFinding[]) => findings.map((f) => f.code);

describe('integrity findings', () => {
  it('finds nothing wrong with an honest run, wrong diagnoses included', async () => {
    const simulated = await suiteRun('held-out', {
      kind: 'simulated',
      provider: new SimulatedProvider(),
    });
    for (const run of [development, heldOut, simulated])
      expect([run.suite.id, integrityFindings(run)]).toEqual([run.suite.id, []]);
    expect(caseOf(development, 'excerpt-wrong-root-cause').score?.rootCause).toBe('incorrect');
  });

  it('names the case, the metric and the reason when a citation is not confirmed', () => {
    const run = fresh(development);
    const c = caseOf(run, 'excerpt-correct');
    if (c.grounding === null) throw new Error('fixture changed');
    c.grounding.verified = c.grounding.citations - 1;
    reaggregate(run);
    const [f, ...rest] = integrityFindings(run);
    expect(rest).toEqual([]);
    expect(f).toMatchObject({
      code: 'citation_unconfirmed',
      suite: 'development@1',
      case: 'excerpt-correct',
      metric: 'citation_grounding',
    });
    expect(formatFinding(f as GateFinding)).toBe(
      `development@1: case excerpt-correct: 1 of ${String(c.grounding.citations)} citation(s) not confirmed by the independent re-read`,
    );
  });

  it('fails an admitted case whose citations were never re-read', () => {
    const run = fresh(development);
    caseOf(run, 'excerpt-correct').grounding = null;
    reaggregate(run);
    expect(integrityFindings(run)).toMatchObject([
      { code: 'grounding_missing', case: 'excerpt-correct', metric: 'citation_grounding' },
    ]);
  });

  it('fails a report whose totals, metrics or status do not follow from its cases', () => {
    const totals = fresh(heldOut);
    totals.report.totals.rootCauseCorrect += 1;
    expect(inconsistencies(totals)).toEqual(['report.totals']);
    expect(integrityFindings(totals)).toMatchObject([
      { code: 'report_inconsistent', reason: containing('report.totals') },
    ]);

    const metrics = fresh(heldOut);
    const m = metrics.metrics.find((x) => x.id === 'completion');
    if (!m) throw new Error('fixture changed');
    m.value = 0.123;
    expect(inconsistencies(metrics)).toEqual(['metrics']);

    const status = fresh(heldOut);
    status.harnessErrors = [{ id: 'x', error: 'the harness could not evaluate this case' }];
    expect(inconsistencies(status)).toEqual(expect.arrayContaining(['status', 'reliability']));
  });

  it('fails a run that does not satisfy its schema, without judging anything else', () => {
    const run = fresh(heldOut) as unknown as Record<string, unknown>;
    delete run['metrics'];
    const found = integrityFindings(run as unknown as EvaluationRun);
    expect(codes(found)).toEqual(['run_schema_invalid']);
    expect(found[0]?.reason).toContain('metrics');
  });

  it('rejects a case report whose score or grounding is malformed', () => {
    const score = fresh(heldOut);
    (caseOf(score, 'fabricated-correct') as unknown as { score: unknown }).score = {
      rootCause: 'maybe',
    };
    expect(codes(integrityFindings(score))).toEqual(['run_schema_invalid']);
    const grounding = fresh(heldOut);
    (caseOf(grounding, 'fabricated-correct') as unknown as { grounding: unknown }).grounding = {
      citations: 'many',
    };
    expect(codes(integrityFindings(grounding))).toEqual(['run_schema_invalid']);
  });

  it('detects a scripted case that the suite defines but the run lacks, and one it does not define', () => {
    const missing = fresh(development);
    missing.report.cases = missing.report.cases.filter((c) => c.id !== 'excerpt-correct');
    reaggregate(missing);
    expect(integrityFindings(missing)).toMatchObject([
      { code: 'case_not_reported', case: 'excerpt-correct' },
    ]);
    const extra = fresh(development);
    caseOf(extra, 'excerpt-correct').id = 'invented-case';
    reaggregate(extra);
    expect(codes(integrityFindings(extra)).sort()).toEqual([
      'case_not_in_suite',
      'case_not_reported',
    ]);
  });

  it('detects a case reported twice', () => {
    const run = fresh(heldOut);
    run.report.cases.push(copyOf(run).report.cases[0] as never);
    reaggregate(run);
    expect(integrityFindings(run)).toMatchObject([
      { code: 'duplicate_case', case: 'fabricated-correct' },
    ]);
  });

  it('keeps reporting leaks, contract failures and incomplete runs, now with the case', () => {
    const run = fresh(heldOut);
    caseOf(run, 'fabricated-correct').answerLeak.leaked = true;
    caseOf(run, 'fabricated-correct').resultValid = false;
    run.status = 'incomplete';
    reaggregate(run);
    const found = integrityFindings(run);
    expect(codes(found)).toEqual(
      expect.arrayContaining(['answer_leak', 'result_invalid', 'run_incomplete']),
    );
    expect(found.find((f) => f.code === 'answer_leak')?.reason).toBe(
      '1 case(s) leaked answer text (fabricated-correct)',
    );
    expect(found.find((f) => f.code === 'result_invalid')).toMatchObject({
      case: 'fabricated-correct',
      metric: 'result_validity',
    });
  });
});

describe('regressions against a baseline', () => {
  it('finds no difference between a run and itself', () => {
    expect(regressionFindings(development, copyOf(development))).toEqual([]);
    expect(baselineFindings([development, heldOut], [heldOut, development])).toEqual([]);
  });

  it('names the case, the dimension and both values for each case that got worse', () => {
    const baseline = fresh(development);
    const c = caseOf(baseline, 'excerpt-wrong-root-cause');
    if (!c.score) throw new Error('fixture changed');
    c.score.rootCause = 'correct';
    c.score.affected.recall = 1;
    const found = regressionFindings(baseline, development).filter((f) => f.case === c.id);
    expect(found).toMatchObject([
      {
        code: 'case_regressed',
        metric: 'root_cause_correct',
        baseline: 'correct',
        current: 'incorrect',
        reason:
          'case excerpt-wrong-root-cause is regressed: root_cause_correct went from correct to incorrect',
      },
      ...(caseOf(development, c.id).score?.affected.recall === 1
        ? []
        : [{ code: 'case_regressed', metric: 'affected_recall' }]),
    ]);
  });

  it('reports a case that got worse on one dimension and better on another as changed', () => {
    const baseline = fresh(development);
    const c = caseOf(baseline, 'excerpt-wrong-root-cause');
    if (!c.score) throw new Error('fixture changed');
    c.score.rootCause = 'correct';
    c.score.symptomEvidence = c.score.symptomEvidence === 'covered' ? 'not_covered' : 'covered';
    const now = caseOf(development, c.id).score?.symptomEvidence;
    const found = regressionFindings(baseline, development).find((f) => f.case === c.id);
    expect(found?.reason).toContain(now === 'covered' ? 'is changed' : 'is regressed');
  });

  it('detects a drop in citation grounding and in precision and recall', () => {
    const baseline = fresh(development);
    const c = caseOf(baseline, 'excerpt-correct');
    if (!c.score || !c.grounding) throw new Error('fixture changed');
    c.score.affected.precision = 1;
    c.score.affected.recall = 1;
    const now = caseOf(development, 'excerpt-correct');
    const worsened = [
      (now.score?.affected.precision ?? 1) < 1 ? 'affected_precision' : null,
      (now.score?.affected.recall ?? 1) < 1 ? 'affected_recall' : null,
    ].flatMap((x) => (x ? [x] : []));
    const found = regressionFindings(baseline, development).filter((f) => f.case === c.id);
    expect(found.map((f) => f.metric)).toEqual(worsened);
    // Grounding: the later run confirms fewer of its citations.
    const later = fresh(development);
    const g = caseOf(later, 'excerpt-correct').grounding;
    if (!g) throw new Error('fixture changed');
    g.verified = 0;
    expect(
      regressionFindings(development, later).filter((f) => f.metric === 'citation_grounding'),
    ).toMatchObject([
      { code: 'case_regressed', case: 'excerpt-correct', current: `0/${String(g.citations)}` },
    ]);
  });

  it('cannot pass when a baseline case is missing from the run, or a new one appears', () => {
    const baseline = fresh(development);
    caseOf(baseline, 'excerpt-correct').id = 'old-name';
    reaggregate(baseline);
    const found = regressionFindings(baseline, development);
    expect(found).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'case_missing',
          case: 'old-name',
          reason: 'case old-name is in the baseline but missing from this run',
        }),
        expect.objectContaining({ code: 'case_unexpected', case: 'excerpt-correct' }),
      ]),
    );
  });

  it('names the metric that fell, with numerators and denominators', () => {
    const baseline = fresh(development);
    for (const c of baseline.report.cases) if (c.score) c.score.rootCause = 'correct';
    reaggregate(baseline);
    const found = regressionFindings(baseline, development).filter(
      (f) => f.code === 'metric_regressed',
    );
    const was = baseline.metrics.find((m) => m.id === 'root_cause_correct');
    const now = development.metrics.find((m) => m.id === 'root_cause_correct');
    expect(found).toContainEqual(
      expect.objectContaining({
        metric: 'root_cause_correct',
        reason: `metric root_cause_correct fell from ${String(was?.value)} (${String(was?.numerator)}/${String(was?.denominator)}) to ${String(now?.value)} (${String(now?.numerator)}/${String(now?.denominator)})`,
      }),
    );
  });

  it('treats a rise in a lower-is-better metric as a regression, and a rise in a higher one as fine', () => {
    const baseline = fresh(development);
    for (const c of baseline.report.cases) if (c.score) c.score.rootCause = 'incorrect';
    reaggregate(baseline);
    const worse = fresh(development);
    for (const c of worse.report.cases) if (c.score) c.score.rootCause = 'ambiguous';
    reaggregate(worse);
    const metrics = regressionFindings(baseline, worse)
      .filter((f) => f.code === 'metric_regressed')
      .map((f) => f.metric);
    expect(metrics).toContain('root_cause_ambiguous');
    expect(metrics).not.toContain('root_cause_correct');
    expect(
      regressionFindings(worse, baseline).filter((f) => f.code === 'metric_regressed'),
    ).toEqual([]);
  });

  it('fails a metric that was scored in the baseline but is not any more, and one it cannot judge', () => {
    const baseline = fresh(heldOut);
    const later = fresh(heldOut);
    const m = later.metrics.find((x) => x.id === 'completion');
    if (!m) throw new Error('fixture changed');
    Object.assign(m, { numerator: null, denominator: 0, value: null, status: 'not_applicable' });
    expect(regressionFindings(baseline, later)).toMatchObject([
      {
        code: 'metric_regressed',
        metric: 'completion',
        current: 'not_applicable',
        reason: containing('but is not_applicable in this run'),
      },
    ]);
    const unknown = fresh(heldOut);
    const u = unknown.metrics.find((x) => x.id === 'completion');
    if (!u) throw new Error('fixture changed');
    u.id = 'invented_metric';
    expect(regressionFindings(unknown, heldOut)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'metric_unjudgeable', metric: 'invented_metric' }),
      ]),
    );
  });

  it('declares a direction for every metric the harness scores', () => {
    const scored = [...development.metrics, ...heldOut.metrics, ...aggregateMetrics([])]
      .filter((m) => m.status !== 'not_scored')
      .map((m) => m.id);
    expect(scored.length).toBeGreaterThan(0);
    for (const id of new Set(scored)) expect(METRIC_DIRECTION).toHaveProperty(id);
  });

  it('detects the development / held-out split moving', () => {
    const wasHeldOut = fresh(development);
    wasHeldOut.suite.split = 'held-out';
    const found = regressionFindings(wasHeldOut, development);
    expect(found).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'split_changed',
          baseline: 'held-out',
          current: 'development',
          reason: 'the suite was held-out in the baseline and is development now',
        }),
        expect.objectContaining({
          code: 'split_changed',
          reason:
            'scenario provider-outage was in the held-out baseline but is registered as development now',
        }),
      ]),
    );
  });

  it('detects a scenario that is no longer registered, and a changed scenario set', () => {
    const baseline = fresh(development);
    for (const s of baseline.scenarios)
      if (s.scenario === 'provider-outage') s.scenario = 'retired-scenario';
    expect(regressionFindings(baseline, development)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'split_changed',
          reason: containing('no longer registered on either side of the split'),
        }),
        expect.objectContaining({ code: 'scenario_set_changed', current: 'provider-outage' }),
        expect.objectContaining({ code: 'scenario_set_changed', baseline: 'retired-scenario' }),
      ]),
    );
  });

  it('detects a case that moved to another scenario', () => {
    const baseline = fresh(heldOut);
    const c = caseOf(baseline, 'fabricated-correct');
    if (!c.scenario) throw new Error('fixture changed');
    c.scenario.name = 'provider-outage';
    expect(regressionFindings(baseline, heldOut)).toContainEqual(
      expect.objectContaining({
        code: 'case_scenario_changed',
        case: 'fabricated-correct',
        baseline: 'provider-outage',
        current: 'synthetic-cache-saturation',
      }),
    );
  });

  it('says why a baseline has no matching run, including a version mismatch', () => {
    const v2 = fresh(heldOut);
    v2.suite.version = '2';
    expect(baselineFindings([heldOut], [v2])).toMatchObject([
      {
        code: 'baseline_missing_run',
        baseline: '2',
        current: '1',
        reason: 'the baseline records version 2 of this suite; this run is version 1',
      },
    ]);
    expect(baselineFindings([heldOut], [development])).toMatchObject([
      { code: 'baseline_missing_run', reason: 'the baseline has no scripted run of this suite' },
    ]);
  });
});

describe('baselines that cannot be trusted', () => {
  it('accepts an honest baseline', () => {
    expect(baselineProblems([development, heldOut])).toEqual([]);
  });

  it('refuses one that is incomplete, inconsistent, ambiguous or reports a case twice', () => {
    const incomplete = fresh(heldOut);
    incomplete.status = 'incomplete';
    expect(baselineProblems([incomplete])[0]).toContain('is incomplete');
    const inconsistent = fresh(heldOut);
    inconsistent.report.totals.cases += 1;
    expect(baselineProblems([inconsistent])[0]).toContain(
      'internally inconsistent (report.totals)',
    );
    expect(baselineProblems([heldOut, copyOf(heldOut)])).toEqual([
      'the baseline holds 2 runs of held-out@1 (scripted); it must hold exactly one',
    ]);
    const twice = fresh(heldOut);
    twice.report.cases.push(copyOf(heldOut).report.cases[0] as never);
    reaggregate(twice);
    expect(baselineProblems([twice])[0]).toContain(
      'reports a case more than once (fabricated-correct)',
    );
  });
});
