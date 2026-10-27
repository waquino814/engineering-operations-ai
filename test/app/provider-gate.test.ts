import { describe, expect, it } from 'vitest';
import {
  isProviderName,
  parseProviderName,
  PERMITTED_PROVIDERS,
  pinnedProvider,
  ProviderPolicyError,
} from '../../src/app/provider-gate.ts';

const refused = (value: string) => {
  try {
    parseProviderName(value);
  } catch (e) {
    expect(e).toBeInstanceOf(ProviderPolicyError);
    return e as ProviderPolicyError;
  }
  throw new Error('expected the gate to refuse');
};

describe('the provider allowlist', () => {
  it('permits exactly fake and ollama', () => {
    expect([...PERMITTED_PROVIDERS]).toEqual(['fake', 'ollama']);
    expect(parseProviderName('fake')).toBe('fake');
    expect(parseProviderName('ollama')).toBe('ollama');
    expect(isProviderName('ollama')).toBe(true);
    expect(isProviderName('anthropic')).toBe(false);
    expect(isProviderName(undefined)).toBe(false);
  });

  it.each([
    'anthropic',
    'openai',
    'local',
    'Fake',
    'OLLAMA',
    ' fake',
    'fake ',
    'ollama-cloud',
    'x'.repeat(40),
  ])('fails closed for %j', (value) => {
    expect(refused(value).code).toBe('provider_not_permitted');
  });

  it('withholds a value that does not look like a provider name', () => {
    const e = refused('sk-ant-api03-SECRET/value');
    expect(e.message).not.toContain('SECRET');
    expect(e.message).toContain('value withheld');
  });

  it('pins the provider only when EOAI_MODEL_PROVIDER is set, and refuses anything else', () => {
    expect(pinnedProvider({})).toBeNull();
    expect(pinnedProvider({ EOAI_MODEL_PROVIDER: '' })).toBeNull();
    expect(pinnedProvider({ EOAI_MODEL_PROVIDER: 'ollama' })).toBe('ollama');
    expect(() =>
      pinnedProvider({ EOAI_MODEL_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'k' }),
    ).toThrow(ProviderPolicyError);
  });
});
