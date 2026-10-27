import { Ajv2020, type ErrorObject } from 'ajv/dist/2020.js';
import type { TelemetryFile } from '../intake/contract.ts';
import type { InvestigationLimits } from './config.ts';
import type { Failure } from './failures.ts';
import { validateResult, type SchemaValidator } from './result-validator.ts';
import {
  MODEL_OUTPUT_SCHEMA,
  RESULT_SCHEMA_VERSION,
  SUPPORTED_MODEL_OUTPUT_VERSIONS,
} from './schemas.ts';
import type { SelectionSummary } from './selection.ts';
import type { TokenUsageSnapshot } from './usage.ts';

/** Types for the result contract (ADR 0004) and strict parsing of model output (ADR 0007). */
export type Confidence = 'high' | 'medium' | 'low';
export type FindingKind = 'root_cause' | 'affected_component' | 'symptom';

export interface EvidenceReference {
  file: string;
  line: number;
  sha256?: string;
  series?: { name: string; labels: Record<string, string> };
  samples?: [number, string][];
  time?: string;
  service?: string;
  traceId?: string;
  spanId?: string;
}

export interface ProposedFinding {
  id: string;
  kind: FindingKind;
  statement: string;
  components: string[];
  confidence: Confidence;
  rationale: string;
  evidence: EvidenceReference[];
}

export interface ModelOutput {
  schemaVersion: string;
  outcome: 'completed' | 'inconclusive';
  findings: ProposedFinding[];
  remediation: { step: string; addresses: string[] }[];
  limitations: string[];
}

/**
 * What was checked for a finding's evidence (ADR 0007). A finding reaches a result only when every
 * reference passed every deterministic check, so those are "verified". Semantic support, whether
 * the records actually support the statement, is not checked by anything, so it is "not_assessed"
 * and the schema allows no other value: a result cannot claim more than the code does.
 */
export interface FindingVerification {
  /** Each cited file is an admitted telemetry file and the line holds an admitted record. */
  referenceExists: 'verified';
  /** The identifiers quoted (series and labels, time and service, trace and span) are the record's. */
  identityMatches: 'verified';
  /** The file's SHA-256 was recomputed at admission and equals `bundle.files`; a quoted one matched. */
  integrity: 'verified';
  /** Every cited record was in the evidence sent to the model. */
  includedInRequest: 'verified';
  semanticSupport: 'not_assessed';
}

export const FINDING_VERIFICATION: Readonly<FindingVerification> = Object.freeze({
  referenceExists: 'verified',
  identityMatches: 'verified',
  integrity: 'verified',
  includedInRequest: 'verified',
  semanticSupport: 'not_assessed',
});

export interface VerifiedFinding extends ProposedFinding {
  verification: FindingVerification;
}

export type Outcome = 'completed' | 'inconclusive' | 'budget_exceeded' | 'failed';

export interface InvestigationResult {
  schemaVersion: string;
  caseId: string | null;
  bundle: { files: Record<TelemetryFile, { sha256: string }> } | null;
  outcome: Outcome;
  failure?: Failure;
  findings: VerifiedFinding[];
  remediation: { step: string; addresses: string[] }[];
  limitations: string[];
  selection: SelectionSummary | null;
  run: {
    provider: string;
    model: string;
    /** Empty when the configuration itself was invalid. */
    limits: InvestigationLimits | Record<string, never>;
    usage: {
      modelCalls: number;
      repairAttempts: number;
      retries: number;
    } & TokenUsageSnapshot;
    startedAt: string;
    finishedAt: string;
    durationMs: number;
  };
}

export interface OutputProblem {
  code:
    | 'malformed_json'
    | 'not_an_object'
    | 'unsupported_result_version'
    | 'schema_violation'
    | 'reply_too_large';
  /** A dotted path into the output, when one applies. */
  field?: string;
  message: string;
}

// Compiled on first use: only the application parses model output, and runtime compilation is not
// possible in the console under its Content-Security-Policy (see result-validator.ts).
let compiledOutput: SchemaValidator | undefined;
const outputValidator = (): SchemaValidator =>
  (compiledOutput ??= new Ajv2020({ strict: true, allErrors: true }).compile(MODEL_OUTPUT_SCHEMA));

const describe = (e: ErrorObject) => {
  const path = e.instancePath.split('/').slice(1).join('.');
  const extra = (e.params as { additionalProperty?: unknown }).additionalProperty;
  return {
    field: typeof extra === 'string' ? (path ? `${path}.${extra}` : extra) : path,
    message: `${path || 'the output'} ${e.message ?? 'is invalid'}${typeof extra === 'string' ? `: "${extra}"` : ''}`,
  };
};

/** The largest reply accepted for parsing; a longer one is rejected without being parsed. */
export const MAX_REPLY_BYTES = 1_000_000;

/**
 * Parses a model reply strictly: one JSON object, a supported version, the closed output schema.
 * Nothing is defaulted, repaired or invented; any problem returns problems instead of output.
 */
export function parseModelOutput(
  text: string,
): { ok: true; output: ModelOutput } | { ok: false; problems: OutputProblem[] } {
  if (Buffer.byteLength(text, 'utf8') > MAX_REPLY_BYTES) {
    return {
      ok: false,
      problems: [
        { code: 'reply_too_large', message: `the reply exceeds ${String(MAX_REPLY_BYTES)} bytes` },
      ],
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return {
      ok: false,
      problems: [{ code: 'malformed_json', message: 'the reply is not a single JSON document' }],
    };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {
      ok: false,
      problems: [{ code: 'not_an_object', message: 'the reply must be a JSON object' }],
    };
  }
  const version = (value as { schemaVersion?: unknown }).schemaVersion;
  if (typeof version !== 'string' || !SUPPORTED_MODEL_OUTPUT_VERSIONS.includes(version)) {
    return {
      ok: false,
      problems: [
        {
          code: 'unsupported_result_version',
          field: 'schemaVersion',
          message: `schemaVersion ${version === undefined ? 'is missing' : JSON.stringify(version)}; supported: ${SUPPORTED_MODEL_OUTPUT_VERSIONS.join(', ')}`,
        },
      ],
    };
  }
  const validateOutput = outputValidator();
  if (!validateOutput(value)) {
    return {
      ok: false,
      problems: (validateOutput.errors ?? []).map((e) => ({
        code: 'schema_violation',
        ...describe(e),
      })),
    };
  }
  return { ok: true, output: value as ModelOutput };
}

/** Checks an assembled result against the published result schema. */
export function resultSchemaProblems(result: unknown): string[] {
  if (validateResult(result)) return [];
  return (validateResult.errors ?? []).map((e) => describe(e).message);
}

export interface ResultProblem {
  code: 'not_an_object' | 'unsupported_result_version' | 'schema_violation' | 'inconsistent_result';
  message: string;
}

/**
 * Reads a result document as a consumer would (docs/contracts/investigation-result/README.md):
 * the version first, then the schema, then the rules a schema cannot express. A consumer must not
 * interpret a document this rejects.
 */
export function readInvestigationResult(
  value: unknown,
): { ok: true; result: InvestigationResult } | { ok: false; problems: ResultProblem[] } {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return {
      ok: false,
      problems: [{ code: 'not_an_object', message: 'a result must be a JSON object' }],
    };
  const version = (value as { schemaVersion?: unknown }).schemaVersion;
  if (version !== RESULT_SCHEMA_VERSION)
    return {
      ok: false,
      problems: [
        {
          code: 'unsupported_result_version',
          message: `schemaVersion ${version === undefined ? 'is missing' : JSON.stringify(version)}; supported: ${RESULT_SCHEMA_VERSION}`,
        },
      ],
    };
  const schema = resultSchemaProblems(value);
  if (schema.length > 0)
    return {
      ok: false,
      problems: schema.map((message) => ({ code: 'schema_violation', message })),
    };
  const result = value as InvestigationResult;
  const problems: ResultProblem[] = [];
  const ids = result.findings.map((f) => f.id);
  if (new Set(ids).size !== ids.length)
    problems.push({ code: 'inconsistent_result', message: 'finding ids are not unique' });
  for (const r of result.remediation)
    for (const id of r.addresses)
      if (!ids.includes(id))
        problems.push({
          code: 'inconsistent_result',
          message: `remediation addresses unknown finding ${id}`,
        });
  const u = result.run.usage;
  if (u.repairAttempts + u.retries > u.modelCalls)
    problems.push({
      code: 'inconsistent_result',
      message: 'repairs and retries exceed the model calls that contain them',
    });
  if (u.chargedTokens < u.inputTokens + u.outputTokens)
    problems.push({
      code: 'inconsistent_result',
      message: 'charged tokens are fewer than the tokens reported',
    });
  if ((u.tokenAccounting === 'reported') !== (u.unreportedCalls + u.inconsistentReports === 0))
    problems.push({
      code: 'inconsistent_result',
      message: 'tokenAccounting does not match the unreported and inconsistent call counts',
    });
  return problems.length > 0 ? { ok: false, problems } : { ok: true, result };
}
