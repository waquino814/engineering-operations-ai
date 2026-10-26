/**
 * Failure classes recorded in an investigation result (ADR 0006). Expected failures become a
 * result with `outcome` "failed" or "budget_exceeded", never an exception and never a result that
 * looks successful.
 */
export const FAILURE_CLASSES = [
  'invalid_bundle',
  'unsupported_contract_version',
  'invalid_configuration',
  'provider_timeout',
  'provider_rate_limited',
  'provider_unavailable',
  'provider_authentication',
  'provider_rejected_request',
  'malformed_provider_response',
  'invalid_result',
  'evidence_verification_failed',
  'resource_limit_exceeded',
  'cancelled',
  'internal_error',
] as const;

export type FailureClass = (typeof FAILURE_CLASSES)[number];

export interface Failure {
  class: FailureClass;
  /** Short, sanitised, and free of telemetry content and credentials. */
  message: string;
}

const MAX_MESSAGE = 300;
const SECRET_PATTERNS: RegExp[] = [
  /bearer\s+[a-z0-9._~+/=-]+/gi,
  /\b(sk|pk|rk)-[a-z0-9_-]{8,}/gi,
  /\b(api[_-]?key|authorization|x-api-key|token|secret|password)\b\s*[:=]\s*\S+/gi,
];

/** Removes credential-like strings and bounds the length of a message before it is recorded. */
export function sanitizeMessage(message: string): string {
  let out = message;
  for (const p of SECRET_PATTERNS) out = out.replace(p, '[redacted]');
  out = out.replace(/\s+/g, ' ').trim();
  return out.length > MAX_MESSAGE ? `${out.slice(0, MAX_MESSAGE - 1)}…` : out;
}

export function failure(cls: FailureClass, message: string): Failure {
  return { class: cls, message: sanitizeMessage(message) };
}
