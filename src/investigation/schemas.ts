import { DEFAULT_LIMITS } from './config.ts';
import { FAILURE_CLASSES } from './failures.ts';

/**
 * The investigation-result contract, version 0.1.0 (ADR 0004; proposed amendment ADR 0010), and
 * the model-output contract, as JSON Schema draft 2020-12. Defined here so the investigation layer
 * needs no file access; the committed copies in docs/contracts/investigation-result/v0/ are
 * checked against these by a drift test. The two documents are versioned separately: the model
 * output is what a model must return, the result is what consumers read.
 */
export const RESULT_SCHEMA_VERSION = '0.1.0';
export const MODEL_OUTPUT_VERSION = '0.1.0';
export const SUPPORTED_MODEL_OUTPUT_VERSIONS: readonly string[] = [MODEL_OUTPUT_VERSION];

/** Failure classes raised before an investigation starts: there is no admitted case. */
export const ADMISSION_FAILURE_CLASSES = [
  'invalid_bundle',
  'unsupported_contract_version',
  'invalid_configuration',
] as const;

const BASE = 'https://engineering-operations-ai.local/schemas/investigation-result/v0';
const findingId = { type: 'string', pattern: '^[A-Za-z0-9_-]{1,32}$' } as const;
const component = { type: 'string', pattern: '^[a-z][a-z0-9-]*$', maxLength: 64 } as const;
const text = (max: number) => ({ type: 'string', minLength: 1, maxLength: max }) as const;
const hex = (n: number) => ({ type: 'string', pattern: `^[0-9a-f]{${String(n)}}$` }) as const;
const count = { type: 'integer', minimum: 0 } as const;
const TELEMETRY = ['traces.jsonl', 'metrics.jsonl', 'logs.jsonl'] as const;
const closed = (properties: Record<string, unknown>) =>
  ({
    type: 'object',
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  }) as const;

/**
 * A reference to one telemetry record. `file` is a free string here so the evidence verifier,
 * not the schema, reports an unknown or forbidden file precisely.
 */
const evidenceReference = {
  type: 'object',
  additionalProperties: false,
  required: ['file', 'line'],
  properties: {
    file: text(200),
    line: { type: 'integer', minimum: 1 },
    sha256: hex(64),
    series: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'labels'],
      properties: {
        name: text(200),
        labels: { type: 'object', additionalProperties: { type: 'string' } },
      },
    },
    samples: {
      type: 'array',
      minItems: 1,
      maxItems: 20,
      items: {
        type: 'array',
        prefixItems: [{ type: 'number' }, { type: 'string' }],
        minItems: 2,
        maxItems: 2,
      },
    },
    time: text(64),
    service: text(64),
    traceId: hex(32),
    spanId: hex(16),
  },
} as const;

const finding = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'kind', 'statement', 'components', 'confidence', 'rationale', 'evidence'],
  properties: {
    id: findingId,
    kind: { enum: ['root_cause', 'affected_component', 'symptom'] },
    statement: text(2_000),
    components: { type: 'array', maxItems: 20, items: component },
    confidence: { enum: ['high', 'medium', 'low'] },
    rationale: text(1_000),
    evidence: { type: 'array', minItems: 1, maxItems: 50, items: evidenceReference },
  },
} as const;

const remediation = {
  type: 'array',
  maxItems: 30,
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['step', 'addresses'],
    properties: {
      step: text(1_000),
      addresses: { type: 'array', minItems: 1, maxItems: 20, items: findingId },
    },
  },
} as const;

const limitations = { type: 'array', maxItems: 50, items: text(1_000) } as const;

/** What a model must return. Closed objects: unknown fields are rejected. */
export const MODEL_OUTPUT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: `${BASE}/model-output.schema.json`,
  title: 'Investigation model output',
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'outcome', 'findings', 'remediation', 'limitations'],
  properties: {
    schemaVersion: { type: 'string' },
    outcome: { enum: ['completed', 'inconclusive'] },
    findings: { type: 'array', maxItems: 50, items: finding },
    remediation,
    limitations,
  },
} as const;

/** The persisted result, assembled by the investigator after verification. */
export const INVESTIGATION_RESULT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: `${BASE}/investigation-result.schema.json`,
  title: 'Investigation result',
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'caseId',
    'bundle',
    'outcome',
    'findings',
    'remediation',
    'limitations',
    'selection',
    'run',
  ],
  properties: {
    schemaVersion: { const: RESULT_SCHEMA_VERSION },
    caseId: { anyOf: [hex(16), { type: 'null' }] },
    bundle: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          required: ['files'],
          properties: {
            files: {
              type: 'object',
              additionalProperties: false,
              required: ['traces.jsonl', 'metrics.jsonl', 'logs.jsonl'],
              properties: Object.fromEntries(
                ['traces.jsonl', 'metrics.jsonl', 'logs.jsonl'].map((f) => [
                  f,
                  {
                    type: 'object',
                    additionalProperties: false,
                    required: ['sha256'],
                    properties: { sha256: hex(64) },
                  },
                ]),
              ),
            },
          },
        },
      ],
    },
    outcome: { enum: ['completed', 'inconclusive', 'budget_exceeded', 'failed'] },
    failure: {
      type: 'object',
      additionalProperties: false,
      required: ['class', 'message'],
      properties: { class: { enum: [...FAILURE_CLASSES] }, message: { type: 'string' } },
    },
    findings: {
      type: 'array',
      items: {
        ...finding,
        required: [...finding.required, 'verification'],
        properties: {
          ...finding.properties,
          // ADR 0007: only what the code checks can be claimed. A stronger value, such as a
          // semantic-support verdict, needs new code and a new schema version.
          verification: closed({
            referenceExists: { const: 'verified' },
            identityMatches: { const: 'verified' },
            integrity: { const: 'verified' },
            includedInRequest: { const: 'verified' },
            semanticSupport: { const: 'not_assessed' },
          }),
        },
      },
    },
    remediation,
    limitations,
    selection: {
      anyOf: [
        { type: 'null' },
        closed({
          limits: closed({ maxRecords: count, maxBytes: count, maxRecordBytes: count }),
          files: closed(
            Object.fromEntries(
              TELEMETRY.map((f) => [
                f,
                closed({
                  records: count,
                  selected: count,
                  omitted: closed({
                    record_limit: count,
                    context_limit: count,
                    record_too_large: count,
                    repeated: count,
                  }),
                }),
              ]),
            ),
          ),
          selectedBytes: count,
          emptyFiles: { type: 'array', items: { enum: [...TELEMETRY] } },
          truncatedTraceServices: { type: 'array', items: { type: 'string' } },
          notes: { type: 'array', items: { type: 'string' } },
        }),
      ],
    },
    run: {
      type: 'object',
      additionalProperties: false,
      required: ['provider', 'model', 'limits', 'usage', 'startedAt', 'finishedAt', 'durationMs'],
      properties: {
        provider: { type: 'string' },
        model: { type: 'string' },
        // Every limit, or none when the configuration itself was invalid.
        limits: {
          anyOf: [
            closed(Object.fromEntries(Object.keys(DEFAULT_LIMITS).map((k) => [k, count]))),
            { type: 'object', maxProperties: 0 },
          ],
        },
        usage: closed({
          modelCalls: count,
          repairAttempts: count,
          retries: count,
          inputTokens: count,
          outputTokens: count,
          chargedTokens: count,
          unreportedCalls: count,
          inconsistentReports: count,
          tokenAccounting: { enum: ['reported', 'estimated'] },
        }),
        startedAt: { type: 'string' },
        finishedAt: { type: 'string' },
        durationMs: { type: 'integer', minimum: 0 },
      },
    },
  },
  // The result states (docs/contracts/investigation-result/README.md). `outcome` decides; the
  // other fields must agree with it.
  allOf: [
    {
      // Only a run that did not finish carries a failure, and then it reports nothing found.
      if: { properties: { outcome: { enum: ['failed', 'budget_exceeded'] } } },
      then: {
        required: ['failure'],
        properties: {
          failure: true,
          findings: { type: 'array', maxItems: 0 },
          remediation: { type: 'array', maxItems: 0 },
        },
      },
      else: { properties: { failure: false } },
    },
    {
      if: { properties: { outcome: { const: 'completed' } } },
      then: { properties: { findings: { type: 'array', minItems: 1 } } },
    },
    {
      // An inconclusive result is a valid investigation that says why it could not conclude.
      if: { properties: { outcome: { const: 'inconclusive' } } },
      then: { properties: { limitations: { type: 'array', minItems: 1 } } },
    },
    {
      if: { properties: { outcome: { const: 'budget_exceeded' } } },
      then: {
        properties: {
          failure: { type: 'object', properties: { class: { const: 'resource_limit_exceeded' } } },
        },
      },
    },
    {
      if: { properties: { outcome: { const: 'failed' } } },
      then: {
        properties: {
          failure: {
            type: 'object',
            properties: { class: { not: { const: 'resource_limit_exceeded' } } },
          },
        },
      },
    },
    {
      // No case ID means the bundle or configuration was refused before any investigation.
      if: { properties: { caseId: { type: 'null' } } },
      then: {
        required: ['failure'],
        properties: {
          outcome: { const: 'failed' },
          bundle: { type: 'null' },
          selection: { type: 'null' },
          failure: {
            type: 'object',
            properties: { class: { enum: [...ADMISSION_FAILURE_CLASSES] } },
          },
        },
      },
      else: {
        properties: {
          bundle: { type: 'object' },
          failure: {
            type: 'object',
            properties: { class: { not: { enum: [...ADMISSION_FAILURE_CLASSES] } } },
          },
        },
      },
    },
  ],
} as const;
