import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as evidence from '../../src/intake/evidence.ts';
import { FakeProvider, resultSchemaProblems, runInvestigation } from '../../src/index.ts';
import { makeBundle } from '../support.ts';
import { bundles, goodOutput } from '../investigation/support.ts';

/** ADR 0006 steps 1 and 2: admission, and what crosses into the investigator. */
const snapshot = async (dir: string): Promise<Record<string, string>> =>
  Object.fromEntries(
    await Promise.all(
      (await readdir(dir)).map(async (f): Promise<[string, string]> => [
        f,
        await readFile(join(dir, f), 'utf8'),
      ]),
    ),
  );

describe('the investigation pipeline', () => {
  it('admits a valid bundle and investigates its blinded view', async () => {
    const dir = (await bundles()).excerpt;
    const view = await evidence.openEvidence(dir);
    const provider = new FakeProvider([{ reply: goodOutput(view) }]);
    const before = await snapshot(dir);
    const { result, report } = await runInvestigation(dir, { provider, now: () => 0 });
    expect(report?.valid).toBe(true);
    expect(result).toMatchObject({ outcome: 'completed', caseId: view.caseId });
    expect(resultSchemaProblems(result)).toEqual([]);
    // The bundle is never written to.
    expect(await snapshot(dir)).toEqual(before);
    // Nothing that names the bundle reached the model.
    expect(provider.requests[0]?.input).not.toContain(dir);
    expect(provider.requests[0]?.input).not.toContain('provider-outage');
  });

  it('refuses an invalid bundle without calling the model or quoting its path', async () => {
    const dir = await makeBundle({ after: { 'logs.jsonl': 'nope\n' } });
    const provider = new FakeProvider([]);
    const { result, report } = await runInvestigation(dir, { provider, now: () => 0 });
    expect(report?.valid).toBe(false);
    expect(result).toMatchObject({
      outcome: 'failed',
      caseId: null,
      bundle: null,
      failure: { class: 'invalid_bundle', message: '4 contract issue(s) under rule(s) 4, 9' },
    });
    expect(JSON.stringify(result)).not.toContain(dir);
    expect(JSON.stringify(result)).not.toContain('provider-outage');
    expect(provider.requests).toHaveLength(0);
    expect(resultSchemaProblems(result)).toEqual([]);
  });

  it('classifies an unsupported contract version', async () => {
    const dir = await makeBundle({ manifest: (m) => (m.schemaVersion = '2.0.0') });
    const { result } = await runInvestigation(dir, {
      provider: new FakeProvider([]),
      now: () => 0,
    });
    expect(result.failure?.class).toBe('unsupported_contract_version');
  });

  it('refuses evidence that changes between validation and admission', async () => {
    const dir = (await bundles()).excerpt;
    const spy = vi
      .spyOn(evidence, 'openEvidence')
      .mockRejectedValueOnce(new evidence.EvidenceError([]));
    const { result } = await runInvestigation(dir, {
      provider: new FakeProvider([]),
      now: () => 0,
    });
    spy.mockRestore();
    expect(result).toMatchObject({
      outcome: 'failed',
      failure: {
        class: 'invalid_bundle',
        message: 'the evidence changed after validation: 0 issue(s)',
      },
    });
  });

  it('lets unexpected errors through instead of misreporting them', async () => {
    const dir = (await bundles()).excerpt;
    const spy = vi.spyOn(evidence, 'openEvidence').mockRejectedValueOnce(new Error('disk on fire'));
    await expect(runInvestigation(dir, { provider: new FakeProvider([]) })).rejects.toThrow(
      'disk on fire',
    );
    spy.mockRestore();
  });

  it('passes a cancellation signal through to the investigator', async () => {
    const dir = (await bundles()).excerpt;
    const controller = new AbortController();
    controller.abort();
    const { result } = await runInvestigation(dir, {
      provider: new FakeProvider([]),
      now: () => 0,
      signal: controller.signal,
    });
    expect(result.failure?.class).toBe('cancelled');
  });
});

describe('the fake provider', () => {
  it('fails loudly when a test scripts too few steps', async () => {
    const provider = new FakeProvider([]);
    await expect(
      provider.complete(
        { instructions: '', input: '', outputSchema: {}, maxOutputTokens: 1 },
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow('FakeProvider has no scripted step left');
  });

  it('settles a hung call as soon as its signal is already aborted', async () => {
    const provider = new FakeProvider([{ hang: true }]);
    const controller = new AbortController();
    controller.abort();
    await expect(
      provider.complete(
        { instructions: '', input: '', outputSchema: {}, maxOutputTokens: 1 },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ kind: 'timeout' });
  });
});
