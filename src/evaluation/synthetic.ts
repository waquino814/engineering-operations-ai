import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeProvider, type FakeStep } from '../investigation/fake-provider.ts';
import { ProviderError } from '../investigation/provider.ts';
import type { EvidenceReference, ModelOutput } from '../investigation/result.ts';
import type { EvaluationCase } from './harness.ts';

/**
 * Synthetic evaluation fixtures (ADR 0009). Everything here is synthetic and labelled so:
 *
 * - the excerpt-derived bundle reuses the committed example's genuine manifest, ground truth and
 *   excerpt lines, with checksums recomputed so it is complete and valid;
 * - the fabricated bundle describes a scenario that does not exist in Commerce Platform, with
 *   invented components and telemetry, so tests cannot pass by fitting the real scenarios;
 * - the scripted replies stand in for a model. They are built from the fixture records, so their
 *   identifiers are exact; they prove the pipeline's behaviour, not any model's ability. Some
 *   carry invented usage reports and some none, to exercise both kinds of token accounting.
 *
 * Real bundles are never committed and never used here.
 */
type Json = Record<string, unknown>;

const EXAMPLE_ID = 'provider-outage-42-20261026T122230Z';
const EXAMPLE_DIR = fileURLToPath(new URL(`../../docs/examples/${EXAMPLE_ID}/`, import.meta.url));
export const FABRICATED_ID = 'synthetic-cache-saturation-7-20260101T000000Z';

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const lines = (records: unknown[]) => records.map((r) => `${JSON.stringify(r)}\n`).join('');
const count = (text: string) => (text === '' ? 0 : text.split('\n').length - 1);

async function writeBundle(
  dir: string,
  manifest: Json,
  truth: Json | Uint8Array,
  telemetry: Record<string, string>,
) {
  await mkdir(dir, { recursive: true });
  const truthBytes =
    truth instanceof Uint8Array ? truth : Buffer.from(`${JSON.stringify(truth, null, 2)}\n`);
  const files: Json = {
    'ground_truth.json': { sha256: sha256(truthBytes), bytes: truthBytes.length, records: 1 },
  };
  await writeFile(join(dir, 'ground_truth.json'), truthBytes);
  for (const [name, text] of Object.entries(telemetry)) {
    const bytes = Buffer.from(text);
    files[name] = { sha256: sha256(bytes), bytes: bytes.length, records: count(text) };
    await writeFile(join(dir, name), bytes);
  }
  await writeFile(
    join(dir, 'manifest.json'),
    `${JSON.stringify({ ...manifest, files }, null, 2)}\n`,
  );
}

const example = async (f: string) => readFile(join(EXAMPLE_DIR, f));
const exampleJson = async (f: string) => JSON.parse((await example(f)).toString('utf8')) as Json;

/** The fabricated scenario's telemetry: invented, and free of any scenario name. */
function fabricatedTelemetry(): Record<string, string> {
  const t = (s: number) => `2026-01-01T00:00:${String(s).padStart(2, '0')}.000Z`;
  const log = (s: number, service: string, level: string, message: string) => ({
    service,
    time: t(s),
    level,
    message,
    attributes: {},
  });
  const logs = [
    log(1, 'orders-api', 'info', 'request completed'),
    log(2, 'orders-api', 'info', 'request completed'),
    log(3, 'orders-api', 'info', 'request completed'),
    log(4, 'orders-api', 'error', 'cache request failed: connection slots exhausted'),
    log(5, 'orders-api', 'error', 'cache request failed: connection slots exhausted'),
    log(6, 'worker', 'info', 'pass completed'),
  ];
  const base = 1767225600;
  const series = (name: string, labels: Json, values: string[]) => ({
    name,
    labels,
    samples: values.map((v, i) => [base + i * 5, v]),
  });
  const metrics = [
    series('cache_requests_total', { job: 'orders-api', result: 'error' }, ['0', '0', '4', '9']),
    series('cache_requests_total', { job: 'orders-api', result: 'ok' }, ['50', '50', '50', '50']),
    series('http_server_request_duration_seconds_bucket', { job: 'orders-api', le: '0.5' }, [
      '10',
      '10',
      '10',
      '10',
    ]),
  ];
  const span = (trace: string, name: string, attrs: Json[], status: Json) => ({
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'orders-api' } }] },
        scopeSpans: [
          {
            scope: { name: 'synthetic' },
            spans: [
              {
                traceId: trace,
                spanId: trace.slice(0, 16),
                name,
                startTimeUnixNano: '1767225601000000000',
                endTimeUnixNano: '1767225601250000000',
                attributes: attrs,
                status,
              },
            ],
          },
        ],
      },
    ],
  });
  const traces = [
    span(
      'a'.repeat(32),
      'GET /orders/:id',
      [{ key: 'cache.result', value: { stringValue: 'error' } }],
      { code: 2 },
    ),
    span(
      'b'.repeat(32),
      'GET /orders/:id',
      [{ key: 'cache.result', value: { stringValue: 'hit' } }],
      {},
    ),
  ];
  return {
    'traces.jsonl': lines(traces),
    'metrics.jsonl': lines(metrics),
    'logs.jsonl': lines(logs),
  };
}

export interface SyntheticBundles {
  excerpt: string;
  fabricated: string;
  tampered: string;
}

/** Writes the three synthetic bundles under `root`; nothing else is written. */
export async function writeSyntheticBundles(root: string): Promise<SyntheticBundles> {
  const manifest = await exampleJson('manifest.json');
  const excerpt = join(root, EXAMPLE_ID);
  const telemetry = {
    'traces.jsonl': (await example('traces.excerpt.jsonl')).toString('utf8'),
    'metrics.jsonl': (await example('metrics.excerpt.jsonl')).toString('utf8'),
    'logs.jsonl': (await example('logs.excerpt.jsonl')).toString('utf8'),
  };
  await writeBundle(
    excerpt,
    { ...manifest, bundleId: EXAMPLE_ID },
    await example('ground_truth.json'),
    telemetry,
  );

  const truth = await exampleJson('ground_truth.json');
  const scenario = { name: 'synthetic-cache-saturation', version: 1, seed: 7 };
  const fabricated = join(root, FABRICATED_ID);
  await writeBundle(
    fabricated,
    {
      ...manifest,
      bundleId: FABRICATED_ID,
      scenario,
      load: { ...(manifest.load as Json), seed: 7 },
    },
    {
      ...truth,
      scenario,
      description:
        'Synthetic fixture: the cache tier runs out of connection slots and fails reads.',
      rootCause: {
        component: 'cache-node',
        summary: 'Synthetic fixture: the cache node exhausts its connection slots.',
      },
      affectedComponents: ['cache-node', 'orders-api'],
      faultParameters: { synthetic: true },
      primarySymptom: {
        ...(truth.primarySymptom as Json),
        metric: 'cache_requests_total',
        matchers: { job: 'orders-api', result: 'error' },
        description: 'Synthetic cache errors rise.',
      },
      secondarySymptoms: [],
      dataEffects: ['Synthetic fixture; no data effects.'],
      expectedRemediation: ['Synthetic fixture: restore cache capacity.'],
    },
    fabricatedTelemetry(),
  );

  const tampered = join(root, 'tampered-42-20260101T000000Z');
  await writeBundle(
    tampered,
    { ...manifest, bundleId: 'tampered-42-20260101T000000Z' },
    await example('ground_truth.json'),
    telemetry,
  );
  await writeFile(join(tampered, 'logs.jsonl'), 'tampered\n');
  return { excerpt, fabricated, tampered };
}

/** Builds a reference to a fixture record from the record itself. */
async function cite(
  dir: string,
  file: 'traces.jsonl' | 'metrics.jsonl' | 'logs.jsonl',
  line: number,
): Promise<EvidenceReference> {
  const text = (await readFile(join(dir, file), 'utf8')).split('\n')[line - 1] ?? '';
  const r = JSON.parse(text) as Json;
  if (file === 'metrics.jsonl')
    return {
      file,
      line,
      series: { name: r.name as string, labels: r.labels as Record<string, string> },
    };
  if (file === 'logs.jsonl')
    return { file, line, time: r.time as string, service: r.service as string };
  const spans = ((r.resourceSpans as Json[])[0]?.scopeSpans as Json[])[0]?.spans as Json[];
  return { file, line, traceId: spans[0]?.traceId as string };
}

const output = (o: Partial<ModelOutput>): ModelOutput => ({
  schemaVersion: '0.1.0',
  outcome: 'completed',
  findings: [],
  remediation: [],
  limitations: [],
  ...o,
});

/** The synthetic evaluation cases, each exercising a distinct path through the pipeline. */
export async function syntheticCases(b: SyntheticBundles): Promise<EvaluationCase[]> {
  const correct = output({
    findings: [
      {
        id: 'F1',
        kind: 'root_cause',
        statement: 'Payment provider lookups fail, so payments cannot be confirmed.',
        components: ['payment-provider'],
        confidence: 'medium',
        rationale:
          'Lookup errors rise in the payment-call counter and the worker logs failed lookups.',
        evidence: [
          await cite(b.excerpt, 'metrics.jsonl', 1),
          await cite(b.excerpt, 'logs.jsonl', 3),
        ],
      },
      {
        id: 'F2',
        kind: 'affected_component',
        statement: 'The worker cannot finish payments.',
        components: ['worker'],
        confidence: 'medium',
        rationale: 'A worker trace records a failed lookup.',
        evidence: [await cite(b.excerpt, 'traces.jsonl', 1)],
      },
    ],
    remediation: [
      {
        step: 'Restore the payment provider, then recheck parked orders.',
        addresses: ['F1', 'F2'],
      },
    ],
  });
  const wrong = output({
    findings: [
      {
        id: 'F1',
        kind: 'root_cause',
        statement: 'The orders API fails to create orders.',
        components: ['orders-api'],
        confidence: 'low',
        rationale: 'Chosen to exercise scoring of a well-grounded but wrong conclusion.',
        evidence: [await cite(b.excerpt, 'logs.jsonl', 1)],
      },
    ],
  });
  const conflicting = output({
    findings: [
      ...correct.findings.slice(0, 1),
      {
        id: 'F2',
        kind: 'root_cause',
        statement: 'The orders API fails to create orders.',
        components: ['orders-api'],
        confidence: 'low',
        rationale: 'A second, conflicting claim, to exercise scoring of an ambiguous diagnosis.',
        evidence: [await cite(b.excerpt, 'logs.jsonl', 1)],
      },
    ],
  });
  const logsOnly = output({
    findings: [
      {
        ...(correct.findings[0] as ModelOutput['findings'][number]),
        evidence: [await cite(b.excerpt, 'logs.jsonl', 3)],
      },
    ],
  });
  const fabricatedEvidence = output({
    findings: [
      {
        ...(correct.findings[0] as ModelOutput['findings'][number]),
        evidence: [{ file: 'logs.jsonl', line: 99, time: 'x', service: 'worker' }],
      },
    ],
  });
  const inconclusive = output({
    outcome: 'inconclusive',
    limitations: ['The selected evidence shows no failing component.'],
  });
  const cache = output({
    findings: [
      {
        id: 'F1',
        kind: 'root_cause',
        statement: 'The cache node rejects requests because its connection slots are exhausted.',
        components: ['cache-node'],
        confidence: 'high',
        rationale: 'Cache errors rise and the API logs exhausted connection slots.',
        evidence: [
          await cite(b.fabricated, 'metrics.jsonl', 1),
          await cite(b.fabricated, 'logs.jsonl', 4),
          await cite(b.fabricated, 'traces.jsonl', 1),
        ],
      },
      {
        id: 'F2',
        kind: 'affected_component',
        statement: 'Order reads fail in the orders API.',
        components: ['orders-api'],
        confidence: 'medium',
        rationale: 'The failing trace is an order read.',
        evidence: [await cite(b.fabricated, 'traces.jsonl', 1)],
      },
    ],
    remediation: [{ step: 'Restore cache capacity.', addresses: ['F1'] }],
  });
  const fake = (steps: FakeStep[]) => new FakeProvider(steps, 'scripted');
  const down = () => ({ error: new ProviderError('unavailable', 'synthetic outage') });
  return [
    {
      id: 'excerpt-correct',
      kind: 'synthetic',
      bundleDir: b.excerpt,
      provider: fake([{ reply: correct, usage: { inputTokens: 6_200, outputTokens: 410 } }]),
    },
    {
      id: 'excerpt-wrong-root-cause',
      kind: 'synthetic',
      bundleDir: b.excerpt,
      provider: fake([{ reply: wrong }]),
    },
    {
      id: 'excerpt-conflicting-root-causes',
      kind: 'synthetic',
      bundleDir: b.excerpt,
      provider: fake([{ reply: conflicting }]),
    },
    {
      id: 'excerpt-correct-without-symptom-evidence',
      kind: 'synthetic',
      bundleDir: b.excerpt,
      provider: fake([{ reply: logsOnly }]),
    },
    {
      id: 'excerpt-repaired-reply',
      kind: 'synthetic',
      bundleDir: b.excerpt,
      provider: fake([
        {
          reply: '{"schemaVersion": "0.1.0", oops',
          usage: { inputTokens: 6_200, outputTokens: 12 },
        },
        { reply: correct, usage: { inputTokens: 6_300, outputTokens: 410 } },
      ]),
    },
    {
      id: 'excerpt-fabricated-evidence',
      kind: 'synthetic',
      bundleDir: b.excerpt,
      provider: fake([{ reply: fabricatedEvidence }, { reply: fabricatedEvidence }]),
    },
    {
      id: 'excerpt-inconclusive',
      kind: 'synthetic',
      bundleDir: b.excerpt,
      provider: fake([{ reply: inconclusive }]),
    },
    {
      id: 'fabricated-correct',
      kind: 'synthetic',
      bundleDir: b.fabricated,
      provider: fake([{ reply: cache, usage: { inputTokens: 1_900, outputTokens: 380 } }]),
    },
    {
      id: 'fabricated-provider-down',
      kind: 'synthetic',
      bundleDir: b.fabricated,
      provider: fake([down(), down(), down()]),
    },
    { id: 'tampered-bundle', kind: 'synthetic', bundleDir: b.tampered, provider: fake([]) },
  ];
}
