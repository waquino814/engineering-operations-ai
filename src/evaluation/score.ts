import type { InvestigationResult } from '../investigation/result.ts';
import type { AnswerKey } from './ground-truth.ts';

/**
 * Scoring v0 (ADR 0009, proposed): compares a finished result with the answer key, field by
 * field. It measures conclusions only; evidence integrity was already enforced when the result
 * was produced, and whether evidence semantically supports a finding is not scored yet.
 */
export interface Score {
  outcome: InvestigationResult['outcome'];
  /**
   * `missing` when the result has no root-cause finding; `ambiguous` when it names more than one
   * component as the root cause (conflicting claims); otherwise whether the one named is right.
   */
  rootCause: 'correct' | 'incorrect' | 'missing' | 'ambiguous';
  /**
   * Whether some finding cites a record of the series the bundle's primary symptom is about,
   * with the labels the symptom matches on. It measures that the diagnosis rests on the
   * symptomatic evidence; it does not say the finding explains it.
   */
  symptomEvidence: 'covered' | 'not_covered';
  affected: { predicted: string[]; expected: string[]; precision: number | null; recall: number };
}

function citesSymptom(result: InvestigationResult, key: AnswerKey): boolean {
  const { metric, matchers } = key.primarySymptom;
  return result.findings.some((f) =>
    f.evidence.some(
      (e) =>
        e.file === 'metrics.jsonl' &&
        e.series?.name === metric &&
        Object.entries(matchers).every(([k, v]) => e.series?.labels[k] === v),
    ),
  );
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
        : rootComponents.size > 1
          ? 'ambiguous'
          : rootComponents.has(key.rootCauseComponent)
            ? 'correct'
            : 'incorrect',
    symptomEvidence: citesSymptom(result, key) ? 'covered' : 'not_covered',
    affected: {
      predicted,
      expected,
      precision: predicted.length === 0 ? null : round(hits / predicted.length),
      recall: expected.length === 0 ? 1 : round(hits / expected.length),
    },
  };
}

/**
 * Plain sentences saying why a result scored as it did, for the operator. They restate the score
 * and the answer key's expected values; they add no judgement of their own.
 */
export function explainScore(result: InvestigationResult, score: Score, key: AnswerKey): string[] {
  const named = [
    ...new Set(result.findings.filter((f) => f.kind === 'root_cause').flatMap((f) => f.components)),
  ].sort();
  const lines: string[] = [];
  if (result.outcome !== 'completed')
    lines.push(`The investigation ended ${result.outcome}, so no diagnosis was scored as correct.`);
  const root = {
    correct: `Root cause correct: the finding names ${key.rootCauseComponent}.`,
    incorrect: `Root cause incorrect: named ${named.join(', ')}; expected ${key.rootCauseComponent}.`,
    ambiguous: `Root cause ambiguous: ${String(named.length)} components named as the root cause (${named.join(', ')}); expected ${key.rootCauseComponent}.`,
    missing: `No root-cause finding; expected ${key.rootCauseComponent}.`,
  } as const;
  lines.push(root[score.rootCause]);
  lines.push(
    score.symptomEvidence === 'covered'
      ? `A finding cites the primary symptom's series (${key.primarySymptom.metric}).`
      : `No finding cites the primary symptom's series (${key.primarySymptom.metric}) with its labels.`,
  );
  const missed = score.affected.expected.filter((c) => !score.affected.predicted.includes(c));
  const extra = score.affected.predicted.filter((c) => !score.affected.expected.includes(c));
  if (missed.length > 0) lines.push(`Affected components not named: ${missed.join(', ')}.`);
  if (extra.length > 0) lines.push(`Components named that are not affected: ${extra.join(', ')}.`);
  return lines;
}
