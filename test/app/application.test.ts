import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApplication } from '../../src/app/application.ts';
import { saveRun } from '../../src/app/run-store.ts';
import { FakeProvider } from '../../src/investigation/fake-provider.ts';
import { ProviderError } from '../../src/investigation/provider.ts';
import { readInvestigationResult } from '../../src/investigation/result.ts';
import { fetchSpy, tempDir, workspace } from './support.ts';

describe('the application', () => {
  it('investigates a valid bundle, stores the validated result and reads it back', async () => {
    const w = await workspace();
    const app = createApplication(w.env(), {
      fakeSteps: w.steps,
      now: () => Date.UTC(2026, 9, 27, 12, 30),
    });
    const out = await app.startInvestigation(w.excerptId);
    expect(out.status).toBe('done');
    if (out.status !== 'done') return;
    expect(out.result.outcome).toBe('completed');
    expect(out.runId).toMatch(/^20261027T123000Z-[0-9a-f]{16}$/);
    expect(readInvestigationResult(out.result).ok).toBe(true);
    const got = await app.getRun(out.runId);
    expect(got).toEqual({ ok: true, result: out.result });
    const listed = await app.listRuns();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: out.runId, ok: true, summary: { outcome: 'completed' } });
    // A stored run names neither the bundle directory nor the scenario.
    const raw = await readFile(join(w.runsDir, `${out.runId}.json`), 'utf8');
    expect(raw).not.toContain(w.bundlesDir);
    expect(raw).not.toContain(w.excerptId);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('keeps the investigator’s semantics: an inconclusive reply stays inconclusive', async () => {
    const w = await workspace();
    const reply = {
      schemaVersion: '0.1.0',
      outcome: 'inconclusive',
      findings: [],
      remediation: [],
      limitations: ['not enough evidence'],
    };
    const app = createApplication(w.env(), { fakeSteps: [{ reply }] });
    const out = await app.startInvestigation(w.excerptId);
    expect(out).toMatchObject({ status: 'done', result: { outcome: 'inconclusive' } });
  });

  it('stores a provider failure as a failed result, with the model calls counted', async () => {
    const w = await workspace();
    const down = () => ({ error: new ProviderError('unavailable', 'down') });
    const app = createApplication(w.env(), {
      fakeSteps: [down(), down(), down()],
      sleep: () => Promise.resolve(),
    });
    const out = await app.startInvestigation(w.excerptId);
    expect(out).toMatchObject({ status: 'done', result: { outcome: 'failed' } });
    expect((await app.listRuns())[0]).toMatchObject({ ok: true, summary: { outcome: 'failed' } });
  });

  it('never calls the provider for an invalid bundle', async () => {
    const w = await workspace();
    const fake = new FakeProvider(w.steps);
    const app = createApplication(w.env(), { fakeProvider: fake });
    const out = await app.startInvestigation(w.tamperedId);
    expect(out).toMatchObject({
      status: 'done',
      result: { outcome: 'failed', failure: { class: 'invalid_bundle' } },
    });
    expect(fake.requests).toHaveLength(0);
    expect(fake.remaining).toBe(1);
  });

  it('rejects bundle ids that could leave the bundles root, before any provider call', async () => {
    const w = await workspace();
    const outside = await tempDir();
    await symlink(outside, join(w.bundlesDir, 'link-out'));
    await writeFile(join(w.bundlesDir, 'afile'), 'x');
    const fake = new FakeProvider(w.steps);
    const app = createApplication(w.env(), { fakeProvider: fake });
    for (const id of ['..', '../x', 'a/b', '.hidden', '', '/etc', 'x\0y'])
      expect(await app.startInvestigation(id)).toEqual({
        status: 'error',
        reason: 'invalid_bundle_id',
      });
    for (const id of ['link-out', 'afile', 'missing'])
      expect(await app.startInvestigation(id)).toEqual({
        status: 'error',
        reason: 'bundle_not_found',
      });
    expect(fake.requests).toHaveLength(0);
  });

  it('lists bundle directories only, and validates one for the operator', async () => {
    const w = await workspace();
    await writeFile(join(w.bundlesDir, 'afile'), 'x');
    const app = createApplication(w.env());
    const ids = await app.listBundles();
    expect(ids).toContain(w.excerptId);
    expect(ids).not.toContain('afile');
    const ok = await app.validateBundle(w.excerptId);
    expect(ok).toMatchObject({ status: 'checked', report: { valid: true } });
    expect(await app.validateBundle(w.tamperedId)).toMatchObject({
      status: 'checked',
      report: { valid: false },
    });
    expect(await app.validateBundle('../x')).toEqual({
      status: 'error',
      reason: 'invalid_bundle_id',
    });
    expect(
      await createApplication(w.env({ EOAI_BUNDLES_DIR: join(w.runsDir, 'none') })).listBundles(),
    ).toEqual([]);
  });

  it('reports a damaged or missing run instead of repairing or inventing it', async () => {
    const w = await workspace();
    const app = createApplication(w.env(), { fakeSteps: w.steps });
    await mkdir(w.runsDir, { recursive: true });
    await writeFile(join(w.runsDir, '20261027T000000Z-nocase.json'), '{"schemaVersion":"9"}');
    await writeFile(join(w.runsDir, '20261027T000001Z-nocase.json'), 'not json');
    await writeFile(join(w.runsDir, 'notes.txt'), 'ignored');
    const runs = await app.listRuns();
    expect(runs.map((r) => [r.id, r.ok])).toEqual([
      ['20261027T000000Z-nocase', false],
      ['20261027T000001Z-nocase', false],
    ]);
    expect(await app.getRun('20261027T000000Z-nocase')).toMatchObject({
      ok: false,
      reason: 'unreadable',
    });
    expect(await app.getRun('20261027T000001Z-nocase')).toMatchObject({
      ok: false,
      reason: 'unreadable',
    });
    expect(await app.getRun('20261027T000009Z-nocase')).toEqual({
      ok: false,
      reason: 'run_not_found',
    });
    for (const id of ['../x', 'a', ''])
      expect(await app.getRun(id)).toEqual({ ok: false, reason: 'invalid_run_id' });
    expect(
      await createApplication(w.env({ EOAI_RUNS_DIR: join(w.runsDir, 'absent') })).listRuns(),
    ).toEqual([]);
  });
});

describe('the run store', () => {
  it('never replaces an existing run and leaves no temporary file', async () => {
    const w = await workspace();
    const app = createApplication(w.env(), { fakeSteps: w.steps });
    const out = await app.startInvestigation(w.excerptId);
    if (out.status !== 'done') throw new Error('expected a run');
    const t = Date.UTC(2026, 9, 27, 1, 2, 3);
    const a = await saveRun(w.runsDir, out.result, t);
    const b = await saveRun(w.runsDir, out.result, t);
    expect(a).not.toBe(b);
    expect(b).toBe(`${a}-1`);
    expect((await readdir(w.runsDir)).filter((n) => n.startsWith('.tmp'))).toEqual([]);
  });

  it('refuses to store a result that fails the contract', async () => {
    const w = await workspace();
    await expect(saveRun(w.runsDir, { schemaVersion: 'x' } as never, 0)).rejects.toThrow(
      /contract/,
    );
  });

  it('does not follow a link or read an oversized file in place of a run', async () => {
    const w = await workspace();
    const app = createApplication(w.env(), { fakeSteps: w.steps });
    const out = await app.startInvestigation(w.excerptId);
    if (out.status !== 'done') throw new Error('expected a run');
    const target = join(w.runsDir, `${out.runId}.json`);
    // A valid result reached through a link is still refused.
    const linked = '20261027T000002Z-nocase';
    await symlink(target, join(w.runsDir, `${linked}.json`));
    expect(await app.getRun(linked)).toMatchObject({ ok: false, reason: 'unreadable' });
    const big = '20261027T000003Z-nocase';
    await writeFile(join(w.runsDir, `${big}.json`), ' '.repeat(10_000_001));
    expect(await app.getRun(big)).toMatchObject({ ok: false, reason: 'unreadable' });
    const listed = await app.listRuns();
    expect(listed.filter((r) => r.ok).map((r) => r.id)).toEqual([out.runId]);
    expect(listed).toHaveLength(3);
  });

  it('accepts a bundles root that is itself a link, and still contains ids inside it', async () => {
    const w = await workspace();
    const rootLink = join(await tempDir(), 'root-link');
    await symlink(w.bundlesDir, rootLink);
    const app = createApplication(w.env({ EOAI_BUNDLES_DIR: rootLink }));
    expect(await app.validateBundle(w.excerptId)).toMatchObject({ status: 'checked' });
    expect(await app.validateBundle('..')).toEqual({
      status: 'error',
      reason: 'invalid_bundle_id',
    });
  });
});
