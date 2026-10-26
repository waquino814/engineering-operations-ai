import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  INVESTIGATION_RESULT_SCHEMA,
  MODEL_OUTPUT_SCHEMA,
  RESULT_SCHEMA_VERSION,
} from '../../src/index.ts';

/** The committed result-contract files must match the schemas the code uses (ADR 0004). */
describe('the investigation-result contract files', () => {
  it('match the schemas in the code', async () => {
    const dir = new URL('../../docs/contracts/investigation-result/v0/', import.meta.url);
    const read = async (f: string) =>
      JSON.parse(await readFile(new URL(f, dir), 'utf8')) as unknown;
    expect(await read('model-output.schema.json')).toEqual(MODEL_OUTPUT_SCHEMA);
    expect(await read('investigation-result.schema.json')).toEqual(INVESTIGATION_RESULT_SCHEMA);
    expect(RESULT_SCHEMA_VERSION).toBe('0.1.0');
  });
});
