import { readdir, readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join } from 'node:path';
import { createApplication, type AppDeps, type Application } from './application.ts';
import { ensureDataDirs } from './data-dirs.ts';
import { SettingsError } from './settings.ts';
import type { AppEnv } from './provider-gate.ts';

/**
 * The loopback HTTP server (ADR 0012, section 6): a thin adapter over the application layer for
 * the console. It binds to a loopback address only, never calls out, and cannot enable a
 * provider: startup builds the application through the provider gate, so a refused provider or a
 * bad configuration stops the server before it listens. Responses are small JSON documents that
 * carry no path, stack trace, environment value or raw exception text.
 */
export const DEFAULT_PORT = 8787;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_STATIC_BYTES = 5_000_000;
const LOOPBACK = new Set(['127.0.0.1', '::1']);

export class ServerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServerConfigError';
  }
}

/** Loopback literals only; `localhost` is accepted as an alias of 127.0.0.1, never resolved. */
export function resolveListenHost(host: string | undefined): string {
  const h = host ?? '127.0.0.1';
  if (h === 'localhost') return '127.0.0.1';
  if (!LOOPBACK.has(h))
    throw new ServerConfigError('the listen host must be a loopback address (127.0.0.1 or ::1)');
  return h;
}

export function resolveListenPort(port: number | undefined): number {
  const p = port ?? DEFAULT_PORT;
  if (!Number.isInteger(p) || p < 0 || p > 65_535)
    throw new ServerConfigError('the port must be an integer from 0 to 65535');
  return p;
}

export interface ServerOptions {
  env: AppEnv;
  appDeps?: Omit<AppDeps, 'signal'>;
  host?: string;
  port?: number;
  /** Create the bundles and runs directories when missing, once the provider gate has passed. */
  ensureDirs?: boolean;
  /** A built console (dist/ui); read into memory at startup and served by exact path. */
  staticDir?: string;
}

export interface RunningServer {
  readonly host: string;
  readonly port: number;
  /** False when no built console was found; the API still works. */
  readonly consoleServed: boolean;
  close(): Promise<void>;
}

type Json = Record<string, unknown>;
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const ERRORS: Record<string, [number, string]> = {
  bad_request: [400, 'the request is not valid'],
  invalid_bundle_id: [400, 'the bundle id is not valid'],
  invalid_run_id: [400, 'the run id is not valid'],
  not_found: [404, 'nothing here'],
  bundle_not_found: [404, 'no such bundle'],
  run_not_found: [404, 'no such run'],
  method_not_allowed: [405, 'method not allowed'],
  unsupported_media_type: [415, 'send application/json'],
  payload_too_large: [413, 'the request body is too large'],
  forbidden: [403, 'the request was refused'],
  // The message of a blocked provider is dynamic (it says why); see `fail`'s override.
  provider_blocked: [409, 'the selected provider cannot run. Nothing was run.'],
  provider_pinned: [409, 'the provider is fixed by EOAI_MODEL_PROVIDER and cannot be changed here'],
  unknown_suite: [400, 'no such evaluation suite'],
  evaluation_not_found: [404, 'no such evaluation'],
  evaluation_unreadable: [500, 'the stored evaluation could not be read'],
  different_suite: [409, 'the two evaluations are of different suites or versions'],
  settings_unreadable: [500, 'the settings file could not be read or is not valid'],
  busy: [429, 'an investigation is already running'],
  run_unreadable: [500, 'the stored run could not be read'],
  internal_error: [500, 'unexpected error'],
};

function send(res: ServerResponse, status: number, body: Json | string, type?: string): true {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': type ?? 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
  });
  res.end(payload);
  return true;
}

function fail(
  res: ServerResponse,
  code: string,
  extra: Record<string, string> = {},
  message?: string,
): true {
  const [status, fixed] = ERRORS[code] ?? [500, 'unexpected error'];
  res.setHeader('allow', extra['allow'] ?? 'GET, POST, PUT');
  return send(res, status, { error: { code, message: message ?? fixed } });
}

/**
 * The checks every state-changing request passes: this server's own origin, JSON content, a
 * bounded body that parses. On failure it has already answered and returns null.
 */
async function jsonBody(
  req: IncomingMessage,
  res: ServerResponse,
  allowedHosts: Set<string>,
): Promise<{ value: unknown } | null> {
  // A browser page from another origin cannot change anything.
  const origin = req.headers.origin;
  if (origin !== undefined && ![...allowedHosts].some((h) => origin === `http://${h}`)) {
    fail(res, 'forbidden');
    return null;
  }
  if (!/^application\/json(\s*;.*)?$/i.test(req.headers['content-type'] ?? '')) {
    fail(res, 'unsupported_media_type');
    return null;
  }
  const raw = await readBody(req);
  if (raw === null) {
    fail(res, 'payload_too_large');
    return null;
  }
  try {
    return { value: JSON.parse(raw.toString('utf8')) as unknown };
  } catch {
    fail(res, 'bad_request');
    return null;
  }
}

/** A malformed percent-escape becomes an id no route accepts, not an error. */
function safeDecode(segment: string | undefined): string {
  try {
    return decodeURIComponent(segment ?? '');
  } catch {
    return '%';
  }
}

/** Reads a body of at most MAX_BODY_BYTES; resolves null when it is larger. */
function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) over = true;
      else chunks.push(c);
    });
    req.on('end', () => {
      resolve(over ? null : Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

async function loadStatic(dir: string): Promise<Map<string, { body: Buffer; type: string }>> {
  const files = new Map<string, { body: Buffer; type: string }>();
  let names: string[];
  try {
    names = await readdir(dir, { recursive: true });
  } catch {
    return files;
  }
  for (const name of names) {
    const type = TYPES[extname(name)];
    if (!type) continue;
    const info = await stat(join(dir, name));
    if (!info.isFile() || info.size > MAX_STATIC_BYTES) continue;
    files.set(`/${name.split('\\').join('/')}`, { body: await readFile(join(dir, name)), type });
  }
  const index = files.get('/index.html');
  if (index) files.set('/', index);
  return files;
}

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const host = resolveListenHost(options.host);
  const wantedPort = resolveListenPort(options.port);
  const abort = new AbortController();
  // Throws ProviderPolicyError or AppConfigError before anything listens or is read.
  const app: Application = createApplication(options.env, {
    ...options.appDeps,
    signal: abort.signal,
  });
  if (options.ensureDirs)
    await ensureDataDirs([app.config.bundlesDir, app.config.runsDir, app.config.evaluationsDir]);
  const assets = options.staticDir
    ? await loadStatic(options.staticDir)
    : new Map<string, { body: Buffer; type: string }>();
  let allowedHosts = new Set<string>();
  let running = false;

  const route = async (req: IncomingMessage, res: ServerResponse): Promise<true> => {
    // Against DNS rebinding: only this server's own loopback names are served.
    if (!allowedHosts.has((req.headers.host ?? '').toLowerCase())) return fail(res, 'forbidden');
    let path: string;
    try {
      const url = new URL(req.url ?? '/', 'http://local');
      path = url.pathname;
    } catch {
      return fail(res, 'bad_request');
    }
    const method = req.method ?? '';
    if (method !== 'GET' && method !== 'POST' && method !== 'PUT')
      return fail(res, 'method_not_allowed');
    if (path !== '/healthz' && !path.startsWith('/api/')) {
      if (method !== 'GET') return fail(res, 'method_not_allowed', { allow: 'GET' });
      const asset = assets.get(path);
      if (!asset) return fail(res, 'not_found');
      return send(res, 200, asset.body.toString('utf8'), asset.type);
    }

    if (path === '/healthz') {
      if (method !== 'GET') return fail(res, 'method_not_allowed', { allow: 'GET' });
      return send(res, 200, { status: 'ok' });
    }
    if (path === '/api/status') {
      if (method !== 'GET') return fail(res, 'method_not_allowed', { allow: 'GET' });
      // What the console needs to be honest about a run: the selection and its readiness, apart.
      try {
        return send(res, 200, { ...(await app.getProviderStatus()) });
      } catch (e) {
        if (e instanceof SettingsError) return fail(res, 'settings_unreadable');
        throw e;
      }
    }
    if (path === '/api/settings') {
      if (method === 'GET') {
        try {
          return send(res, 200, { ...(await app.getSettings()) });
        } catch (e) {
          if (e instanceof SettingsError) return fail(res, 'settings_unreadable');
          throw e;
        }
      }
      if (method !== 'PUT') return fail(res, 'method_not_allowed', { allow: 'GET, PUT' });
      const body = await jsonBody(req, res, allowedHosts);
      if (body === null) return true;
      const out = await app.updateSettings(body.value);
      if (out.status === 'saved') return send(res, 200, { ...out.settings, pinned: false });
      return fail(res, out.status === 'pinned' ? 'provider_pinned' : 'bad_request');
    }
    if (path === '/api/runs') {
      if (method !== 'GET') return fail(res, 'method_not_allowed', { allow: 'GET' });
      return send(res, 200, { runs: await app.listRuns() });
    }
    if (path === '/api/bundles') {
      if (method !== 'GET') return fail(res, 'method_not_allowed', { allow: 'GET' });
      return send(res, 200, { bundles: (await app.listBundles()).map((id) => ({ id })) });
    }
    if (path === '/api/evaluation-suites') {
      if (method !== 'GET') return fail(res, 'method_not_allowed', { allow: 'GET' });
      return send(res, 200, { suites: app.listEvaluationSuites() });
    }
    if (path === '/api/evaluations') {
      if (method === 'GET') return send(res, 200, { evaluations: await app.listEvaluations() });
      if (method !== 'POST') return fail(res, 'method_not_allowed', { allow: 'GET, POST' });
      const body = await jsonBody(req, res, allowedHosts);
      if (body === null) return true;
      const v = body.value;
      const keys = typeof v === 'object' && v !== null && !Array.isArray(v) ? Object.keys(v) : [];
      const { suiteId, provider } = (v ?? {}) as Json;
      if (
        keys.length !== 2 ||
        typeof suiteId !== 'string' ||
        (provider !== 'scripted' && provider !== 'simulated' && provider !== 'ollama')
      )
        return fail(res, 'bad_request');
      if (running) return fail(res, 'busy');
      running = true;
      const cancel = new AbortController();
      res.once('close', () => {
        if (!res.writableEnded) cancel.abort();
      });
      try {
        const out = await app.startEvaluation({ suiteId, provider }, { signal: cancel.signal });
        if (out.status === 'refused') return fail(res, out.reason, {}, out.message);
        if (out.status === 'error') return fail(res, out.reason);
        return send(res, 201, { id: out.run.id, status: out.run.status });
      } finally {
        running = false;
      }
    }
    const compare = /^\/api\/evaluations\/([^/]+)\/compare\/([^/]+)$/.exec(path);
    if (compare) {
      if (method !== 'GET') return fail(res, 'method_not_allowed', { allow: 'GET' });
      const out = await app.compareEvaluations(safeDecode(compare[1]), safeDecode(compare[2]));
      if (out.status === 'ok') return send(res, 200, { ...out.comparison });
      return fail(
        res,
        out.reason === 'invalid_id'
          ? 'invalid_run_id'
          : out.reason === 'not_found'
            ? 'evaluation_not_found'
            : out.reason === 'unreadable'
              ? 'evaluation_unreadable'
              : 'different_suite',
      );
    }
    const evaluation = /^\/api\/evaluations\/([^/]+)$/.exec(path);
    if (evaluation) {
      if (method !== 'GET') return fail(res, 'method_not_allowed', { allow: 'GET' });
      const got = await app.getEvaluation(safeDecode(evaluation[1]));
      if (got.ok) return send(res, 200, { evaluation: got.run });
      return fail(
        res,
        got.reason === 'invalid_id'
          ? 'invalid_run_id'
          : got.reason === 'not_found'
            ? 'evaluation_not_found'
            : 'evaluation_unreadable',
      );
    }
    const evidence = /^\/api\/runs\/([^/]+)\/evidence$/.exec(path);
    if (evidence) {
      if (method !== 'GET') return fail(res, 'method_not_allowed', { allow: 'GET' });
      const out = await app.getEvidence(safeDecode(evidence[1]));
      if (out.status === 'ok') return send(res, 200, { ...out.report });
      return fail(res, out.reason === 'unreadable' ? 'run_unreadable' : out.reason);
    }
    const run = /^\/api\/runs\/([^/]+)$/.exec(path);
    if (run) {
      if (method !== 'GET') return fail(res, 'method_not_allowed', { allow: 'GET' });
      const got = await app.getRun(safeDecode(run[1]));
      if (got.ok) return send(res, 200, { result: got.result });
      return fail(res, got.reason === 'unreadable' ? 'run_unreadable' : got.reason);
    }
    const check = /^\/api\/bundles\/([^/]+)\/validation$/.exec(path);
    if (check) {
      if (method !== 'GET') return fail(res, 'method_not_allowed', { allow: 'GET' });
      const out = await app.checkBundle(safeDecode(check[1]));
      return out.status === 'checked' ? send(res, 200, { ...out.check }) : fail(res, out.reason);
    }
    if (path === '/api/investigations') {
      if (method !== 'POST') return fail(res, 'method_not_allowed', { allow: 'POST' });
      const body = await jsonBody(req, res, allowedHosts);
      if (body === null) return true;
      const keys =
        typeof body.value === 'object' && body.value !== null && !Array.isArray(body.value)
          ? Object.keys(body.value)
          : [];
      const bundleId = (body.value as Json | null)?.['bundleId'];
      if (keys.length !== 1 || keys[0] !== 'bundleId' || typeof bundleId !== 'string')
        return fail(res, 'bad_request');
      if (running) return fail(res, 'busy');
      running = true;
      // A client that goes away cancels its run; the result is stored as cancelled.
      const cancel = new AbortController();
      res.once('close', () => {
        if (!res.writableEnded) cancel.abort();
      });
      try {
        const out = await app.startInvestigation(bundleId, { signal: cancel.signal });
        if (out.status === 'refused') return fail(res, out.reason, {}, out.message);
        if (out.status === 'error') return fail(res, out.reason);
        return send(res, 201, { runId: out.runId, outcome: out.result.outcome });
      } finally {
        running = false;
      }
    }
    return fail(res, 'not_found');
  };

  const server: Server = createServer((req, res) => {
    route(req, res).catch(() => {
      // Nothing about the failure is sent: it could hold a path or other internal detail.
      if (!res.headersSent) fail(res, 'internal_error');
      else res.destroy();
    });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 1_000;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host, port: wantedPort }, resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : wantedPort;
  const names =
    host === '::1'
      ? [`[::1]:${String(port)}`]
      : [`127.0.0.1:${String(port)}`, `localhost:${String(port)}`];
  allowedHosts = new Set(names);

  return {
    host,
    port,
    consoleServed: assets.has('/'),
    close: () =>
      new Promise<void>((resolve) => {
        // Aborting ends a running investigation with a stored `cancelled` result; in-flight
        // requests get a short grace period to answer, then remaining connections are cut.
        abort.abort();
        const force = setTimeout(() => {
          server.closeAllConnections();
        }, 2_000);
        server.close(() => {
          clearTimeout(force);
          resolve();
        });
        server.closeIdleConnections();
      }),
  };
}
