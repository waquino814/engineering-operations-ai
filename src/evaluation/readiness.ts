import { fileURLToPath } from 'node:url';
import { openEvidence } from '../intake/evidence.ts';
import { validateBundle } from '../intake/validate-bundle.ts';
import { readAnswerKey } from './ground-truth.ts';
import { SCENARIO_SPLIT, TUNING_SEEDS, type Split } from './suites.ts';

/**
 * Is a bundle fit to be used as an evaluation input? (E7; the data request is
 * docs/proposals/commerce-data-request.md, proposed.) It runs the consumer-side contract
 * validation, then the checks that decide whether the bundle can count as evidence for a given
 * side of the development / held-out split. It reads files only, writes nothing, calls no model,
 * and reads the answer key (through the scoring boundary's reader) for the scenario, seed and
 * timing, so it belongs to evaluation, never to the investigator.
 *
 * Findings are `blocking` (the bundle cannot be used as intended) or `limitation` (it can, with
 * the stated caveat). It makes no judgement about whether a bundle is *good* data, and it cannot
 * tell whether two bundles are independent beyond scenario and seed.
 */
export type ReadinessCode =
  | 'bundle_invalid'
  | 'scenario_unregistered'
  | 'split_conflict'
  | 'seed_used_for_tuning'
  | 'fixed_fault_timing'
  | 'telemetry_truncated';

export interface ReadinessFinding {
  code: ReadinessCode;
  severity: 'blocking' | 'limitation';
  message: string;
}

export interface Readiness {
  ready: boolean;
  /** The side the bundle was checked for; null when none was asked for. */
  intendedSplit: Split | null;
  scenario: { name: string; seed: number } | null;
  findings: ReadinessFinding[];
}

/** Every real bundle so far faults this long after load start (ADR 0003, "Remaining risks"). */
export const FIXED_FAULT_OFFSET_MS = 30_000;
const MAX_ISSUES_LISTED = 10;

export async function checkEvaluationInput(
  bundleDir: string,
  intendedSplit: Split | null = null,
): Promise<Readiness> {
  const report = await validateBundle(bundleDir);
  if (!report.valid) {
    const shown = report.issues.slice(0, MAX_ISSUES_LISTED);
    const more = report.issues.length - shown.length;
    return {
      ready: false,
      intendedSplit,
      scenario: null,
      findings: [
        ...shown.map((i) => ({
          code: 'bundle_invalid' as const,
          severity: 'blocking' as const,
          message: `rule ${String(i.rule)} ${i.ruleId}: ${i.file ?? '(directory)'}${i.field ? ` ${i.field}` : ''}: ${i.message.replaceAll(bundleDir, '<bundle>')}`,
        })),
        ...(more > 0
          ? [
              {
                code: 'bundle_invalid' as const,
                severity: 'blocking' as const,
                message: `${String(more)} more issue(s) not listed`,
              },
            ]
          : []),
      ],
    };
  }
  const key = await readAnswerKey(bundleDir);
  const scenario = { name: key.scenario, seed: key.scenarioSeed };
  const findings: ReadinessFinding[] = [];
  const add = (code: ReadinessCode, severity: ReadinessFinding['severity'], message: string) =>
    findings.push({ code, severity, message });

  const registered = SCENARIO_SPLIT[scenario.name];
  if (registered === undefined)
    add(
      'scenario_unregistered',
      'blocking',
      `scenario "${scenario.name}" has no declared split, so no suite can run it; declaring its side is an owner decision`,
    );
  else if (intendedSplit !== null && registered !== intendedSplit)
    add(
      'split_conflict',
      'blocking',
      `scenario "${scenario.name}" is registered as ${registered}, not ${intendedSplit}`,
    );
  if ((TUNING_SEEDS[scenario.name] ?? []).includes(scenario.seed))
    add(
      'seed_used_for_tuning',
      intendedSplit === 'held-out' ? 'blocking' : 'limitation',
      `scenario "${scenario.name}" with seed ${String(scenario.seed)} was already used to build or tune this project, so it is not independent evidence`,
    );
  if (key.triggerOffsetMs === FIXED_FAULT_OFFSET_MS)
    add(
      'fixed_fault_timing',
      'limitation',
      `the fault starts ${String(FIXED_FAULT_OFFSET_MS / 1000)} s after load start, as in every bundle so far; results on it are fixed-timing results`,
    );
  // The blinded manifest keeps the per-service truncation flags the contract defines.
  const view = await openEvidence(bundleDir);
  const truncated = view.manifest.capture.traces.services
    .filter((s) => s.truncated)
    .map((s) => s.name);
  if (truncated.length > 0)
    add(
      'telemetry_truncated',
      'limitation',
      `traces were truncated for: ${truncated.join(', ')}; a diagnosis must report this as a limitation`,
    );
  return {
    ready: findings.every((f) => f.severity !== 'blocking'),
    intendedSplit,
    scenario,
    findings,
  };
}

export interface Writer {
  write(text: string): unknown;
}

export const USAGE =
  'usage: node src/evaluation/readiness.ts <bundle-dir> [--for development|held-out]';

/** Exit codes: 0 ready, 1 not ready, 2 usage error. */
export async function main(args: readonly string[], out: Writer, err: Writer): Promise<number> {
  const [dir, flag, side, ...extra] = args;
  const intended = flag === '--for' ? side : undefined;
  if (
    dir === undefined ||
    dir.startsWith('--') ||
    extra.length > 0 ||
    (flag !== undefined && (flag !== '--for' || (side !== 'development' && side !== 'held-out')))
  ) {
    err.write(`${USAGE}\n`);
    return 2;
  }
  const readiness = await checkEvaluationInput(dir, (intended as Split | undefined) ?? null);
  out.write(`${JSON.stringify(readiness, null, 2)}\n`);
  return readiness.ready ? 0 : 1;
}

export function isEntryPoint(moduleUrl: string, argv1: string | undefined): boolean {
  return argv1 !== undefined && fileURLToPath(moduleUrl) === argv1;
}

if (isEntryPoint(import.meta.url, process.argv[1]))
  process.exitCode = await main(process.argv.slice(2), process.stdout, process.stderr);
