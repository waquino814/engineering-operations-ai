import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openEvidence } from '../intake/evidence.ts';
import { validateBundle } from '../intake/validate-bundle.ts';
import { FakeProvider } from '../investigation/fake-provider.ts';
import { ProviderError, type ModelProvider } from '../investigation/provider.ts';
import { runInvestigation } from '../pipeline/run-investigation.ts';
import type { BundleValidation, UiFixtures } from '../ui/data/types.ts';
import { syntheticCases, writeSyntheticBundles } from './synthetic.ts';

/**
 * Generates the console's fixtures (ADR 0011): `pnpm fixtures:ui`. Every investigation result is
 * produced by the real pipeline with the deterministic fake provider, from the scripted synthetic
 * cases; every validation report by the real `validateBundle`. Nothing is hand-written, no answer
 * key is read and nothing is scored. Paths are removed, and the bundles are shown by neutral
 * labels and their blinded metadata, never by scenario-bearing names (ADR 0003).
 */
const NOTICE =
  'Fixture data. Generated from synthetic bundles by the real pipeline with a deterministic fake model provider. No live investigation ran and no real model was called.';

/** Fixture start times: fixed, an hour apart, and each call to the clock advances 250 ms. */
const START = Date.parse('2026-10-26T09:00:00.000Z');
const clock = (index: number) => {
  let t = START + index * 3_600_000;
  return () => (t += 250);
};

const BUNDLES = [
  {
    id: 'bundle-a',
    key: 'excerpt',
    label: 'Fixture bundle A',
    description: 'A genuine Commerce Platform bundle excerpt, with recomputed checksums.',
  },
  {
    id: 'bundle-b',
    key: 'fabricated',
    label: 'Fixture bundle B',
    description: 'An invented incident with invented components and telemetry.',
  },
  {
    id: 'bundle-c',
    key: 'tampered',
    label: 'Fixture bundle C',
    description: 'Bundle A with its log file altered after the manifest was written.',
  },
  {
    id: 'bundle-d',
    key: 'unsupported',
    label: 'Fixture bundle D',
    description: 'Bundle B declaring a contract major version this project does not support.',
  },
] as const;

/**
 * The synthetic cases shown in the console, by fixture ID, with a neutral label for each scripted
 * path; any case not listed is not shown. fx-007 is added below: a token-budget run.
 */
const SHOWN: Partial<Record<string, { id: string; bundleId: string; label: string }>> = {
  'excerpt-correct': { id: 'fx-001', bundleId: 'bundle-a', label: 'Scripted reply' },
  'excerpt-repaired-reply': {
    id: 'fx-002',
    bundleId: 'bundle-a',
    label: 'Scripted invalid reply, then a repaired one',
  },
  'excerpt-inconclusive': {
    id: 'fx-003',
    bundleId: 'bundle-a',
    label: 'Scripted inconclusive reply',
  },
  'excerpt-fabricated-evidence': {
    id: 'fx-004',
    bundleId: 'bundle-a',
    label: 'Scripted reply citing a record that does not exist',
  },
  'fabricated-correct': { id: 'fx-005', bundleId: 'bundle-b', label: 'Scripted reply' },
  'fabricated-provider-down': {
    id: 'fx-006',
    bundleId: 'bundle-b',
    label: 'Scripted provider failure: unavailable, every retry',
  },
  'tampered-bundle': { id: 'fx-008', bundleId: 'bundle-c', label: 'Bundle refused at admission' },
};

export async function buildUiFixtures(): Promise<UiFixtures> {
  const root = await mkdtemp(join(tmpdir(), 'eoai-ui-fixtures-'));
  try {
    const synthetic = await writeSyntheticBundles(root);
    const unsupported = join(root, 'unsupported-7-20260101T000000Z');
    await cp(synthetic.fabricated, unsupported, { recursive: true });
    const manifestPath = join(unsupported, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    await writeFile(
      manifestPath,
      `${JSON.stringify({ ...manifest, schemaVersion: '2.0.0', bundleId: 'unsupported-7-20260101T000000Z' }, null, 2)}\n`,
    );
    const dirs: Record<(typeof BUNDLES)[number]['key'], string> = { ...synthetic, unsupported };
    const strip = (text: string) => text.split(root).join('<bundles>');

    const bundles: UiFixtures['bundles'] = [];
    for (const b of BUNDLES) {
      const report = await validateBundle(dirs[b.key]);
      let metadata: BundleValidation['metadata'] = null;
      if (report.valid) {
        const view = await openEvidence(dirs[b.key]);
        metadata = { caseId: view.caseId, manifest: view.manifest };
      }
      bundles.push({
        id: b.id,
        label: b.label,
        description: b.description,
        origin: 'fixture',
        validation: {
          valid: report.valid,
          schemaVersion: report.schemaVersion,
          issues: report.issues.map((i) => ({ ...i, message: strip(i.message) })),
          metadata,
        },
      });
    }

    const investigations: UiFixtures['investigations'] = [];
    // Each fixture's clock follows its ID, so the order cases run in does not matter.
    const run = async (
      meta: { id: string; bundleId: string; label: string },
      dir: string,
      provider: ModelProvider,
      limits: Record<string, number> = {},
    ) => {
      const { result } = await runInvestigation(dir, {
        provider,
        now: clock(Number(meta.id.slice(3)) - 1),
        sleep: () => Promise.resolve(),
        limits,
      });
      investigations.push({ ...meta, result });
    };
    for (const c of await syntheticCases(synthetic)) {
      const meta = SHOWN[c.id];
      if (meta) await run(meta, c.bundleDir, c.provider);
    }
    // A token budget that admits exactly one call at its ceiling: the failure cannot be retried.
    const unavailable = () => ({ error: new ProviderError('unavailable', 'synthetic outage') });
    await run(
      {
        id: 'fx-007',
        bundleId: 'bundle-b',
        label: 'Token budget for one call, then an unavailable provider',
      },
      synthetic.fabricated,
      new FakeProvider([unavailable(), unavailable()], 'scripted'),
      { maxTotalTokens: 204_000 },
    );
    investigations.sort((a, b) => a.id.localeCompare(b.id));

    return { fixtureVersion: 1, notice: NOTICE, bundles, investigations };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export interface Writer {
  write(text: string): unknown;
}

/** Prints the fixtures as the committed JSON file's exact bytes. */
export async function main(out: Writer, build = buildUiFixtures): Promise<number> {
  out.write(`${JSON.stringify(await build(), null, 2)}\n`);
  return 0;
}

export const isEntryPoint = (moduleUrl: string, argv1: string | undefined) =>
  argv1 !== undefined && fileURLToPath(moduleUrl) === argv1;

if (isEntryPoint(import.meta.url, process.argv[1])) process.exitCode = await main(process.stdout);
