import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { selectEvidence, type EvidenceView } from '../../src/index.ts';
import { excerptView, fabricatedView } from './support.ts';

const roomy = { maxRecords: 100, maxBytes: 1_000_000, maxRecordBytes: 1_000_000 };
const at = (s: ReturnType<typeof selectEvidence>) =>
  s.records.map((r) => `${r.file}:${String(r.line)}`);

describe('evidence selection', () => {
  it('ranks generic error signals first and keeps original lines and values', async () => {
    const view = await fabricatedView();
    const selection = selectEvidence(view, { ...roomy, maxRecords: 4 });
    // Error logs, the changing error series and the error trace outrank everything else.
    expect(at(selection).sort()).toEqual(
      ['logs.jsonl:4', 'logs.jsonl:5', 'metrics.jsonl:1', 'traces.jsonl:1'].sort(),
    );
    for (const r of selection.records) {
      expect(r.value).toEqual(view.files[r.file].entries.find((e) => e.line === r.line)?.value);
      expect(r.bytes).toBe(Buffer.byteLength(JSON.stringify(r.value)));
    }
    expect(selection.records.find((r) => r.file === 'metrics.jsonl')?.reasons).toEqual([
      'error-like label value',
      'series changes',
    ]);
    expect(selection.records.find((r) => r.file === 'logs.jsonl')?.reasons).toEqual([
      'log level error',
    ]);
  });

  it('returns records in file, then line order, and the same selection every time', async () => {
    const view = await fabricatedView();
    const a = selectEvidence(view, roomy);
    const b = selectEvidence(view, roomy);
    expect(b).toEqual(a);
    const order = ['logs.jsonl', 'metrics.jsonl', 'traces.jsonl'];
    const keys = a.records.map((r) => [order.indexOf(r.file), r.line] as const);
    expect(keys).toEqual([...keys].sort((x, y) => x[0] - y[0] || x[1] - y[1]));
  });

  it('collapses repeated records to their first and last occurrence, and counts the rest', async () => {
    const view = await fabricatedView();
    const selection = selectEvidence(view, roomy);
    // "request completed" appears on lines 1 to 3; line 2 is the repeat.
    expect(at(selection)).not.toContain('logs.jsonl:2');
    expect(selection.summary.files['logs.jsonl'].omitted.repeated).toBe(1);
    expect(
      selection.records.find((r) => r.line === 1 && r.file === 'logs.jsonl')?.reasons,
    ).toContain('3 similar records');
  });

  it('honours the record, byte and per-record limits, and accounts for every record', async () => {
    const view = await fabricatedView();
    const byRecords = selectEvidence(view, { ...roomy, maxRecords: 2 });
    expect(byRecords.records).toHaveLength(2);
    const smallest = Math.min(...byRecords.records.map((r) => r.bytes));
    const byBytes = selectEvidence(view, { ...roomy, maxBytes: smallest });
    expect(byBytes.records).toHaveLength(1);
    expect(byBytes.summary.selectedBytes).toBeLessThanOrEqual(smallest);
    const tooLarge = selectEvidence(view, { ...roomy, maxRecordBytes: 100 });
    expect(tooLarge.records.every((r) => r.bytes <= 100)).toBe(true);
    for (const s of [byRecords, byBytes, tooLarge]) {
      for (const [file, f] of Object.entries(s.summary.files)) {
        const omitted = Object.values(f.omitted).reduce((n, x) => n + x, 0);
        expect(f.selected + omitted, file).toBe(f.records);
      }
    }
    expect(tooLarge.summary.files['traces.jsonl'].omitted.record_too_large).toBe(2);
    expect(byRecords.summary.files['logs.jsonl'].omitted.record_limit).toBeGreaterThan(0);
    expect(byBytes.summary.files['metrics.jsonl'].omitted.context_limit).toBeGreaterThan(0);
  });

  it('never alters the admitted evidence', async () => {
    const view = await excerptView();
    const before = structuredClone(view);
    selectEvidence(view, { ...roomy, maxRecords: 1 });
    expect(view).toEqual(before);
  });

  it('notes empty files and truncated trace capture', async () => {
    const view = await fabricatedView();
    const empty: EvidenceView = {
      ...view,
      files: {
        ...view.files,
        'logs.jsonl': { ...view.files['logs.jsonl'], entries: [], records: 0 },
      },
      manifest: {
        ...view.manifest,
        capture: {
          ...view.manifest.capture,
          traces: {
            services: [
              {
                name: 'orders-api',
                truncated: true,
                truncationReasons: ['slice_saturated'],
                saturatedSlices: 3,
              },
            ],
          },
        },
      },
    };
    const s = selectEvidence(empty, roomy);
    expect(s.summary.emptyFiles).toEqual(['logs.jsonl']);
    expect(s.summary.truncatedTraceServices).toEqual(['orders-api']);
    expect(s.summary.notes).toEqual([
      'logs.jsonl has no records.',
      'Trace capture for orders-api was truncated (slice_saturated).',
    ]);
  });

  it('copes with records of unexpected shape without failing', async () => {
    const view = await fabricatedView();
    const odd: EvidenceView = {
      ...view,
      files: {
        'logs.jsonl': {
          ...view.files['logs.jsonl'],
          entries: [
            { line: 1, value: 'not an object' },
            { line: 2, value: { level: 7 } },
          ],
        },
        'metrics.jsonl': {
          ...view.files['metrics.jsonl'],
          entries: [{ line: 1, value: { name: 'm', labels: null, samples: 'x' } }],
        },
        'traces.jsonl': {
          ...view.files['traces.jsonl'],
          entries: [
            { line: 1, value: { resourceSpans: [null, { scopeSpans: [{ spans: [1] }] }] } },
          ],
        },
      },
    };
    const s = selectEvidence(odd, roomy);
    expect(at(s)).toEqual(['logs.jsonl:1', 'logs.jsonl:2', 'metrics.jsonl:1', 'traces.jsonl:1']);
    expect(s.records.find((r) => r.file === 'metrics.jsonl')?.reasons).toEqual([
      'no numeric samples',
    ]);
  });
});

describe('the investigation code is scenario-agnostic', () => {
  it('names no scenario, scenario-specific component or fault timing', async () => {
    const root = new URL('../../src/investigation/', import.meta.url).pathname;
    const files = (await readdir(root)).filter((f) => f.endsWith('.ts'));
    const forbidden = [
      /bad-deploy|payment-timeouts|provider-outage|api-pool-exhaustion|poison-order/,
      /payment-provider|orders-api-pool|lookup_or_void|claims_recovered/,
      /triggerOffset|30_?000|loadStartedAt|captureFrom/,
    ];
    for (const f of files) {
      const text = await readFile(join(root, f), 'utf8');
      for (const pattern of forbidden) expect(text, `${f} ${String(pattern)}`).not.toMatch(pattern);
    }
  });
});
