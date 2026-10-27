import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeProvider } from '../../src/investigation/fake-provider.ts';
import { AnthropicProvider } from '../../src/providers/anthropic/provider.ts';
import { ProviderConfigError, selectProvider } from '../../src/providers/select.ts';

const KEY = 'sk-ant-test-secret-value';
const good = {
  EOAI_MODEL_PROVIDER: 'anthropic',
  ANTHROPIC_API_KEY: KEY,
  EOAI_ANTHROPIC_MODEL: 'claude-opus-5-5',
};

const fetchSpy = vi.fn(() => {
  throw new Error('network access attempted in a test');
});
beforeEach(() => {
  fetchSpy.mockClear();
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const problems = (env: Record<string, string | undefined>) => {
  try {
    selectProvider(env);
  } catch (e) {
    expect(e).toBeInstanceOf(ProviderConfigError);
    return { message: (e as Error).message, list: (e as ProviderConfigError).problems };
  }
  throw new Error('expected a configuration error');
};

describe('selectProvider', () => {
  it('defaults to the fake provider with nothing configured, and for "fake"', () => {
    for (const env of [{}, { EOAI_MODEL_PROVIDER: '' }, { EOAI_MODEL_PROVIDER: 'fake' }]) {
      const p = selectProvider(env);
      expect(p).toBeInstanceOf(FakeProvider);
      expect(p.provider).toBe('fake');
    }
  });

  it('ignores Anthropic settings unless the provider is explicitly selected', () => {
    const p = selectProvider({ ANTHROPIC_API_KEY: KEY, EOAI_ANTHROPIC_MODEL: 'claude-opus-5-5' });
    expect(p).toBeInstanceOf(FakeProvider);
  });

  it('passes scripted steps to the fake provider', () => {
    const p = selectProvider({}, { fakeSteps: [{ reply: '{}' }] }) as FakeProvider;
    expect(p.remaining).toBe(1);
  });

  it('builds the Anthropic provider when selected and configured, without any request', () => {
    const p = selectProvider({ ...good, EOAI_ANTHROPIC_EFFORT: 'low' });
    expect(p).toBeInstanceOf(AnthropicProvider);
    expect(p.provider).toBe('anthropic');
    expect(p.model).toBe('claude-opus-5-5');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects an unknown provider name instead of falling back', () => {
    expect(problems({ EOAI_MODEL_PROVIDER: 'openai' }).list).toEqual([
      'EOAI_MODEL_PROVIDER must be "fake" or "anthropic"',
    ]);
  });

  it('rejects a missing or malformed key, model and effort, naming variables only', () => {
    const missing = problems({ EOAI_MODEL_PROVIDER: 'anthropic' });
    expect(missing.list).toHaveLength(2);
    expect(problems({ ...good, ANTHROPIC_API_KEY: '   ' }).list[0]).toMatch(/ANTHROPIC_API_KEY/);
    expect(problems({ ...good, ANTHROPIC_API_KEY: 'a b' }).list[0]).toMatch(/ANTHROPIC_API_KEY/);
    expect(problems({ ...good, EOAI_ANTHROPIC_MODEL: 'bad model!' }).list[0]).toMatch(/MODEL/);
    expect(problems({ ...good, EOAI_ANTHROPIC_EFFORT: 'LOW HIGH' }).list[0]).toMatch(/EFFORT/);
  });

  it('never puts the key in an error message', () => {
    const bad = { ...good, ANTHROPIC_API_KEY: `${KEY} with space`, EOAI_ANTHROPIC_MODEL: '' };
    const { message, list } = problems(bad);
    expect(message).not.toContain(KEY);
    expect(JSON.stringify(list)).not.toContain(KEY);
  });

  it('does not fall back to the fake provider when a real one is misconfigured', () => {
    expect(() => selectProvider({ EOAI_MODEL_PROVIDER: 'anthropic' })).toThrow(ProviderConfigError);
  });

  it('makes no network request for any selection', () => {
    selectProvider({});
    selectProvider(good);
    expect(() => selectProvider({ EOAI_MODEL_PROVIDER: 'anthropic' })).toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
