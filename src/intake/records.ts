import { RECORD_SCHEMA, validatorsFor, type TelemetryFile } from './contract.ts';
import { schemaIssues } from './checks.ts';
import type { ValidationIssue } from './issues.ts';

/**
 * Validates one telemetry record, or the manifest document, against a supported major version's
 * vendored schema, outside any bundle: for excerpts and fixtures (docs/examples/).
 */
export type RecordKind = TelemetryFile | 'manifest.json';

export async function validateRecord(
  kind: RecordKind,
  value: unknown,
  major = 1,
): Promise<ValidationIssue[]> {
  const validators = await validatorsFor(major);
  if (kind === 'manifest.json') return schemaIssues(validators.manifest, value, 3, kind);
  return schemaIssues(validators[RECORD_SCHEMA[kind]], value, 4, kind);
}
