import { FakeProvider, type FakeStep } from '../investigation/fake-provider.ts';
import type { ModelProvider } from '../investigation/provider.ts';
import { createAnthropicProvider } from './anthropic/provider.ts';

/**
 * Provider selection from configuration (ADR 0002, ADR 0008). The environment is passed in, so
 * this module reads no process state and a test supplies its own. Selecting a provider only
 * validates settings and constructs objects: it never makes a request. With nothing configured the
 * result is the fake provider; a requested real provider is never replaced by another one, and a
 * bad configuration throws instead of falling back.
 */
export class ProviderConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    // Problems name variables, never their values, so a key cannot reach a message.
    super(`invalid model provider configuration: ${problems.join('; ')}`);
    this.name = 'ProviderConfigError';
    this.problems = problems;
  }
}

export type ProviderEnv = Readonly<Record<string, string | undefined>>;

export interface SelectOptions {
  /** Scripted replies for the fake provider; tests and the evaluation harness set these. */
  fakeSteps?: FakeStep[];
}

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const EFFORT = /^[a-z][a-z0-9_-]{0,31}$/;

export function selectProvider(env: ProviderEnv, options: SelectOptions = {}): ModelProvider {
  const name = env['EOAI_MODEL_PROVIDER']?.trim() ?? '';
  if (name === '' || name === 'fake') return new FakeProvider(options.fakeSteps ?? []);
  if (name !== 'anthropic') {
    throw new ProviderConfigError(['EOAI_MODEL_PROVIDER must be "fake" or "anthropic"']);
  }
  const problems: string[] = [];
  const apiKey = env['ANTHROPIC_API_KEY'] ?? '';
  // Presence only: whether the key is valid is known to the provider alone, at the first request.
  if (apiKey.trim() === '' || /\s/.test(apiKey.trim()))
    problems.push('ANTHROPIC_API_KEY must be set and contain no whitespace');
  const model = env['EOAI_ANTHROPIC_MODEL']?.trim() ?? '';
  if (!MODEL_ID.test(model)) problems.push('EOAI_ANTHROPIC_MODEL must be set to a model ID');
  const effort = env['EOAI_ANTHROPIC_EFFORT']?.trim();
  if (effort !== undefined && effort !== '' && !EFFORT.test(effort))
    problems.push('EOAI_ANTHROPIC_EFFORT must be a lowercase word');
  if (problems.length > 0) throw new ProviderConfigError(problems);
  return createAnthropicProvider(apiKey.trim(), {
    model,
    ...(effort ? { effort } : {}),
  });
}
