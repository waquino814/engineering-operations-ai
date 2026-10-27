import { describe, expect, it } from 'vitest';
import { createInvestigator, DEFAULT_LIMITS } from '../../src/index.ts';
import { excerptView, goodOutput } from '../investigation/support.ts';
import { MODEL_OUTPUT_SCHEMA } from '../../src/investigation/schemas.ts';
import { ProviderError } from '../../src/investigation/provider.ts';
import {
  AnthropicProvider,
  createAnthropicProvider,
  type AnthropicClientLike,
} from '../../src/providers/anthropic/provider.ts';

interface Call {
  params: Record<string, unknown>;
  options: { signal: AbortSignal; maxRetries: number };
}
function stub(outcomes: unknown[]) {
  const calls: Call[] = [];
  const client: AnthropicClientLike = {
    messages: {
      stream(params, options) {
        calls.push({ params, options });
        const next = outcomes.shift();
        return {
          finalMessage: () =>
            next instanceof Error ? Promise.reject(next) : Promise.resolve(next),
        };
      },
    },
  };
  return { client, calls };
}
const request = {
  instructions: 'inst',
  input: '{}',
  outputSchema: MODEL_OUTPUT_SCHEMA,
  maxOutputTokens: 500,
};
const signal = () => new AbortController().signal;
const sdkError = (name: string, status?: number) =>
  Object.assign(new Error(name), { name, status });

describe('AnthropicProvider', () => {
  it('streams one request with SDK retries off and returns text with mapped usage', async () => {
    const { client, calls } = stub([
      {
        content: [{ type: 'text', text: '{"ok":true}' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 2 },
      },
    ]);
    const provider = new AnthropicProvider(client, { model: 'claude-opus-5-5', effort: 'medium' });
    const s = signal();
    const reply = await provider.complete(request, { signal: s });
    expect(reply).toEqual({ text: '{"ok":true}', usage: { inputTokens: 15, outputTokens: 2 } });
    expect(provider.provider).toBe('anthropic');
    expect(provider.model).toBe('claude-opus-5-5');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.options).toEqual({ signal: s, maxRetries: 0 });
    expect(calls[0]?.params).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 500,
      system: 'inst',
      output_config: { effort: 'medium' },
    });
    expect(JSON.stringify(calls[0]?.params)).not.toContain('maxLength');
  });

  it('returns truncated text for max_tokens', async () => {
    const { client } = stub([
      { content: [{ type: 'text', text: '{"a' }], stop_reason: 'max_tokens' },
    ]);
    const reply = await new AnthropicProvider(client, { model: 'm' }).complete(request, {
      signal: signal(),
    });
    expect(reply.text).toBe('{"a');
    expect(reply.usage).toBeUndefined();
  });

  it('raises rejected_request for a refusal and keeps its billed usage', async () => {
    const { client } = stub([
      { content: [], stop_reason: 'refusal', usage: { input_tokens: 7, output_tokens: 1 } },
    ]);
    const error = await new AnthropicProvider(client, { model: 'm' })
      .complete(request, { signal: signal() })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({
      kind: 'rejected_request',
      usage: { inputTokens: 7, outputTokens: 1 },
    });
  });

  it.each([
    [sdkError('RateLimitError', 429), 'rate_limited'],
    [sdkError('AuthenticationError', 401), 'authentication'],
    [sdkError('InternalServerError', 529), 'unavailable'],
    [sdkError('APIConnectionTimeoutError'), 'timeout'],
    [sdkError('BadRequestError', 400), 'rejected_request'],
  ])('maps SDK error %#', async (error, kind) => {
    const { client } = stub([error]);
    const caught = await new AnthropicProvider(client, { model: 'm' })
      .complete(request, { signal: signal() })
      .catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(ProviderError);
    expect((caught as ProviderError).kind).toBe(kind);
    expect((caught as ProviderError).usage).toBeUndefined();
  });

  it('creates the real client without a request', () => {
    const provider = createAnthropicProvider('test-key', { model: 'claude-sonnet-5-5' });
    expect(provider.model).toBe('claude-sonnet-5-5');
  });
});

describe('AnthropicProvider under the investigator', () => {
  it('retries a rate limit once, by the investigator, and charges unknown usage at the ceiling', async () => {
    const { client, calls } = stub([
      sdkError('RateLimitError', 429),
      sdkError('RateLimitError', 429),
    ]);
    const sleeps: number[] = [];
    const result = await createInvestigator({
      provider: new AnthropicProvider(client, { model: 'm' }),
      limits: { maxModelCalls: 2, maxRetries: 1 },
      now: () => 0,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    }).investigate(await excerptView());
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.options.maxRetries === 0)).toBe(true);
    expect(sleeps).toHaveLength(1);
    expect(result.outcome).toBe('failed');
    expect(result.failure?.class).toBe('provider_rate_limited');
    const { maxInputTokensPerCall, maxOutputTokens } = DEFAULT_LIMITS;
    expect(result.run.usage).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      chargedTokens: 2 * (maxInputTokensPerCall + maxOutputTokens),
      tokenAccounting: 'estimated',
    });
  });

  it('accounts reported usage, cached input included, for a valid reply', async () => {
    const view = await excerptView();
    const { client } = stub([
      {
        content: [{ type: 'text', text: JSON.stringify(goodOutput(view)) }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 100, cache_creation_input_tokens: 50, output_tokens: 20 },
      },
    ]);
    const result = await createInvestigator({
      provider: new AnthropicProvider(client, { model: 'm' }),
      now: () => 0,
    }).investigate(view);
    expect(result.run.usage).toMatchObject({
      inputTokens: 150,
      outputTokens: 20,
      chargedTokens: 170,
      tokenAccounting: 'reported',
    });
  });
});
