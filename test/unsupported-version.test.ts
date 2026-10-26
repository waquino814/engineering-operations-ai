import { describe, expect, it } from 'vitest';
import { validateBundle } from '../src/index.ts';
import { makeBundle } from './support.ts';

/** ADR 0005: an unsupported major version skips schema validation but not the schema-free checks. */
describe('an unsupported major version', () => {
  it('skips schema checks yet still reports schema-free problems', async () => {
    const dir = await makeBundle({
      manifest: (m) => {
        m.schemaVersion = '2.0.0';
        delete m.detection; // a schema problem: not reported, no v2 schema is vendored
        m.bundleId = 'elsewhere-42-20261026T000000Z'; // a rule 6 problem: still reported
      },
      after: { 'logs.jsonl': '\n' }, // a JSONL structure problem: still reported
    });
    const report = await validateBundle(dir);
    expect(report.issues.map((i) => [i.rule, i.file])).toEqual([
      [2, 'manifest.json'],
      [4, 'logs.jsonl'],
      [6, 'manifest.json'],
      [9, 'logs.jsonl'],
      [9, 'logs.jsonl'],
      [9, 'logs.jsonl'],
    ]);
    expect(report.issues.some((i) => i.rule === 3)).toBe(false);
  });
});
