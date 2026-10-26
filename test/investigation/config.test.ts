import { describe, expect, it } from 'vitest';
import {
  createInvestigator,
  DEFAULT_LIMITS,
  FakeProvider,
  InvestigationConfigError,
  resolveLimits,
  runInvestigation,
} from '../../src/index.ts';
import { bundles } from './support.ts';

describe('investigation limits', () => {
  it('defaults every limit, and accepts valid overrides', () => {
    expect(resolveLimits()).toEqual(DEFAULT_LIMITS);
    expect(resolveLimits({ maxModelCalls: 2, maxRepairAttempts: 1 })).toMatchObject({
      maxModelCalls: 2,
      maxRepairAttempts: 1,
    });
    expect(Object.isFrozen(DEFAULT_LIMITS)).toBe(true);
    // The default token budget fits exactly maxModelCalls calls at their ceiling.
    expect(DEFAULT_LIMITS.maxTotalTokens).toBe(
      DEFAULT_LIMITS.maxModelCalls *
        (DEFAULT_LIMITS.maxInputTokensPerCall + DEFAULT_LIMITS.maxOutputTokens),
    );
  });

  it('rejects unknown, non-integer and out-of-range limits, naming each problem', () => {
    const error = (() => {
      try {
        resolveLimits({ maxModelCalls: 0, deadlineMs: 1.5, maxTokens: 10, maxRetries: '2' });
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(InvestigationConfigError);
    expect((error as InvestigationConfigError).problems).toEqual([
      'unknown limit "maxTokens"',
      'maxModelCalls must be between 1 and 20; got 0',
      'maxRetries must be an integer',
      'deadlineMs must be an integer',
    ]);
  });

  it('rejects inconsistent limits', () => {
    expect(() => resolveLimits({ maxModelCalls: 1, maxRepairAttempts: 1 })).toThrow(
      'maxRepairAttempts must be lower than maxModelCalls',
    );
    expect(() => resolveLimits({ perCallTimeoutMs: 20_000, deadlineMs: 10_000 })).toThrow(
      'perCallTimeoutMs must not exceed deadlineMs',
    );
    expect(() => resolveLimits({ retryBaseDelayMs: 5_000, retryMaxDelayMs: 1_000 })).toThrow(
      'retryBaseDelayMs must not exceed retryMaxDelayMs',
    );
    expect(() => resolveLimits({ maxRecordBytes: 5_000, maxContextBytes: 2_000 })).toThrow(
      'maxRecordBytes must not exceed maxContextBytes',
    );
    expect(() =>
      resolveLimits({
        maxTotalTokens: 100_000,
        maxInputTokensPerCall: 99_000,
        maxOutputTokens: 2_000,
      }),
    ).toThrow('maxTotalTokens must be at least maxInputTokensPerCall + maxOutputTokens');
    expect(
      resolveLimits({
        maxTotalTokens: 101_000,
        maxInputTokensPerCall: 99_000,
        maxOutputTokens: 2_000,
      }),
    ).toMatchObject({ maxTotalTokens: 101_000 });
  });

  it('fails when the investigator is created, before any model call', () => {
    const provider = new FakeProvider([]);
    expect(() => createInvestigator({ provider, limits: { maxModelCalls: 99 } })).toThrow(
      InvestigationConfigError,
    );
    expect(provider.requests).toHaveLength(0);
  });

  it('becomes an invalid_configuration result in the pipeline, without reading the bundle', async () => {
    const provider = new FakeProvider([]);
    const run = await runInvestigation((await bundles()).excerpt, {
      provider,
      limits: { deadlineMs: -1 },
      now: () => 0,
    });
    expect(run.report).toBeNull();
    expect(run.result).toMatchObject({
      outcome: 'failed',
      caseId: null,
      bundle: null,
      failure: { class: 'invalid_configuration' },
    });
    expect(provider.requests).toHaveLength(0);
  });
});
