import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  findLeaks,
  legitimateText,
  protectedValues,
  tokens,
  type ProtectedValue,
} from '../../src/evaluation/index.ts';
import { INSTRUCTIONS, openEvidence } from '../../src/index.ts';
import { bundles } from '../investigation/support.ts';

/**
 * ADR 0009: deterministic leak detection. Positive controls for each transformation it claims to
 * see through, and a recorded negative for what it cannot see: a paraphrase.
 */
const value = (source: string, v: string, policy: ProtectedValue['policy'] = 'always') => ({
  source,
  value: v,
  policy,
});
const scan = (text: string, values: ProtectedValue[], legitimate = '') =>
  findLeaks([{ channel: 'request', text }], values, legitimate);

describe('the protected values of a bundle', () => {
  it('cover answer text, every excluded manifest field and the bundle location, but not the view', async () => {
    const dir = (await bundles()).excerpt;
    const values = await protectedValues(dir);
    const policy = (source: string) => values.find((v) => v.source === source)?.policy;
    for (const s of [
      'ground_truth.scenario.name',
      'ground_truth.rootCause.summary',
      'ground_truth.description',
      'ground_truth.primarySymptom.description',
      'ground_truth.secondarySymptoms.0.description',
      'ground_truth.expectedRemediation.0',
      'ground_truth.dataEffects.0',
      'bundle.path',
      'bundle.directoryName',
    ])
      expect(policy(s), s).toBe('always');
    for (const s of [
      'ground_truth.rootCause.component',
      'ground_truth.primarySymptom.metric',
      'manifest.bundleId',
      'manifest.scenario.name',
      'manifest.createdAt',
      'manifest.trigger.startedAt',
      'manifest.detection.detectedAt',
      'manifest.window.captureFrom',
      'manifest.load.planHash',
      'manifest.load.runPrefix',
      'manifest.producer.commit',
      'manifest.files.ground_truth.json.sha256',
    ])
      expect(policy(s), s).toBe('unless_in_evidence');
    // The view's own fields are not protected: the investigator is meant to see them.
    for (const s of ['manifest.services.0.name', 'manifest.files.logs.jsonl.sha256'])
      expect(policy(s), s).toBeUndefined();
    expect(values.find((v) => v.source === 'bundle.directoryName')?.value).toBe(basename(dir));
    // Too short to check without false alarms: the seed's digits, "worker".
    expect(values.every((v) => tokens(v.value).join('').length >= 8)).toBe(true);
  });

  it('protects a field a later producer adds, without being told about it', async () => {
    const dir = (await bundles()).excerpt;
    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      join(dir, 'manifest.json'),
      JSON.stringify({ ...manifest, faultHints: { label: 'an unaudited future field' } }),
    );
    expect(await protectedValues(dir)).toContainEqual({
      source: 'manifest.faultHints.label',
      value: 'an unaudited future field',
      policy: 'unless_in_evidence',
    });
  });
});

describe('matching', () => {
  const name = [value('ground_truth.scenario.name', 'provider-outage')];

  it('sees through case, separators, word boundaries and camelCase', () => {
    for (const text of [
      'provider-outage',
      'PROVIDER OUTAGE',
      'provider_outage',
      'Provider.Outage',
      'providerOutage',
      '["provider","outage"]',
    ]) {
      const found = scan(text, name).findings;
      expect(found, text).toHaveLength(1);
      expect(found[0]?.match, text).toBe(text === 'provider-outage' ? 'exact' : 'normalized');
    }
  });

  it('sees through base64, percent and hex encoding', () => {
    const summary = 'The payment provider rejects every charge.';
    const values = [value('ground_truth.rootCause.summary', summary)];
    const b64 = Buffer.from(summary).toString('base64');
    for (const text of [
      b64,
      b64.replace(/=+$/, ''),
      Buffer.from(summary).toString('base64url'),
      encodeURIComponent(summary),
      Buffer.from(summary).toString('hex'),
      Buffer.from(summary).toString('hex').toUpperCase(),
    ])
      expect(scan(`{"x":"${text}"}`, values).findings, text).toEqual([
        { channel: 'request', source: 'ground_truth.rootCause.summary', match: 'encoded' },
      ]);
  });

  it('catches excluded manifest metadata that a broken investigator would send', () => {
    const values = [
      value('manifest.trigger.startedAt', '2026-10-26T12:23:00.324Z', 'unless_in_evidence'),
      value('manifest.load.planHash', 'c5ff38777f042dbadcfe9cd0e3fae6d5', 'unless_in_evidence'),
    ];
    const check = findLeaks(
      [
        {
          channel: 'request',
          text: '{"selection":{"notes":["fault at 2026-10-26 12:23:00.324"]}}',
        },
        {
          channel: 'result_metadata',
          text: '{"failure":{"message":"plan c5ff38777f042dbadcfe9cd0e3fae6d5"}}',
        },
      ],
      values,
      '',
    );
    expect(check.findings).toEqual([
      { channel: 'request', source: 'manifest.trigger.startedAt', match: 'normalized' },
      { channel: 'result_metadata', source: 'manifest.load.planHash', match: 'exact' },
    ]);
  });

  it('allows excluded metadata the evidence or fixed instructions legitimately contain, but never answer text', () => {
    const values = [
      value('ground_truth.rootCause.component', 'payment-provider', 'unless_in_evidence'),
      value('manifest.load.profile', 'incident', 'unless_in_evidence'),
      value('ground_truth.description', 'The payment provider is unavailable.'),
    ];
    const legitimate = legitimateText(null, [
      INSTRUCTIONS,
      '{"service":"worker","attributes":{"peer":"payment-provider"}} The payment provider is unavailable.',
    ]);
    const text = 'incident: payment-provider; The payment provider is unavailable.';
    const check = scan(text, values, legitimate);
    expect(check).toEqual({
      checkedValues: 1,
      legitimatelyPresent: 2,
      findings: [{ channel: 'request', source: 'ground_truth.description', match: 'exact' }],
    });
  });

  it('builds the legitimate text from the admitted evidence view', async () => {
    const view = await openEvidence((await bundles()).fabricated);
    expect(legitimateText(view, ['fixed'])).toBe(`${JSON.stringify(view)}\nfixed`);
  });

  it('names the source of a leak, never the leaked value', () => {
    const secret = 'zanzibar-canary-scenario';
    const check = scan(secret, [value('ground_truth.scenario.name', secret)]);
    expect(JSON.stringify(check)).not.toContain(secret);
  });

  it('does not detect a paraphrase: a documented limit, not a guarantee', () => {
    const values = [
      value('ground_truth.scenario.name', 'provider-outage'),
      value(
        'ground_truth.rootCause.summary',
        'The payment provider rejects every charge and lookup as unavailable.',
      ),
    ];
    const paraphrase = 'The external card processor went down and refused all requests.';
    expect(scan(paraphrase, values).findings).toEqual([]);
  });
});
