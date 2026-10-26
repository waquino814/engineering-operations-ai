import { describe, expect, it } from 'vitest';
import { verifyEvidence, type EvidenceView, type ModelOutput } from '../../src/index.ts';
import type { EvidenceReference } from '../../src/investigation/result.ts';
import { allShown, excerptView, fabricatedView, goodOutput, ref } from './support.ts';

/** ADR 0007: every reference is resolved against the admitted evidence, never trusted. */
const withEvidence = (view: EvidenceView, evidence: EvidenceReference[]): ModelOutput => {
  const base = goodOutput(view);
  return {
    ...base,
    findings: [{ ...(base.findings[0] as ModelOutput['findings'][number]), evidence }],
  };
};
const codes = (view: EvidenceView, output: ModelOutput) =>
  verifyEvidence(output, view, allShown(view)).issues.map((i) => [i.code, i.field]);

describe('evidence verification', () => {
  it('accepts references that resolve, with matching samples, spans and checksums', async () => {
    const view = await excerptView();
    const metric = ref(view, 'metrics.jsonl', 1);
    const sample = (
      view.files['metrics.jsonl'].entries[0]?.value as { samples: [number, string][] }
    ).samples[0] as [number, string];
    const trace = ref(view, 'traces.jsonl', 2);
    const firstSpan = JSON.stringify(view.files['traces.jsonl'].entries[1]?.value).match(
      /"spanId":"([0-9a-f]{16})"/,
    )?.[1];
    const output = withEvidence(view, [
      { ...metric, samples: [sample], sha256: view.files['metrics.jsonl'].sha256 },
      { ...trace, spanId: firstSpan as string },
      ref(view, 'logs.jsonl', 4),
    ]);
    expect(verifyEvidence(output, view, allShown(view))).toEqual({ issues: [], limitations: [] });
  });

  it('rejects the answer file and other files outside the admitted telemetry', async () => {
    const view = await excerptView();
    const output = withEvidence(view, [
      { file: 'ground_truth.json', line: 1 },
      { file: 'manifest.json', line: 1 },
      { file: 'traces.json', line: 1 },
    ]);
    expect(codes(view, output)).toEqual([
      ['unknown_file', 'findings.0.evidence.0.file'],
      ['unknown_file', 'findings.0.evidence.1.file'],
      ['unknown_file', 'findings.0.evidence.2.file'],
    ]);
  });

  it('rejects paths, including ones that would escape the bundle', async () => {
    const view = await excerptView();
    const output = withEvidence(view, [
      { file: '../ground_truth.json', line: 1 },
      { file: '/etc/passwd', line: 1 },
      { file: 'logs.jsonl/../logs.jsonl', line: 1 },
      { file: '..\\logs.jsonl', line: 1 },
    ]);
    expect(codes(view, output).map(([c]) => c)).toEqual(Array(4).fill('path_outside_bundle'));
  });

  it('rejects lines beyond the file, and lines that are not admitted records', async () => {
    const view = await excerptView();
    expect(codes(view, withEvidence(view, [{ ...ref(view, 'logs.jsonl', 1), line: 5 }]))).toEqual([
      ['line_out_of_range', 'findings.0.evidence.0.line'],
    ]);
    // A view whose file holds a line that was not admitted, as a malformed record would be.
    const partial: EvidenceView = {
      ...view,
      files: {
        ...view.files,
        'logs.jsonl': {
          ...view.files['logs.jsonl'],
          entries: view.files['logs.jsonl'].entries.filter((e) => e.line !== 2),
        },
      },
    };
    expect(codes(partial, withEvidence(view, [ref(view, 'logs.jsonl', 2)]))).toEqual([
      ['record_not_admitted', 'findings.0.evidence.0.line'],
    ]);
  });

  it('rejects a checksum that does not match the admitted file', async () => {
    const view = await excerptView();
    const output = withEvidence(view, [{ ...ref(view, 'logs.jsonl', 1), sha256: '0'.repeat(64) }]);
    expect(verifyEvidence(output, view, allShown(view)).issues).toEqual([
      {
        code: 'checksum_mismatch',
        field: 'findings.0.evidence.0.sha256',
        message: `logs.jsonl has SHA-256 ${view.files['logs.jsonl'].sha256}`,
      },
    ]);
  });

  it('requires each file’s identifiers, and rejects identifiers that do not apply', async () => {
    const view = await excerptView();
    const output = withEvidence(view, [
      { file: 'metrics.jsonl', line: 1 },
      { file: 'logs.jsonl', line: 1, time: ref(view, 'logs.jsonl', 1).time as string },
      { file: 'traces.jsonl', line: 1 },
      { ...ref(view, 'logs.jsonl', 2), traceId: 'a'.repeat(32) },
    ]);
    expect(codes(view, output)).toEqual([
      ['missing_identity', 'findings.0.evidence.0.series'],
      ['missing_identity', 'findings.0.evidence.1'],
      ['missing_identity', 'findings.0.evidence.2.traceId'],
      ['inapplicable_field', 'findings.0.evidence.3.traceId'],
    ]);
  });

  it('rejects identifiers that do not match the record at that line', async () => {
    const view = await excerptView();
    const metric = ref(view, 'metrics.jsonl', 1);
    const log = ref(view, 'logs.jsonl', 1);
    const output = withEvidence(view, [
      { ...metric, series: { name: 'other_metric', labels: metric.series?.labels ?? {} } },
      {
        ...ref(view, 'metrics.jsonl', 2),
        series: {
          name: ref(view, 'metrics.jsonl', 2).series?.name ?? '',
          labels: { job: 'worker' },
        },
      },
      { ...log, time: '2026-01-01T00:00:00.000Z', service: 'nope' },
      { ...ref(view, 'traces.jsonl', 1), traceId: 'f'.repeat(32) },
    ]);
    expect(codes(view, output)).toEqual([
      ['identity_mismatch', 'findings.0.evidence.0.series.name'],
      ['identity_mismatch', 'findings.0.evidence.1.series.labels'],
      ['identity_mismatch', 'findings.0.evidence.2.time'],
      ['identity_mismatch', 'findings.0.evidence.2.service'],
      ['identity_mismatch', 'findings.0.evidence.3.traceId'],
    ]);
  });

  it('catches the right identifiers cited at the wrong line', async () => {
    const view = await excerptView();
    const output = withEvidence(view, [
      { ...ref(view, 'traces.jsonl', 2), line: 1 },
      { ...ref(view, 'logs.jsonl', 3), line: 2 },
      { ...ref(view, 'metrics.jsonl', 2), line: 1 },
    ]);
    expect(codes(view, output)).toEqual([
      ['identity_mismatch', 'findings.0.evidence.0.traceId'],
      ['identity_mismatch', 'findings.0.evidence.1.time'],
      ['identity_mismatch', 'findings.0.evidence.2.series.labels'],
    ]);
  });

  it('rejects samples and spans that are not in the record', async () => {
    const view = await excerptView();
    const output = withEvidence(view, [
      { ...ref(view, 'metrics.jsonl', 1), samples: [[1, '1']] },
      { ...ref(view, 'traces.jsonl', 1), spanId: 'e'.repeat(16) },
    ]);
    expect(codes(view, output)).toEqual([
      ['sample_not_found', 'findings.0.evidence.0.samples.0'],
      ['span_not_found', 'findings.0.evidence.1.spanId'],
    ]);
  });

  it('rejects duplicate references, duplicate finding ids and unknown remediation targets', async () => {
    const view = await excerptView();
    const base = goodOutput(view);
    const f = base.findings[0] as ModelOutput['findings'][number];
    const output: ModelOutput = {
      ...base,
      findings: [
        { ...f, evidence: [ref(view, 'logs.jsonl', 1), ref(view, 'logs.jsonl', 1)] },
        { ...f },
      ],
      remediation: [{ step: 'Do something.', addresses: ['F1', 'F9'] }],
    };
    expect(codes(view, output)).toEqual([
      ['duplicate_reference', 'findings.0.evidence.1'],
      ['duplicate_finding_id', 'findings.1.id'],
      ['unknown_finding_reference', 'remediation.0.addresses.1'],
    ]);
  });

  it('rejects a record that exists but was not in the evidence given to the model', async () => {
    const view = await excerptView();
    const shown = new Set([...allShown(view)].filter((k) => k !== 'logs.jsonl:1'));
    const output = withEvidence(view, [ref(view, 'logs.jsonl', 1), ref(view, 'metrics.jsonl', 1)]);
    expect(verifyEvidence(output, view, shown).issues).toEqual([
      {
        code: 'record_not_shown',
        field: 'findings.0.evidence.0.line',
        message:
          'logs.jsonl line 1 was not in the evidence given; cite only records from the input',
      },
    ]);
    // Nothing shown: nothing can be cited, however real the records are.
    expect(verifyEvidence(output, view, new Set()).issues.map((i) => i.code)).toEqual([
      'record_not_shown',
      'record_not_shown',
    ]);
  });

  it('refuses an empty "completed" investigation and an unexplained "inconclusive" one', async () => {
    const view = await excerptView();
    expect(codes(view, goodOutput(view, { findings: [], remediation: [] }))).toEqual([
      ['completed_without_findings', 'findings'],
    ]);
    expect(
      codes(view, goodOutput(view, { outcome: 'inconclusive', findings: [], remediation: [] })),
    ).toEqual([['inconclusive_without_limitations', 'limitations']]);
  });

  it('adds a limitation when cited traces come from a truncated capture', async () => {
    const view = await fabricatedView();
    const truncatedView: EvidenceView = {
      ...view,
      manifest: {
        ...view.manifest,
        capture: {
          ...view.manifest.capture,
          traces: {
            services: view.manifest.capture.traces.services.map((s) => ({
              ...s,
              truncated: true,
              truncationReasons: ['service_cap'],
            })),
          },
        },
      },
    };
    const output = withEvidence(truncatedView, [ref(view, 'traces.jsonl', 1)]);
    expect(verifyEvidence(output, truncatedView, allShown(truncatedView))).toEqual({
      issues: [],
      limitations: [
        'Trace capture for orders-api was truncated; other relevant traces may be missing.',
      ],
    });
  });
});
