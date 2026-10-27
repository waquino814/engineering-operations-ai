import { describe, expect, it } from 'vitest';
import { ProviderError } from '../../src/investigation/provider.ts';
import { MODEL_OUTPUT_SCHEMA } from '../../src/investigation/schemas.ts';
import {
  createOllamaHttp,
  OllamaEndpointError,
  resolveOllamaEndpoint,
  type FetchLike,
} from '../../src/providers/ollama/client.ts';
import { LOCAL_GUIDANCE, OllamaProvider } from '../../src/providers/ollama/provider.ts';
import { verifyLocalModel } from '../../src/providers/ollama/verify.ts';
import { chatReply, ollamaStub, type StubModel } from './ollama-stub.ts';

interface ChatBody {
  format: unknown;
  messages: { role: string; content: string }[];
  [key: string]: unknown;
}
const http = (stub: { fetch: FetchLike }) =>
  createOllamaHttp(resolveOllamaEndpoint(undefined), stub.fetch);
const request = {
  instructions: 'inst',
  input: '{"evidence":[]}',
  outputSchema: MODEL_OUTPUT_SCHEMA,
  maxOutputTokens: 500,
};
const signal = () => new AbortController().signal;

describe('the Ollama endpoint', () => {
  it('defaults to loopback and accepts only loopback http', () => {
    expect(resolveOllamaEndpoint(undefined).href).toBe('http://127.0.0.1:11434/');
    expect(resolveOllamaEndpoint('  ').href).toBe('http://127.0.0.1:11434/');
    expect(resolveOllamaEndpoint('http://localhost:9999').href).toBe('http://127.0.0.1:9999/');
    expect(resolveOllamaEndpoint('http://[::1]:11434/').hostname).toBe('[::1]');
    for (const bad of [
      'https://127.0.0.1:11434',
      'http://0.0.0.0:11434',
      'http://192.168.1.4:11434',
      'http://example.com',
      'http://ollama.com',
      'http://user:pw@127.0.0.1:11434',
      'http://127.0.0.1:11434/api',
      'http://127.0.0.1:11434/?x=1',
      'http://127.0.0.1.evil.example',
      'http://127.0.0.2:11434',
      'ftp://127.0.0.1',
      'not a url',
    ])
      expect(() => resolveOllamaEndpoint(bad), bad).toThrow(OllamaEndpointError);
  });

  it('reaches only the three paths the adapter needs, refuses redirects, and tolerates non-JSON', async () => {
    const seen: { url: string; redirect: string }[] = [];
    const fetchStub: FetchLike = (input, init) => {
      seen.push({ url: input, redirect: init.redirect });
      return Promise.resolve({ status: 200, text: () => Promise.resolve('not json') });
    };
    const client = createOllamaHttp(resolveOllamaEndpoint(undefined), fetchStub);
    expect(client.endpoint).toBe('http://127.0.0.1:11434/');
    expect(await client.get('/api/tags')).toEqual({ status: 200, body: undefined });
    await client.post('/api/show', { model: 'm' });
    expect(seen).toEqual([
      { url: 'http://127.0.0.1:11434/api/tags', redirect: 'error' },
      { url: 'http://127.0.0.1:11434/api/show', redirect: 'error' },
    ]);
    for (const path of [
      '/api/pull',
      '/api/delete',
      '/api/copy',
      '/api/generate',
      '/x',
      '//evil.example/api/tags',
    ])
      await expect(client.get(path), path).rejects.toThrow(OllamaEndpointError);
    expect(seen).toHaveLength(2);
  });
});

describe('local-only verification', () => {
  const check = (models: StubModel[], wanted: string | null = null, extra = {}) =>
    verifyLocalModel(http(ollamaStub({ models, ...extra })), wanted);

  it('accepts the only installed model, or the one asked for', async () => {
    const one = await check([{ name: 'gemma:12b' }]);
    expect(one).toMatchObject({ ok: true, model: { name: 'gemma:12b' }, installed: ['gemma:12b'] });
    const two = await check([{ name: 'a:1b' }, { name: 'b:2b' }], 'b:2b');
    expect(two).toMatchObject({ ok: true, model: { name: 'b:2b' } });
  });

  it('never sends a prompt, a pull or anything but three metadata reads', async () => {
    const stub = ollamaStub();
    await verifyLocalModel(http(stub), null);
    expect(stub.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /api/tags',
      'GET /api/status',
      'POST /api/show',
    ]);
  });

  describe('the runtime must report its cloud features as disabled', () => {
    type Status = NonNullable<NonNullable<Parameters<typeof ollamaStub>[0]>['status']>;
    const verifyWith = (status: Status) => verifyLocalModel(http(ollamaStub({ status })), null);

    it('blocks a runtime whose cloud features are enabled, naming the setting to change, before any model check', async () => {
      const stub = ollamaStub({ status: { body: { cloud: { disabled: false, source: 'none' } } } });
      const r = await verifyLocalModel(http(stub), null);
      expect(r).toMatchObject({ ok: false, code: 'cloud_not_disabled', installed: ['tiny:1b'] });
      if (!r.ok) {
        expect(r.message).toContain('OLLAMA_NO_CLOUD=1');
        expect(r.message).toContain('Nothing was sent');
      }
      // The model's metadata was not even read.
      expect(stub.calls.map((c) => c.path)).toEqual(['/api/tags', '/api/status']);
    });

    it.each<[string, Status]>([
      ['an older runtime without the endpoint', { status: 404, body: { error: 'not found' } }],
      ['a server error', { status: 500, body: {} }],
      ['a body that is not an object', { body: 'ok' }],
      ['no cloud field', { body: {} }],
      ['an unknown extra field', { body: { cloud: { disabled: true, source: 'env' }, other: 1 } }],
      [
        'an unknown cloud field',
        { body: { cloud: { disabled: true, source: 'env', signedIn: false } } },
      ],
      ['a non-boolean flag', { body: { cloud: { disabled: 'yes', source: 'env' } } }],
      ['a missing source', { body: { cloud: { disabled: true } } }],
    ])('blocks %s as unknown, never as local', async (_why, status) => {
      expect(await verifyWith(status)).toMatchObject({ ok: false, code: 'cloud_status_unknown' });
    });

    it('accepts a runtime that reports cloud disabled, whatever the stated source', async () => {
      for (const source of ['env', 'config'])
        expect(await verifyWith({ body: { cloud: { disabled: true, source } } })).toMatchObject({
          ok: true,
        });
    });
  });

  it.each<[string, StubModel[], string | null, string]>([
    ['no models', [], null, 'no_models'],
    ['several without a choice', [{ name: 'a:1b' }, { name: 'b:1b' }], null, 'model_not_selected'],
    ['a model that is not installed', [{ name: 'a:1b' }], 'z:1b', 'model_not_installed'],
    ['a cloud-named model', [{ name: 'big:cloud' }], 'big:cloud', 'not_verifiably_local'],
    ['a malformed name', [{ name: 'a b' }], 'a b', 'not_verifiably_local'],
    [
      'an unknown field in the model entry',
      [{ name: 'a:1b', extraTags: { remote_host: 'https://ollama.com' } }],
      null,
      'not_verifiably_local',
    ],
    ['weights that are not present', [{ name: 'a:1b', size: 1_000 }], null, 'not_verifiably_local'],
    [
      'an unknown field in the metadata',
      [{ name: 'a:1b', extraShow: { remote_model: 'x' } }],
      null,
      'not_verifiably_local',
    ],
    [
      'a remote marker in the details',
      [{ name: 'a:1b', extraShow: { details: { remote_host: 'x' } } }],
      null,
      'not_verifiably_local',
    ],
  ])('blocks %s', async (_why, models, wanted, code) => {
    const r = await check(models, wanted);
    expect(r).toMatchObject({ ok: false, code });
    if (!r.ok) expect(r.message).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)/);
  });

  it('blocks when the runtime is down, answers oddly, or stops mid-check', async () => {
    expect(await check([], null, { down: true })).toMatchObject({
      ok: false,
      code: 'ollama_unreachable',
    });
    const odd: FetchLike = () =>
      Promise.resolve({ status: 200, text: () => Promise.resolve('{"models":"x"}') });
    expect(
      await verifyLocalModel(createOllamaHttp(resolveOllamaEndpoint(undefined), odd), null),
    ).toMatchObject({ code: 'bad_response' });
    const err: FetchLike = () =>
      Promise.resolve({ status: 500, text: () => Promise.resolve('{}') });
    expect(
      await verifyLocalModel(createOllamaHttp(resolveOllamaEndpoint(undefined), err), null),
    ).toMatchObject({ code: 'bad_response' });
    const notModels: FetchLike = () =>
      Promise.resolve({ status: 200, text: () => Promise.resolve('{"models":[{"x":1}]}') });
    expect(
      await verifyLocalModel(createOllamaHttp(resolveOllamaEndpoint(undefined), notModels), null),
    ).toMatchObject({ code: 'bad_response' });

    const base = ollamaStub();
    let n = 0;
    const flaky: FetchLike = (input, init) =>
      ++n === 3 ? Promise.reject(new Error('gone')) : base.fetch(input, init);
    expect(
      await verifyLocalModel(createOllamaHttp(resolveOllamaEndpoint(undefined), flaky), null),
    ).toMatchObject({ code: 'ollama_unreachable' });

    const noInfo: FetchLike = (input, init) =>
      input.endsWith('/api/show')
        ? Promise.resolve({ status: 200, text: () => Promise.resolve('{"details":{}}') })
        : base.fetch(input, init);
    expect(
      await verifyLocalModel(createOllamaHttp(resolveOllamaEndpoint(undefined), noInfo), null),
    ).toMatchObject({ code: 'not_verifiably_local' });
  });
});

describe('the Ollama provider', () => {
  async function provider(chat: Parameters<typeof ollamaStub>[0], format?: 'json') {
    const stub = ollamaStub(chat);
    const check = await verifyLocalModel(http(stub), null);
    if (!check.ok) throw new Error('the stub model must verify');
    return {
      stub,
      p: new OllamaProvider(http(stub), check.model, {
        numCtx: 4096,
        ...(format ? { format } : {}),
      }),
    };
  }

  it('sends one non-streaming chat to the verified model with the schema, guidance and bounds', async () => {
    const { stub, p } = await provider({ chat: () => chatReply('{"ok":true}') });
    const reply = await p.complete(request, { signal: signal() });
    expect(reply).toEqual({ text: '{"ok":true}', usage: { inputTokens: 120, outputTokens: 40 } });
    expect([p.provider, p.model]).toEqual(['ollama', 'tiny:1b']);
    const chat = stub.calls.find((c) => c.path === '/api/chat')?.body as ChatBody;
    expect(chat).toMatchObject({
      model: 'tiny:1b',
      stream: false,
      think: false,
      options: { num_predict: 500, num_ctx: 4096, temperature: 0, seed: 0 },
    });
    expect(chat.messages).toEqual([
      { role: 'system', content: `inst\n\n${LOCAL_GUIDANCE}` },
      { role: 'user', content: '{"evidence":[]}' },
    ]);
    expect(JSON.stringify(chat.format)).not.toContain('maxLength');
    expect(chat.format).toMatchObject({ type: 'object' });
  });

  it('can ask for plain JSON and put the schema in the prompt instead', async () => {
    const { stub, p } = await provider({ chat: () => chatReply('{}') }, 'json');
    await p.complete(request, { signal: signal() });
    const chat = stub.calls.find((c) => c.path === '/api/chat')?.body as ChatBody;
    expect(chat.format).toBe('json');
    expect(chat.messages[0]?.content).toContain('Output JSON Schema:');
  });

  it('returns an empty or missing reply as empty text, for the investigator to reject', async () => {
    const empty = await provider({
      chat: () => ({ body: { message: { content: '' }, done: true } }),
    });
    expect(await empty.p.complete(request, { signal: signal() })).toEqual({ text: '', usage: {} });
    const none = await provider({ chat: () => ({ body: { done: true, eval_count: -1 } }) });
    expect(await none.p.complete(request, { signal: signal() })).toEqual({ text: '', usage: {} });
  });

  it.each([
    [404, 'rejected_request'],
    [400, 'rejected_request'],
    [500, 'unavailable'],
    [503, 'unavailable'],
  ])('maps HTTP %i to %s', async (status, kind) => {
    const { p } = await provider({ chat: () => ({ status, body: { error: 'x' } }) });
    const e = await p.complete(request, { signal: signal() }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ProviderError);
    expect((e as ProviderError).kind).toBe(kind);
    expect((e as ProviderError).usage).toBeUndefined();
  });

  it('rejects a reply that is not JSON, and maps a lost connection and an abort', async () => {
    const odd = await provider({ chat: () => ({ body: 'plain text' }) });
    await expect(odd.p.complete(request, { signal: signal() })).rejects.toMatchObject({
      kind: 'rejected_request',
    });

    const base = ollamaStub();
    const check = await verifyLocalModel(http(base), null);
    if (!check.ok) throw new Error('verify');
    const lost = new OllamaProvider(
      createOllamaHttp(resolveOllamaEndpoint(undefined), () =>
        Promise.reject(new Error('ECONNRESET')),
      ),
      check.model,
      { numCtx: 1 },
    );
    await expect(lost.complete(request, { signal: signal() })).rejects.toMatchObject({
      kind: 'unavailable',
    });

    const controller = new AbortController();
    controller.abort();
    await expect(lost.complete(request, { signal: controller.signal })).rejects.toMatchObject({
      kind: 'timeout',
    });
    const named = new OllamaProvider(
      createOllamaHttp(resolveOllamaEndpoint(undefined), () =>
        Promise.reject(Object.assign(new Error('x'), { name: 'AbortError' })),
      ),
      check.model,
      { numCtx: 1 },
    );
    await expect(named.complete(request, { signal: signal() })).rejects.toMatchObject({
      kind: 'timeout',
    });
  });
});
