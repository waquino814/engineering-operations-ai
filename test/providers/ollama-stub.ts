/** A stand-in for the local Ollama runtime: no process, no port, no network. */
export interface StubModel {
  name: string;
  size?: number;
  extraTags?: Record<string, unknown>;
  extraShow?: Record<string, unknown>;
}
export function ollamaStub(
  options: {
    models?: StubModel[];
    chat?: (body: Record<string, unknown>) => { status?: number; body: unknown } | Promise<never>;
    down?: boolean;
  } = {},
) {
  const calls: { method: string; path: string; body: Record<string, unknown> | undefined }[] = [];
  const models = options.models ?? [{ name: 'tiny:1b' }];
  const reply = (status: number, body: unknown) =>
    Promise.resolve({
      status,
      text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
    });
  const fetchStub = (
    input: string,
    init: { method: string; body?: string; signal?: AbortSignal },
  ) => {
    const path = new URL(input).pathname;
    const body =
      init.body === undefined ? undefined : (JSON.parse(init.body) as Record<string, unknown>);
    calls.push({ method: init.method, path, body });
    if (options.down) return Promise.reject(new Error('connect ECONNREFUSED'));
    if (path === '/api/tags')
      return reply(200, {
        models: models.map((m) => ({
          name: m.name,
          model: m.name,
          modified_at: '2026-01-01T00:00:00Z',
          size: m.size ?? 7_000_000_000,
          digest: 'abc123',
          details: {},
          capabilities: ['completion'],
          ...m.extraTags,
        })),
      });
    if (path === '/api/show') {
      const m = models.find((x) => x.name === body?.['model']);
      return m
        ? reply(200, {
            details: {},
            model_info: { 'general.architecture': 'x' },
            capabilities: [],
            ...m.extraShow,
          })
        : reply(404, { error: 'model not found' });
    }
    if (path === '/api/chat') {
      const out = options.chat?.(body ?? {});
      if (!out) return reply(500, { error: 'no chat scripted' });
      if (out instanceof Promise) return out;
      return reply(out.status ?? 200, out.body);
    }
    return reply(404, {});
  };
  return { fetch: fetchStub, calls };
}

/** The Ollama chat reply that carries `text` as the model's answer. */
export const chatReply = (text: string, usage = { prompt_eval_count: 120, eval_count: 40 }) => ({
  body: {
    message: { role: 'assistant', content: text },
    done: true,
    done_reason: 'stop',
    ...usage,
  },
});
