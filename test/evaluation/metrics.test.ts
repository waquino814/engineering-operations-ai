import { describe, expect, it } from 'vitest';
import type { CaseReport } from '../../src/evaluation/harness.ts';
import {
  aggregateMetrics,
  reliabilityOf,
  scenarioBreakdown,
} from '../../src/evaluation/metrics.ts';

/** Metrics from hand-made case reports, so every numerator and denominator can be checked by eye. */
function report(
  over: Partial<CaseReport> & {
    root?: string;
    symptom?: string;
    predicted?: string[];
    expected?: string[];
    outcome?: string;
  },
): CaseReport {
  const admitted = over.score !== null;
  return {
    id: 'c',
    kind: 'synthetic',
    summary: { outcome: over.outcome ?? 'completed', failureClass: null } as CaseReport['summary'],
    failure: null,
    scenario: admitted ? { name: 's', seed: 1 } : null,
    score: admitted
      ? ({
          outcome: over.outcome ?? 'completed',
          rootCause: over.root ?? 'correct',
          symptomEvidence: over.symptom ?? 'covered',
          affected: {
            predicted: over.predicted ?? ['a'],
            expected: over.expected ?? ['a'],
            precision: 1,
            recall: 1,
          },
        } as CaseReport['score'])
      : null,
    rationale: [],
    grounding: admitted ? { citations: 2, verified: 2 } : null,
    componentEvidence: admitted ? { named: 1, identified: 1, unidentified: [] } : null,
    resultValid: true,
    answerLeak: {
      checkedRequests: 1,
      checkedValues: 1,
      legitimatelyPresent: 0,
      leaked: false,
      findings: [],
    },
    ...over,
  };
}
const get = (ms: ReturnType<typeof aggregateMetrics>, id: string) => {
  const m = ms.find((x) => x.id === id);
  if (!m) throw new Error(id);
  return m;
};

describe('aggregate metrics', () => {
  it('count a failed or missing diagnosis as a miss, and keep un-admitted cases out of the diagnosis denominators', () => {
    const ms = aggregateMetrics([
      report({ id: 'ok' }),
      report({ id: 'wrong', root: 'incorrect', symptom: 'not_covered' }),
      report({ id: 'conflict', root: 'ambiguous' }),
      report({
        id: 'failed',
        root: 'missing',
        symptom: 'not_covered',
        outcome: 'failed',
        grounding: { citations: 0, verified: 0 },
      }),
      report({ id: 'tampered', score: null, outcome: 'failed', grounding: null }),
    ]);
    expect(get(ms, 'root_cause_correct')).toMatchObject({
      numerator: 1,
      denominator: 4,
      value: 0.25,
      status: 'scored',
    });
    expect(get(ms, 'root_cause_ambiguous')).toMatchObject({
      numerator: 1,
      denominator: 4,
      value: 0.25,
    });
    expect(get(ms, 'symptom_evidence')).toMatchObject({ numerator: 2, denominator: 4 });
    // The un-admitted case still counts where it must.
    expect(get(ms, 'completion')).toMatchObject({ numerator: 3, denominator: 5, value: 0.6 });
    expect(get(ms, 'result_validity')).toMatchObject({ numerator: 5, denominator: 5 });
    expect(get(ms, 'answer_leaks')).toMatchObject({ numerator: 0, denominator: 5, value: 0 });
  });

  it('sums affected components across cases instead of averaging ratios', () => {
    const ms = aggregateMetrics([
      report({ predicted: ['a', 'x'], expected: ['a', 'b'] }),
      report({ predicted: ['a'], expected: ['a'] }),
    ]);
    // hits 2; predicted 3; expected 3
    expect(get(ms, 'affected_precision')).toMatchObject({
      numerator: 2,
      denominator: 3,
      value: 0.667,
    });
    expect(get(ms, 'affected_recall')).toMatchObject({
      numerator: 2,
      denominator: 3,
      value: 0.667,
    });
  });

  it('counts named components found in cited records as a rate over components named, never as support', () => {
    const ms = aggregateMetrics([
      report({ componentEvidence: { named: 3, identified: 1, unidentified: [] } }),
      report({ componentEvidence: { named: 1, identified: 1, unidentified: [] } }),
      report({ score: null, grounding: null, componentEvidence: null }),
    ]);
    const m = get(ms, 'component_identified');
    expect(m).toMatchObject({ numerator: 2, denominator: 4, value: 0.5, status: 'scored' });
    expect(m.definition).toContain('does not show that the records support the finding');
    expect(
      get(aggregateMetrics([report({ componentEvidence: null })]), 'component_identified'),
    ).toMatchObject({ status: 'not_applicable', value: null });
  });

  it('counts re-verified citations over all citations, and says not applicable rather than zero when there are none', () => {
    const some = aggregateMetrics([
      report({ grounding: { citations: 3, verified: 2 } }),
      report({ grounding: { citations: 1, verified: 1 } }),
    ]);
    expect(get(some, 'citation_grounding')).toMatchObject({
      numerator: 3,
      denominator: 4,
      value: 0.75,
    });
    const none = aggregateMetrics([
      report({ grounding: { citations: 0, verified: 0 } }),
      report({ score: null, grounding: null }),
    ]);
    expect(get(none, 'citation_grounding')).toEqual(
      expect.objectContaining({
        numerator: null,
        denominator: 0,
        value: null,
        status: 'not_applicable',
      }),
    );
    const empty = aggregateMetrics([]);
    expect(get(empty, 'root_cause_correct')).toMatchObject({
      value: null,
      status: 'not_applicable',
    });
  });

  it('never scores remediation, and says why', () => {
    const m = get(aggregateMetrics([report({})]), 'remediation');
    expect(m).toMatchObject({ status: 'not_scored', value: null, numerator: null });
    expect(m.note).toContain('no rubric');
  });

  it('breaks the numbers down by scenario and reports reliability by failure class', () => {
    const cases = [
      report({ id: 'a1' }),
      report({ id: 'b1', scenario: { name: 'other', seed: 9 }, root: 'incorrect' }),
      report({
        id: 't',
        score: null,
        scenario: null,
        outcome: 'failed',
        summary: { outcome: 'failed', failureClass: 'invalid_bundle' } as CaseReport['summary'],
      }),
      report({
        id: 'to',
        outcome: 'failed',
        summary: { outcome: 'failed', failureClass: 'provider_timeout' } as CaseReport['summary'],
        durationMs: 12,
      }),
    ];
    const by = scenarioBreakdown(cases);
    expect(by.map((s) => [s.scenario, s.seed, s.cases])).toEqual([
      [null, null, ['t']],
      ['other', 9, ['b1']],
      ['s', 1, ['a1', 'to']],
    ]);
    expect(by[1]?.metrics.find((m) => m.id === 'root_cause_correct')).toMatchObject({
      numerator: 0,
      denominator: 1,
    });
    expect(reliabilityOf(cases, 1)).toMatchObject({
      cases: 4,
      failed: 2,
      notAdmitted: 1,
      timeouts: 1,
      harnessErrors: 1,
      failuresByClass: { invalid_bundle: 1, provider_timeout: 1 },
      durationMsByCase: [
        { id: 'a1', durationMs: null },
        { id: 'b1', durationMs: null },
        { id: 't', durationMs: null },
        { id: 'to', durationMs: 12 },
      ],
    });
  });
});
