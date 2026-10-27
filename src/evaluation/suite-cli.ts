import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { SimulatedProvider } from '../investigation/simulated-provider.ts';
import { readEvaluationRun } from './document.ts';
import {
  baselineFindings,
  baselineProblems,
  formatFinding,
  integrityFindings,
  type GateFinding,
} from './gate.ts';
import { runSuite, type EvaluationRun, type ProviderChoice } from './run.ts';
import { SplitViolation, SUITES, suiteById, type SuiteDefinition } from './suites.ts';

/**
 * `pnpm eval:suite <suite-id|all> [--provider scripted|simulated] [--out <file>] [--baseline <file>]`
 * (E7): the offline, repeatable evaluation workflow as a command. It runs the versioned suites
 * through the real pipeline and prints one machine-readable document: every run in full (per-case
 * outcome, score and rationale, aggregate metrics with numerators and denominators, reliability
 * counts, limitations) and a `gate` that says whether the run passed.
 *
 * Only `scripted` (replies written in advance) and `simulated` (the deterministic placeholder) are
 * available here. A real local model is reachable only through the application's provider gate
 * (ADR 0013), never from this command, so it can make no request and cannot spend anything.
 * Neither provider measures a model; the document says so in each run's `limitations`.
 *
 * The gate (src/evaluation/gate.ts) fails (exit 1) on an integrity problem, not on a wrong
 * diagnosis: an answer leak, a result that fails its contract or schema, an inconsistent report, a
 * missing or unexpected case, a citation the independent re-read does not confirm, a run the
 * harness could not complete, or, with `--baseline`, a case or metric that got worse, a case that
 * appeared or vanished, or a moved development / held-out split. Scripted suites contain
 * deliberately wrong and fabricated diagnoses, so a wrong root cause is an expected outcome there.
 * A baseline that is itself damaged, inconsistent, incomplete or ambiguous is an input error.
 *
 * Exit codes: 0 gate passed, 1 gate failed, 2 usage or input error, 3 split violation (the
 * development / held-out separation was breached; nothing is reported as a result).
 */
export const USAGE =
  'usage: node src/evaluation/suite-cli.ts <suite-id|all> [--provider scripted|simulated] [--out <file>] [--baseline <file>]';

export interface SuiteDocument {
  schemaVersion: '0.1.0';
  runs: EvaluationRun[];
  /**
   * `problems` are the findings as sentences, for people; `findings` carry the same facts as
   * fields (code, suite, case, metric, reason, baseline and current value), for machines.
   */
  gate: { passed: boolean; problems: string[]; findings: GateFinding[] };
}

export interface Writer {
  write(text: string): unknown;
}

export interface SuiteCliDeps {
  /** Wall-clock time, for run ids and timestamps. */
  now?: () => Date;
  /** Milliseconds, for per-case timing. */
  clock?: () => number;
  /** Replaces the suite runner, for tests. */
  run?: typeof runSuite;
}

interface Options {
  suites: readonly SuiteDefinition[];
  provider: 'scripted' | 'simulated';
  out?: string;
  baseline?: string;
}

const stamp = (d: Date) => d.toISOString().replace(/[-:]|\.\d{3}/g, '');

/** Parses the arguments; a string is the message for a usage error. */
function parse(args: readonly string[]): Options | string {
  const [target, ...rest] = args;
  if (target === undefined || target.startsWith('--')) return 'a suite id, or "all", is required';
  let suites: readonly SuiteDefinition[];
  if (target === 'all') suites = SUITES;
  else {
    const one = suiteById(target);
    if (one === undefined)
      return `unknown suite "${/^[a-z0-9-]{1,40}$/.test(target) ? target : '(value withheld)'}"; the suites are ${SUITES.map((s) => s.id).join(', ')}`;
    suites = [one];
  }
  const options: Options = { suites, provider: 'scripted' };
  for (let i = 0; i < rest.length; i += 2) {
    const [flag, value] = [rest[i], rest[i + 1]];
    if (value === undefined || value.startsWith('--')) return `${flag ?? ''} needs a value`;
    if (flag === '--provider') {
      if (value !== 'scripted' && value !== 'simulated')
        return 'this command runs only the "scripted" and "simulated" providers; a real local model runs only through the application, behind its provider gate';
      options.provider = value;
    } else if (flag === '--out') options.out = value;
    else if (flag === '--baseline') options.baseline = value;
    else return `unknown option ${flag ?? ''}`;
  }
  return options;
}

type Baseline = { ok: true; runs: EvaluationRun[] } | { ok: false; problems: string[] };

async function readBaseline(file: string): Promise<Baseline> {
  const fail = (problem: string): Baseline => ({ ok: false, problems: [problem] });
  let value: unknown;
  try {
    value = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fail('the baseline file cannot be read as JSON');
  }
  const raw = (value as { runs?: unknown } | null)?.runs;
  if (!Array.isArray(raw)) return fail('the baseline holds no "runs" array');
  const runs: EvaluationRun[] = [];
  for (const r of raw as unknown[]) {
    const read = readEvaluationRun(r);
    if (!read.ok) return fail('the baseline holds a run that fails its schema');
    runs.push(read.run);
  }
  // A baseline that cannot stand for a full, consistent suite would let a regression pass.
  const unusable = baselineProblems(runs);
  return unusable.length > 0 ? { ok: false, problems: unusable } : { ok: true, runs };
}

export async function main(
  args: readonly string[],
  out: Writer,
  err: Writer,
  deps: SuiteCliDeps = {},
): Promise<number> {
  const parsed = parse(args);
  if (typeof parsed === 'string') {
    err.write(`${parsed}\n${USAGE}\n`);
    return 2;
  }
  let baseline: EvaluationRun[] | undefined;
  if (parsed.baseline !== undefined) {
    const read = await readBaseline(parsed.baseline);
    if (!read.ok) {
      for (const problem of read.problems) err.write(`${problem}\n`);
      return 2;
    }
    baseline = read.runs;
  }
  const now = deps.now ?? (() => new Date());
  const clock = deps.clock ?? (() => performance.now());
  const run = deps.run ?? runSuite;
  const choice: ProviderChoice =
    parsed.provider === 'scripted'
      ? { kind: 'scripted' }
      : { kind: 'simulated', provider: new SimulatedProvider() };
  const runs: EvaluationRun[] = [];
  try {
    for (const suite of parsed.suites)
      runs.push(
        await run(suite, {
          provider: choice,
          clock,
          now,
          id: `${stamp(now())}-${suite.id}-${parsed.provider}`,
        }),
      );
  } catch (e) {
    if (e instanceof SplitViolation) {
      err.write(`split violation: ${e.message}\n`);
      return 3;
    }
    throw e;
  }
  const findings = [
    ...runs.flatMap(integrityFindings),
    ...(baseline === undefined ? [] : baselineFindings(runs, baseline)),
  ];
  const problems = findings.map(formatFinding);
  const document: SuiteDocument = {
    schemaVersion: '0.1.0',
    runs,
    gate: { passed: findings.length === 0, problems, findings },
  };
  const text = `${JSON.stringify(document, null, 2)}\n`;
  if (parsed.out === undefined) out.write(text);
  else {
    try {
      // 'wx': an earlier document, which may be someone's baseline, is never overwritten.
      await writeFile(parsed.out, text, { flag: 'wx' });
    } catch {
      err.write('cannot write the output file (it may already exist)\n');
      return 2;
    }
  }
  for (const p of problems) err.write(`gate: ${p}\n`);
  return document.gate.passed ? 0 : 1;
}

/** True when this module is the program Node was started with. */
export function isEntryPoint(moduleUrl: string, argv1: string | undefined): boolean {
  return argv1 !== undefined && fileURLToPath(moduleUrl) === argv1;
}

if (isEntryPoint(import.meta.url, process.argv[1]))
  process.exitCode = await main(process.argv.slice(2), process.stdout, process.stderr);
