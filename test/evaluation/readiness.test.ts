import { describe, expect, it } from 'vitest';
import {
  checkEvaluationInput,
  FIXED_FAULT_OFFSET_MS,
  isEntryPoint,
  main,
  USAGE,
} from '../../src/evaluation/readiness.ts';
import { readAnswerKey } from '../../src/evaluation/ground-truth.ts';
import { SCENARIO_SPLIT, TUNING_SEEDS, buildSuite, SUITES } from '../../src/evaluation/suites.ts';
import { example, makeBundle } from '../support.ts';

/** `expect.stringContaining`, typed as the string it stands in for. */
const containing = (text: string): string => expect.stringContaining(text) as string;

type Json = Record<string, unknown>;

/** A valid bundle whose scenario, seed and trigger offset are changed consistently. */
async function bundleFor(scenario: { name: string; seed: number }, offsetMs?: number) {
  const truth = JSON.parse((await example('ground_truth.json')).toString('utf8')) as Json;
  truth['scenario'] = { ...(truth['scenario'] as Json), ...scenario };
  if (offsetMs !== undefined)
    truth['timeline'] = { ...(truth['timeline'] as Json), triggerOffsetMs: offsetMs };
  return makeBundle({
    dirName: `${scenario.name}-${String(scenario.seed)}-20261027T000000Z`,
    files: { 'ground_truth.json': `${JSON.stringify(truth, null, 2)}\n` },
    manifest: (m) => {
      m['scenario'] = { ...(m['scenario'] as Json), ...scenario };
    },
  });
}

describe('evaluation input readiness', () => {
  it('lets the genuine excerpt be used for development, with its two stated limits', async () => {
    const r = await checkEvaluationInput(await makeBundle(), 'development');
    expect(r).toMatchObject({
      ready: true,
      intendedSplit: 'development',
      scenario: { name: 'provider-outage', seed: 42 },
    });
    expect(r.findings.map((f) => [f.code, f.severity])).toEqual([
      ['seed_used_for_tuning', 'limitation'],
      ['fixed_fault_timing', 'limitation'],
    ]);
  });

  it('refuses the tuning seed as a held-out input, and a development scenario on the held-out side', async () => {
    const r = await checkEvaluationInput(await makeBundle(), 'held-out');
    expect(r.ready).toBe(false);
    expect(r.findings.filter((f) => f.severity === 'blocking').map((f) => f.code)).toEqual([
      'split_conflict',
      'seed_used_for_tuning',
    ]);
  });

  it('accepts a new seed of the development scenario as development input without the tuning caveat', async () => {
    const r = await checkEvaluationInput(
      await bundleFor({ name: 'provider-outage', seed: 43 }, 45_000),
      'development',
    );
    expect(r).toMatchObject({ ready: true, findings: [] });
  });

  it('cannot use a scenario that has no declared split, and says the owner decides its side', async () => {
    const r = await checkEvaluationInput(
      await bundleFor({ name: 'payment-timeouts', seed: 7 }, 20_000),
    );
    expect(r.ready).toBe(false);
    expect(r.findings).toMatchObject([
      {
        code: 'scenario_unregistered',
        severity: 'blocking',
        message: containing('owner decision'),
      },
    ]);
  });

  it('checks nothing about the side when none is asked for', async () => {
    const r = await checkEvaluationInput(await makeBundle());
    expect(r.intendedSplit).toBeNull();
    expect(r.findings.map((f) => f.code)).not.toContain('split_conflict');
  });

  it('reports truncated traces as a limitation', async () => {
    const dir = await makeBundle({
      manifest: (m) => {
        const services = ((m['capture'] as Json)['traces'] as Json)['services'] as Json[];
        Object.assign(services[0] as Json, {
          truncated: true,
          truncationReasons: ['service_cap'],
        });
      },
    });
    const r = await checkEvaluationInput(dir, 'development');
    expect(r.findings).toContainEqual(
      expect.objectContaining({ code: 'telemetry_truncated', severity: 'limitation' }),
    );
    expect(r.ready).toBe(true);
  });

  it('reports every contract problem of an invalid bundle, without the bundle path, and nothing else', async () => {
    const dir = await makeBundle({ after: { 'logs.jsonl': null } });
    const r = await checkEvaluationInput(dir, 'development');
    expect(r).toMatchObject({ ready: false, scenario: null });
    expect(r.findings.length).toBeGreaterThan(0);
    for (const f of r.findings) {
      expect([f.code, f.severity]).toEqual(['bundle_invalid', 'blocking']);
      expect(f.message).not.toContain(dir);
    }
    expect(r.findings[0]?.message).toMatch(/^rule 1 files-present: logs\.jsonl/);
  });

  it('lists at most ten issues and counts the rest', async () => {
    const many = Array.from({ length: 25 }, () => '{"not":"a record"}').join('\n');
    const dir = await makeBundle({ files: { 'logs.jsonl': `${many}\n` } });
    const r = await checkEvaluationInput(dir);
    expect(r.ready).toBe(false);
    expect(r.findings).toHaveLength(11);
    expect(r.findings.at(-1)?.message).toMatch(/^\d+ more issue\(s\) not listed$/);
  });

  it('knows the fixed fault offset the project records', () => {
    expect(FIXED_FAULT_OFFSET_MS).toBe(30_000);
  });
});

describe('the registry the check relies on', () => {
  it('lists the seed of every development bundle as used for tuning, and of no held-out bundle', async () => {
    for (const suite of SUITES) {
      const built = await buildSuite(suite);
      try {
        for (const b of built.bundles) {
          const key = await readAnswerKey(b.dir);
          expect(SCENARIO_SPLIT[key.scenario]).toBe(suite.split);
          const tuned = (TUNING_SEEDS[key.scenario] ?? []).includes(key.scenarioSeed);
          expect([suite.id, key.scenario, tuned]).toEqual([
            suite.id,
            key.scenario,
            suite.split === 'development',
          ]);
        }
      } finally {
        await built.cleanup();
      }
    }
  });
});

describe('the readiness command', () => {
  const run = async (args: string[]) => {
    let out = '';
    let err = '';
    const code = await main(args, { write: (t) => (out += t) }, { write: (t) => (err += t) });
    return { code, out, err };
  };

  it('prints the readiness as JSON and exits 0 when ready, 1 when not', async () => {
    const ok = await run([await makeBundle(), '--for', 'development']);
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.out)).toMatchObject({ ready: true, intendedSplit: 'development' });
    const bad = await run([await makeBundle(), '--for', 'held-out']);
    expect(bad.code).toBe(1);
    expect(JSON.parse(bad.out)).toMatchObject({ ready: false });
    expect((await run([await makeBundle()])).code).toBe(0);
  });

  it.each([
    [[]],
    [['--for', 'held-out']],
    [['dir', '--for']],
    [['dir', '--for', 'both']],
    [['dir', '--side', 'held-out']],
    [['dir', '--for', 'held-out', 'extra']],
  ])('refuses %j as a usage error', async (args) => {
    const r = await run(args);
    expect([r.code, r.out]).toEqual([2, '']);
    expect(r.err).toBe(`${USAGE}\n`);
  });

  it('recognises when it is the program being run', () => {
    const url = new URL('../../src/evaluation/readiness.ts', import.meta.url);
    expect(isEntryPoint(url.href, url.pathname)).toBe(true);
    expect(isEntryPoint(url.href, undefined)).toBe(false);
  });
});
