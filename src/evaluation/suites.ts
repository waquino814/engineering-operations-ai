import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EvaluationCase } from './harness.ts';
import { syntheticCases, writeSyntheticBundles } from './synthetic.ts';

/**
 * Versioned evaluation suites and the development / held-out split (ADR 0009, "Holdout
 * strategy"). The split is by **scenario**, declared here once: `SCENARIO_SPLIT` maps every
 * scenario name the repository can evaluate to exactly one side, and a scenario that is not
 * registered cannot be run at all, so adding a bundle forces a decision about its side.
 *
 * What is real about it, and what is not:
 * - Development: the `provider-outage` scenario (seed 42), whose excerpt is genuine Commerce
 *   Platform data. Prompts, selection and scoring were written looking at it.
 * - Held-out: `synthetic-cache-saturation`, an **invented** scenario with invented components
 *   and metric names that nothing in `src/` outside `src/evaluation/` mentions (a test fails if
 *   one does). It is held out from prompt and selection design, but it is synthetic, so it says
 *   nothing about performance on real incidents.
 * - The roadmap's held-out requirement (new seeds of real scenarios, a real unseen scenario,
 *   varied fault timing) needs Commerce Platform bundles this repository does not have. This file
 *   does not pretend otherwise: `MISSING_FOR_FULL_HOLDOUT` lists what is absent.
 */
export type Split = 'development' | 'held-out';

export const SCENARIO_SPLIT: Readonly<Record<string, Split>> = Object.freeze({
  'provider-outage': 'development',
  'synthetic-cache-saturation': 'held-out',
});

/**
 * The seeds of each scenario that were used to build, tune or test this project's prompts,
 * selection and scoring. A bundle with one of these seeds is not independent evidence for that
 * scenario, whatever its other contents (src/evaluation/readiness.ts). A test requires every
 * development bundle's seed to be listed here.
 */
export const TUNING_SEEDS: Readonly<Record<string, readonly number[]>> = Object.freeze({
  'provider-outage': [42],
});

export const MISSING_FOR_FULL_HOLDOUT = [
  'Real Commerce Platform bundles for scenarios other than provider-outage (the repository holds one genuine excerpt: provider-outage, seed 42).',
  'New seeds of a real scenario, to hold out seeds rather than scenarios.',
  'Bundles with varied fault timing (every real bundle so far faults exactly 30 s after load start; ADR 0003, "Remaining risks").',
] as const;

export interface SuiteDefinition {
  id: string;
  version: string;
  split: Split;
  description: string;
  /** Always true for the suites here: no real incident data is committed or generated. */
  synthetic: true;
  /** Case ids, and the scenario each is declared to belong to (checked against the answer key). */
  cases: readonly { id: string; scenario: string }[];
}

export const SUITES: readonly SuiteDefinition[] = Object.freeze([
  {
    id: 'development',
    version: '1',
    split: 'development',
    description:
      'The provider-outage excerpt (genuine Commerce Platform data) with scripted replies for correct, wrong, conflicting, partial, repaired, fabricated and inconclusive diagnoses, plus a tampered bundle.',
    synthetic: true,
    cases: [
      { id: 'excerpt-correct', scenario: 'provider-outage' },
      { id: 'excerpt-wrong-root-cause', scenario: 'provider-outage' },
      { id: 'excerpt-conflicting-root-causes', scenario: 'provider-outage' },
      { id: 'excerpt-correct-without-symptom-evidence', scenario: 'provider-outage' },
      { id: 'excerpt-repaired-reply', scenario: 'provider-outage' },
      { id: 'excerpt-fabricated-evidence', scenario: 'provider-outage' },
      { id: 'excerpt-inconclusive', scenario: 'provider-outage' },
      { id: 'tampered-bundle', scenario: 'provider-outage' },
    ],
  },
  {
    id: 'held-out',
    version: '1',
    split: 'held-out',
    description:
      'An invented scenario (synthetic-cache-saturation) that no prompt, selection or scoring code was written against. Synthetic: it tests the split, not generalization to real incidents.',
    synthetic: true,
    cases: [
      { id: 'fabricated-correct', scenario: 'synthetic-cache-saturation' },
      { id: 'fabricated-provider-down', scenario: 'synthetic-cache-saturation' },
    ],
  },
]);

export class SplitViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SplitViolation';
  }
}

export function suiteById(id: string): SuiteDefinition | undefined {
  return SUITES.find((s) => s.id === id);
}

/**
 * Checks a suite definition against the registry: every case's declared scenario is registered
 * and on the suite's side. Run before any case executes.
 */
export function assertSuiteSplit(suite: SuiteDefinition): void {
  for (const c of suite.cases) {
    const side = SCENARIO_SPLIT[c.scenario];
    if (side === undefined)
      throw new SplitViolation(`case ${c.id}: scenario "${c.scenario}" has no declared split`);
    if (side !== suite.split)
      throw new SplitViolation(
        `case ${c.id}: scenario "${c.scenario}" is ${side}, but suite "${suite.id}" is ${suite.split}`,
      );
  }
}

/** Checks, after a case ran, that the scenario the answer key names is the one declared. */
export function assertCaseScenario(
  suite: SuiteDefinition,
  caseId: string,
  actual: string | null,
): void {
  if (actual === null) return; // not admitted: no key was read
  const declared = suite.cases.find((c) => c.id === caseId)?.scenario;
  const side = SCENARIO_SPLIT[actual];
  if (declared !== actual || side !== suite.split)
    throw new SplitViolation(
      `case ${caseId}: the answer key names scenario "${actual}" (${side ?? 'unregistered'}), not the declared "${String(declared)}" of suite "${suite.id}" (${suite.split})`,
    );
}

export interface BuiltSuite {
  cases: EvaluationCase[];
  /** One entry per distinct bundle, named by the first scripted case that uses it. */
  bundles: { id: string; dir: string }[];
  cleanup: () => Promise<void>;
}

/** Writes the suite's synthetic bundles to a temporary directory and builds its cases. */
export async function buildSuite(suite: SuiteDefinition): Promise<BuiltSuite> {
  assertSuiteSplit(suite);
  const root = await mkdtemp(join(tmpdir(), `eoai-suite-${suite.id}-`));
  const written = await writeSyntheticBundles(root);
  const all = await syntheticCases(written);
  const ids = new Set(suite.cases.map((c) => c.id));
  const cases = all.filter((c) => ids.has(c.id));
  if (cases.length !== ids.size)
    throw new SplitViolation(`suite "${suite.id}" names a case the fixtures do not define`);
  const seen = new Map<string, string>();
  for (const c of cases) if (!seen.has(c.bundleDir)) seen.set(c.bundleDir, c.id);
  return {
    cases,
    bundles: [...seen].map(([dir, id]) => ({ id, dir })),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
