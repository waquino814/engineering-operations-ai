import {
  ProviderError,
  type ModelReply,
  type ModelRequest,
  type UsageReport,
} from '../../investigation/provider.ts';
import { toWireSchema } from './wire-schema.ts';

/**
 * Pure mapping between the provider-neutral port and the Anthropic Messages API (ADR 0008). It
 * takes and returns plain data and imports no SDK, so it is tested without network or
 * credentials; the thin client call that uses it is added with the SDK once ADR 0008 is accepted.
 */
type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null;
const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

export interface AnthropicSettings {
  model: string;
  /** `output_config.effort`; omitted means the model's default. */
  effort?: string;
}

/** The body of one Messages API call. Thinking is left to the model's default (ADR 0008). */
export function buildMessageParams(request: ModelRequest, settings: AnthropicSettings): Json {
  return {
    model: settings.model,
    max_tokens: request.maxOutputTokens,
    system: request.instructions,
    messages: [{ role: 'user', content: request.input }],
    output_config: {
      format: { type: 'json_schema', schema: toWireSchema(request.outputSchema).schema },
      ...(settings.effort ? { effort: settings.effort } : {}),
    },
  };
}

/**
 * Output from `output_tokens`; input as the sum of `input_tokens` and both cache fields, since
 * cached input is still input. Absent cache fields count as zero (no caching happened); an absent
 * or malformed primary field is left out, so the investigator charges its ceiling.
 */
export function mapUsage(usage: unknown): UsageReport | undefined {
  if (!isObject(usage)) return undefined;
  const report: UsageReport = {};
  if (isCount(usage['output_tokens'])) report.outputTokens = usage['output_tokens'];
  const cache = [usage['cache_creation_input_tokens'], usage['cache_read_input_tokens']].map((v) =>
    v === undefined || v === null ? 0 : v,
  );
  if (isCount(usage['input_tokens']) && cache.every(isCount)) {
    report.inputTokens = usage['input_tokens'] + cache.reduce((a, b) => a + b, 0);
  }
  return report;
}

/** The reply text of a finished message; thinking and other non-text blocks are ignored. */
export function mapMessage(message: unknown): ModelReply {
  const body = isObject(message) ? message : {};
  const usage = mapUsage(body['usage']);
  if (body['stop_reason'] === 'refusal') {
    // A refusal is HTTP 200 and billed, so its usage is real consumption.
    throw new ProviderError('rejected_request', 'the model refused the request', undefined, usage);
  }
  const content = Array.isArray(body['content']) ? (body['content'] as unknown[]) : [];
  const text = content
    .map((b) =>
      isObject(b) && b['type'] === 'text' && typeof b['text'] === 'string' ? b['text'] : '',
    )
    .join('');
  // `max_tokens` is not an error here: the truncated text fails parsing and goes to repair.
  return { text, ...(usage ? { usage } : {}) };
}

function retryAfterMs(headers: unknown): number | undefined {
  const raw = isObject(headers)
    ? typeof headers['get'] === 'function'
      ? (headers['get'] as (n: string) => unknown).call(headers, 'retry-after')
      : headers['retry-after']
    : undefined;
  const seconds = typeof raw === 'string' || typeof raw === 'number' ? Number(raw) : NaN;
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : undefined;
}

/**
 * Maps an SDK error (by its documented name and HTTP status) onto the port. Usage is left unknown
 * for every error: ADR 0008 has not yet verified when a failed call is free, so each is charged
 * at its ceiling. An unrecognised error ends the investigation rather than being retried.
 */
export function mapError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  const e = isObject(error) ? error : {};
  const name = typeof e['name'] === 'string' ? e['name'] : '';
  const status = typeof e['status'] === 'number' ? e['status'] : undefined;
  const message = error instanceof Error ? error.message : 'unknown provider error';
  if (name === 'APIConnectionTimeoutError' || status === 408)
    return new ProviderError('timeout', message);
  if (name === 'APIUserAbortError') return new ProviderError('timeout', 'request aborted');
  if (name === 'APIConnectionError') return new ProviderError('unavailable', message);
  if (status === 429) return new ProviderError('rate_limited', message, retryAfterMs(e['headers']));
  if (status === 401 || status === 403) return new ProviderError('authentication', message);
  if (status === 409 || (status !== undefined && status >= 500))
    return new ProviderError('unavailable', message, retryAfterMs(e['headers']));
  return new ProviderError('rejected_request', message);
}
