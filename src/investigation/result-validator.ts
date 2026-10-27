import { Ajv2020, type ErrorObject } from 'ajv/dist/2020.js';
import { INVESTIGATION_RESULT_SCHEMA } from './schemas.ts';

/** A compiled JSON Schema check, as Ajv produces it: call it, then read `errors` if it said no. */
export interface SchemaValidator {
  (value: unknown): boolean;
  errors?: ErrorObject[] | null;
}

/**
 * The published result schema, compiled. Ajv compiles at runtime with `new Function`, which the
 * application's Content-Security-Policy (`default-src 'self'`) forbids in a browser, so the
 * console's build swaps this module for a precompiled validator of the same schema
 * (scripts/standalone-validator.ts, wired in vite.config.ts). The policy stays strict, and the
 * console still checks every result against the full schema.
 */
export const validateResult: SchemaValidator = new Ajv2020({
  strict: true,
  allErrors: true,
}).compile(INVESTIGATION_RESULT_SCHEMA);
