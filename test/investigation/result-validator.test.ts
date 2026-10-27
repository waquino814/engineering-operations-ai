import { describe, expect, it } from 'vitest';
import { resultValidatorSource } from '../../scripts/standalone-validator.ts';
import { validateResult } from '../../src/investigation/result-validator.ts';
import { precompiledResultValidator } from '../../vite.config.ts';
import fixtures from '../../src/ui/fixtures/fixtures.json' with { type: 'json' };

/**
 * The console runs under `default-src 'self'`, which forbids the `new Function` Ajv compiles
 * with, so its build ships a precompiled validator. That validator must be self-contained and
 * must accept and reject exactly what the runtime-compiled one does.
 */
interface Precompiled {
  validateResult: ((value: unknown) => boolean) & {
    errors?: { instancePath: string; message?: string }[] | null;
  };
}
const source = resultValidatorSource();
const precompiled = (await import(
  `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
)) as Precompiled;

const results = (fixtures as { investigations: { result: unknown }[] }).investigations.map(
  (i) => i.result as Record<string, unknown>,
);

const outcome = (validate: Precompiled['validateResult'], value: unknown) => ({
  ok: validate(value),
  errors: (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message ?? ''}`),
});

describe('the precompiled result validator', () => {
  it('is self-contained: it needs no import, eval or Function constructor', () => {
    expect(source).not.toMatch(/\brequire\(|^\s*import\s|\beval\(|new Function/m);
    expect(source).toContain('export { validate20 as validateResult }');
  });

  it('has a document to compare on every outcome the console can show', () => {
    expect(results.length).toBeGreaterThan(3);
  });

  it.each(results.map((r, i) => [i, r] as const))('accepts fixture result %i like Ajv', (_, r) => {
    expect(outcome(precompiled.validateResult, r)).toEqual(outcome(validateResult, r));
    expect(precompiled.validateResult(r)).toBe(true);
  });

  it('rejects malformed results with the same errors as Ajv', () => {
    const base = results[0] as Record<string, unknown>;
    const withoutVersion = Object.fromEntries(
      Object.entries(base).filter(([key]) => key !== 'schemaVersion'),
    );
    const bad: unknown[] = [
      null,
      [],
      'text',
      {},
      withoutVersion,
      { ...base, schemaVersion: '9.9.9' },
      { ...base, surprise: true },
      { ...base, caseId: 'x'.repeat(40) },
      { ...base, findings: 'none' },
    ];
    for (const value of bad) {
      const expected = outcome(validateResult, value);
      expect(expected.ok).toBe(false);
      expect(outcome(precompiled.validateResult, value)).toEqual(expected);
    }
  });
});

describe('the console build plugin', () => {
  const plugin = precompiledResultValidator();
  const load = plugin.load as (id: string) => string | undefined;
  const target = new URL('../../src/investigation/result-validator.ts', import.meta.url).pathname;

  it('replaces only the result validator module, and before other plugins', () => {
    expect(plugin.enforce).toBe('pre');
    expect(load(target)).toBe(source);
    expect(load(target.replace('result-validator', 'result'))).toBeUndefined();
  });
});
