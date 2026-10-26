/**
 * Investigation limits (ADR 0002, ADR 0006). Every limit is explicit, has a default, and is
 * checked when an investigator is created, so a bad configuration fails before any model call.
 */
export interface InvestigationLimits {
  /** Model invocations per investigation, counting retries and repair attempts. */
  maxModelCalls: number;
  /** Repair requests after an invalid model response (ADR 0007). */
  maxRepairAttempts: number;
  /** Retries of one request after a transient provider failure. */
  maxRetries: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  perCallTimeoutMs: number;
  /** Wall-clock budget for the whole investigation. */
  deadlineMs: number;
  /** Passed to the provider as its output cap; also the output ceiling charged per call. */
  maxOutputTokens: number;
  /**
   * The most input tokens one request may hold, in the provider's own tokens. An operator setting,
   * not derived from bytes: the provider adapter is responsible for its being true. It is the
   * input ceiling charged for a call whose usage is not reported.
   */
  maxInputTokensPerCall: number;
  /** Input plus output tokens across every call of one investigation (src/investigation/usage.ts). */
  maxTotalTokens: number;
  /** UTF-8 bytes of instructions, output schema and input together. */
  maxContextBytes: number;
  maxEvidenceRecords: number;
  /** A record larger than this is omitted from the context, never cut. */
  maxRecordBytes: number;
}

export const DEFAULT_LIMITS: Readonly<InvestigationLimits> = Object.freeze({
  maxModelCalls: 4,
  maxRepairAttempts: 1,
  maxRetries: 2,
  retryBaseDelayMs: 1_000,
  retryMaxDelayMs: 10_000,
  perCallTimeoutMs: 60_000,
  deadlineMs: 300_000,
  maxOutputTokens: 4_000,
  // Equal to maxContextBytes, on the assumption that a request never has more tokens than UTF-8
  // bytes. That assumption must be confirmed for a real provider (ADR 0006); nothing converts.
  maxInputTokensPerCall: 200_000,
  // Room for maxModelCalls calls at their ceiling: 4 x (200,000 + 4,000).
  maxTotalTokens: 816_000,
  maxContextBytes: 200_000,
  maxEvidenceRecords: 200,
  maxRecordBytes: 16_384,
});

const BOUNDS: Record<keyof InvestigationLimits, [number, number]> = {
  maxModelCalls: [1, 20],
  maxRepairAttempts: [0, 5],
  maxRetries: [0, 10],
  retryBaseDelayMs: [0, 60_000],
  retryMaxDelayMs: [0, 300_000],
  perCallTimeoutMs: [100, 600_000],
  deadlineMs: [100, 3_600_000],
  maxOutputTokens: [1, 200_000],
  maxInputTokensPerCall: [1_000, 2_000_000],
  maxTotalTokens: [1_000, 50_000_000],
  maxContextBytes: [1_024, 10_000_000],
  maxEvidenceRecords: [1, 10_000],
  maxRecordBytes: [64, 1_000_000],
};

export class InvestigationConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`invalid investigation configuration: ${problems.join('; ')}`);
    this.name = 'InvestigationConfigError';
    this.problems = problems;
  }
}

/** Merges overrides into the defaults and validates the result; throws on any problem. */
export function resolveLimits(
  overrides: Partial<Record<string, unknown>> = {},
): InvestigationLimits {
  const problems: string[] = [];
  for (const key of Object.keys(overrides)) {
    if (!(key in BOUNDS)) problems.push(`unknown limit "${key}"`);
  }
  const limits = { ...DEFAULT_LIMITS } as Record<string, number>;
  for (const [key, [min, max]] of Object.entries(BOUNDS)) {
    const value = key in overrides ? overrides[key] : limits[key];
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      problems.push(`${key} must be an integer`);
    } else if (value < min || value > max) {
      problems.push(
        `${key} must be between ${String(min)} and ${String(max)}; got ${String(value)}`,
      );
    } else {
      limits[key] = value;
    }
  }
  const l = limits as unknown as InvestigationLimits;
  if (problems.length === 0) {
    if (l.maxRepairAttempts >= l.maxModelCalls)
      problems.push('maxRepairAttempts must be lower than maxModelCalls');
    if (l.perCallTimeoutMs > l.deadlineMs)
      problems.push('perCallTimeoutMs must not exceed deadlineMs');
    if (l.retryBaseDelayMs > l.retryMaxDelayMs)
      problems.push('retryBaseDelayMs must not exceed retryMaxDelayMs');
    if (l.maxRecordBytes > l.maxContextBytes)
      problems.push('maxRecordBytes must not exceed maxContextBytes');
    if (l.maxInputTokensPerCall + l.maxOutputTokens > l.maxTotalTokens)
      problems.push(
        'maxTotalTokens must be at least maxInputTokensPerCall + maxOutputTokens, the ceiling of one call',
      );
  }
  if (problems.length > 0) throw new InvestigationConfigError(problems);
  return l;
}
