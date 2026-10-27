import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GROUND_TRUTH_FILE } from '../intake/contract.ts';
import { validatorsFor } from '../intake/contract.ts';

/**
 * The scoring boundary's access to the answer key (ADR 0003, ADR 0009). Evaluation reads
 * `ground_truth.json` only here, after an investigation has finished; the investigation layer
 * cannot import this module (enforced by a test).
 */
export interface AnswerKey {
  scenario: string;
  scenarioSeed: number;
  rootCauseComponent: string;
  affectedComponents: string[];
  /** The metric series that shows the fault, as the bundle contract states it. */
  primarySymptom: { metric: string; matchers: Record<string, string> };
}

export async function readAnswerKey(bundleDir: string): Promise<AnswerKey> {
  const value = JSON.parse(await readFile(join(bundleDir, GROUND_TRUTH_FILE), 'utf8')) as Record<
    string,
    unknown
  >;
  const validators = await validatorsFor(1);
  if (!validators['ground-truth'](value))
    throw new Error(`${GROUND_TRUTH_FILE} does not match its schema`);
  const scenario = value.scenario as { name: string; seed: number };
  const rootCause = value.rootCause as { component: string; summary: string };
  return {
    scenario: scenario.name,
    scenarioSeed: scenario.seed,
    rootCauseComponent: rootCause.component,
    affectedComponents: [...(value.affectedComponents as string[])].sort(),
    primarySymptom: {
      metric: (value.primarySymptom as { metric: string }).metric,
      matchers: (value.primarySymptom as { matchers: Record<string, string> }).matchers,
    },
  };
}
