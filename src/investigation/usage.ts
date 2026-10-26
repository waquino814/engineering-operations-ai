import type { InvestigationLimits } from './config.ts';

/**
 * Token accounting for one investigation (ADR 0006). Every model call, whether it returned a
 * reply, failed, timed out or was cancelled, is recorded once. The budget counts reported usage
 * where the provider gave a valid report, and the call's ceiling (maxInputTokensPerCall for input,
 * maxOutputTokens for output) for any part it did not. A new call starts only if the budget still
 * has room for a whole call at its ceiling, so the budget holds as long as the ceilings do. A
 * report above a ceiling shows they did not hold: it is counted, and no further call starts.
 *
 * Bytes are never converted to tokens here or anywhere else.
 */
export type UsageReportStatus = 'reported' | 'missing' | 'invalid' | 'inconsistent';

export interface TokenUsageSnapshot {
  /** Sums of the valid input and output counts the provider reported. */
  inputTokens: number;
  outputTokens: number;
  /** What the budget counted: reported values, and ceilings for anything not reported. */
  chargedTokens: number;
  /** Calls whose report was missing or invalid, in whole or in part, and so charged a ceiling. */
  unreportedCalls: number;
  /** Reports above a per-call ceiling. */
  inconsistentReports: number;
  /** "reported" only when every call had a valid, consistent report. */
  tokenAccounting: 'reported' | 'estimated';
}

export const EMPTY_TOKEN_USAGE: Readonly<TokenUsageSnapshot> = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  chargedTokens: 0,
  unreportedCalls: 0,
  inconsistentReports: 0,
  tokenAccounting: 'reported',
});

type Json = Record<string, unknown>;
const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

export class TokenLedger {
  private readonly limits: Pick<
    InvestigationLimits,
    'maxTotalTokens' | 'maxInputTokensPerCall' | 'maxOutputTokens'
  >;
  private inputTokens = 0;
  private outputTokens = 0;
  private charged = 0;
  private unreported = 0;
  private inconsistent = 0;
  private calls = 0;

  constructor(
    limits: Pick<
      InvestigationLimits,
      'maxTotalTokens' | 'maxInputTokensPerCall' | 'maxOutputTokens'
    >,
  ) {
    this.limits = limits;
  }

  /** The most one call is assumed to cost. */
  get callCeiling(): number {
    return this.limits.maxInputTokensPerCall + this.limits.maxOutputTokens;
  }

  /** Calls recorded so far. */
  get recordedCalls(): number {
    return this.calls;
  }

  /** Why another call may not start, or null if it may. */
  refusal(): string | null {
    if (this.inconsistent > 0)
      return 'a usage report exceeded the per-call token ceilings, so the remaining token budget cannot be relied on';
    const left = this.limits.maxTotalTokens - this.charged;
    if (left < this.callCeiling)
      return `the token budget (${String(this.limits.maxTotalTokens)}) has ${String(Math.max(0, left))} tokens left, less than one call's ceiling (${String(this.callCeiling)})`;
    return null;
  }

  /** True when the tokens charged exceed the budget. */
  get exceeded(): boolean {
    return this.charged > this.limits.maxTotalTokens;
  }

  /**
   * Records one call. `report` is whatever the provider adapter supplied, or undefined. A reply's
   * input count must be at least 1, since a reply always had input; an error may report zero.
   */
  record(report: unknown, call: 'reply' | 'error'): UsageReportStatus {
    this.calls += 1;
    const r: Json | null =
      typeof report === 'object' && report !== null && !Array.isArray(report)
        ? (report as Json)
        : null;
    const input =
      r && isCount(r.inputTokens) && (call === 'error' || r.inputTokens > 0) ? r.inputTokens : null;
    const output = r && isCount(r.outputTokens) ? r.outputTokens : null;
    if (input !== null) this.inputTokens += input;
    if (output !== null) this.outputTokens += output;
    this.charged +=
      (input ?? this.limits.maxInputTokensPerCall) + (output ?? this.limits.maxOutputTokens);

    let status: UsageReportStatus;
    if (input !== null && output !== null) {
      status =
        input > this.limits.maxInputTokensPerCall || output > this.limits.maxOutputTokens
          ? 'inconsistent'
          : 'reported';
    } else if (
      report === undefined ||
      report === null ||
      (r !== null && r.inputTokens === undefined && r.outputTokens === undefined)
    ) {
      status = 'missing';
    } else {
      status = 'invalid';
    }
    if (status === 'inconsistent') this.inconsistent += 1;
    if (status === 'missing' || status === 'invalid') this.unreported += 1;
    return status;
  }

  snapshot(): TokenUsageSnapshot {
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      chargedTokens: this.charged,
      unreportedCalls: this.unreported,
      inconsistentReports: this.inconsistent,
      tokenAccounting: this.unreported === 0 && this.inconsistent === 0 ? 'reported' : 'estimated',
    };
  }
}
