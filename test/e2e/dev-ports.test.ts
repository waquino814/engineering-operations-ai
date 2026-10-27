import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { claimPort, isOurs, occupiedOn, ownersOf } from '../../scripts/ports.ts';

/**
 * The failure the user saw at http://localhost:5180/: a stale dev server from before the fix,
 * `vite` alone on [::1]:5180 with nothing behind its /api proxy, answered every API call with an
 * empty 502, and a new dev server bound to 127.0.0.1:5180 did not replace it, because the two
 * addresses are different sockets while `localhost` may resolve to either. These tests recreate
 * that process on a free port and run the real `scripts/dev.ts` over it.
 */
const root = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const live = new Set<ChildProcess>();
const servers = new Set<Server>();
let home: string;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'eoai-ports-'));
});
afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});
afterEach(async () => {
  for (const c of live) c.kill('SIGKILL');
  live.clear();
  await Promise.all([...servers].map((s) => new Promise((r) => s.close(r))));
  servers.clear();
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => {
        resolve(port);
      });
    });
  });
}

function get(host: string, port: number, path: string) {
  return new Promise<{ status: number; type: string }>((resolve, reject) => {
    const req = request({ host, port, path, timeout: 3_000 }, (res) => {
      res.resume();
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, type: res.headers['content-type'] ?? '' });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    req.end();
  });
}

async function until<T>(what: string, probe: () => Promise<T | null>, ms = 40_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const v = await probe();
      if (v !== null) return v;
    } catch {
      // not yet
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

function spawnNode(args: string[], env: Record<string, string> = {}) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: { PATH: process.env['PATH'] ?? '', HOME: home, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  live.add(child);
  let log = '';
  for (const s of [child.stdout, child.stderr])
    s.on('data', (c: Buffer) => {
      log += c.toString();
    });
  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => {
      live.delete(child);
      resolve(code);
    });
  });
  return { child, log: () => log, exited };
}

/** What `pnpm ui:dev` ran before the fix: Vite alone, on IPv6 loopback, proxying to nothing. */
async function staleViteOnIPv6(uiPort: number, apiPort: number) {
  const stale = spawnNode(
    ['node_modules/vite/bin/vite.js', '--host', '::1', '--port', String(uiPort), '--strictPort'],
    { EOAI_PORT: String(apiPort) },
  );
  await until('the stale server', async () =>
    (await get('::1', uiPort, '/')).status === 200 ? true : null,
  );
  return stale;
}

describe('port ownership', { timeout: 60_000 }, () => {
  it('sees a holder on either loopback address, so IPv6 cannot shadow IPv4', async () => {
    const port = await freePort();
    expect(await occupiedOn(port)).toEqual([]);
    const v6 = createServer();
    servers.add(v6);
    await new Promise<void>((r) => v6.listen(port, '::1', r));
    expect(await occupiedOn(port)).toEqual(['::1']);
  });

  it('recognises this repository’s own dev server and application, and nothing else', () => {
    const vite = `node ${root}/node_modules/.bin/../.pnpm/vite@8.3.5/node_modules/vite/bin/vite.js --port 5180 --strictPort`;
    const ours = { pid: 1, command: vite, cwd: root };
    expect(isOurs(ours, root, 'ui')).toBe(true);
    expect(
      isOurs({ ...ours, command: vite.replace('node ', '/usr/local/bin/node ') }, root, 'ui'),
    ).toBe(true);
    // As scripts/dev.ts starts it: a relative path, from the repository.
    const relative = {
      ...ours,
      command: 'node node_modules/vite/bin/vite.js --host ::1 --port 5180',
    };
    expect(isOurs(relative, root, 'ui')).toBe(true);
    expect(
      isOurs({ ...relative, command: 'node ../other/node_modules/vite/bin/vite.js' }, root, 'ui'),
    ).toBe(false);
    expect(isOurs({ ...ours, cwd: '/somewhere/else' }, root, 'ui')).toBe(false);
    expect(isOurs({ ...ours, cwd: null }, root, 'ui')).toBe(false);
    expect(isOurs({ ...ours, command: vite.replace(root, '/other/repo') }, root, 'ui')).toBe(false);
    expect(isOurs({ ...ours, command: 'python3 -m http.server' }, root, 'ui')).toBe(false);
    expect(isOurs({ ...ours, command: vite }, root, 'api')).toBe(false);
    const api = { pid: 2, command: 'node src/cli.ts serve --port 8787', cwd: root };
    expect(isOurs(api, root, 'api')).toBe(true);
    expect(isOurs({ ...api, command: 'node src/cli.ts validate x' }, root, 'api')).toBe(false);
    expect(isOurs({ ...api, cwd: '/tmp' }, root, 'api')).toBe(false);
    expect(isOurs(api, root, 'ui')).toBe(false);
  });

  it('claims a free port, and never touches a process that is not ours', async () => {
    const port = await freePort();
    expect(await claimPort(port, 'ui', root, 'the console')).toEqual({ ok: true, stopped: [] });

    const foreign = spawnNode([
      '-e',
      `require('net').createServer().listen(${String(port)},'127.0.0.1')`,
    ]);
    await until('the foreign listener', async () =>
      (await occupiedOn(port)).length > 0 ? true : null,
    );
    const claim = await claimPort(port, 'ui', root, 'the console');
    expect(claim.ok).toBe(false);
    if (!claim.ok) {
      expect(claim.message).toContain(`pid ${String(foreign.child.pid)}`);
      expect(claim.message).toContain('left running');
    }
    expect(foreign.child.exitCode).toBeNull();
    expect((await occupiedOn(port)).length).toBeGreaterThan(0);
  });

  it('stops a stale dev server of this repository on IPv6 and frees the port', async () => {
    const [ui, api] = [await freePort(), await freePort()];
    const stale = await staleViteOnIPv6(ui, api);
    const owners = await ownersOf(ui);
    expect(owners?.map((o) => o.pid)).toContain(stale.child.pid);
    const claim = await claimPort(ui, 'ui', root, 'the console');
    expect(claim).toMatchObject({ ok: true });
    expect(await stale.exited).not.toBeNull();
    expect(await occupiedOn(ui)).toEqual([]);
  });
});

describe('pnpm dev on a port held by a stale dev server', { timeout: 90_000 }, () => {
  it('reproduces the 502, then replaces the stale server so the same URL works', async () => {
    const [ui, api] = [await freePort(), await freePort()];
    const stale = await staleViteOnIPv6(ui, api);
    // The exact symptom: the API route answers an empty 502 from the dead proxy.
    expect(await get('::1', ui, '/api/runs')).toEqual({ status: 502, type: 'text/plain' });

    const dev = spawnNode(['scripts/dev.ts', '--port', String(ui), '--strictPort'], {
      EOAI_PORT: String(api),
    });
    await until('the replaced console', async () => {
      const r = await get('127.0.0.1', ui, '/api/runs').catch(() => null);
      return r?.status === 200 ? r : null;
    });
    expect(dev.log()).toContain('stopped a previous instance of the console');
    expect(await stale.exited).not.toBeNull();
    // Every way a browser may resolve localhost now reaches the working server.
    for (const host of ['127.0.0.1', 'localhost'])
      expect(await get(host, ui, '/api/runs')).toEqual({
        status: 200,
        type: 'application/json; charset=utf-8',
      });
    expect((await get('localhost', ui, '/healthz')).status).toBe(200);
    expect(await occupiedOn(ui)).toEqual(['127.0.0.1']);
    dev.child.kill('SIGTERM');
    expect(await dev.exited).toBe(0);
    expect(await occupiedOn(ui)).toEqual([]);
    expect(await occupiedOn(api)).toEqual([]);
  });

  it('replaces an earlier running instance of itself, supervisor and all, without a restart race', async () => {
    const [ui, api] = [await freePort(), await freePort()];
    const first = spawnNode(['scripts/dev.ts', '--port', String(ui), '--strictPort'], {
      EOAI_PORT: String(api),
    });
    await until('the first instance', async () =>
      (await get('127.0.0.1', ui, '/api/runs').catch(() => null))?.status === 200 ? true : null,
    );
    const second = spawnNode(['scripts/dev.ts', '--port', String(ui), '--strictPort'], {
      EOAI_PORT: String(api),
    });
    expect(await first.exited).toBe(0);
    await until('the second instance', async () =>
      (await get('127.0.0.1', ui, '/api/runs').catch(() => null))?.status === 200 ? true : null,
    );
    // Stopping the earlier supervisor stopped its console too, so only one claim had to act.
    expect(second.log()).toContain('stopped a previous instance of the application');
    // The first one did not respawn the application behind the second one's back.
    expect(first.log()).not.toContain('restarting it');
    expect(second.log()).not.toContain('already in use');
    expect(await ownersOf(api)).toHaveLength(1);
    second.child.kill('SIGTERM');
    expect(await second.exited).toBe(0);
    expect(await occupiedOn(api)).toEqual([]);
    expect(await occupiedOn(ui)).toEqual([]);
  });

  it('refuses a port held by something else, says who holds it, and leaves it alone', async () => {
    const [ui, api] = [await freePort(), await freePort()];
    const foreign = spawnNode(['-e', `require('net').createServer().listen(${String(ui)},'::1')`]);
    await until('the foreign listener', async () =>
      (await occupiedOn(ui)).length > 0 ? true : null,
    );
    const dev = spawnNode(['scripts/dev.ts', '--port', String(ui), '--strictPort'], {
      EOAI_PORT: String(api),
    });
    expect(await dev.exited).toBe(1);
    expect(dev.log()).toContain(`pid ${String(foreign.child.pid)}`);
    expect(dev.log()).toContain('left running');
    expect(foreign.child.exitCode).toBeNull();
    // Nothing was started: no console, no application.
    expect(await occupiedOn(api)).toEqual([]);
  });

  it('fails loudly, starting no console, when the application cannot start', async () => {
    const [ui, api] = [await freePort(), await freePort()];
    // A bad provider setting makes the application refuse to start.
    const dev = spawnNode(['scripts/dev.ts', '--port', String(ui), '--strictPort'], {
      EOAI_PORT: String(api),
      EOAI_MODEL_PROVIDER: 'anthropic',
    });
    expect(await dev.exited).toBe(2);
    expect(dev.log()).toContain('not permitted');
    expect(dev.log()).toContain('stopped during startup');
    expect(await occupiedOn(ui)).toEqual([]);
  });

  it('restarts a crashed application while the console stays up, so the same page recovers', async () => {
    const [ui, api] = [await freePort(), await freePort()];
    const dev = spawnNode(['scripts/dev.ts', '--port', String(ui), '--strictPort'], {
      EOAI_PORT: String(api),
    });
    await until('the console', async () =>
      (await get('127.0.0.1', ui, '/api/runs').catch(() => null))?.status === 200 ? true : null,
    );
    const uiPid = (await ownersOf(ui))?.[0]?.pid;
    const apiPid = (await ownersOf(api))?.[0]?.pid;
    expect(uiPid).toBeGreaterThan(0);
    process.kill(apiPid ?? 0, 'SIGKILL');
    await until(
      'the outage to be visible',
      async () =>
        (await get('127.0.0.1', ui, '/api/runs').catch(() => null))?.status === 502 ? true : null,
      10_000,
    ).catch(() => undefined);
    await until('the application to be back', async () =>
      (await get('127.0.0.1', ui, '/api/runs').catch(() => null))?.status === 200 ? true : null,
    );
    expect((await ownersOf(ui))?.[0]?.pid).toBe(uiPid);
    expect((await ownersOf(api))?.[0]?.pid).not.toBe(apiPid);
    expect(dev.log()).toContain('restarting it');
    dev.child.kill('SIGTERM');
    expect(await dev.exited).toBe(0);
  });
});
