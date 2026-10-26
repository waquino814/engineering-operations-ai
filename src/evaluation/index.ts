/** The evaluation boundary (ADR 0009): the only package entry that can read answer keys. */
export { readAnswerKey, type AnswerKey } from './ground-truth.ts';
export {
  runEvaluation,
  type CaseReport,
  type EvaluationCase,
  type EvaluationReport,
} from './harness.ts';
export {
  findLeaks,
  legitimateText,
  MIN_NORMALIZED_LENGTH,
  protectedValues,
  tokens,
  type LeakCheck,
  type LeakFinding,
  type LeakMatch,
  type LeakPolicy,
  type ProtectedValue,
} from './leakage.ts';
export { scoreResult, type Score } from './score.ts';
export { syntheticCases, writeSyntheticBundles, type SyntheticBundles } from './synthetic.ts';
export { runSyntheticEvaluation } from './cli.ts';
