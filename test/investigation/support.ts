import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { writeSyntheticBundles, type SyntheticBundles } from '../../src/evaluation/synthetic.ts';
import {
  openEvidence,
  shownKey,
  TELEMETRY_FILES,
  type EvidenceView,
  type ShownRecords,
} from '../../src/index.ts';
import type { EvidenceReference, ModelOutput } from '../../src/investigation/result.ts';

/** Evidence views over the synthetic bundles (src/evaluation/synthetic.ts), in temp directories. */
const roots: string[] = [];
afterEach(async () => {
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});

export async function bundles(): Promise<SyntheticBundles> {
  const root = await mkdtemp(join(tmpdir(), 'eoai-inv-'));
  roots.push(root);
  return writeSyntheticBundles(root);
}

export async function excerptView(): Promise<EvidenceView> {
  return openEvidence((await bundles()).excerpt);
}

export async function fabricatedView(): Promise<EvidenceView> {
  return openEvidence((await bundles()).fabricated);
}

type Json = Record<string, unknown>;

/** Every admitted record, as if all were sent to the model. */
export function allShown(view: EvidenceView): ShownRecords {
  return new Set(
    TELEMETRY_FILES.flatMap((f) => view.files[f].entries.map((e) => shownKey(f, e.line))),
  );
}

/** A reference to the record at `line`, quoting its identifiers exactly. */
export function ref(
  view: EvidenceView,
  file: 'traces.jsonl' | 'metrics.jsonl' | 'logs.jsonl',
  line: number,
): EvidenceReference {
  const r = view.files[file].entries.find((e) => e.line === line)?.value as Json;
  if (file === 'metrics.jsonl')
    return {
      file,
      line,
      series: { name: r.name as string, labels: r.labels as Record<string, string> },
    };
  if (file === 'logs.jsonl')
    return { file, line, time: r.time as string, service: r.service as string };
  const span = (
    ((r.resourceSpans as Json[])[0]?.scopeSpans as Json[])[0]?.spans as Json[]
  )[0] as Json;
  return { file, line, traceId: span.traceId as string };
}

/** A valid model output for `view`, citing logs line 1 and metrics line 1. */
export function goodOutput(view: EvidenceView, overrides: Partial<ModelOutput> = {}): ModelOutput {
  return {
    schemaVersion: '0.1.0',
    outcome: 'completed',
    findings: [
      {
        id: 'F1',
        kind: 'root_cause',
        statement: 'A component fails.',
        components: ['worker'],
        confidence: 'medium',
        rationale: 'The cited records show it.',
        evidence: [ref(view, 'logs.jsonl', 1), ref(view, 'metrics.jsonl', 1)],
      },
    ],
    remediation: [{ step: 'Fix the component.', addresses: ['F1'] }],
    limitations: [],
    ...overrides,
  };
}
