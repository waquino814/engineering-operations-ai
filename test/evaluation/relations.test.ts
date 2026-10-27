import { appendFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { componentEvidence } from '../../src/evaluation/relations.ts';
import { syntheticCases, writeSyntheticBundles } from '../../src/evaluation/synthetic.ts';
import type { InvestigationResult } from '../../src/investigation/result.ts';
import { runInvestigation } from '../../src/pipeline/run-investigation.ts';

/**
 * The component-in-cited-records relation (src/evaluation/relations.ts): a descriptive count.
 * These tests pin what it counts and, as importantly, what it does not claim.
 */
let root: string;
let dir: string;
let result: InvestigationResult;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'eoai-relations-'));
  const written = await writeSyntheticBundles(root);
  const cases = await syntheticCases(written);
  const correct = cases.find((c) => c.id === 'excerpt-correct');
  if (!correct) throw new Error('fixture changed');
  dir = correct.bundleDir;
  result = (
    await runInvestigation(dir, {
      provider: correct.provider,
      now: () => 0,
      sleep: () => Promise.resolve(),
    })
  ).result;
});
afterAll(() => rm(root, { recursive: true, force: true }));

const withComponents = (components: string[][]): InvestigationResult => ({
  ...result,
  findings: result.findings.map((f, i) => ({ ...f, components: components[i] ?? f.components })),
});

describe('component evidence', () => {
  it('counts a named component only when a record its own finding cites carries the name', async () => {
    // F1 names payment-provider but cites a metric and a log that never carry that name as a
    // value (the dependency is implied); F2 names worker and cites a worker trace.
    expect(result.findings.map((f) => f.components)).toEqual([['payment-provider'], ['worker']]);
    expect(await componentEvidence(dir, result)).toEqual({
      named: 2,
      identified: 1,
      unidentified: [{ finding: 'F1', component: 'payment-provider' }],
    });
  });

  it('does not credit a component to a finding because another finding cites a record naming it', async () => {
    // `postgres` is a value only in the trace F2 cites (server.address); F1 cites a metric and a log.
    const swapped = withComponents([['postgres'], ['postgres']]);
    expect(await componentEvidence(dir, swapped)).toMatchObject({
      named: 2,
      unidentified: [{ finding: 'F1', component: 'postgres' }],
    });
  });

  it('counts each component once per finding, in a stable order, and a component that appears nowhere as not found', async () => {
    const odd = withComponents([['worker', 'worker', 'zzz-unknown', 'aaa-unknown'], ['worker']]);
    expect(await componentEvidence(dir, odd)).toEqual({
      named: 4,
      identified: 2,
      unidentified: [
        { finding: 'F1', component: 'aaa-unknown' },
        { finding: 'F1', component: 'zzz-unknown' },
      ],
    });
  });

  it('is null when no bundle was admitted, and counts nothing for a result without findings', async () => {
    expect(await componentEvidence(dir, { ...result, bundle: null })).toBeNull();
    expect(await componentEvidence(dir, { ...result, findings: [] })).toEqual({
      named: 0,
      identified: 0,
      unidentified: [],
    });
  });

  it('ignores a record whose file no longer matches the checksum the run recorded', async () => {
    const copy = await syntheticCases(await writeSyntheticBundles(await mkdtemp(join(root, 'c-'))));
    const same = copy.find((c) => c.id === 'excerpt-correct');
    if (!same) throw new Error('fixture changed');
    await appendFile(join(same.bundleDir, 'traces.jsonl'), '\n');
    expect(await componentEvidence(same.bundleDir, result)).toMatchObject({
      named: 2,
      identified: 0,
    });
  });

  it('treats an unreadable file, a missing line and a non-record line as nothing found', async () => {
    const copy = await syntheticCases(await writeSyntheticBundles(await mkdtemp(join(root, 'd-'))));
    const same = copy.find((c) => c.id === 'excerpt-correct');
    if (!same) throw new Error('fixture changed');
    await rm(join(same.bundleDir, 'traces.jsonl'));
    expect(await componentEvidence(same.bundleDir, result)).toMatchObject({ identified: 0 });
    const past = {
      ...result,
      findings: result.findings.map((f) => ({
        ...f,
        evidence: f.evidence.map((e) => ({ ...e, line: 9_999 })),
      })),
    };
    expect(await componentEvidence(dir, past)).toMatchObject({ identified: 0 });
    // A line that is not JSON holds no record.
    const junk = await syntheticCases(await writeSyntheticBundles(await mkdtemp(join(root, 'e-'))));
    const j = junk.find((c) => c.id === 'excerpt-correct');
    if (!j) throw new Error('fixture changed');
    await writeFile(join(j.bundleDir, 'logs.jsonl'), 'not json\n');
    expect(await componentEvidence(j.bundleDir, past)).toMatchObject({ identified: 0 });
  });

  it('never opens a file that is not telemetry', async () => {
    const odd = {
      ...result,
      findings: result.findings.map((f) => ({
        ...f,
        evidence: f.evidence.map((e) => ({ ...e, file: 'ground_truth.json' })),
      })),
    };
    expect(await componentEvidence(dir, odd)).toMatchObject({ named: 2, identified: 0 });
  });
});
