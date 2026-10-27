/**
 * The runnable application's provider policy (ADR 0012, ADR 0013): no hosted AI request and no
 * spending. The only providers are the deterministic `fake` (simulated output, labelled as such)
 * and `ollama` (a verified local model on a loopback runtime). The allowlist is code: no flag,
 * environment variable, setting or request adds to it, and nothing here imports a hosted adapter.
 */
export const PERMITTED_PROVIDERS = ['fake', 'ollama'] as const;
export type ProviderName = (typeof PERMITTED_PROVIDERS)[number];

export class ProviderPolicyError extends Error {
  readonly code = 'provider_not_permitted';
  constructor(message: string) {
    super(message);
    this.name = 'ProviderPolicyError';
  }
}

export type AppEnv = Readonly<Record<string, string | undefined>>;

/** Names a plain word may be echoed; anything else could be a pasted secret and is not. */
const ECHOABLE = /^[a-z][a-z0-9_-]{0,31}$/;

export function isProviderName(value: unknown): value is ProviderName {
  return typeof value === 'string' && (PERMITTED_PROVIDERS as readonly string[]).includes(value);
}

/** Exactly a permitted name; anything else (`anthropic`, `local`, `Fake`, ` fake`) fails closed. */
export function parseProviderName(raw: string): ProviderName {
  if (isProviderName(raw)) return raw;
  throw new ProviderPolicyError(
    `provider ${ECHOABLE.test(raw) ? `"${raw}"` : '(value withheld)'} is not permitted; ` +
      `the application allows only ${PERMITTED_PROVIDERS.join(' and ')}`,
  );
}

/** `EOAI_MODEL_PROVIDER`, when set, pins the provider and the Settings page cannot change it. */
export function pinnedProvider(env: AppEnv): ProviderName | null {
  const raw = env['EOAI_MODEL_PROVIDER'];
  return raw === undefined || raw === '' ? null : parseProviderName(raw);
}
