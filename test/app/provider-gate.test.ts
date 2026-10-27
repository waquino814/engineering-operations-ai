import { describe, expect, it } from 'vitest';
import { FakeProvider } from '../../src/investigation/fake-provider.ts';
import {
  gateProvider,
  PERMITTED_PROVIDERS,
  ProviderPolicyError,
  resolveProviderName,
} from '../../src/app/provider-gate.ts';
import { fetchSpy } from './support.ts';

const refused = (env: Record<string, string>) => {
  try {
    gateProvider(env);
  } catch (e) {
    expect(e).toBeInstanceOf(ProviderPolicyError);
    return e as ProviderPolicyError;
  }
  throw new Error('expected the gate to refuse');
};

describe('the provider gate', () => {
  it('permits exactly fake and local', () => {
    expect([...PERMITTED_PROVIDERS]).toEqual(['fake', 'local']);
  });

  it('defaults to the fake provider when nothing is set, and accepts "fake"', () => {
    for (const env of [{}, { EOAI_MODEL_PROVIDER: '' }, { EOAI_MODEL_PROVIDER: 'fake' }]) {
      const g = gateProvider(env);
      expect(g.name).toBe('fake');
      expect(g.provider).toBeInstanceOf(FakeProvider);
      expect(g.provider.provider).toBe('fake');
    }
  });

  it('marks the fake provider runnable only when replies were scripted', () => {
    expect(gateProvider({}).runnable).toBe(false);
    expect(gateProvider({}, { fakeSteps: [] }).runnable).toBe(true);
  });

  it('refuses anthropic, even with every setting that would have enabled it', () => {
    const e = refused({
      EOAI_MODEL_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: 'sk-ant-secret',
      EOAI_ANTHROPIC_MODEL: 'claude-opus-5-5',
    });
    expect(e.code).toBe('provider_not_permitted');
    expect(e.message).not.toContain('sk-ant-secret');
  });

  it.each(['openai', 'ollama', 'Fake', 'LOCAL', ' fake', 'fake ', 'anthropic ', 'x'.repeat(40)])(
    'fails closed for the unknown value %j',
    (value) => {
      expect(refused({ EOAI_MODEL_PROVIDER: value }).code).toBe('provider_not_permitted');
    },
  );

  it('withholds a value that does not look like a provider name', () => {
    const e = refused({ EOAI_MODEL_PROVIDER: 'sk-ant-api03-SECRET/value' });
    expect(e.message).not.toContain('SECRET');
    expect(e.message).toContain('value withheld');
  });

  it('blocks the local provider until local-only operation is verified', () => {
    expect(resolveProviderName({ EOAI_MODEL_PROVIDER: 'local' })).toBe('local');
    expect(refused({ EOAI_MODEL_PROVIDER: 'local' }).code).toBe('local_provider_blocked');
  });

  it('makes no network request while resolving or refusing', () => {
    gateProvider({});
    for (const v of ['anthropic', 'local', 'nope']) refused({ EOAI_MODEL_PROVIDER: v });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
