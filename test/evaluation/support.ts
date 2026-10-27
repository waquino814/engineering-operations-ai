import { buildReport } from '../../src/evaluation/harness.ts';
import {
  aggregateMetrics,
  reliabilityOf,
  scenarioBreakdown,
} from '../../src/evaluation/metrics.ts';
import { runSuite, type EvaluationRun, type ProviderChoice } from '../../src/evaluation/run.ts';
import { suiteById } from '../../src/evaluation/suites.ts';

/** Recomputes everything a run derives from its case reports, as the harness does. */
export function reaggregate(run: EvaluationRun): EvaluationRun {
  const cases = run.report.cases;
  run.report = buildReport(cases);
  run.metrics = aggregateMetrics(cases);
  run.scenarios = scenarioBreakdown(cases);
  run.reliability = reliabilityOf(cases, run.harnessErrors.length);
  return run;
}

/** A real run of a suite with a fixed clock, so tests can alter a copy of it. */
export async function suiteRun(
  suiteId: 'development' | 'held-out',
  provider: ProviderChoice = { kind: 'scripted' },
): Promise<EvaluationRun> {
  const suite = suiteById(suiteId);
  if (suite === undefined) throw new Error('unknown suite');
  let tick = 0;
  return runSuite(suite, {
    provider,
    clock: () => (tick += 5),
    now: () => new Date('2026-10-27T12:00:00Z'),
    id: `20261027T120000Z-${suiteId}-${provider.kind}`,
  });
}

/** An independent copy, so a test can change one without touching another. */
export const copyOf = (run: EvaluationRun): EvaluationRun =>
  JSON.parse(JSON.stringify(run)) as EvaluationRun;
