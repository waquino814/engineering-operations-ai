import { describe, expect, it } from 'vitest';
import { FAILURE_CLASSES, sanitizeMessage } from '../../src/index.ts';
import { INVESTIGATION_RESULT_SCHEMA } from '../../src/investigation/schemas.ts';

/** ADR 0006: failure messages are bounded and carry no credentials. */
describe('failure messages', () => {
  it('redacts bearer tokens, API keys and credential assignments', () => {
    expect(sanitizeMessage('Authorization: Bearer abc.def')).toBe('[redacted]');
    expect(sanitizeMessage('key sk-abcdef123456 rejected')).toBe('key [redacted] rejected');
    expect(sanitizeMessage('x-api-key=12345 password: hunter2')).toBe('[redacted] [redacted]');
  });

  it('collapses whitespace and bounds the length', () => {
    expect(sanitizeMessage('  a\n\n  b\t c ')).toBe('a b c');
    const long = sanitizeMessage('x'.repeat(1_000));
    expect(long).toHaveLength(300);
    expect(long.endsWith('…')).toBe(true);
  });

  it('lists the same failure classes as the published result schema', () => {
    const schemaClasses = INVESTIGATION_RESULT_SCHEMA.properties.failure.properties.class.enum;
    expect(schemaClasses).toEqual([...FAILURE_CLASSES]);
  });
});
