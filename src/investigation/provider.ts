/**
 * The provider-neutral model port (ADR 0002). The investigation domain depends only on these
 * types; a concrete provider lives in an adapter that implements `ModelProvider` and maps its own
 * errors onto `ProviderError`. No provider SDK type crosses this boundary.
 */
export interface ModelRequest {
  /** Fixed instructions. Never contains telemetry. */
  instructions: string;
  /** The evidence and context, as a JSON document; untrusted data, not instructions. */
  input: string;
  /** JSON Schema the reply must satisfy. */
  outputSchema: object;
  maxOutputTokens: number;
}

/**
 * Token usage as the provider reports it for one call. Adapters translate their provider's own
 * fields into these two; the investigator validates them (src/investigation/usage.ts) and never
 * derives tokens from bytes. Absent means "not reported", which is charged conservatively.
 */
export interface UsageReport {
  inputTokens?: number;
  outputTokens?: number;
}

export interface ModelReply {
  /** The model's reply text, expected to be one JSON document. */
  text: string;
  usage?: UsageReport;
}

export interface ModelProvider {
  /** Recorded in results; no secrets. */
  readonly provider: string;
  readonly model: string;
  complete(request: ModelRequest, options: { signal: AbortSignal }): Promise<ModelReply>;
}

export type ProviderErrorKind =
  'timeout' | 'rate_limited' | 'unavailable' | 'authentication' | 'rejected_request';

/** Transient kinds are retried, within the limits; the others end the investigation. */
export const TRANSIENT_KINDS: readonly ProviderErrorKind[] = [
  'timeout',
  'rate_limited',
  'unavailable',
];

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly retryAfterMs: number | undefined;
  /**
   * What the failed call consumed, when the provider's documented semantics say so (for example,
   * zero for a request rejected before processing). Undefined means unknown, and the call is
   * charged at its ceiling.
   */
  readonly usage: UsageReport | undefined;
  constructor(
    kind: ProviderErrorKind,
    message: string,
    retryAfterMs?: number,
    usage?: UsageReport,
  ) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
    this.usage = usage;
  }
}
