import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { ContractError } from '../src/index.ts';
import * as validate from '../src/intake/validate-bundle.ts';
import { main } from '../src/cli.ts';
import { EXAMPLE_DIR, makeBundle } from './support.ts';

function streams() {
  let out = '';
  let err = '';
  return {
    out: { write: (s: string) => (out += s) },
    err: { write: (s: string) => (err += s) },
    text: () => ({ out, err }),
  };
}

describe('cli', () => {
  it('prints usage and exits 2 for bad arguments', async () => {
    for (const argv of [[], ['validate'], ['check', 'x'], ['validate', 'a', 'b']]) {
      const s = streams();
      expect(await main(argv, s.out, s.err)).toBe(2);
      expect(s.text().err).toBe(
        'usage: node src/cli.ts validate <bundle-dir> [--json]\n       node src/cli.ts investigate <bundle-id> [--json]\n       node src/cli.ts serve [--host <loopback-address>] [--port <n>]\n',
      );
    }
  });

  it('exits 0 for a valid bundle', async () => {
    const dir = await makeBundle();
    const s = streams();
    expect(await main(['validate', dir], s.out, s.err)).toBe(0);
    expect(s.text().out).toBe(`valid: ${dir} (schema 1.0.0)\n`);
  });

  it('lists each issue with its rule, file and location, and exits 1', async () => {
    const s = streams();
    expect(await main(['validate', EXAMPLE_DIR], s.out, s.err)).toBe(1);
    expect(s.text().out).toBe(
      [
        `invalid: ${EXAMPLE_DIR} (3 issue(s))`,
        '  rule 1 files-present | traces.jsonl | traces.jsonl is missing',
        '  rule 1 files-present | metrics.jsonl | metrics.jsonl is missing',
        '  rule 1 files-present | logs.jsonl | logs.jsonl is missing',
        '',
      ].join('\n'),
    );
  });

  it('prints the report as JSON with --json', async () => {
    const dir = await makeBundle({ manifest: (m) => delete m.load });
    const s = streams();
    expect(await main(['validate', '--json', dir], s.out, s.err)).toBe(1);
    expect(JSON.parse(s.text().out)).toMatchObject({
      valid: false,
      schemaVersion: '1.0.0',
      issues: [{ rule: 3, ruleId: 'document-schema', file: 'manifest.json', field: 'load' }],
    });
  });

  it('reports a broken vendored contract as exit 2, and lets other errors through', async () => {
    const spy = vi.spyOn(validate, 'validateBundle');
    spy.mockRejectedValueOnce(new ContractError('vendored schema changed'));
    const s = streams();
    expect(await main(['validate', 'x'], s.out, s.err)).toBe(2);
    expect(s.text().err).toBe('contract error: vendored schema changed\n');
    spy.mockRejectedValueOnce(new Error('disk on fire'));
    await expect(main(['validate', 'x'], s.out, s.err)).rejects.toThrow('disk on fire');
    spy.mockRestore();
  });

  it('runs as a program', async () => {
    const run = promisify(execFile);
    const cli = new URL('../src/cli.ts', import.meta.url).pathname;
    const ok = await run('node', [cli, 'validate', await makeBundle()]);
    expect(ok.stdout).toMatch(/^valid: .* \(schema 1\.0\.0\)\n$/);
    const bad = await run('node', [cli, 'validate', EXAMPLE_DIR]).catch((e: unknown) => e);
    expect(bad).toMatchObject({ code: 1 });
  });
});
