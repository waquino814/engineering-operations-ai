import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { CONTRACTS_DIR, majorOf, PINNED_SCHEMAS, validatorsFor } from '../src/intake/contract.ts';
import { ContractError, SUPPORTED_MAJOR_VERSIONS } from '../src/index.ts';

describe('the vendored contract', () => {
  it('pins every schema file to the checksum in the provenance table', async () => {
    const readme = await readFile(`${CONTRACTS_DIR}README.md`, 'utf8');
    for (const [name, pinned] of Object.entries(PINNED_SCHEMAS[1] ?? {})) {
      const bytes = await readFile(`${CONTRACTS_DIR}v1/${name}.schema.json`);
      expect(createHash('sha256').update(bytes).digest('hex'), name).toBe(pinned);
      expect(readme, name).toContain(`v1/${name}.schema.json`);
      expect(readme, name).toContain(pinned);
    }
  });

  it('supports major version 1 only, and refuses to load another', async () => {
    expect(SUPPORTED_MAJOR_VERSIONS).toEqual([1]);
    await expect(validatorsFor(2)).rejects.toBeInstanceOf(ContractError);
    await expect(validatorsFor(1)).resolves.toHaveProperty('manifest');
  });

  it('reads the major version of a semantic version only', () => {
    expect([majorOf('1.0.0'), majorOf('12.3.4'), majorOf('1.0.0-rc.1')]).toEqual([1, 12, 1]);
    expect([
      majorOf('1.0'),
      majorOf('v1.0.0'),
      majorOf('01.0.0'),
      majorOf(1),
      majorOf(null),
    ]).toEqual([null, null, null, null, null]);
  });
});
