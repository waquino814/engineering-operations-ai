import { appendFile, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApplication } from '../../src/app/application.ts';
import { checkCitations, EXCERPT_CHARS } from '../../src/app/evidence.ts';
import { readRunMeta } from '../../src/app/run-store.ts';
import { openEvidence } from '../../src/index.ts';
import type { InvestigationResult } from '../../src/investigation/result.ts';
import { goodOutput, ref } from '../investigation/support.ts';
import { workspace } from './support.ts';

/** Re-checking a saved run's citations against the original bundle, with no model involved. */
async function savedRun() {
  const w = await workspace();
  const view = await openEvidence(w.b.excerpt);
  const app = createApplication(w.env(), { fakeSteps: [{ reply: goodOutput(view) }] });
  const out = await app.startInvestigation(w.excerptId);
  if (out.status !== 'done') throw new Error('expected a saved run');
  const file = join(w.runsDir, `${out.runId}.json`);
  /** Rewrites the stored result, as a damaged or old run might look. */
  const edit = async (change: (r: InvestigationResult) => void) => {
    const r = JSON.parse(await readFile(file, 'utf8')) as InvestigationResult;
    change(r);
    await writeFile(file, JSON.stringify(r));
  };
  return { w, app, out, edit, file, bundle: w.b.excerpt };
}
const report = async (app: ReturnType<typeof createApplication>, id: string) => {
  const r = await app.getEvidence(id);
  if (r.status !== 'ok') throw new Error(r.reason);
  return r.report;
};

describe('citation re-check', () => {
  it('verifies every citation of an untouched bundle and returns the cited text', async () => {
    const { app, out, bundle } = await savedRun();
    const r = await report(app, out.runId);
    expect(r.status).toBe('checked');
    if (r.status !== 'checked') return;
    expect(r.citations).toHaveLength(2);
    for (const c of r.citations) {
      expect(c).toMatchObject({ findingId: 'F1', status: 'verified', issues: [] });
      const line = (await readFile(join(bundle, c.file), 'utf8')).split('\n')[c.line - 1] ?? '';
      expect(c.excerpt).toBe(line.slice(0, EXCERPT_CHARS));
    }
  });

  it('does not run a model, and reading the answer key is impossible by construction', async () => {
    const { app, out } = await savedRun();
    // A scripted provider with nothing left would throw if asked anything.
    await expect(report(app, out.runId)).resolves.toMatchObject({ status: 'checked' });
    const source = await readFile(new URL('../../src/app/evidence.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/ground_truth|GROUND_TRUTH|readAnswerKey/);
  });

  it('marks a long record as truncated and keeps the start of it', async () => {
    const { app, out, edit, bundle } = await savedRun();
    const view = await openEvidence(bundle);
    const trace = ref(view, 'traces.jsonl', 1);
    await edit((r) => {
      const f = r.findings[0];
      if (f) f.evidence = [trace];
    });
    const r = await report(app, out.runId);
    if (r.status !== 'checked') throw new Error('checked');
    expect(r.citations[0]).toMatchObject({
      file: 'traces.jsonl',
      status: 'verified',
      truncated: true,
    });
    expect(r.citations[0]?.excerpt).toHaveLength(EXCERPT_CHARS);
  });

  it('reports a bundle file that changed since the run, and shows no text from it', async () => {
    const { app, out, bundle } = await savedRun();
    await appendFile(join(bundle, 'logs.jsonl'), '\n');
    const r = await report(app, out.runId);
    if (r.status !== 'checked') throw new Error('checked');
    const logs = r.citations.filter((c) => c.file === 'logs.jsonl');
    expect(logs[0]).toMatchObject({ status: 'file_changed', excerpt: null });
    expect(logs[0]?.issues[0]).toContain('no longer matches');
    // The other file is untouched and still verifies.
    expect(r.citations.find((c) => c.file === 'metrics.jsonl')?.status).toBe('verified');
  });

  it('reports a missing line, a mismatched identity and an unreadable file', async () => {
    const { app, out, edit, bundle } = await savedRun();
    await edit((r) => {
      const [a, b] = r.findings[0]?.evidence ?? [];
      if (a) a.line = 9_999;
      if (b?.series) b.series.name = 'some_other_series';
    });
    let r = await report(app, out.runId);
    if (r.status !== 'checked') throw new Error('checked');
    expect(r.citations.map((c) => c.status)).toEqual(['line_missing', 'identity_mismatch']);
    expect(r.citations[1]?.issues[0]).toContain('some_other_series');
    expect(r.citations[0]?.excerpt).toBeNull();
    await unlink(join(bundle, 'metrics.jsonl'));
    r = await report(app, out.runId);
    if (r.status !== 'checked') throw new Error('checked');
    expect(r.citations[1]).toMatchObject({ status: 'unreadable', excerpt: null });
  });

  it('says why nothing can be re-checked: no bundle recorded, bundle gone, not admitted', async () => {
    const { app, out, w } = await savedRun();
    expect(await readRunMeta(w.runsDir, out.runId)).toEqual({ bundleId: w.excerptId });
    await unlink(join(w.runsDir, `${out.runId}.meta.json`));
    expect(await report(app, out.runId)).toEqual({
      status: 'unavailable',
      reason: 'no_bundle_recorded',
    });

    const second = await savedRun();
    await rm(second.bundle, { recursive: true });
    expect(await report(second.app, second.out.runId)).toEqual({
      status: 'unavailable',
      reason: 'bundle_not_found',
    });

    const bad = await second.app.startInvestigation(second.w.tamperedId);
    if (bad.status !== 'done') throw new Error('expected a stored run');
    expect(bad.result.bundle).toBeNull();
    expect(await report(second.app, bad.runId)).toEqual({
      status: 'unavailable',
      reason: 'not_admitted',
    });
  });

  it('never opens a file that is not telemetry, even if a damaged result names one', async () => {
    const { out, bundle } = await savedRun();
    const forged = structuredClone(out.result);
    const first = forged.findings[0];
    if (first?.evidence[0]) first.evidence[0].file = 'ground_truth.json';
    await expect(checkCitations(bundle, forged)).rejects.toThrow('not telemetry');
  });

  it('refuses unknown and invalid run ids and ignores a damaged sidecar', async () => {
    const { app, out, w } = await savedRun();
    expect(await app.getEvidence('../x')).toEqual({ status: 'error', reason: 'invalid_run_id' });
    expect(await app.getEvidence('20261027T000000Z-nocase')).toEqual({
      status: 'error',
      reason: 'run_not_found',
    });
    await writeFile(
      join(w.runsDir, `${out.runId}.meta.json`),
      '{"version":1,"bundleId":"x","extra":1}',
    );
    expect(await readRunMeta(w.runsDir, out.runId)).toBeNull();
    await writeFile(join(w.runsDir, `${out.runId}.meta.json`), 'not json');
    expect(await readRunMeta(w.runsDir, out.runId)).toBeNull();
    expect(await readRunMeta(w.runsDir, '../x')).toBeNull();
    expect(await report(app, out.runId)).toEqual({
      status: 'unavailable',
      reason: 'no_bundle_recorded',
    });
    // The sidecar never shows up as a run.
    expect((await app.listRuns()).map((r) => r.id)).toEqual([out.runId]);
  });
});
