import type { CaseReport } from './harness.ts';
import type { Metric } from './metrics.ts';
import type { EvaluationRun } from './run.ts';

/**
 * Comparing two stored evaluation runs of the same suite and version, to detect regressions
 * without rerunning anything. A case "regressed" when its root cause got worse, it stopped citing
 * the primary symptom's series, or it stopped reaching a result; "improved" is the reverse; a case
 * that moved both ways is "changed". Runs from different providers can be compared, but are
 * flagged: comparing a simulated run with a real model's measures the provider, not a change.
 */
export type CaseChange =
  'regressed' | 'improved' | 'changed' | 'unchanged' | 'only_in_a' | 'only_in_b';

export interface Comparison {
  suite: { id: string; version: string };
  a: { id: string; provider: EvaluationRun['provider'] };
  b: { id: string; provider: EvaluationRun['provider'] };
  /** False when the two runs used different providers or models. */
  sameProvider: boolean;
  metrics: {
    id: string;
    label: string;
    a: number | null;
    b: number | null;
    delta: number | null;
  }[];
  cases: { id: string; change: CaseChange; a: string | null; b: string | null }[];
  regressions: number;
  improvements: number;
}

export const ROOT_RANK: Record<string, number> = {
  correct: 3,
  ambiguous: 2,
  incorrect: 1,
  missing: 0,
};
export const OUTCOME_RANK: Record<string, number> = {
  completed: 2,
  inconclusive: 1,
  failed: 0,
  budget_exceeded: 0,
};

const label = (c: CaseReport | undefined) =>
  c === undefined
    ? null
    : `${c.summary.outcome}; root cause ${c.score?.rootCause ?? 'n/a'}; symptom series ${c.score?.symptomEvidence ?? 'n/a'}`;

function direction(a: CaseReport, b: CaseReport): CaseChange {
  const dims = [
    (ROOT_RANK[b.score?.rootCause ?? 'missing'] ?? 0) -
      (ROOT_RANK[a.score?.rootCause ?? 'missing'] ?? 0),
    (b.score?.symptomEvidence === 'covered' ? 1 : 0) -
      (a.score?.symptomEvidence === 'covered' ? 1 : 0),
    (OUTCOME_RANK[b.summary.outcome] ?? 0) - (OUTCOME_RANK[a.summary.outcome] ?? 0),
  ];
  const worse = dims.some((d) => d < 0);
  const better = dims.some((d) => d > 0);
  return worse && better ? 'changed' : worse ? 'regressed' : better ? 'improved' : 'unchanged';
}

export function compareRuns(a: EvaluationRun, b: EvaluationRun): Comparison | 'different_suite' {
  if (a.suite.id !== b.suite.id || a.suite.version !== b.suite.version) return 'different_suite';
  const value = (ms: Metric[], id: string) => ms.find((m) => m.id === id)?.value ?? null;
  const metrics = a.metrics
    .filter(
      (m) => m.status === 'scored' || b.metrics.some((x) => x.id === m.id && x.status === 'scored'),
    )
    .map((m) => {
      const [va, vb] = [value(a.metrics, m.id), value(b.metrics, m.id)];
      return {
        id: m.id,
        label: m.label,
        a: va,
        b: vb,
        delta: va === null || vb === null ? null : Math.round((vb - va) * 1000) / 1000,
      };
    });
  const ids = [...new Set([...a.report.cases, ...b.report.cases].map((c) => c.id))];
  const cases = ids.map((id) => {
    const [ca, cb] = [
      a.report.cases.find((c) => c.id === id),
      b.report.cases.find((c) => c.id === id),
    ];
    const change: CaseChange = !ca ? 'only_in_b' : !cb ? 'only_in_a' : direction(ca, cb);
    return { id, change, a: label(ca), b: label(cb) };
  });
  return {
    suite: { id: a.suite.id, version: a.suite.version },
    a: { id: a.id, provider: a.provider },
    b: { id: b.id, provider: b.provider },
    sameProvider: a.provider.kind === b.provider.kind && a.provider.model === b.provider.model,
    metrics,
    cases,
    regressions: cases.filter((c) => c.change === 'regressed' || c.change === 'changed').length,
    improvements: cases.filter((c) => c.change === 'improved').length,
  };
}
