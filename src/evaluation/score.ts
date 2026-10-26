import type { InvestigationResult } from '../investigation/result.ts';
import type { AnswerKey } from './ground-truth.ts';

/**
 * Scoring v0 (ADR 0009, proposed): compares a finished result with the answer key, field by
 * field. It measures conclusions only; evidence integrity was already enforced when the result
 * was produced, and whether evidence semantically supports a finding is not scored yet.
 */
export interface Score {
  outcome: InvestigationResult['outcome'];
  /** `missing` when the result has no root-cause finding. */
  rootCause: 'correct' | 'incorrect' | 'missing';
  affected: { predicted: string[]; expected: string[]; precision: number | null; recall: number };
}

const round = (n: number) => Math.round(n * 1000) / 1000;

export function scoreResult(result: InvestigationResult, key: AnswerKey): Score {
  const rootComponents = new Set(
    result.findings.filter((f) => f.kind === 'root_cause').flatMap((f) => f.components),
  );
  const predicted = [...new Set(result.findings.flatMap((f) => f.components))].sort();
  const expected = key.affectedComponents;
  const hits = predicted.filter((c) => expected.includes(c)).length;
  return {
    outcome: result.outcome,
    rootCause:
      rootComponents.size === 0
        ? 'missing'
        : rootComponents.has(key.rootCauseComponent)
          ? 'correct'
          : 'incorrect',
    affected: {
      predicted,
      expected,
      precision: predicted.length === 0 ? null : round(hits / predicted.length),
      recall: expected.length === 0 ? 1 : round(hits / expected.length),
    },
  };
}
