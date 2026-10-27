import type { ModelProvider } from '../investigation/provider.ts';
import {
  evaluateCase,
  buildReport,
  type CaseReport,
  type EvaluationCase,
  type EvaluationReport,
} from './harness.ts';
import {
  aggregateMetrics,
  reliabilityOf,
  scenarioBreakdown,
  type Metric,
  type Reliability,
} from './metrics.ts';
import {
  assertCaseScenario,
  buildSuite,
  MISSING_FOR_FULL_HOLDOUT,
  SCENARIO_SPLIT,
  type SuiteDefinition,
} from './suites.ts';

/**
 * A completed evaluation run: one suite, one provider, every case's score and rationale, the
 * aggregate metrics and the reliability counts. It is what the application stores and reopens;
 * reading it never reruns an investigation.
 *
 * `provider.kind` says what the numbers are about, and is never inferred from a name:
 * - `scripted`: each case's own scripted reply (a test double). Measures the pipeline and the
 *   harness: the replies are fixed in advance and no model is involved.
 * - `simulated`: the deterministic simulated provider run over the suite's bundles. Measures the
 *   pipeline; it is a placeholder that cites by position and diagnoses nothing.
 * - `real_model`: a model that actually generated the replies. Only this kind says anything
 *   about diagnostic quality, and then only about the bundles it was run on.
 */
export type ProviderKind = 'scripted' | 'simulated' | 'real_model';

export interface ProviderInfo {
  kind: ProviderKind;
  provider: string;
  model: string;
  /** True unless a real model generated the replies. */
  simulated: boolean;
}

export type ProviderChoice =
  | { kind: 'scripted' }
  | {
      kind: 'simulated' | 'real_model';
      provider: ModelProvider;
      limits?: Partial<Record<string, unknown>>;
    };

export interface EvaluationRun {
  schemaVersion: '0.1.0';
  id: string;
  suite: {
    id: string;
    version: string;
    split: SuiteDefinition['split'];
    synthetic: boolean;
    description: string;
  };
  provider: ProviderInfo;
  /** True only for `real_model`: whether these numbers measure a model's diagnoses. */
  measuresModelQuality: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /** `incomplete` when the run was cancelled or the harness could not evaluate a case. */
  status: 'complete' | 'incomplete';
  report: EvaluationReport;
  metrics: Metric[];
  scenarios: ReturnType<typeof scenarioBreakdown>;
  reliability: Reliability;
  /** Cases the harness itself failed on (not diagnoses), by id, with a sanitised reason. */
  harnessErrors: { id: string; error: string }[];
  /** What this run does not show. */
  limitations: string[];
}

export interface RunOptions {
  provider: ProviderChoice;
  /** Milliseconds, for per-case timing. */
  clock: () => number;
  /** Wall-clock time for the record. */
  now: () => Date;
  /** The id the store gave this run. */
  id: string;
  signal?: AbortSignal;
}

function describe(choice: ProviderChoice): ProviderInfo {
  if (choice.kind === 'scripted')
    return { kind: 'scripted', provider: 'fake', model: 'scripted', simulated: true };
  return {
    kind: choice.kind,
    provider: choice.provider.provider,
    model: choice.provider.model,
    simulated: choice.kind !== 'real_model',
  };
}

function limitationsOf(suite: SuiteDefinition, info: ProviderInfo): string[] {
  const out: string[] = [];
  if (info.kind === 'scripted')
    out.push(
      'Scripted replies: the diagnoses were written in advance for each case. These numbers test the pipeline, the verification and the scoring; they say nothing about any model.',
    );
  if (info.kind === 'simulated')
    out.push(
      'Simulated provider: a deterministic placeholder that cites the first record of each file and claims no root cause. These numbers test the pipeline end to end; they say nothing about any model.',
    );
  if (info.kind === 'real_model')
    out.push(
      'Real model, synthetic bundles: scores describe this model on these few bundles only. They are not an estimate of accuracy on real incidents.',
    );
  out.push('Remediation is not scored (no rubric exists).');
  out.push(
    'The bundles are synthetic or a single genuine excerpt of one scenario at fixed timing; there are no varied-timing or unseen real scenarios in the repository.',
  );
  if (suite.split === 'held-out')
    out.push(
      'The held-out scenario is invented, so this is a test of the split, not of generalization to real incidents.',
    );
  else
    out.push(
      'Development split: prompts, selection and scoring were written looking at this scenario; a good score here does not indicate generalization.',
    );
  out.push(...MISSING_FOR_FULL_HOLDOUT.map((m) => `Missing for a full held-out evaluation: ${m}`));
  return out;
}

export async function runSuite(
  suite: SuiteDefinition,
  options: RunOptions,
): Promise<EvaluationRun> {
  const built = await buildSuite(suite);
  const started = options.now();
  const t0 = options.clock();
  try {
    // [report id, the scripted case id the declaration is looked up by, the case]
    const plan: { id: string; declared: string; case: EvaluationCase }[] =
      options.provider.kind === 'scripted'
        ? built.cases.map((c) => ({ id: c.id, declared: c.id, case: c }))
        : built.bundles.map((b) => ({
            id: `bundle:${suite.id}:${b.id}`,
            declared: b.id,
            case: {
              id: `bundle:${suite.id}:${b.id}`,
              kind: 'synthetic' as const,
              bundleDir: b.dir,
              provider: (options.provider as { provider: ModelProvider }).provider,
              ...((options.provider as { limits?: Partial<Record<string, unknown>> }).limits
                ? {
                    limits: (options.provider as { limits: Partial<Record<string, unknown>> })
                      .limits,
                  }
                : {}),
              ...(options.signal ? { signal: options.signal } : {}),
            },
          }));
    const reports: CaseReport[] = [];
    const harnessErrors: { id: string; error: string }[] = [];
    let cancelled = false;
    for (const p of plan) {
      if (options.signal?.aborted) {
        cancelled = true;
        break;
      }
      try {
        const report = await evaluateCase(
          options.provider.kind === 'scripted' && options.signal
            ? { ...p.case, signal: options.signal }
            : p.case,
          { clock: options.clock },
        );
        // The answer key names the scenario; it must be the declared one, on this suite's side.
        assertCaseScenario(suite, p.declared, report.scenario?.name ?? null);
        reports.push({ ...report, id: p.id });
      } catch (e) {
        if (e instanceof Error && e.name === 'SplitViolation') throw e;
        // One case the harness could not evaluate does not discard the others.
        harnessErrors.push({ id: p.id, error: 'the harness could not evaluate this case' });
      }
    }
    const info = describe(options.provider);
    const finished = options.now();
    return {
      schemaVersion: '0.1.0',
      id: options.id,
      suite: {
        id: suite.id,
        version: suite.version,
        split: suite.split,
        synthetic: suite.synthetic,
        description: suite.description,
      },
      provider: info,
      measuresModelQuality: info.kind === 'real_model',
      startedAt: started.toISOString(),
      finishedAt: finished.toISOString(),
      durationMs: options.clock() - t0,
      status: cancelled || harnessErrors.length > 0 ? 'incomplete' : 'complete',
      report: buildReport(reports),
      metrics: aggregateMetrics(reports),
      scenarios: scenarioBreakdown(reports),
      reliability: reliabilityOf(reports, harnessErrors.length),
      harnessErrors,
      limitations: limitationsOf(suite, info),
    };
  } finally {
    await built.cleanup();
  }
}

/** The split a scenario name is registered on, for display; unknown scenarios have none. */
export const splitOfScenario = (name: string | null) =>
  name === null ? null : (SCENARIO_SPLIT[name] ?? null);
