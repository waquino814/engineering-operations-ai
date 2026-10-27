import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_DATA_DIRNAME, ensureDataDirs, withDataDefaults } from '../../src/app/data-dirs.ts';
import { loadConfig, AppConfigError } from '../../src/app/config.ts';
import { startServer } from '../../src/app/http-server.ts';
import { ProviderPolicyError } from '../../src/app/provider-gate.ts';
import { main } from '../../src/cli.ts';
import { tempDir } from './support.ts';

describe('data directory defaults', () => {
  it('defaults to a place under the home directory, never the repository', () => {
    const env = withDataDefaults({}, '/home/ada');
    expect(env['EOAI_BUNDLES_DIR']).toBe(join('/home/ada', DEFAULT_DATA_DIRNAME, 'bundles'));
    expect(env['EOAI_RUNS_DIR']).toBe(join('/home/ada', DEFAULT_DATA_DIRNAME, 'runs'));
    expect(env['EOAI_BUNDLES_DIR']).not.toContain(process.cwd());
  });

  it('lets EOAI_DATA_DIR move the root and explicit directories win', () => {
    const moved = withDataDefaults({ EOAI_DATA_DIR: '/srv/eoai' }, '/home/ada');
    expect(moved['EOAI_RUNS_DIR']).toBe('/srv/eoai/runs');
    const explicit = withDataDefaults(
      { EOAI_DATA_DIR: '/srv/eoai', EOAI_BUNDLES_DIR: '/b', EOAI_RUNS_DIR: '/r' },
      '/home/ada',
    );
    expect([explicit['EOAI_BUNDLES_DIR'], explicit['EOAI_RUNS_DIR']]).toEqual(['/b', '/r']);
  });

  it('treats empty values as unset, keeps other variables, and leaves a relative root to validation', () => {
    const env = withDataDefaults(
      { EOAI_BUNDLES_DIR: '', EOAI_DATA_DIR: '  ', EOAI_MODEL_PROVIDER: 'fake' },
      '/h',
    );
    expect(env['EOAI_BUNDLES_DIR']).toBe(join('/h', DEFAULT_DATA_DIRNAME, 'bundles'));
    expect(env['EOAI_MODEL_PROVIDER']).toBe('fake');
    const relative = withDataDefaults({ EOAI_DATA_DIR: 'data' }, '/h');
    expect(() => loadConfig(relative)).toThrow(AppConfigError);
  });
});

describe('ensureDataDirs', () => {
  it('creates private directories and leaves existing ones and their content alone', async () => {
    const root = await tempDir();
    const [a, b] = [join(root, 'x', 'bundles'), join(root, 'x', 'runs')];
    await ensureDataDirs([a, b]);
    for (const d of [a, b]) expect((await stat(d)).mode & 0o077).toBe(0);
    await writeFile(join(a, 'keep.txt'), 'mine');
    await chmod(a, 0o750);
    await ensureDataDirs([a, b]);
    expect(await readFile(join(a, 'keep.txt'), 'utf8')).toBe('mine');
    expect((await stat(a)).mode & 0o777).toBe(0o750);
  });

  it('fails when a path exists but is not a directory, without touching it', async () => {
    const root = await tempDir();
    const file = join(root, 'runs');
    await writeFile(file, 'precious');
    await expect(ensureDataDirs([file])).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe('precious');
  });
});

describe('startup creates directories only after the provider gate', () => {
  it('creates them when serving, and not when the provider is refused', async () => {
    const root = await tempDir();
    const env = { EOAI_BUNDLES_DIR: join(root, 'b'), EOAI_RUNS_DIR: join(root, 'r') };
    await expect(
      startServer({ env: { ...env, EOAI_MODEL_PROVIDER: 'anthropic' }, port: 0, ensureDirs: true }),
    ).rejects.toThrow(ProviderPolicyError);
    await expect(stat(env.EOAI_BUNDLES_DIR)).rejects.toThrow();
    const server = await startServer({ env, port: 0, ensureDirs: true });
    try {
      expect((await stat(env.EOAI_BUNDLES_DIR)).isDirectory()).toBe(true);
      expect((await stat(env.EOAI_RUNS_DIR)).isDirectory()).toBe(true);
    } finally {
      await server.close();
    }
  });
});

describe('the CLI with a home directory', () => {
  const sink = { write: () => true };

  it('serve with no paths set uses the home defaults and honours EOAI_PORT', async () => {
    const home = await tempDir();
    let out = '';
    let stop: () => Promise<void> = () => Promise.reject(new Error('not serving'));
    let ready: () => void = () => undefined;
    const serving = new Promise<void>((r) => (ready = r));
    const code = main(
      ['serve'],
      { write: (s) => (out += s) },
      sink,
      { EOAI_PORT: '0' },
      {
        home,
        onServing: (fn) => {
          stop = fn;
          ready();
        },
      },
    );
    await serving;
    expect(out).toMatch(/http:\/\/127\.0\.0\.1:\d+\n/);
    expect((await stat(join(home, DEFAULT_DATA_DIRNAME, 'runs'))).isDirectory()).toBe(true);
    await stop();
    expect(await code).toBe(0);
  });

  it('rejects a bad EOAI_PORT, and investigate with defaults finds no bundle', async () => {
    const home = await tempDir();
    expect(await main(['serve'], sink, sink, { EOAI_PORT: 'abc' }, { home })).toBe(2);
    await mkdir(join(home, DEFAULT_DATA_DIRNAME, 'bundles'), { recursive: true });
    let err = '';
    const code = await main(
      ['investigate', 'x'],
      sink,
      { write: (s) => (err += s) },
      {},
      { home, fakeSteps: [] },
    );
    expect([code, err]).toEqual([2, 'bundle_not_found: x\n']);
  });
});
