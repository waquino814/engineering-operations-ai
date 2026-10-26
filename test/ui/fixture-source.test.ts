import { describe, expect, it } from 'vitest';
import {
  createFixtureSource,
  E6_REQUIRED,
  FixtureError,
} from '../../src/ui/data/fixture-source.ts';
import type { UiFixtures } from '../../src/ui/data/types.ts';
import committed from '../../src/ui/fixtures/fixtures.json' with { type: 'json' };

/** ADR 0011: the fixture data source behind the console's typed interface. */
const fixtures = committed as UiFixtures;

describe('the fixture data source', () => {
  it('describes itself as fixture data', () => {
    const source = createFixtureSource(fixtures);
    expect(source.description).toEqual({ mode: 'fixture', notice: fixtures.notice });
  });

  it('lists every investigation, newest first, marked as fixtures', async () => {
    const list = await createFixtureSource(fixtures).listInvestigations();
    expect(list).toHaveLength(fixtures.investigations.length);
    const starts = list.map((i) => i.result.run.startedAt);
    expect(starts).toEqual([...starts].sort().reverse());
    expect(new Set(list.map((i) => i.origin))).toEqual(new Set(['fixture']));
  });

  it('finds one investigation by id, or none', async () => {
    const source = createFixtureSource(fixtures);
    expect((await source.getInvestigation('fx-001'))?.result.outcome).toBe('completed');
    expect(await source.getInvestigation('fx-999')).toBeNull();
  });

  it('lists bundles without their validation, and validates each on request', async () => {
    const source = createFixtureSource(fixtures);
    const bundles = await source.listBundles();
    expect(bundles.map((b) => b.id)).toEqual(['bundle-a', 'bundle-b', 'bundle-c', 'bundle-d']);
    expect(bundles[0]).not.toHaveProperty('validation');
    expect(await source.validateBundle('bundle-a')).toMatchObject({
      bundleId: 'bundle-a',
      valid: true,
      issues: [],
      metadata: { caseId: expect.stringMatching(/^[0-9a-f]{16}$/) as unknown },
    });
    expect(await source.validateBundle('bundle-c')).toMatchObject({ valid: false, metadata: null });
    await expect(source.validateBundle('bundle-z')).rejects.toThrow('no fixture bundle bundle-z');
  });

  it('answers that uploading and starting need the E6 boundary, pointing to fixture results', async () => {
    const source = createFixtureSource(fixtures);
    expect(await source.uploadBundle([])).toEqual({
      status: 'unavailable',
      reason: `Uploading a bundle: ${E6_REQUIRED}`,
    });
    expect(await source.startInvestigation('bundle-a')).toEqual({
      status: 'unavailable',
      reason: `Starting an investigation: ${E6_REQUIRED}`,
      fixtureInvestigationIds: ['fx-001', 'fx-002', 'fx-003', 'fx-004'],
    });
    expect(await source.startInvestigation('bundle-d')).toMatchObject({
      fixtureInvestigationIds: [],
    });
  });

  it('refuses a fixture that is not a valid result, rather than render it', () => {
    const broken = structuredClone(fixtures);
    const first = broken.investigations[0];
    if (!first) throw new Error('no fixtures');
    (first.result as { outcome: string }).outcome = 'partial';
    expect(() => createFixtureSource(broken)).toThrow(FixtureError);
    expect(() => createFixtureSource(broken)).toThrow(
      /fixture fx-001 is not a valid investigation result/,
    );
  });
});
