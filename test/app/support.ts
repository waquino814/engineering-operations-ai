import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, vi } from 'vitest';
import { openEvidence } from '../../src/index.ts';
import type { FakeStep } from '../../src/investigation/fake-provider.ts';
import { bundles, goodOutput } from '../investigation/support.ts';

/** Deterministic and offline: any fetch fails the test (this alone does not prove no network path). */
export const fetchSpy = vi.fn(() => {
  throw new Error('network access attempted in a test');
});
beforeEach(() => {
  fetchSpy.mockClear();
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const d of temps.splice(0)) await rm(d, { recursive: true, force: true });
});
const temps: string[] = [];

export async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'eoai-app-'));
  temps.push(d);
  return d;
}

/** A bundles root holding the synthetic bundles, a fresh runs directory, and ready environments. */
export async function workspace() {
  const b = await bundles();
  const bundlesDir = dirname(b.excerpt);
  const runsDir = join(await tempDir(), 'runs');
  const view = await openEvidence(b.excerpt);
  const steps: FakeStep[] = [{ reply: goodOutput(view) }];
  return {
    b,
    bundlesDir,
    runsDir,
    excerptId: basename(b.excerpt),
    tamperedId: basename(b.tampered),
    env: (extra: Record<string, string> = {}) => ({
      EOAI_BUNDLES_DIR: bundlesDir,
      EOAI_RUNS_DIR: runsDir,
      ...extra,
    }),
    steps,
  };
}
