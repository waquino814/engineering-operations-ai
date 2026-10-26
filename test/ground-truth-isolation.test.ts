import { chmod, cp, readdir, readFile, rm } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EvidenceError,
  EXCLUDED_MANIFEST_FIELDS,
  investigatorManifest,
  openEvidence,
  validateBundle,
  type EvidenceView,
} from '../src/index.ts';
import { example, makeBundle } from './support.ts';

/**
 * ADR 0003: investigation code never reads the answer file, and the evidence view carries nothing
 * that identifies the scenario or the fault window.
 */
type Json = Record<string, unknown>;
const ANSWER = 'ground_truth.json';
const exampleManifest = async () =>
  JSON.parse((await example('manifest.json')).toString('utf8')) as Json;
const scenarioName = async () => ((await exampleManifest()).scenario as { name: string }).name;

function recordingReader() {
  const paths: string[] = [];
  return {
    paths,
    readFile: (path: string) => {
      paths.push(path);
      return readFile(path);
    },
  };
}

/** Every key path in a value, arrays collapsed to `[]`, for comparing shapes. */
function keyPaths(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value))
    return value.length ? keyPaths(value[0], `${prefix}[]`) : [`${prefix}[]`];
  if (typeof value !== 'object' || value === null) return [prefix];
  return Object.entries(value).flatMap(([k, v]) => keyPaths(v, prefix ? `${prefix}.${k}` : k));
}

describe('the investigator never reads the answer file', () => {
  it('opens only the manifest and telemetry, while contract validation reads all five', async () => {
    const dir = await makeBundle();
    const evidence = recordingReader();
    await openEvidence(dir, evidence);
    expect(evidence.paths.map((p) => relative(dir, p))).toEqual([
      'manifest.json',
      'traces.jsonl',
      'metrics.jsonl',
      'logs.jsonl',
    ]);
    const validation = recordingReader();
    await validateBundle(dir, validation);
    expect(validation.paths.some((p) => p.endsWith(ANSWER))).toBe(true);
  });

  it('opens a bundle whose answer file is absent or unreadable', async () => {
    const absent = await makeBundle();
    await rm(join(absent, ANSWER));
    await expect(openEvidence(absent)).resolves.toHaveProperty('caseId');
    const unreadable = await makeBundle();
    await chmod(join(unreadable, ANSWER), 0o000);
    await expect(openEvidence(unreadable)).resolves.toHaveProperty('caseId');
  });
});

describe('the evidence view is strictly blinded', () => {
  it('exposes exactly the allowlisted manifest fields', async () => {
    const view = await openEvidence(await makeBundle());
    expect(Object.keys(view).sort()).toEqual(['caseId', 'files', 'manifest']);
    expect(keyPaths(view.manifest).sort()).toEqual(
      [
        'capture.logs.services[].name',
        'capture.logs.services[].nonJsonLines',
        'capture.metrics.stepSeconds',
        'capture.traces.services[].name',
        'capture.traces.services[].saturatedSlices',
        'capture.traces.services[].truncated',
        'capture.traces.services[].truncationReasons[]',
        'files.logs.jsonl.bytes',
        'files.logs.jsonl.records',
        'files.logs.jsonl.sha256',
        'files.metrics.jsonl.bytes',
        'files.metrics.jsonl.records',
        'files.metrics.jsonl.sha256',
        'files.traces.jsonl.bytes',
        'files.traces.jsonl.records',
        'files.traces.jsonl.sha256',
        'schemaVersion',
        'services[].instanceId',
        'services[].name',
        'services[].version',
      ].sort(),
    );
  });

  it('builds the same view from the committed example manifest, field by field', async () => {
    const m = await exampleManifest();
    expect(investigatorManifest(m)).toEqual({
      schemaVersion: '1.0.0',
      services: [
        { name: 'orders-api', version: '0.0.0', instanceId: 'a528255144d3' },
        { name: 'worker', version: '0.0.0', instanceId: 'worker-1' },
      ],
      capture: {
        traces: {
          services: [
            { name: 'orders-api', truncated: false, truncationReasons: [], saturatedSlices: 0 },
            { name: 'worker', truncated: false, truncationReasons: [], saturatedSlices: 0 },
          ],
        },
        metrics: { stepSeconds: 5 },
        logs: {
          services: [
            { name: 'orders-api', nonJsonLines: 0 },
            { name: 'worker', nonJsonLines: 0 },
          ],
        },
      },
      files: Object.fromEntries(
        ['traces.jsonl', 'metrics.jsonl', 'logs.jsonl'].map((f) => [f, (m.files as Json)[f]]),
      ),
    });
  });

  it('omits every audited answer-bearing field', async () => {
    const view = await openEvidence(await makeBundle());
    for (const field of [
      'bundleId',
      'scenario',
      'createdAt',
      'window',
      'trigger',
      'detection',
      'producer',
      'infrastructure',
      'load',
    ]) {
      expect(view.manifest, field).not.toHaveProperty(field);
    }
    const capture = view.manifest.capture as unknown as Json;
    const traces = capture.traces as Json;
    expect(Object.keys(traces)).toEqual(['services']);
    for (const s of traces.services as Json[]) {
      expect(s).not.toHaveProperty('traces');
    }
    expect(Object.keys(capture.metrics as Json)).toEqual(['stepSeconds']);
    for (const s of (capture.logs as Json).services as Json[]) {
      expect(s).not.toHaveProperty('records');
      expect(s).not.toHaveProperty('droppedAdminLines');
    }
    expect(Object.keys(view.manifest.files)).toEqual([
      'traces.jsonl',
      'metrics.jsonl',
      'logs.jsonl',
    ]);
    expect(Object.keys(EXCLUDED_MANIFEST_FIELDS)).toEqual(
      expect.arrayContaining(['bundleId', 'scenario', 'window', 'trigger', 'detection', 'load']),
    );
  });

  it('carries none of their values anywhere in the view', async () => {
    const dir = await makeBundle();
    const view = await openEvidence(dir);
    const all = JSON.stringify(view);
    const manifestOnly = JSON.stringify(view.manifest);
    const m = JSON.parse((await readFile(join(dir, 'manifest.json'))).toString('utf8')) as Json;
    const files = m.files as Record<string, { sha256: string }>;
    const at = (o: unknown, k: string) => (o as Json)[k] as string;
    // Distinctive strings must not appear anywhere, telemetry included.
    for (const value of [
      await scenarioName(),
      m.bundleId as string,
      dir,
      dirname(dir),
      files[ANSWER]?.sha256 ?? 'missing',
      at(m.producer, 'commit'),
      at(m.load, 'planHash'),
    ]) {
      expect(all, value).not.toContain(value);
    }
    // Timing and run values must not appear in the manifest view.
    for (const value of [
      at(m.trigger, 'startedAt'),
      at(m.trigger, 'stoppedAt'),
      at(m.detection, 'detectedAt'),
      String((m.detection as Json).latencyMs),
      at(m.window, 'loadStartedAt'),
      at(m.window, 'captureFrom'),
      at(m.window, 'captureTo'),
      at(m, 'createdAt'),
      at(m.load, 'runPrefix'),
    ]) {
      expect(manifestOnly, value).not.toContain(value);
    }
  });

  it('drops fields a later producer adds, at any depth, instead of passing them through', async () => {
    const name = await scenarioName();
    const dir = await makeBundle({
      manifest: (m) => {
        m.scenarioHint = name;
        m.faultWindow = { from: 'x', to: 'y' };
        const traces = (m.capture as Json).traces as Json;
        ((traces.services as Json[])[0] as Json).faultActive = true;
        ((m.services as Json[])[0] as Json).role = `victim of ${name}`;
      },
    });
    expect((await validateBundle(dir)).valid).toBe(true);
    const view = await openEvidence(dir);
    const text = JSON.stringify(view.manifest);
    for (const leaked of ['scenarioHint', 'faultWindow', 'faultActive', 'role', name]) {
      expect(text, leaked).not.toContain(leaked);
    }
  });

  it('does not depend on the directory name: a renamed copy gives the same view', async () => {
    const dir = await makeBundle();
    const copy = join(dirname(dir), 'case-under-investigation');
    await cp(dir, copy, { recursive: true });
    const a: EvidenceView = await openEvidence(dir);
    const b: EvidenceView = await openEvidence(copy);
    expect(b).toEqual(a);
    expect(a.caseId).toMatch(/^[0-9a-f]{16}$/);
  });

  it('reports errors without the scenario name or the path', async () => {
    const dir = await makeBundle({
      after: { 'traces.jsonl': null, 'logs.jsonl': 'x\n' },
      manifest: (m) => ((m.producer as Json).dirty = 'no'),
    });
    const error = await openEvidence(dir).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EvidenceError);
    const text = JSON.stringify((error as EvidenceError).issues) + (error as Error).message;
    expect((error as EvidenceError).issues.map((i) => i.rule)).toEqual([1, 3, 4, 9, 9, 9]);
    expect(text).not.toContain(await scenarioName());
    expect(text).not.toContain(dirname(dir));
  });
});

describe('the evidence view still checks what it reads', () => {
  it('holds the telemetry records with line numbers and checksums', async () => {
    const view = await openEvidence(await makeBundle());
    expect(view.files['traces.jsonl'].entries.map((e) => e.line)).toEqual([1, 2]);
    expect(view.files['metrics.jsonl'].entries.map((e) => e.line)).toEqual([1, 2]);
    expect(view.files['logs.jsonl'].entries.map((e) => e.line)).toEqual([1, 2, 3, 4]);
    expect(view.files['logs.jsonl']).toMatchObject({ records: 4 });
    expect(view.files['logs.jsonl'].sha256).toBe(view.manifest.files['logs.jsonl'].sha256);
  });

  it('re-checks the telemetry instead of trusting an earlier validation', async () => {
    const changed = await makeBundle({ after: { 'logs.jsonl': '{"x":1}\n' } });
    const error = await openEvidence(changed).catch((e: unknown) => e);
    expect((error as EvidenceError).issues.map((i) => [i.rule, i.field])).toEqual([
      [4, 'service'],
      [4, 'time'],
      [4, 'level'],
      [4, 'message'],
      [4, 'attributes'],
      [9, 'files.logs.jsonl.sha256'],
      [9, 'files.logs.jsonl.bytes'],
      [9, 'files.logs.jsonl.records'],
    ]);
    const unsupported = await makeBundle({ manifest: (m) => (m.schemaVersion = '3.1.0') });
    await expect(openEvidence(unsupported)).rejects.toMatchObject({
      issues: [{ rule: 2, field: 'schemaVersion' }],
    });
  });
});

describe('the source tree', () => {
  const root = new URL('../src/', import.meta.url).pathname;
  const sources = async () =>
    Promise.all(
      (await readdir(root, { recursive: true }))
        .filter((f) => f.endsWith('.ts'))
        .map(async (f) => ({ file: f, text: await readFile(join(root, f), 'utf8') })),
    );

  it('names the answer file only in the contract and in contract validation', async () => {
    const mentions = (await sources())
      .filter(({ text }) => /ground_truth|GROUND_TRUTH_FILE|groundTruth/.test(text))
      .map(({ file }) => file);
    expect(mentions.sort()).toEqual(['intake/contract.ts', 'intake/validate-bundle.ts']);
  });

  it('keeps contract validation out of the evidence path', async () => {
    const importers = (await sources())
      .filter(({ text }) => /from '\.\/(intake\/)?validate-bundle\.ts'/.test(text))
      .map(({ file }) => file);
    expect(importers.sort()).toEqual(['cli.ts', 'index.ts']);
  });
});
