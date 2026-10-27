/**
 * The local Ollama runtime, reached over loopback HTTP only (ADR 0013). The endpoint is validated
 * before any request: `http`, no credentials, no path, and a loopback address (`localhost` is an
 * alias for 127.0.0.1 and is never resolved). Redirects are refused, so a response cannot send a
 * request anywhere else. The fetch function is injected, so tests need no Ollama and no network.
 */
export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';

export class OllamaEndpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OllamaEndpointError';
  }
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]']);

export function resolveOllamaEndpoint(raw: string | undefined): URL {
  const text = raw === undefined || raw.trim() === '' ? DEFAULT_OLLAMA_URL : raw.trim();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new OllamaEndpointError('the Ollama endpoint is not a valid URL');
  }
  const host = url.hostname === 'localhost' ? '127.0.0.1' : url.hostname;
  if (
    url.protocol !== 'http:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    (url.pathname !== '/' && url.pathname !== '') ||
    !LOOPBACK_HOSTS.has(host)
  )
    throw new OllamaEndpointError(
      'the Ollama endpoint must be http on a loopback address (127.0.0.1 or ::1), with no credentials or path',
    );
  return new URL(`http://${host}:${url.port === '' ? '11434' : url.port}/`);
}

export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
    redirect: 'error';
  },
) => Promise<{ status: number; text(): Promise<string> }>;

export interface OllamaReply {
  status: number;
  /** The parsed JSON body, or undefined when it was not JSON. */
  body: unknown;
}

export interface OllamaHttp {
  readonly endpoint: string;
  get(path: string, signal?: AbortSignal): Promise<OllamaReply>;
  post(path: string, body: unknown, signal?: AbortSignal): Promise<OllamaReply>;
}

const PATHS = new Set(['/api/tags', '/api/show', '/api/status', '/api/chat']);

export function createOllamaHttp(endpoint: URL, fetchImpl: FetchLike): OllamaHttp {
  const call = async (
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<OllamaReply> => {
    // Only the three read-and-chat paths this adapter needs; nothing that pulls, copies or deletes.
    if (!PATHS.has(path)) throw new OllamaEndpointError('that Ollama path is not permitted');
    const response = await fetchImpl(new URL(path, endpoint).href, {
      method,
      redirect: 'error',
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    return { status: response.status, body: parsed };
  };
  return {
    endpoint: endpoint.href,
    get: (path, signal) => call('GET', path, undefined, signal),
    post: (path, body, signal) => call('POST', path, body, signal),
  };
}

/** The runtime's global fetch, the one place this adapter reaches the network (loopback only). */
export const globalFetch: FetchLike = (input, init) => fetch(input, init);
