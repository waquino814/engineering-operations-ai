import { FakeProvider, type FakeStep } from '../investigation/fake-provider.ts';
import type { ModelProvider } from '../investigation/provider.ts';

/**
 * The runnable application's provider policy (ADR 0012, ADR 0013): no hosted AI request and no
 * spending. Only deterministic fake execution and verified local-only inference are permitted, and
 * anything else fails closed. The allowlist is code: no flag, environment variable, setting or
 * option adds to it, and nothing here imports a hosted adapter or SDK.
 */
export const PERMITTED_PROVIDERS = ['fake', 'local'] as const;
export type PermittedProvider = (typeof PERMITTED_PROVIDERS)[number];

export type ProviderPolicyCode = 'provider_not_permitted' | 'local_provider_blocked';

export class ProviderPolicyError extends Error {
  readonly code: ProviderPolicyCode;
  constructor(code: ProviderPolicyCode, message: string) {
    super(message);
    this.name = 'ProviderPolicyError';
    this.code = code;
  }
}

export type AppEnv = Readonly<Record<string, string | undefined>>;

/** Names a plain word may be echoed; anything else could be a pasted secret and is not. */
const ECHOABLE = /^[a-z][a-z0-9_-]{0,31}$/;

/** Unset or empty means `fake`; every other value must be exactly a permitted name. */
export function resolveProviderName(env: AppEnv): PermittedProvider {
  const raw = env['EOAI_MODEL_PROVIDER'];
  if (raw === undefined || raw === '') return 'fake';
  if ((PERMITTED_PROVIDERS as readonly string[]).includes(raw)) return raw as PermittedProvider;
  throw new ProviderPolicyError(
    'provider_not_permitted',
    `EOAI_MODEL_PROVIDER ${ECHOABLE.test(raw) ? `"${raw}"` : '(value withheld)'} is not permitted; ` +
      `the application allows only ${PERMITTED_PROVIDERS.join(' and ')}`,
  );
}

export interface GatedProvider {
  name: PermittedProvider;
  provider: ModelProvider;
  /**
   * False for a fake provider with no scripted replies: it exists, but cannot produce an
   * investigation, and the application must not pretend otherwise.
   */
  runnable: boolean;
}

/**
 * Resolves and constructs the permitted provider. Construction performs no I/O. `local` is
 * refused until local-only operation is implemented and verified (ADR 0013, section 2).
 */
export function gateProvider(env: AppEnv, options: { fakeSteps?: FakeStep[] } = {}): GatedProvider {
  const name = resolveProviderName(env);
  if (name === 'local') {
    throw new ProviderPolicyError(
      'local_provider_blocked',
      'the local provider is blocked until local-only operation is implemented and verified',
    );
  }
  return {
    name,
    provider: new FakeProvider(options.fakeSteps ?? []),
    runnable: options.fakeSteps !== undefined,
  };
}
