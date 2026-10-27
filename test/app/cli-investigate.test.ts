import { request } from 'node:http';
import { describe, expect, it } from 'vitest';
import { main } from '../../src/cli.ts';
import { ProviderError } from '../../src/investigation/provider.ts';
import { fetchSpy, workspace } from './support.ts';

function streams() {
  let out = '';
  let err = '';
  return {
    out: { write: (s: string) => (out += s) },
    err: { write: (s: string) => (err += s) },
    text: () => ({ out, err }),
  };
}

describe('cli investigate', () => {
  it('runs a scripted fake investigation and exits 0', async () => {
    const w = await workspace();
    const s = streams();
    const code = await main(['investigate', w.excerptId], s.out, s.err, w.env(), {
      fakeSteps: w.steps,
    });
    expect(code).toBe(0);
    expect(s.text().out).toMatch(
      /^run \d{8}T\d{6}Z-[0-9a-f]{16}: completed, \d+ finding\(s\), 1 model call\(s\)\n$/,
    );
    expect(s.text().err).toBe('');
  });

  it('prints the stored result with --json', async () => {
    const w = await workspace();
    const s = streams();
    await main(['investigate', w.excerptId, '--json'], s.out, s.err, w.env(), {
      fakeSteps: w.steps,
    });
    expect(JSON.parse(s.text().out)).toMatchObject({ outcome: 'completed' });
  });

  it('exits 1 when the stored result is a failure', async () => {
    const w = await workspace();
    const s = streams();
    const code = await main(['investigate', w.tamperedId], s.out, s.err, w.env(), {
      fakeSteps: w.steps,
    });
    expect(code).toBe(1);
    expect(s.text().out).toContain('failed (invalid_bundle)');
    const down = () => ({ error: new ProviderError('unavailable', 'down') });
    const s2 = streams();
    expect(
      await main(['investigate', w.excerptId], s2.out, s2.err, w.env(), {
        fakeSteps: [down(), down(), down()],
        sleep: () => Promise.resolve(),
      }),
    ).toBe(1);
  });

  it('exits 2 without running when the fake provider has nothing scripted', async () => {
    const w = await workspace();
    const s = streams();
    expect(await main(['investigate', w.excerptId], s.out, s.err, w.env())).toBe(2);
    expect(s.text().err).toContain('no runnable provider');
    expect(s.text().out).toBe('');
  });

  it.each([['anthropic'], ['local'], ['unknown']])(
    'exits 2 for provider %s, with no run stored',
    async (name) => {
      const w = await workspace();
      const s = streams();
      const env = w.env({ EOAI_MODEL_PROVIDER: name, ANTHROPIC_API_KEY: 'sk-ant-secret' });
      expect(
        await main(['investigate', w.excerptId], s.out, s.err, env, { fakeSteps: w.steps }),
      ).toBe(2);
      expect(s.text().err).not.toContain('sk-ant-secret');
      expect(s.text().out).toBe('');
    },
  );

  it('exits 2 for missing configuration and for an unknown bundle', async () => {
    const w = await workspace();
    const s = streams();
    expect(await main(['investigate', w.excerptId], s.out, s.err, {})).toBe(2);
    expect(s.text().err).toContain('EOAI_BUNDLES_DIR');
    const s2 = streams();
    expect(
      await main(['investigate', 'nope'], s2.out, s2.err, w.env(), { fakeSteps: w.steps }),
    ).toBe(2);
    expect(s2.text().err).toBe('bundle_not_found: nope\n');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not hide an unexpected startup failure behind a policy message', async () => {
    const s = streams();
    const env = new Proxy(
      {},
      {
        get() {
          throw new Error('boom');
        },
      },
    );
    await expect(main(['investigate', 'x'], s.out, s.err, env)).rejects.toThrow('boom');
  });
});

describe('cli serve', () => {
  const get = (port: number, path: string) =>
    new Promise<{ status: number; text: string }>((resolve, reject) => {
      request({ host: '127.0.0.1', port, path }, (res) => {
        let text = '';
        res.on('data', (c: Buffer) => (text += c.toString()));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, text });
        });
      })
        .on('error', reject)
        .end();
    });

  it('listens on loopback, serves, and stops cleanly when told to', async () => {
    const w = await workspace();
    const s = streams();
    let stop: () => Promise<void> = () => Promise.reject(new Error('not serving'));
    const ready = new Promise<void>((resolve) => {
      void main(['serve', '--port', '0'], s.out, s.err, w.env(), {
        onServing: (fn) => {
          stop = fn;
          resolve();
        },
      }).then((code) => {
        exit = code;
      });
    });
    let exit: number | undefined;
    await ready;
    const port = Number(/http:\/\/127\.0\.0\.1:(\d+)\n/.exec(s.text().out)?.[1]);
    expect(port).toBeGreaterThan(0);
    expect((await get(port, '/healthz')).text).toBe('{"status":"ok"}');
    await stop();
    await new Promise((r) => setTimeout(r, 20));
    expect(exit).toBe(0);
    await expect(get(port, '/healthz')).rejects.toThrow(/ECONNREFUSED/);
  });

  it.each([
    [['serve', '--host', '0.0.0.0'], {}],
    [['serve', '--host', '192.168.1.2'], {}],
    [['serve', '--port', 'abc'], {}],
    [['serve', '--port', '70000'], {}],
    [['serve', '--port'], {}],
    [['serve', '--bogus', 'x'], {}],
    [['serve'], { EOAI_MODEL_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-secret' }],
    [['serve'], { EOAI_MODEL_PROVIDER: 'local' }],
  ])('exits 2 without listening for %j', async (argv, extra) => {
    const w = await workspace();
    const s = streams();
    expect(await main(argv, s.out, s.err, w.env(extra))).toBe(2);
    expect(s.text().out).toBe('');
    expect(s.text().err).not.toContain('sk-ant-secret');
  });
});
