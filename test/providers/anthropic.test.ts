import { describe, expect, it } from 'vitest';
import { MODEL_OUTPUT_SCHEMA } from '../../src/investigation/schemas.ts';
import { ProviderError } from '../../src/investigation/provider.ts';
import {
  buildMessageParams,
  mapError,
  mapMessage,
  mapUsage,
} from '../../src/providers/anthropic/mapping.ts';
import { toWireSchema } from '../../src/providers/anthropic/wire-schema.ts';

const UNSUPPORTED = ['minLength', 'maxLength', 'minimum', 'maxItems', 'prefixItems', '$id'];

describe('toWireSchema', () => {
  it('drops every keyword outside the provider subset from the model output schema', () => {
    const { schema, dropped } = toWireSchema(MODEL_OUTPUT_SCHEMA);
    const text = JSON.stringify(schema);
    for (const k of UNSUPPORTED) expect(text).not.toContain(`"${k}"`);
    expect(dropped).toEqual(expect.arrayContaining(['maxItems', 'maxLength', 'minLength']));
    expect(text).not.toMatch(/"minItems":([2-9]|\d\d)/);
    expect(text).not.toMatch(/"additionalProperties":\{/);
    // Closed objects and required lists survive.
    expect(text).toContain('"additionalProperties":false');
    expect(text).toContain('"required"');
  });

  it('keeps a property whose name is a dropped keyword, and does not mutate the input', () => {
    const input = { type: 'object', properties: { maxItems: { type: 'string', maxLength: 3 } } };
    const copy = JSON.stringify(input);
    const { schema } = toWireSchema(input);
    expect(schema).toEqual({ type: 'object', properties: { maxItems: { type: 'string' } } });
    expect(JSON.stringify(input)).toBe(copy);
  });

  it('keeps minItems 0 and 1 and drops larger values', () => {
    const { schema, dropped } = toWireSchema({
      a: { minItems: 1 },
      b: { minItems: 0 },
      c: { minItems: 2 },
    });
    expect(schema).toEqual({ a: { minItems: 1 }, b: { minItems: 0 }, c: {} });
    expect(dropped).toEqual(['minItems']);
  });
});

describe('buildMessageParams', () => {
  const request = {
    instructions: 'be exact',
    input: '{"evidence":[]}',
    outputSchema: MODEL_OUTPUT_SCHEMA,
    maxOutputTokens: 4000,
  };
  it('maps the port request to a Messages API body, with effort only when configured', () => {
    const params = buildMessageParams(request, { model: 'claude-opus-5-5', effort: 'low' });
    expect(params).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 4000,
      system: 'be exact',
      messages: [{ role: 'user', content: '{"evidence":[]}' }],
      output_config: { effort: 'low', format: { type: 'json_schema' } },
    });
    const bare = buildMessageParams(request, { model: 'm' });
    expect(Object.keys(bare['output_config'] as object)).toEqual(['format']);
  });
});

describe('mapUsage', () => {
  it('sums cached input into input and reads output_tokens', () => {
    expect(
      mapUsage({
        input_tokens: 10,
        cache_creation_input_tokens: 5,
        cache_read_input_tokens: 7,
        output_tokens: 3,
      }),
    ).toEqual({ inputTokens: 22, outputTokens: 3 });
  });
  it('treats absent or null cache fields as zero', () => {
    expect(mapUsage({ input_tokens: 4, cache_read_input_tokens: null, output_tokens: 1 })).toEqual({
      inputTokens: 4,
      outputTokens: 1,
    });
  });
  it('leaves out what is missing or malformed instead of writing zero', () => {
    expect(mapUsage({ output_tokens: 2 })).toEqual({ outputTokens: 2 });
    expect(mapUsage({ input_tokens: 'x', output_tokens: -1 })).toEqual({});
    expect(mapUsage({ input_tokens: 4, cache_read_input_tokens: 'x' })).toEqual({});
    expect(mapUsage(undefined)).toBeUndefined();
  });
});

describe('mapMessage', () => {
  it('joins text blocks and ignores thinking blocks', () => {
    const reply = mapMessage({
      content: [
        { type: 'thinking', thinking: 'secret' },
        { type: 'text', text: '{"a":' },
        { type: 'text', text: '1}' },
      ],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 2 },
    });
    expect(reply).toEqual({ text: '{"a":1}', usage: { inputTokens: 1, outputTokens: 2 } });
  });
  it('returns truncated text for max_tokens so that repair can handle it', () => {
    expect(
      mapMessage({ content: [{ type: 'text', text: '{"a' }], stop_reason: 'max_tokens' }).text,
    ).toBe('{"a');
  });
  it('raises rejected_request for a refusal, keeping the billed usage', () => {
    try {
      mapMessage({
        content: [],
        stop_reason: 'refusal',
        usage: { input_tokens: 9, output_tokens: 1 },
      });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError);
      expect((e as ProviderError).kind).toBe('rejected_request');
      expect((e as ProviderError).usage).toEqual({ inputTokens: 9, outputTokens: 1 });
    }
  });
  it('tolerates a malformed message', () => {
    expect(mapMessage(null)).toEqual({ text: '' });
  });
});

describe('mapError', () => {
  const err = (name: string, status?: number, headers?: unknown) =>
    Object.assign(new Error(name), { name, status, headers });
  const kind = (e: unknown) => mapError(e).kind;
  it('maps SDK errors by name and status', () => {
    expect(kind(err('APIConnectionTimeoutError'))).toBe('timeout');
    expect(kind(err('APIConnectionError'))).toBe('unavailable');
    expect(kind(err('RateLimitError', 429))).toBe('rate_limited');
    expect(kind(err('AuthenticationError', 401))).toBe('authentication');
    expect(kind(err('PermissionDeniedError', 403))).toBe('authentication');
    expect(kind(err('InternalServerError', 529))).toBe('unavailable');
    expect(kind(err('ConflictError', 409))).toBe('unavailable');
    expect(kind(err('RequestTimeout', 408))).toBe('timeout');
    expect(kind(err('BadRequestError', 400))).toBe('rejected_request');
    expect(kind(err('APIUserAbortError'))).toBe('timeout');
  });
  it('reads retry-after from a plain record or a Headers object', () => {
    expect(mapError(err('RateLimitError', 429, { 'retry-after': '7' })).retryAfterMs).toBe(7000);
    expect(
      mapError(err('RateLimitError', 429, new Headers({ 'retry-after': '1.5' }))).retryAfterMs,
    ).toBe(1500);
    expect(
      mapError(err('RateLimitError', 429, { 'retry-after': 'soon' })).retryAfterMs,
    ).toBeUndefined();
    expect(mapError(err('RateLimitError', 429)).retryAfterMs).toBeUndefined();
  });
  it('leaves usage unknown so a failed call is charged at its ceiling', () => {
    expect(mapError(err('RateLimitError', 429)).usage).toBeUndefined();
  });
  it('ends the investigation on an unrecognised error and passes a ProviderError through', () => {
    expect(kind(new Error('boom'))).toBe('rejected_request');
    expect(kind('weird')).toBe('rejected_request');
    const own = new ProviderError('timeout', 'x');
    expect(mapError(own)).toBe(own);
  });
});
