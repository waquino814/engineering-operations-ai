import { execFile } from 'node:child_process';
import { readdir, readFile, readlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { promisify } from 'node:util';

/**
 * Port ownership for `pnpm dev` (and the tests). A loopback port can be held on 127.0.0.1, on
 * ::1, or both, and `localhost` in a browser may resolve to either. A stale dev server holding
 * [::1]:5180 therefore shadows a new one bound to 127.0.0.1:5180: the browser keeps reaching the
 * old process and its dead proxy. So both addresses are checked, the holder is identified, and
 * only this repository's own previous dev server or API is ever stopped; anything else is left
 * alone and named in the error.
 */
const run = promisify(execFile);
export const LOOPBACK_ADDRESSES = ['127.0.0.1', '::1'] as const;

/** The loopback addresses on which `port` is already taken. */
export async function occupiedOn(port: number): Promise<string[]> {
  const taken: string[] = [];
  for (const host of LOOPBACK_ADDRESSES) {
    const free = await new Promise<boolean>((resolve) => {
      const probe = createServer();
      probe.once('error', (e: NodeJS.ErrnoException) => {
        // An address this machine does not have (no IPv6, say) cannot be shadowed.
        resolve(e.code !== 'EADDRINUSE');
      });
      probe.listen({ port, host }, () => {
        probe.close(() => {
          resolve(true);
        });
      });
    });
    if (!free) taken.push(host);
  }
  return taken;
}

export interface Owner {
  pid: number;
  command: string;
  cwd: string | null;
}

async function text(cmd: string, args: string[]): Promise<string | null> {
  try {
    return (await run(cmd, args)).stdout;
  } catch (e) {
    // lsof exits 1 when nothing matches; that is an answer, not a failure.
    const err = e as { code?: unknown; stdout?: string };
    return err.code === 1 ? (err.stdout ?? '') : null;
  }
}

/** Linux: listening sockets from /proc/net/tcp{,6}, matched to processes through /proc/<pid>/fd. */
async function ownersFromProc(port: number): Promise<Owner[] | null> {
  const inodes = new Set<string>();
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let rows: string;
    try {
      rows = await readFile(table, 'utf8');
    } catch {
      return null;
    }
    for (const row of rows.split('\n').slice(1)) {
      const cols = row.trim().split(/\s+/);
      const local = cols[1] ?? '';
      // State 0A is LISTEN; the port is the hex number after the last colon.
      if (cols[3] === '0A' && parseInt(local.split(':').at(-1) ?? '', 16) === port && cols[9])
        inodes.add(cols[9]);
    }
  }
  const owners: Owner[] = [];
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const fds = await readdir(`/proc/${entry}/fd`);
      const links = await Promise.all(
        fds.map((fd) => readlink(`/proc/${entry}/fd/${fd}`).catch(() => '')),
      );
      if (
        !links.some(
          (l) => /^socket:\[(\d+)\]$/.test(l) && inodes.has(/\[(\d+)\]/.exec(l)?.[1] ?? ''),
        )
      )
        continue;
      const command = (await readFile(`/proc/${entry}/cmdline`, 'utf8'))
        .split('\0')
        .join(' ')
        .trim();
      owners.push({
        pid: Number(entry),
        command,
        cwd: await readlink(`/proc/${entry}/cwd`).catch(() => null),
      });
    } catch {
      // A process that is gone, or one this user may not inspect, is not our previous instance.
    }
  }
  return owners;
}

/** The processes listening on `port`; null when they cannot be inspected. */
export async function ownersOf(port: number): Promise<Owner[] | null> {
  if (process.platform === 'linux') {
    const owners = await ownersFromProc(port);
    if (owners !== null) return owners;
  }
  const listing = await text('lsof', ['-nP', `-iTCP:${String(port)}`, '-sTCP:LISTEN', '-Fp']);
  if (listing === null) return null;
  const pids = [...new Set([...listing.matchAll(/^p(\d+)$/gm)].map((m) => Number(m[1])))];
  const owners: Owner[] = [];
  for (const pid of pids) {
    const command = (await text('ps', ['-o', 'command=', '-p', String(pid)]))?.trim() ?? '';
    const cwd = /^n(.+)$/m.exec(
      (await text('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'])) ?? '',
    )?.[1];
    owners.push({ pid, command, cwd: cwd ?? null });
  }
  return owners;
}

/**
 * Is this process a previous instance of this repository's own dev server (`vite` from this
 * repository's node_modules) or API (`node src/cli.ts serve`), started from the repository?
 */
export function isOurs(owner: Owner, root: string, kind: 'ui' | 'api'): boolean {
  if (owner.cwd?.replace(/\/$/, '') !== root.replace(/\/$/, '')) return false;
  const words = owner.command.split(/\s+/);
  if (!/(^|\/)node$/.test(words[0] ?? '')) return false;
  const rest = words.slice(1);
  const base = root.replace(/\/$/, '');
  // Started from the repository, so a relative path resolves inside it; an absolute one must.
  const insideRepo = (w: string) =>
    w.startsWith('/') ? w.startsWith(`${base}/node_modules/`) : w.startsWith('node_modules/');
  return kind === 'ui'
    ? rest.some((w) => insideRepo(w) && /(^|\/)vite\/bin\/vite\.js$/.test(w))
    : rest.includes('src/cli.ts') && rest.includes('serve');
}

/** The pid of the `scripts/dev.ts` of this repository that started `pid`, if there is one. */
async function supervisorOf(pid: number, root: string): Promise<number | null> {
  const ppid = Number((await text('ps', ['-o', 'ppid=', '-p', String(pid)]))?.trim());
  if (!Number.isInteger(ppid) || ppid <= 1) return null;
  const command = (await text('ps', ['-o', 'command=', '-p', String(ppid)]))?.trim() ?? '';
  const words = command.split(/\s+/);
  if (!/(^|\/)node$/.test(words[0] ?? '') || !words.slice(1).includes('scripts/dev.ts'))
    return null;
  const cwd = /^n(.+)$/m.exec(
    (await text('lsof', ['-a', '-p', String(ppid), '-d', 'cwd', '-Fn'])) ?? '',
  )?.[1];
  const procCwd = cwd ?? (await readlink(`/proc/${String(ppid)}/cwd`).catch(() => null));
  return procCwd?.replace(/\/$/, '') === root.replace(/\/$/, '') ? ppid : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type Claim = { ok: true; stopped: Owner[] } | { ok: false; message: string };

/**
 * Makes `port` free on every loopback address. A free port is returned as is. This repository's
 * own previous instance is stopped (SIGTERM, then a wait). Any other holder is never touched.
 */
export async function claimPort(
  port: number,
  kind: 'ui' | 'api',
  root: string,
  label: string,
): Promise<Claim> {
  const taken = await occupiedOn(port);
  if (taken.length === 0) return { ok: true, stopped: [] };
  const where = taken.join(' and ');
  const owners = await ownersOf(port);
  if (owners === null || owners.length === 0)
    return {
      ok: false,
      message: `port ${String(port)} (${label}) is in use on ${where}, and the process holding it could not be identified. Stop it, or choose another port.`,
    };
  const foreign = owners.filter((o) => !isOurs(o, root, kind));
  if (foreign.length > 0)
    return {
      ok: false,
      message:
        `port ${String(port)} (${label}) is in use on ${where} by a process that is not this repository's ${kind === 'ui' ? 'dev server' : 'application'}: ` +
        foreign.map((o) => `pid ${String(o.pid)}: ${o.command}`).join('; ') +
        '. It was left running. Stop it yourself, or choose another port.',
    };
  // Its supervisor first: a running `scripts/dev.ts` would otherwise restart the application
  // the moment it is stopped. The supervisor stops its own children on SIGTERM.
  for (const o of owners) {
    const parent = await supervisorOf(o.pid, root);
    if (parent !== null) process.kill(parent, 'SIGTERM');
  }
  for (let i = 0; i < 40 && (await occupiedOn(port)).length > 0; i++) await sleep(150);
  for (const o of owners) {
    try {
      process.kill(o.pid, 'SIGTERM');
    } catch {
      // already gone with its supervisor
    }
  }
  for (let i = 0; i < 40; i++) {
    if ((await occupiedOn(port)).length === 0) return { ok: true, stopped: owners };
    await sleep(150);
  }
  return {
    ok: false,
    message: `a previous instance (pid ${owners.map((o) => String(o.pid)).join(', ')}) did not stop within 6 seconds; port ${String(port)} (${label}) is still in use.`,
  };
}
