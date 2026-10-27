import { execFile, spawn } from 'node:child_process';
import { request } from 'node:http';
import { access, readdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { workspace } from './support.ts';

/**
 * The real program, in a real Node process, with an isolated environment (execFile's `env`
 * replaces the parent's, so no credential can leak in) and Node's permission model granting read
 * access to the source tree only. A refused run that touched the bundles or runs directory would
 * fail with a permission error instead of the policy message, so these tests show that refusal
 * comes before filesystem access. They do not sandbox the network.
 */
const run = promisify(execFile);
const root = new URL('../../', import.meta.url).pathname;
const cli = `${root}src/cli.ts`;

async function cliRun(args: string[], env: Record<string, string>) {
  try {
    const ok = await run(
      process.execPath,
      ['--permission', `--allow-fs-read=${root}`, cli, ...args],
      {
        env,
        timeout: 30_000,
      },
    );
    return { code: 0, stdout: ok.stdout, stderr: ok.stderr };
  } catch (e) {
    return e as { code: number; stdout: string; stderr: string };
  }
}

describe('src/cli.ts investigate, as a real subprocess', () => {
  it('control: the same read succeeds without the permission model and fails with it', async () => {
    const w = await workspace();
    const open = await run(process.execPath, [cli, 'validate', w.b.excerpt], { env: {} });
    expect(open.stdout).toMatch(/^valid: /);
    const blocked = await cliRun(['validate', w.b.excerpt], {});
    expect(blocked.code).not.toBe(0);
    expect(blocked.stdout).toMatch(/^invalid: /);
  });

  it.each([['anthropic'], ['local'], ['openai'], ['Fake']])(
    'fails closed with exit 2 for EOAI_MODEL_PROVIDER=%s, before any bundle or run access',
    async (name) => {
      const w = await workspace();
      const r = await cliRun(
        ['investigate', w.excerptId],
        w.env({ EOAI_MODEL_PROVIDER: name, ANTHROPIC_API_KEY: 'sk-ant-not-a-real-key' }),
      );
      expect(r.code).toBe(2);
      expect(r.stdout).toBe('');
      // The policy message, not a permission error: nothing outside the source tree was read.
      expect(r.stderr).toMatch(/not permitted/);
      expect(r.stderr).not.toMatch(/ERR_ACCESS_PERMISSION|sk-ant-not-a-real-key/);
      await expect(access(w.runsDir)).rejects.toThrow();
    },
  );

  it.each([[{}], [{ EOAI_MODEL_PROVIDER: '' }], [{ EOAI_MODEL_PROVIDER: 'fake' }]])(
    'runs a labelled simulated investigation by default and stores it, for %j',
    async (extra) => {
      const w = await workspace();
      // Without the permission model: the run reads the bundle and writes the run store.
      const r = await run(process.execPath, [cli, 'investigate', w.excerptId], {
        env: w.env(extra),
      });
      expect(r.stdout).toMatch(/^run \d{8}T\d{6}Z-[0-9a-f]{16}: completed, 1 finding\(s\)/);
      expect(await readdir(w.runsDir)).toHaveLength(1);
    },
  );

  it('rejects a relative data directory with exit 2 and names the variable', async () => {
    const r = await cliRun(['investigate', 'x'], {
      EOAI_BUNDLES_DIR: 'relative',
      EOAI_RUNS_DIR: 'relative',
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('EOAI_BUNDLES_DIR');
    expect(r.stderr).toContain('EOAI_RUNS_DIR');
  });

  it('prints usage for bad arguments', async () => {
    const r = await cliRun(['investigate'], {});
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('investigate <bundle-id>');
  });

  it.each([
    [['serve'], { EOAI_MODEL_PROVIDER: 'anthropic' }, /not permitted/],
    [['serve'], { EOAI_MODEL_PROVIDER: 'local' }, /not permitted/],
    [['serve', '--host', '0.0.0.0'], {}, /loopback/],
  ])('serve %j fails closed with exit 2 and never listens', async (argv, extra, message) => {
    const w = await workspace();
    const r = await cliRun(argv, w.env(extra));
    expect(r.code).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(message);
  });

  it('serves on loopback and shuts down cleanly on SIGTERM (the signal wiring)', async () => {
    const w = await workspace();
    const child = spawn(process.execPath, [cli, 'serve', '--port', '0'], {
      env: w.env(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = new Promise<number | null>((resolve) =>
      child.once('exit', (c) => {
        resolve(c);
      }),
    );
    const port = await new Promise<number>((resolve, reject) => {
      let out = '';
      child.stdout.on('data', (c: Buffer) => {
        out += c.toString();
        const m = /http:\/\/127\.0\.0\.1:(\d+)\n/.exec(out);
        if (m) resolve(Number(m[1]));
      });
      child.once('error', reject);
      child.once('exit', () => {
        reject(new Error('exited before listening'));
      });
    });
    const status = await new Promise<number>((resolve, reject) => {
      request({ host: '127.0.0.1', port, path: '/healthz' }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      })
        .on('error', reject)
        .end();
    });
    expect(status).toBe(200);
    child.kill('SIGTERM');
    expect(await exited).toBe(0);
  });
});
