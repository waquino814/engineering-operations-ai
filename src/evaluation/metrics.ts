import type { CaseReport } from './harness.ts';

/**
 * Aggregate evaluation metrics (ADR 0009, scoring v0.1). Each one states its definition, its
 * numerator and its denominator, so a rate can be recomputed by hand from the per-case reports.
 *
 * Counting rules, which keep failures from hiding inside an average:
 * - "Admitted" cases are those whose bundle passed intake and whose answer key was scored. A case
 *   that was not admitted has no score and is out of the diagnosis denominators, but it is still
 *   counted in `completion`, `result_validity` and `answer_leaks`, and listed by name.
 * - An admitted case that failed, ran out of budget or was inconclusive counts in the
 *   denominator and not in the numerator: a missing diagnosis is a miss.
 * - A rate with an empty denominator is `not_applicable` (value null), never zero.
 */
export interface Metric {
  id: string;
  label: string;
  definition: string;
  numerator: number | null;
  denominator: number;
  /** numerator / denominator rounded to three places; null unless `status` is "scored". */
  value: number | null;
  status: 'scored' | 'not_applicable' | 'not_scored';
  note?: string;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

function rate(id: string, label: string, definition: string, num: number, den: number): Metric {
  return den === 0
    ? {
        id,
        label,
        definition,
        numerator: null,
        denominator: 0,
        value: null,
        status: 'not_applicable',
      }
    : {
        id,
        label,
        definition,
        numerator: num,
        denominator: den,
        value: round(num / den),
        status: 'scored',
      };
}

export const REMEDIATION_NOT_SCORED =
  'The answer key states the expected remediation as free text and defines no rubric or machine-checkable outcome, so remediation is not scored. String similarity would not be correctness. This stays open until the owner defines a rubric.';

export function aggregateMetrics(cases: readonly CaseReport[]): Metric[] {
  const admitted = cases.filter((c) => c.score !== null);
  const count = (f: (c: CaseReport) => boolean) => admitted.filter(f).length;
  let predicted = 0;
  let expected = 0;
  let hits = 0;
  for (const c of admitted) {
    const a = c.score?.affected;
    if (!a) continue;
    predicted += a.predicted.length;
    expected += a.expected.length;
    hits += a.predicted.filter((p) => a.expected.includes(p)).length;
  }
  const grounded = cases.flatMap((c) => (c.grounding ? [c.grounding] : []));
  const citations = grounded.reduce((n, g) => n + g.citations, 0);
  const verified = grounded.reduce((n, g) => n + g.verified, 0);
  return [
    rate(
      'root_cause_correct',
      'Root cause correct',
      "Admitted cases whose single named root-cause component is the answer key's, over admitted cases.",
      count((c) => c.score?.rootCause === 'correct'),
      admitted.length,
    ),
    rate(
      'root_cause_ambiguous',
      'Root cause ambiguous (lower is better)',
      'Admitted cases that name more than one component as the root cause, over admitted cases.',
      count((c) => c.score?.rootCause === 'ambiguous'),
      admitted.length,
    ),
    rate(
      'affected_precision',
      'Affected components: precision',
      'Components named in findings that the key lists as affected, over components named, summed across admitted cases.',
      hits,
      predicted,
    ),
    rate(
      'affected_recall',
      'Affected components: recall',
      'Affected components the key lists that findings name, over components the key lists, summed across admitted cases.',
      hits,
      expected,
    ),
    rate(
      'symptom_evidence',
      'Primary symptom series cited',
      "Admitted cases in which some finding cites the key's primary-symptom series with its labels, over admitted cases. Says the series was cited, not that the reasoning was right.",
      count((c) => c.score?.symptomEvidence === 'covered'),
      admitted.length,
    ),
    rate(
      'citation_grounding',
      'Citations re-verified against the bundle',
      'Citations in all findings that a second, independent read of the bundle confirms (record exists, identifiers match, file checksum unchanged), over all citations. Cases without findings contribute none.',
      verified,
      citations,
    ),
    rate(
      'completion',
      'Investigations that reached a result',
      'Cases ending completed or inconclusive, over all cases. Failed, budget-exceeded and not-admitted cases are the rest.',
      cases.filter((c) => c.summary.outcome === 'completed' || c.summary.outcome === 'inconclusive')
        .length,
      cases.length,
    ),
    rate(
      'result_validity',
      'Results valid against the contract',
      'Cases whose result passes the published result contract, over all cases.',
      cases.filter((c) => c.resultValid).length,
      cases.length,
    ),
    rate(
      'answer_leaks',
      'Cases with an answer leak (must be 0)',
      "Cases in which a protected value reached a model request or the result's metadata, over all cases.",
      cases.filter((c) => c.answerLeak.leaked).length,
      cases.length,
    ),
    {
      id: 'remediation',
      label: 'Remediation quality',
      definition: 'Not scored.',
      numerator: null,
      denominator: 0,
      value: null,
      status: 'not_scored',
      note: REMEDIATION_NOT_SCORED,
    },
  ];
}

/** Metrics for the cases of one scenario, from the same definitions. */
export function scenarioBreakdown(cases: readonly CaseReport[]) {
  const names = [...new Set(cases.map((c) => c.scenario?.name ?? null))].sort((a, b) =>
    String(a).localeCompare(String(b)),
  );
  return names.map((name) => {
    const of = cases.filter((c) => (c.scenario?.name ?? null) === name);
    const m = aggregateMetrics(of);
    const pick = (id: string) => m.find((x) => x.id === id);
    return {
      scenario: name,
      seed: of.find((c) => c.scenario)?.scenario?.seed ?? null,
      cases: of.map((c) => c.id),
      metrics: ['root_cause_correct', 'symptom_evidence', 'citation_grounding', 'completion']
        .map(pick)
        .flatMap((x) => (x ? [x] : [])),
    };
  });
}

export interface Reliability {
  cases: number;
  completed: number;
  inconclusive: number;
  failed: number;
  budgetExceeded: number;
  notAdmitted: number;
  /** Cases that failed on a provider timeout. */
  timeouts: number;
  /** Failed cases by the failure class the pipeline recorded. */
  failuresByClass: Record<string, number>;
  /** Cases the harness itself could not evaluate (an infrastructure error, not a diagnosis). */
  harnessErrors: number;
  durationMsByCase: { id: string; durationMs: number | null }[];
}

export function reliabilityOf(cases: readonly CaseReport[], harnessErrors: number): Reliability {
  const failuresByClass: Record<string, number> = {};
  for (const c of cases)
    if (c.summary.failureClass)
      failuresByClass[c.summary.failureClass] = (failuresByClass[c.summary.failureClass] ?? 0) + 1;
  const n = (o: string) => cases.filter((c) => c.summary.outcome === o).length;
  return {
    cases: cases.length,
    completed: n('completed'),
    inconclusive: n('inconclusive'),
    failed: n('failed'),
    budgetExceeded: n('budget_exceeded'),
    notAdmitted: cases.filter((c) => c.score === null).length,
    timeouts: failuresByClass['provider_timeout'] ?? 0,
    failuresByClass: Object.fromEntries(
      Object.entries(failuresByClass).sort(([a], [b]) => a.localeCompare(b)),
    ),
    harnessErrors,
    durationMsByCase: cases.map((c) => ({ id: c.id, durationMs: c.durationMs ?? null })),
  };
}
