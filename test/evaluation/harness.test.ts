import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  readAnswerKey,
  runEvaluation,
  runSyntheticEvaluation,
  scoreResult,
} from '../../src/evaluation/index.ts';
import { isEntryPoint, main } from '../../src/evaluation/cli.ts';
import { FakeProvider } from '../../src/index.ts';
import type { InvestigationResult } from '../../src/investigation/result.ts';
import { makeBundle } from '../support.ts';
import { bundles, goodOutput } from '../investigation/support.ts';
import { openEvidence } from '../../src/index.ts';

/** ADR 0009: the deterministic evaluation harness and the scoring boundary. */
const GOLDEN = new URL('../golden/synthetic-evaluation.json', import.meta.url);

describe('the synthetic evaluation', () => {
  it('matches the committed golden report exactly', async () => {
    const report = await runSyntheticEvaluation();
    expect(`${JSON.stringify(report, null, 2)}\n`).toBe(await readFile(GOLDEN, 'utf8'));
  });

  it('covers every pipeline path, cites only resolving evidence, and leaks no answer', async () => {
    const report = await runSyntheticEvaluation();
    expect(
      report.cases.map((c) => [
        c.id,
        c.summary.outcome,
        c.summary.failureClass,
        c.score?.rootCause ?? null,
        c.score?.symptomEvidence ?? null,
      ]),
    ).toEqual([
      ['excerpt-correct', 'completed', null, 'correct', 'covered'],
      ['excerpt-wrong-root-cause', 'completed', null, 'incorrect', 'not_covered'],
      ['excerpt-conflicting-root-causes', 'completed', null, 'ambiguous', 'covered'],
      ['excerpt-correct-without-symptom-evidence', 'completed', null, 'correct', 'not_covered'],
      ['excerpt-repaired-reply', 'completed', null, 'correct', 'covered'],
      [
        'excerpt-fabricated-evidence',
        'failed',
        'evidence_verification_failed',
        'missing',
        'not_covered',
      ],
      ['excerpt-inconclusive', 'inconclusive', null, 'missing', 'not_covered'],
      ['fabricated-correct', 'completed', null, 'correct', 'covered'],
      ['fabricated-provider-down', 'failed', 'provider_unavailable', 'missing', 'not_covered'],
      ['tampered-bundle', 'failed', 'invalid_bundle', null, null],
    ]);
    expect(report.totals).toEqual({
      cases: 10,
      byOutcome: { completed: 6, failed: 3, inconclusive: 1 },
      rootCauseCorrect: 4,
      rootCauseAmbiguous: 1,
      symptomEvidenceCovered: 4,
      rejectedForEvidence: 1,
      answerLeaks: 0,
    });
    expect(report.cases.every((c) => c.kind === 'synthetic')).toBe(true);
    expect(report.cases.every((c) => !c.answerLeak.leaked)).toBe(true);
  });

  it('runs as a program and prints the same report', async () => {
    const cli = new URL('../../src/evaluation/cli.ts', import.meta.url).pathname;
    const { stdout } = await promisify(execFile)('node', [cli]);
    expect(stdout).toBe(await readFile(GOLDEN, 'utf8'));
  });
});

describe('the evaluation command', () => {
  it('prints the report and exits 0, or 1 when any answer leaked', async () => {
    let out = '';
    const writer = { write: (t: string) => (out += t) };
    expect(await main(writer)).toBe(0);
    expect(out).toBe(await readFile(GOLDEN, 'utf8'));
    const leaky = await runSyntheticEvaluation();
    leaky.totals.answerLeaks = 1;
    expect(await main(writer, () => Promise.resolve(leaky))).toBe(1);
  });

  it('recognises when it is the program being run', () => {
    const url = new URL('../../src/evaluation/cli.ts', import.meta.url);
    expect(isEntryPoint(url.href, url.pathname)).toBe(true);
    expect(isEntryPoint(url.href, '/somewhere/else.ts')).toBe(false);
    expect(isEntryPoint(url.href, undefined)).toBe(false);
  });
});

describe('the leak check', () => {
  const leakyRun = async (message: (truth: Record<string, unknown>) => string) => {
    const truth = JSON.parse(
      await readFile(join((await bundles()).excerpt, 'ground_truth.json'), 'utf8'),
    ) as Record<string, unknown>;
    const log = JSON.parse(
      (await readFile(join((await bundles()).excerpt, 'logs.jsonl'), 'utf8')).split('\n')[0] ??
        '{}',
    ) as Record<string, unknown>;
    const dir = await makeBundle({
      files: { 'logs.jsonl': `${JSON.stringify({ ...log, message: message(truth) })}\n` },
    });
    const view = await openEvidence(dir);
    const reply = goodOutput(view, {
      findings: [],
      outcome: 'inconclusive',
      remediation: [],
      limitations: ['x'],
    });
    return runEvaluation([
      {
        id: 'leaky',
        kind: 'synthetic',
        bundleDir: dir,
        provider: new FakeProvider([{ reply }]),
      },
    ]);
  };

  it('detects a transformed scenario name carried into a request by the telemetry', async () => {
    // A producer leak: a log message spells the scenario name differently. The check must see
    // through the change of case and separators.
    const report = await leakyRun((t) =>
      (t.scenario as { name: string }).name.toUpperCase().replace('-', ' '),
    );
    expect(report.cases[0]?.answerLeak).toMatchObject({
      leaked: true,
      findings: [{ channel: 'request', source: 'ground_truth.scenario.name', match: 'normalized' }],
    });
    expect(report.totals.answerLeaks).toBe(1);
    expect(JSON.stringify(report)).not.toContain('PROVIDER OUTAGE');
  });

  it('detects answer text that reaches a model request', async () => {
    // A bundle whose telemetry carries the ground truth's description: the check must see it.
    const description = 'A deliberately leaking description used only by this test.';
    const truth = JSON.parse(
      await readFile(join((await bundles()).excerpt, 'ground_truth.json'), 'utf8'),
    ) as Record<string, unknown>;
    const log = JSON.parse(
      (await readFile(join((await bundles()).excerpt, 'logs.jsonl'), 'utf8')).split('\n')[0] ??
        '{}',
    ) as Record<string, unknown>;
    const dir = await makeBundle({
      files: {
        'ground_truth.json': `${JSON.stringify({ ...truth, description })}\n`,
        'logs.jsonl': `${JSON.stringify({ ...log, message: description })}\n`,
      },
    });
    const view = await openEvidence(dir);
    const report = await runEvaluation([
      {
        id: 'leaky',
        kind: 'synthetic',
        bundleDir: dir,
        provider: new FakeProvider([
          {
            reply: goodOutput(view, {
              findings: [],
              outcome: 'inconclusive',
              remediation: [],
              limitations: ['x'],
            }),
          },
        ]),
      },
    ]);
    expect(report.cases[0]?.answerLeak).toMatchObject({
      checkedRequests: 1,
      leaked: true,
      findings: [{ channel: 'request', source: 'ground_truth.description', match: 'exact' }],
    });
    expect(report.totals.answerLeaks).toBe(1);
  });
});

describe('scoring', () => {
  const key = {
    scenario: 's',
    rootCauseComponent: 'cache-node',
    affectedComponents: ['cache-node', 'orders-api'],
    primarySymptom: {
      metric: 'cache_requests_total',
      matchers: { job: 'orders-api', result: 'error' },
    },
  };
  interface F {
    kind: string;
    components: string[];
    evidence?: { file: string; series?: { name: string; labels: Record<string, string> } }[];
  }
  const result = (findings: F[]) =>
    ({
      outcome: 'completed',
      findings: findings.map((f) => ({ evidence: [], ...f })),
    }) as unknown as InvestigationResult;
  const series = (name: string, labels: Record<string, string>) => ({
    file: 'metrics.jsonl',
    series: { name, labels },
  });

  it('scores the root cause and the affected components separately', () => {
    expect(
      scoreResult(
        result([
          { kind: 'root_cause', components: ['cache-node'] },
          { kind: 'symptom', components: ['orders-api', 'worker'] },
        ]),
        key,
      ),
    ).toEqual({
      outcome: 'completed',
      rootCause: 'correct',
      symptomEvidence: 'not_covered',
      affected: {
        predicted: ['cache-node', 'orders-api', 'worker'],
        expected: ['cache-node', 'orders-api'],
        precision: 0.667,
        recall: 1,
      },
    });
    expect(
      scoreResult(result([{ kind: 'root_cause', components: ['worker'] }]), key).rootCause,
    ).toBe('incorrect');
    expect(scoreResult(result([]), key)).toMatchObject({
      rootCause: 'missing',
      affected: { precision: null, recall: 0 },
    });
    expect(scoreResult(result([]), { ...key, affectedComponents: [] }).affected.recall).toBe(1);
  });

  it('calls a result that names two root-cause components ambiguous, even if one is right', () => {
    const both = result([
      { kind: 'root_cause', components: ['cache-node'] },
      { kind: 'root_cause', components: ['worker'] },
    ]);
    expect(scoreResult(both, key).rootCause).toBe('ambiguous');
    // The same component twice, or in one finding, is not a conflict.
    expect(
      scoreResult(
        result([
          { kind: 'root_cause', components: ['cache-node'] },
          { kind: 'root_cause', components: ['cache-node'] },
        ]),
        key,
      ).rootCause,
    ).toBe('correct');
  });

  it('scores whether a finding cites the series of the primary symptom, with its labels', () => {
    const cites = (name: string, labels: Record<string, string>) =>
      scoreResult(
        result([
          { kind: 'root_cause', components: ['cache-node'], evidence: [series(name, labels)] },
        ]),
        key,
      ).symptomEvidence;
    const ok = { job: 'orders-api', result: 'error', extra: 'x' };
    expect(cites('cache_requests_total', ok)).toBe('covered');
    expect(cites('cache_requests_total', { job: 'orders-api', result: 'ok' })).toBe('not_covered');
    expect(cites('cache_requests_total', { job: 'orders-api' })).toBe('not_covered');
    expect(cites('other_total', ok)).toBe('not_covered');
    const logs = result([
      { kind: 'root_cause', components: ['cache-node'], evidence: [{ file: 'logs.jsonl' }] },
    ]);
    expect(scoreResult(logs, key).symptomEvidence).toBe('not_covered');
    expect(scoreResult(result([]), key).symptomEvidence).toBe('not_covered');
  });

  it('reads the answer key only through the scoring boundary, and validates it', async () => {
    const key2 = await readAnswerKey((await bundles()).fabricated);
    expect(key2).toMatchObject({
      scenario: 'synthetic-cache-saturation',
      rootCauseComponent: 'cache-node',
      affectedComponents: ['cache-node', 'orders-api'],
      primarySymptom: {
        metric: 'cache_requests_total',
        matchers: { job: 'orders-api', result: 'error' },
      },
    });
    const broken = await makeBundle({ files: { 'ground_truth.json': '{}\n' } });
    await expect(readAnswerKey(broken)).rejects.toThrow(
      'ground_truth.json does not match its schema',
    );
  });
});
