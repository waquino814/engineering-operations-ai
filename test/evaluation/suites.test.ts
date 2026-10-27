import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readAnswerKey } from '../../src/evaluation/ground-truth.ts';
import {
  assertCaseScenario,
  assertSuiteSplit,
  buildSuite,
  MISSING_FOR_FULL_HOLDOUT,
  SCENARIO_SPLIT,
  SplitViolation,
  SUITES,
  suiteById,
  type SuiteDefinition,
} from '../../src/evaluation/suites.ts';

/** The development / held-out split: declared once, checked against the answer keys, and enforced. */
describe('the suites', () => {
  it('declare two versioned suites, one per side, every case on its suite’s side', () => {
    expect(SUITES.map((s) => [s.id, s.version, s.split])).toEqual([
      ['development', '1', 'development'],
      ['held-out', '1', 'held-out'],
    ]);
    for (const suite of SUITES) {
      expect(() => {
        assertSuiteSplit(suite);
      }).not.toThrow();
      expect(suite.synthetic).toBe(true);
    }
    expect(suiteById('held-out')?.cases.map((c) => c.scenario)).toEqual(
      Array(2).fill('synthetic-cache-saturation'),
    );
    expect(suiteById('nope')).toBeUndefined();
  });

  it('declare scenarios that match what the answer keys actually say', async () => {
    for (const suite of SUITES) {
      const built = await buildSuite(suite);
      try {
        for (const c of built.cases) {
          const declared = suite.cases.find((x) => x.id === c.id)?.scenario;
          const key = await readAnswerKey(c.bundleDir);
          expect(key.scenario, c.id).toBe(declared);
          expect(SCENARIO_SPLIT[key.scenario], c.id).toBe(suite.split);
        }
      } finally {
        await built.cleanup();
      }
    }
  });

  it('refuse a held-out scenario in the development suite, and the reverse, before anything runs', () => {
    const base = SUITES[0] as SuiteDefinition;
    const leaked: SuiteDefinition = {
      ...base,
      cases: [...base.cases, { id: 'fabricated-correct', scenario: 'synthetic-cache-saturation' }],
    };
    expect(() => {
      assertSuiteSplit(leaked);
    }).toThrow(SplitViolation);
    expect(() => {
      assertSuiteSplit(leaked);
    }).toThrow(/synthetic-cache-saturation.*held-out.*development/);
    const heldOut = SUITES[1] as SuiteDefinition;
    expect(() => {
      assertSuiteSplit({
        ...heldOut,
        cases: [{ id: 'excerpt-correct', scenario: 'provider-outage' }],
      });
    }).toThrow(SplitViolation);
  });

  it('refuse a scenario with no declared split, so a new bundle forces a decision', () => {
    const base = SUITES[0] as SuiteDefinition;
    expect(() => {
      assertSuiteSplit({ ...base, cases: [{ id: 'x', scenario: 'brand-new-scenario' }] });
    }).toThrow(/no declared split/);
    expect(() => {
      assertCaseScenario(base, 'excerpt-correct', 'brand-new-scenario');
    }).toThrow(SplitViolation);
  });

  it('check, after a case ran, that the key names the declared scenario; a bundle that was not admitted names none', () => {
    const [dev, held] = SUITES as [SuiteDefinition, SuiteDefinition];
    expect(() => {
      assertCaseScenario(dev, 'excerpt-correct', 'provider-outage');
    }).not.toThrow();
    expect(() => {
      assertCaseScenario(dev, 'tampered-bundle', null);
    }).not.toThrow();
    expect(() => {
      assertCaseScenario(dev, 'excerpt-correct', 'synthetic-cache-saturation');
    }).toThrow(SplitViolation);
    expect(() => {
      assertCaseScenario(held, 'fabricated-correct', 'provider-outage');
    }).toThrow(SplitViolation);
  });

  it('build only the declared cases, and remove their temporary bundles afterwards', async () => {
    const dev = await buildSuite(SUITES[0] as SuiteDefinition);
    expect(dev.cases.map((c) => c.id)).toEqual(
      (SUITES[0] as SuiteDefinition).cases.map((c) => c.id),
    );
    expect(dev.bundles).toHaveLength(2); // the excerpt and the tampered copy
    const root = dirname(dev.cases[0]?.bundleDir ?? '');
    expect((await readdir(root)).length).toBeGreaterThan(0);
    await dev.cleanup();
    await expect(readdir(root)).rejects.toThrow();
    const base = SUITES[0] as SuiteDefinition;
    await expect(
      buildSuite({ ...base, cases: [{ id: 'no-such-case', scenario: 'provider-outage' }] }),
    ).rejects.toThrow(/do not define/);
  });

  it('list what a full held-out evaluation still needs, as the roadmap states it', () => {
    expect(MISSING_FOR_FULL_HOLDOUT.join(' ')).toMatch(/other than provider-outage/);
    expect(MISSING_FOR_FULL_HOLDOUT.join(' ')).toMatch(/seeds/);
    expect(MISSING_FOR_FULL_HOLDOUT.join(' ')).toMatch(/varied fault timing/);
    expect(Object.keys(SCENARIO_SPLIT).sort()).toEqual([
      'provider-outage',
      'synthetic-cache-saturation',
    ]);
  });

  it('never put the held-out scenario into any code that shapes a prompt (source scan)', async () => {
    const dirs = ['investigation', 'pipeline', 'providers', 'intake'];
    for (const d of dirs) {
      const root = new URL(`../../src/${d}/`, import.meta.url).pathname;
      for (const f of await readdir(root, { recursive: true })) {
        if (!/\.tsx?$/.test(f)) continue;
        expect(await readFile(join(root, f), 'utf8'), `${d}/${f}`).not.toMatch(
          /synthetic-cache-saturation|cache-node|cache_requests_total/,
        );
      }
    }
  });
});
