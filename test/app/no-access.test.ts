import * as fs from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { request } from 'node:http';
import { createApplication } from '../../src/app/application.ts';
import { startServer } from '../../src/app/http-server.ts';
import { AppConfigError } from '../../src/app/config.ts';
import { ProviderPolicyError } from '../../src/app/provider-gate.ts';
import { fetchSpy, workspace } from './support.ts';

// Counts every filesystem read and write the application could make, to show that a refusal
// happens before any bundle access (ADR 0012).
const WATCHED = [
  'readdir',
  'lstat',
  'realpath',
  'readFile',
  'stat',
  'open',
  'mkdir',
  'writeFile',
] as const;
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<Record<string, (...args: never[]) => unknown>>();
  const watched = [
    'readdir',
    'lstat',
    'realpath',
    'readFile',
    'stat',
    'open',
    'mkdir',
    'writeFile',
  ];
  return { ...actual, ...Object.fromEntries(watched.map((k) => [k, vi.fn(actual[k])])) };
});

const accesses = () => WATCHED.map((k) => vi.mocked(fs[k]).mock.calls.length);

describe('refusal and startup happen before any bundle access', () => {
  it('refuses anthropic at startup without touching the filesystem', async () => {
    const w = await workspace();
    vi.clearAllMocks();
    expect(() =>
      createApplication(w.env({ EOAI_MODEL_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'k' })),
    ).toThrow(ProviderPolicyError);
    expect(accesses().every((n) => n === 0)).toBe(true);
  });

  it('refuses unknown providers and the blocked local provider the same way', async () => {
    const w = await workspace();
    vi.clearAllMocks();
    for (const v of ['nope', 'local', 'Anthropic'])
      expect(() => createApplication(w.env({ EOAI_MODEL_PROVIDER: v }))).toThrow(
        ProviderPolicyError,
      );
    expect(accesses().every((n) => n === 0)).toBe(true);
  });

  it('rejects an invalid configuration without touching the filesystem', async () => {
    const w = await workspace();
    vi.clearAllMocks();
    for (const env of [{}, { EOAI_BUNDLES_DIR: 'relative', EOAI_RUNS_DIR: w.runsDir }])
      expect(() => createApplication(env)).toThrow(AppConfigError);
    expect(accesses().every((n) => n === 0)).toBe(true);
  });

  it('starts without filesystem or network access when the configuration is valid', async () => {
    const w = await workspace();
    vi.clearAllMocks();
    const app = createApplication(w.env(), { fakeSteps: w.steps });
    expect(app.config.provider.name).toBe('fake');
    expect(accesses().every((n) => n === 0)).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses a fake provider with no scripted replies before reading the bundle', async () => {
    const w = await workspace();
    const app = createApplication(w.env());
    vi.clearAllMocks();
    expect(await app.startInvestigation(w.excerptId)).toEqual({
      status: 'refused',
      reason: 'no_runnable_provider',
    });
    expect(accesses().every((n) => n === 0)).toBe(true);
  });

  it('starts the server and answers liveness without any filesystem access', async () => {
    const w = await workspace();
    vi.clearAllMocks();
    const server = await startServer({ env: w.env(), port: 0 });
    try {
      const status = await new Promise<number>((resolve, reject) => {
        request({ host: server.host, port: server.port, path: '/healthz' }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        })
          .on('error', reject)
          .end();
      });
      expect(status).toBe(200);
      expect(accesses().every((n) => n === 0)).toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
});
