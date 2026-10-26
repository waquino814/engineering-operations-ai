import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runEvaluation, type EvaluationReport } from './harness.ts';
import { syntheticCases, writeSyntheticBundles } from './synthetic.ts';

/**
 * `pnpm eval:synthetic`: runs the synthetic evaluation in a temporary directory and prints the
 * machine-readable report. No network, no credentials, no real bundle. Exit code 1 if any
 * answer text reached a model request.
 */
export async function runSyntheticEvaluation(): Promise<EvaluationReport> {
  const root = await mkdtemp(join(tmpdir(), 'eoai-eval-'));
  try {
    return await runEvaluation(await syntheticCases(await writeSyntheticBundles(root)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export interface Writer {
  write(text: string): unknown;
}

/** Prints the report and returns the exit code. */
export async function main(
  out: Writer,
  run: () => Promise<EvaluationReport> = runSyntheticEvaluation,
): Promise<number> {
  const report = await run();
  out.write(`${JSON.stringify(report, null, 2)}\n`);
  return report.totals.answerLeaks > 0 ? 1 : 0;
}

/** True when this module is the program Node was started with. */
export function isEntryPoint(moduleUrl: string, argv1: string | undefined): boolean {
  return argv1 !== undefined && fileURLToPath(moduleUrl) === argv1;
}

if (isEntryPoint(import.meta.url, process.argv[1])) process.exitCode = await main(process.stdout);
