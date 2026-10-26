import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  findLeaks,
  legitimateText,
  protectedValues,
  type ProtectedValue,
} from '../../src/evaluation/index.ts';
import {
  FakeProvider,
  INSTRUCTIONS,
  MODEL_OUTPUT_SCHEMA,
  openEvidence,
  ProviderError,
  runInvestigation,
  summarize,
  type EvidenceView,
  type FakeStep,
  type ModelOutput,
} from '../../src/index.ts';
import { example, makeBundle, type BundleOptions } from '../support.ts';
import { goodOutput } from '../investigation/support.ts';

/**
 * ADR 0003 and ADR 0009, end to end: a bundle whose excluded manifest fields, unaudited future
 * fields, ground truth and directory name all carry distinctive canary values. Whatever path the
 * pipeline takes, no canary may reach a model request, the result (failure messages, selection,
 * run metadata) or its summary.
 */
type Json = Record<string, unknown>;
const NAME = 'zanzibar-canary-scenario';
const DIR = `${NAME}-9-20991231T235959Z`;
let dir = '';
let view: EvidenceView;
let values: ProtectedValue[] = [];

async function canaryOptions(): Promise<BundleOptions> {
  const truth = JSON.parse((await example('ground_truth.json')).toString('utf8')) as Json;
  const scenario = { name: NAME, version: 3, seed: 9 };
  return {
    dirName: DIR,
    files: {
      'ground_truth.json': `${JSON.stringify(
        {
          ...truth,
          scenario,
          description: 'Zanzibar canary description that must never travel.',
          rootCause: { component: 'zanzibar-node', summary: 'Zanzibar canary root cause summary.' },
          affectedComponents: ['zanzibar-node', 'zanzibar-edge'],
          expectedRemediation: ['Zanzibar canary remediation step.'],
          dataEffects: ['Zanzibar canary data effect.'],
        },
        null,
        2,
      )}\n`,
    },
    manifest: (m) => {
      m.scenario = scenario;
      m.createdAt = '2099-12-31T23:59:58.123Z';
      m.window = {
        captureFrom: '2099-12-31T23:51:11.111Z',
        captureTo: '2099-12-31T23:58:22.222Z',
        loadStartedAt: '2099-12-31T23:51:11.111Z',
        loadEndedAt: '2099-12-31T23:57:33.333Z',
      };
      m.trigger = {
        startedAt: '2099-12-31T23:52:44.444Z',
        stoppedAt: '2099-12-31T23:54:55.555Z',
        requestedDurationMs: 131_111,
      };
      m.detection = {
        detectedAt: '2099-12-31T23:53:06.666Z',
        latencyMs: 22_222,
        deadlineSeconds: 120,
      };
      m.producer = { repository: 'zanzibar-producer', commit: 'deadbeef'.repeat(5), dirty: false };
      m.load = {
        profile: 'zanzibar-profile',
        seed: 9,
        planHash: 'feedface'.repeat(8),
        runPrefix: 'lg-zanzibar-canary-prefix',
      };
      m.zanzibarFutureField = { hint: 'zanzibar future field value' };
      (m.capture as Json).zanzibarNested = 'zanzibar nested capture value';
    },
  };
}

// test/support.ts removes temporary bundles after each test, so each test gets a fresh one.
beforeEach(async () => {
  dir = await makeBundle(await canaryOptions());
  view = await openEvidence(dir);
  values = await protectedValues(dir);
});

const legitimate = () => legitimateText(view, [INSTRUCTIONS, JSON.stringify(MODEL_OUTPUT_SCHEMA)]);

async function leaksOf(
  steps: FakeStep[],
  options: { limits?: Record<string, number>; signal?: AbortSignal; bundleDir?: string } = {},
) {
  const provider = new FakeProvider(steps);
  const { result } = await runInvestigation(options.bundleDir ?? dir, {
    provider,
    now: () => 0,
    sleep: () => Promise.resolve(),
    ...(options.limits ? { limits: options.limits } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const check = findLeaks(
    [
      ...provider.requests.map((r) => ({
        channel: 'request',
        text: `${r.instructions}\n${r.input}\n${JSON.stringify(r.outputSchema)}`,
      })),
      { channel: 'result', text: JSON.stringify(result) },
      { channel: 'summary', text: JSON.stringify(summarize(result)) },
    ],
    values,
    legitimate(),
  );
  return { result, requests: provider.requests.length, check };
}

describe('the canary bundle', () => {
  it('is valid, and every canary is a protected value the evidence does not contain', async () => {
    expect(
      (await runInvestigation(dir, { provider: new FakeProvider([{ reply: goodOutput(view) }]) }))
        .report?.valid,
    ).toBe(true);
    const sources = values.map((v) => v.source);
    for (const s of [
      'ground_truth.scenario.name',
      'ground_truth.description',
      'ground_truth.rootCause.component',
      'manifest.bundleId',
      'manifest.createdAt',
      'manifest.trigger.startedAt',
      'manifest.detection.detectedAt',
      'manifest.producer.commit',
      'manifest.load.planHash',
      'manifest.load.runPrefix',
      'manifest.zanzibarFutureField.hint',
      'manifest.capture.zanzibarNested',
      'bundle.path',
      'bundle.directoryName',
    ])
      expect(sources, s).toContain(s);
    const check = findLeaks([], values, legitimate());
    expect(check.checkedValues).toBeGreaterThanOrEqual(30);
    // Canaries were chosen not to occur in the evidence, so every one of them is checked.
    expect(
      values
        .filter((v) => v.value.toLowerCase().includes('zanzibar'))
        .every(
          (v) =>
            findLeaks([{ channel: 'probe', text: v.value }], [v], legitimate()).findings.length ===
            1,
        ),
    ).toBe(true);
  });
});

describe('no canary escapes', () => {
  const unavailable = () => ({ error: new ProviderError('unavailable', 'down') });
  const fabricated = () =>
    goodOutput(view, {
      findings: [
        {
          ...(goodOutput(view).findings[0] as ModelOutput['findings'][number]),
          evidence: [{ file: 'logs.jsonl', line: 99, time: 'x', service: 'worker' }],
        },
      ],
    });
  const paths: [string, () => Promise<Awaited<ReturnType<typeof leaksOf>>>, string][] = [
    ['a completed run', () => leaksOf([{ reply: goodOutput(view) }]), 'completed'],
    [
      'a repaired run',
      () => leaksOf([{ reply: '{"oops"' }, { reply: goodOutput(view) }]),
      'completed',
    ],
    [
      'a run whose evidence fails verification',
      () => leaksOf([{ reply: fabricated() }, { reply: fabricated() }]),
      'failed',
    ],
    ['a provider outage', () => leaksOf([unavailable(), unavailable(), unavailable()]), 'failed'],
    [
      'an authentication failure',
      () => leaksOf([{ error: new ProviderError('authentication', 'bad key') }]),
      'failed',
    ],
    [
      'a spent token budget',
      () => leaksOf([unavailable(), unavailable()], { limits: { maxTotalTokens: 204_000 } }),
      'budget_exceeded',
    ],
    [
      'a cancelled run',
      () => {
        const c = new AbortController();
        c.abort();
        return leaksOf([], { signal: c.signal });
      },
      'failed',
    ],
    ['an invalid configuration', () => leaksOf([], { limits: { maxModelCalls: 0 } }), 'failed'],
  ];
  for (const [label, runPath, outcome] of paths) {
    it(`on ${label}`, async () => {
      const { result, check } = await runPath();
      expect(result.outcome).toBe(outcome);
      expect(check.findings).toEqual([]);
    });
  }

  it('on a bundle refused at admission', async () => {
    const logs = await readFile(join(dir, 'logs.jsonl'), 'utf8');
    const refused = await makeBundle({
      ...(await canaryOptions()),
      after: { 'logs.jsonl': `${logs}tampered\n` },
    });
    const { result, requests, check } = await leaksOf([], { bundleDir: refused });
    expect(result.failure?.class).toBe('invalid_bundle');
    expect(requests).toBe(0);
    // Checked against the refused bundle's own location too.
    expect(
      findLeaks(
        [{ channel: 'result', text: JSON.stringify(result) }],
        await protectedValues(refused),
        '',
      ).findings,
    ).toEqual([]);
    expect(check.findings).toEqual([]);
  });
});
