import { isDeepStrictEqual } from 'node:util';
import { OUTCOME_RANK, ROOT_RANK } from './compare.ts';
import { readEvaluationRun } from './document.ts';
import { buildReport, type CaseReport } from './harness.ts';
import { aggregateMetrics, reliabilityOf, scenarioBreakdown, type Metric } from './metrics.ts';
import type { EvaluationRun } from './run.ts';
import { SCENARIO_SPLIT, suiteById } from './suites.ts';

/**
 * The offline gate behind `pnpm eval:suite` (E7). It judges two things and nothing else:
 *
 * - **Integrity** of a run: it satisfies its schema and is internally consistent, every case the
 *   suite defines has a report (and no other does), no answer leaked, every result satisfies the
 *   contract, every citation survives an independent re-read, and the run is complete.
 * - **Regression** against a baseline written by an earlier invocation: a case or an aggregate
 *   metric got worse, a case appeared or vanished, or the development / held-out split moved.
 *
 * It never judges a diagnosis (the scripted suites contain deliberately wrong ones) and it uses no
 * thresholds, weights or tolerances: "worse" means strictly worse on a value that already has a
 * stated direction. Whether a metric rises or falls with quality is declared in `METRIC_DIRECTION`
 * and a test requires every metric the harness produces to be declared there, so a new metric
 * cannot ride through the gate unjudged.
 */
export type GateCode =
  | 'run_schema_invalid'
  | 'report_inconsistent'
  | 'duplicate_case'
  | 'case_not_reported'
  | 'case_not_in_suite'
  | 'answer_leak'
  | 'result_invalid'
  | 'run_incomplete'
  | 'citation_unconfirmed'
  | 'grounding_missing'
  | 'baseline_missing_run'
  | 'case_regressed'
  | 'case_missing'
  | 'case_unexpected'
  | 'metric_regressed'
  | 'metric_unjudgeable'
  | 'split_changed'
  | 'scenario_set_changed'
  | 'case_scenario_changed';

export interface GateFinding {
  code: GateCode;
  /** `<suite id>@<version>`. */
  suite: string;
  /** The case concerned, when one is. */
  case: string | null;
  /** The metric or score dimension concerned, when one is. */
  metric: string | null;
  /** What is wrong, in a sentence that stands alone. */
  reason: string;
  /** The value in the baseline and in this run, for a comparison. */
  baseline: string | null;
  current: string | null;
}

export const formatFinding = (f: GateFinding) => `${f.suite}: ${f.reason}`;

/** True when a larger value of the metric means a better result. */
export const METRIC_DIRECTION: Readonly<Record<string, 'higher_is_better' | 'lower_is_better'>> =
  Object.freeze({
    root_cause_correct: 'higher_is_better',
    root_cause_ambiguous: 'lower_is_better',
    affected_precision: 'higher_is_better',
    affected_recall: 'higher_is_better',
    symptom_evidence: 'higher_is_better',
    citation_grounding: 'higher_is_better',
    component_identified: 'higher_is_better',
    completion: 'higher_is_better',
    result_validity: 'higher_is_better',
    answer_leaks: 'lower_is_better',
  });

const where = (run: EvaluationRun) => `${run.suite.id}@${run.suite.version}`;

function finding(
  run: EvaluationRun,
  code: GateCode,
  reason: string,
  extra: Partial<Pick<GateFinding, 'case' | 'metric' | 'baseline' | 'current'>> = {},
): GateFinding {
  return {
    code,
    suite: where(run),
    case: extra.case ?? null,
    metric: extra.metric ?? null,
    reason,
    baseline: extra.baseline ?? null,
    current: extra.current ?? null,
  };
}

const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

/** The sections of a run that are derived from its cases, and differ from a recomputation. */
export function inconsistencies(run: EvaluationRun): string[] {
  const cases = run.report.cases;
  const derived: [string, unknown, unknown][] = [
    ['report.totals', run.report.totals, buildReport(cases).totals],
    ['metrics', run.metrics, aggregateMetrics(cases)],
    ['scenarios', run.scenarios, scenarioBreakdown(cases)],
    ['reliability', run.reliability, reliabilityOf(cases, run.harnessErrors.length)],
  ];
  const out = derived
    .filter(([, stored, recomputed]) => !isDeepStrictEqual(plain(stored), plain(recomputed)))
    .map(([name]) => name);
  if (run.status === 'complete' && run.harnessErrors.length > 0) out.push('status');
  return out;
}

/** Case ids that occur more than once, in order of first repetition. */
function duplicates(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out = new Set<string>();
  for (const id of ids) (seen.has(id) ? out : seen).add(id);
  return [...out];
}

/**
 * Problems that make a baseline unusable as a reference (a damaged or hand-edited document, a run
 * that never finished, an ambiguous reference). They are input errors, not gate failures: nothing
 * can be judged against such a baseline, and a gate that guessed would pass silently.
 */
export function baselineProblems(runs: readonly EvaluationRun[]): string[] {
  const out: string[] = [];
  const keys = new Map<string, number>();
  for (const run of runs) {
    const key = `${where(run)} (${run.provider.kind})`;
    keys.set(key, (keys.get(key) ?? 0) + 1);
    if (run.status !== 'complete')
      out.push(`the baseline run ${key} is incomplete, so it cannot stand for a full suite`);
    const bad = inconsistencies(run);
    if (bad.length > 0)
      out.push(`the baseline run ${key} is internally inconsistent (${bad.join(', ')})`);
    const dup = duplicates(run.report.cases.map((c) => c.id));
    if (dup.length > 0)
      out.push(`the baseline run ${key} reports a case more than once (${dup.join(', ')})`);
  }
  for (const [key, n] of keys)
    if (n > 1) out.push(`the baseline holds ${String(n)} runs of ${key}; it must hold exactly one`);
  return out;
}

/** Integrity findings of one run; wrong diagnoses are not findings. */
export function integrityFindings(run: EvaluationRun): GateFinding[] {
  const schema = readEvaluationRun(run);
  if (!schema.ok)
    return [
      finding(run, 'run_schema_invalid', `the run fails its schema: ${schema.problems.join('; ')}`),
    ];
  const out: GateFinding[] = [];
  const cases = run.report.cases;
  const bad = inconsistencies(run);
  if (bad.length > 0)
    out.push(
      finding(
        run,
        'report_inconsistent',
        `the run's ${bad.join(', ')} do not match its case reports`,
      ),
    );
  for (const id of duplicates(cases.map((c) => c.id)))
    out.push(finding(run, 'duplicate_case', `case ${id} is reported more than once`, { case: id }));
  // The scripted case ids are the suite's own; other providers name cases after bundles.
  const definition = suiteById(run.suite.id);
  if (run.provider.kind === 'scripted' && definition?.version === run.suite.version) {
    const reported = new Set(cases.map((c) => c.id));
    const defined = new Set(definition.cases.map((c) => c.id));
    for (const id of defined)
      if (!reported.has(id))
        out.push(
          finding(
            run,
            'case_not_reported',
            `case ${id} is defined by the suite but has no report`,
            {
              case: id,
            },
          ),
        );
    for (const id of reported)
      if (!defined.has(id))
        out.push(
          finding(
            run,
            'case_not_in_suite',
            `case ${id} is reported but the suite does not define it`,
            {
              case: id,
            },
          ),
        );
  }
  if (run.report.totals.answerLeaks > 0) {
    const ids = cases.filter((c) => c.answerLeak.leaked).map((c) => c.id);
    out.push(
      finding(
        run,
        'answer_leak',
        `${String(run.report.totals.answerLeaks)} case(s) leaked answer text${ids.length > 0 ? ` (${ids.join(', ')})` : ''}`,
        { metric: 'answer_leaks' },
      ),
    );
  }
  for (const c of cases) {
    if (!c.resultValid)
      out.push(
        finding(run, 'result_invalid', `result fails its contract in ${c.id}`, {
          case: c.id,
          metric: 'result_validity',
        }),
      );
    if (c.score !== null && c.grounding === null)
      out.push(
        finding(
          run,
          'grounding_missing',
          `case ${c.id} was admitted but its citations were not re-read from the bundle`,
          { case: c.id, metric: 'citation_grounding' },
        ),
      );
    if (c.grounding !== null && c.grounding.verified < c.grounding.citations)
      out.push(
        finding(
          run,
          'citation_unconfirmed',
          `case ${c.id}: ${String(c.grounding.citations - c.grounding.verified)} of ${String(c.grounding.citations)} citation(s) not confirmed by the independent re-read`,
          {
            case: c.id,
            metric: 'citation_grounding',
            current: `${String(c.grounding.verified)}/${String(c.grounding.citations)}`,
          },
        ),
      );
  }
  if (run.status === 'incomplete')
    out.push(
      finding(
        run,
        'run_incomplete',
        `incomplete (${String(run.harnessErrors.length)} case(s) the harness could not evaluate)`,
      ),
    );
  return out;
}

interface Dimension {
  metric: string;
  before: string;
  after: string;
  /** Positive when the later value is better, negative when worse. */
  direction: number;
}

const ratio = (g: CaseReport['grounding']) =>
  g === null || g.citations === 0 ? null : g.verified / g.citations;

/** How one case moved on each score dimension that has a stated direction. */
function dimensions(a: CaseReport, b: CaseReport): Dimension[] {
  const sign = (n: number) => (n > 0 ? 1 : n < 0 ? -1 : 0);
  const root = (c: CaseReport) => c.score?.rootCause ?? 'missing';
  const out: Dimension[] = [
    {
      metric: 'root_cause_correct',
      before: root(a),
      after: root(b),
      direction: sign((ROOT_RANK[root(b)] ?? 0) - (ROOT_RANK[root(a)] ?? 0)),
    },
    {
      metric: 'symptom_evidence',
      before: a.score?.symptomEvidence ?? 'not_covered',
      after: b.score?.symptomEvidence ?? 'not_covered',
      direction:
        (b.score?.symptomEvidence === 'covered' ? 1 : 0) -
        (a.score?.symptomEvidence === 'covered' ? 1 : 0),
    },
    {
      metric: 'completion',
      before: a.summary.outcome,
      after: b.summary.outcome,
      direction: sign(
        (OUTCOME_RANK[b.summary.outcome] ?? 0) - (OUTCOME_RANK[a.summary.outcome] ?? 0),
      ),
    },
    {
      metric: 'affected_recall',
      before: String(a.score?.affected.recall ?? 0),
      after: String(b.score?.affected.recall ?? 0),
      direction: sign((b.score?.affected.recall ?? 0) - (a.score?.affected.recall ?? 0)),
    },
  ];
  const [pa, pb] = [a.score?.affected.precision, b.score?.affected.precision];
  if (typeof pa === 'number' && typeof pb === 'number')
    out.push({
      metric: 'affected_precision',
      before: String(pa),
      after: String(pb),
      direction: sign(pb - pa),
    });
  const [ga, gb] = [ratio(a.grounding), ratio(b.grounding)];
  if (ga !== null && gb !== null)
    out.push({
      metric: 'citation_grounding',
      before: `${String(a.grounding?.verified)}/${String(a.grounding?.citations)}`,
      after: `${String(b.grounding?.verified)}/${String(b.grounding?.citations)}`,
      direction: sign(gb - ga),
    });
  return out;
}

const fraction = (m: Metric) =>
  m.value === null
    ? m.status
    : `${String(m.value)} (${String(m.numerator)}/${String(m.denominator)})`;

function metricFindings(before: EvaluationRun, after: EvaluationRun): GateFinding[] {
  const out: GateFinding[] = [];
  for (const was of before.metrics) {
    if (was.status !== 'scored') continue;
    const now = after.metrics.find((m) => m.id === was.id);
    const direction = METRIC_DIRECTION[was.id];
    if (direction === undefined) {
      out.push(
        finding(
          after,
          'metric_unjudgeable',
          `metric ${was.id} was scored in the baseline but has no declared direction, so the gate cannot judge it`,
          { metric: was.id, baseline: fraction(was) },
        ),
      );
      continue;
    }
    if (now === undefined || now.status !== 'scored' || now.value === null || was.value === null) {
      out.push(
        finding(
          after,
          'metric_regressed',
          `metric ${was.id} was scored in the baseline (${fraction(was)}) but is ${now?.status ?? 'absent'} in this run`,
          { metric: was.id, baseline: fraction(was), current: now ? fraction(now) : 'absent' },
        ),
      );
      continue;
    }
    const worse = direction === 'higher_is_better' ? now.value < was.value : now.value > was.value;
    if (worse)
      out.push(
        finding(
          after,
          'metric_regressed',
          `metric ${was.id} ${direction === 'higher_is_better' ? 'fell' : 'rose'} from ${fraction(was)} to ${fraction(now)}`,
          { metric: was.id, baseline: fraction(was), current: fraction(now) },
        ),
      );
  }
  return out;
}

function splitFindings(before: EvaluationRun, after: EvaluationRun): GateFinding[] {
  const out: GateFinding[] = [];
  if (before.suite.split !== after.suite.split)
    out.push(
      finding(
        after,
        'split_changed',
        `the suite was ${before.suite.split} in the baseline and is ${after.suite.split} now`,
        { baseline: before.suite.split, current: after.suite.split },
      ),
    );
  const names = (run: EvaluationRun) =>
    run.scenarios.flatMap((s) => (typeof s.scenario === 'string' ? [s.scenario] : []));
  const [was, now] = [names(before), names(after)];
  for (const name of was) {
    const registered = SCENARIO_SPLIT[name];
    if (registered !== before.suite.split)
      out.push(
        finding(
          after,
          'split_changed',
          registered === undefined
            ? `scenario ${name} was in the ${before.suite.split} baseline but is no longer registered on either side of the split`
            : `scenario ${name} was in the ${before.suite.split} baseline but is registered as ${registered} now`,
          { baseline: before.suite.split, current: registered ?? 'unregistered' },
        ),
      );
    if (!now.includes(name))
      out.push(
        finding(
          after,
          'scenario_set_changed',
          `scenario ${name} is in the baseline but not in this run`,
          {
            baseline: name,
          },
        ),
      );
  }
  for (const name of now)
    if (!was.includes(name))
      out.push(
        finding(
          after,
          'scenario_set_changed',
          `scenario ${name} is in this run but not in the baseline`,
          {
            current: name,
          },
        ),
      );
  return out;
}

/** Everything that got worse, appeared or vanished between a baseline run and this one. */
export function regressionFindings(before: EvaluationRun, after: EvaluationRun): GateFinding[] {
  const out: GateFinding[] = [];
  const old = new Map(before.report.cases.map((c) => [c.id, c]));
  const next = new Map(after.report.cases.map((c) => [c.id, c]));
  for (const [id, was] of old) {
    const now = next.get(id);
    if (now === undefined) {
      out.push(
        finding(after, 'case_missing', `case ${id} is in the baseline but missing from this run`, {
          case: id,
        }),
      );
      continue;
    }
    const dims = dimensions(was, now);
    const verdict = dims.some((d) => d.direction > 0) ? 'changed' : 'regressed';
    for (const d of dims.filter((x) => x.direction < 0))
      out.push(
        finding(
          after,
          'case_regressed',
          `case ${id} is ${verdict}: ${d.metric} went from ${d.before} to ${d.after}`,
          { case: id, metric: d.metric, baseline: d.before, current: d.after },
        ),
      );
    const [sa, sb] = [was.scenario?.name ?? null, now.scenario?.name ?? null];
    if (sa !== sb)
      out.push(
        finding(
          after,
          'case_scenario_changed',
          `case ${id} belonged to scenario ${sa ?? '(not admitted)'} in the baseline and to ${sb ?? '(not admitted)'} now`,
          { case: id, baseline: sa ?? 'not admitted', current: sb ?? 'not admitted' },
        ),
      );
  }
  for (const id of next.keys())
    if (!old.has(id))
      out.push(
        finding(
          after,
          'case_unexpected',
          `case ${id} is not in the baseline (a new case: record a new baseline to include it)`,
          { case: id },
        ),
      );
  return [...out, ...metricFindings(before, after), ...splitFindings(before, after)];
}

/** Findings from comparing every run with the baseline run of the same suite, version and kind. */
export function baselineFindings(
  runs: readonly EvaluationRun[],
  baseline: readonly EvaluationRun[],
): GateFinding[] {
  const out: GateFinding[] = [];
  for (const run of runs) {
    const same = baseline.filter(
      (b) =>
        b.suite.id === run.suite.id &&
        b.suite.version === run.suite.version &&
        b.provider.kind === run.provider.kind,
    );
    const before = same[0];
    if (before === undefined) {
      const other = baseline.find(
        (b) => b.suite.id === run.suite.id && b.provider.kind === run.provider.kind,
      );
      out.push(
        finding(
          run,
          'baseline_missing_run',
          other
            ? `the baseline records version ${other.suite.version} of this suite; this run is version ${run.suite.version}`
            : `the baseline has no ${run.provider.kind} run of this suite`,
          other ? { baseline: other.suite.version, current: run.suite.version } : {},
        ),
      );
      continue;
    }
    out.push(...regressionFindings(before, run));
  }
  return out;
}
