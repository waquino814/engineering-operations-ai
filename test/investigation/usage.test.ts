import { describe, expect, it } from 'vitest';
import { EMPTY_TOKEN_USAGE, TokenLedger } from '../../src/index.ts';

/** ADR 0006: token accounting. Unknown usage is charged at the call's ceiling, never guessed. */
const limits = { maxTotalTokens: 10_000, maxInputTokensPerCall: 3_000, maxOutputTokens: 1_000 };

describe('the token ledger', () => {
  it('charges a valid report exactly as reported', () => {
    const ledger = new TokenLedger(limits);
    expect(ledger.record({ inputTokens: 1_200, outputTokens: 300 }, 'reply')).toBe('reported');
    expect(ledger.snapshot()).toEqual({
      inputTokens: 1_200,
      outputTokens: 300,
      chargedTokens: 1_500,
      unreportedCalls: 0,
      inconsistentReports: 0,
      tokenAccounting: 'reported',
    });
    expect(ledger.recordedCalls).toBe(1);
    expect(ledger.refusal()).toBeNull();
  });

  it('starts empty, with nothing reported and nothing estimated', () => {
    expect(new TokenLedger(limits).snapshot()).toEqual(EMPTY_TOKEN_USAGE);
  });

  it('charges a missing report at the full call ceiling and marks the accounting estimated', () => {
    for (const report of [undefined, null, {}]) {
      const ledger = new TokenLedger(limits);
      expect(ledger.record(report, 'reply'), JSON.stringify(report)).toBe('missing');
      expect(ledger.snapshot(), JSON.stringify(report)).toEqual({
        inputTokens: 0,
        outputTokens: 0,
        chargedTokens: 4_000,
        unreportedCalls: 1,
        inconsistentReports: 0,
        tokenAccounting: 'estimated',
      });
    }
  });

  it('treats malformed counts as unreported, charging the ceiling for each bad part', () => {
    const cases: [unknown, number][] = [
      [{ inputTokens: -1, outputTokens: 10 }, 3_000 + 10],
      [{ inputTokens: 1.5, outputTokens: 10 }, 3_000 + 10],
      [{ inputTokens: '100', outputTokens: 10 }, 3_000 + 10],
      [{ inputTokens: Number.NaN, outputTokens: 10 }, 3_000 + 10],
      [{ inputTokens: 100, outputTokens: Number.POSITIVE_INFINITY }, 100 + 1_000],
      [{ inputTokens: 100 }, 100 + 1_000],
      [{ outputTokens: 10 }, 3_000 + 10],
      [[100, 10], 4_000],
      ['lots', 4_000],
    ];
    for (const [report, charged] of cases) {
      const ledger = new TokenLedger(limits);
      expect(ledger.record(report, 'reply'), JSON.stringify(report)).toBe('invalid');
      expect(ledger.snapshot(), JSON.stringify(report)).toMatchObject({
        chargedTokens: charged,
        unreportedCalls: 1,
        tokenAccounting: 'estimated',
      });
    }
  });

  it('rejects zero input for a reply, but accepts a reported zero for a failed call', () => {
    const reply = new TokenLedger(limits);
    expect(reply.record({ inputTokens: 0, outputTokens: 5 }, 'reply')).toBe('invalid');
    expect(reply.snapshot().chargedTokens).toBe(3_005);
    const error = new TokenLedger(limits);
    expect(error.record({ inputTokens: 0, outputTokens: 0 }, 'error')).toBe('reported');
    expect(error.snapshot()).toMatchObject({ chargedTokens: 0, tokenAccounting: 'reported' });
  });

  it('flags a report above a per-call ceiling and refuses every further call', () => {
    for (const report of [
      { inputTokens: 3_001, outputTokens: 10 },
      { inputTokens: 10, outputTokens: 1_001 },
    ]) {
      const ledger = new TokenLedger(limits);
      expect(ledger.record(report, 'reply')).toBe('inconsistent');
      expect(ledger.snapshot()).toMatchObject({
        inconsistentReports: 1,
        unreportedCalls: 0,
        tokenAccounting: 'estimated',
      });
      expect(ledger.exceeded).toBe(false);
      expect(ledger.refusal()).toBe(
        'a usage report exceeded the per-call token ceilings, so the remaining token budget cannot be relied on',
      );
    }
  });

  it('refuses a call the remaining budget cannot cover at its ceiling', () => {
    const ledger = new TokenLedger(limits);
    ledger.record(undefined, 'error');
    ledger.record({ inputTokens: 1_500, outputTokens: 600 }, 'reply');
    // 4,000 + 2,100 charged; 3,900 left, less than the 4,000 ceiling.
    expect(ledger.refusal()).toBe(
      "the token budget (10000) has 3900 tokens left, less than one call's ceiling (4000)",
    );
    expect(ledger.exceeded).toBe(false);
  });

  it('reports when the charged tokens pass the budget', () => {
    const ledger = new TokenLedger(limits);
    ledger.record({ inputTokens: 2_900, outputTokens: 900 }, 'reply');
    ledger.record({ inputTokens: 2_900, outputTokens: 900 }, 'reply');
    expect(ledger.exceeded).toBe(false);
    ledger.record({ inputTokens: 2_900, outputTokens: 900 }, 'reply');
    expect(ledger.snapshot().chargedTokens).toBe(11_400);
    expect(ledger.exceeded).toBe(true);
    expect(ledger.refusal()).toBe(
      "the token budget (10000) has 0 tokens left, less than one call's ceiling (4000)",
    );
  });
});
