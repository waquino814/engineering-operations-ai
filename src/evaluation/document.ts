import { Ajv } from 'ajv';
import type { EvaluationRun } from './run.ts';

/**
 * Reading a stored evaluation run. The envelope is validated against a closed schema (unknown
 * fields rejected); the per-case reports are checked for the fields the console and the
 * comparison depend on. A document that fails is reported, never repaired or partly used.
 */
const ajv = new Ajv({ allErrors: true, strict: true });

const metric = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'label', 'definition', 'numerator', 'denominator', 'value', 'status'],
  properties: {
    id: { type: 'string' },
    label: { type: 'string' },
    definition: { type: 'string' },
    numerator: { type: ['integer', 'null'] },
    denominator: { type: 'integer', minimum: 0 },
    value: { type: ['number', 'null'] },
    status: { enum: ['scored', 'not_applicable', 'not_scored'] },
    note: { type: 'string' },
  },
} as const;

const caseReport = {
  type: 'object',
  required: [
    'id',
    'kind',
    'summary',
    'failure',
    'scenario',
    'score',
    'rationale',
    'grounding',
    'resultValid',
    'answerLeak',
  ],
  properties: {
    id: { type: 'string' },
    kind: { enum: ['synthetic', 'real'] },
    summary: {
      type: 'object',
      required: ['outcome'],
      properties: { outcome: { type: 'string' } },
    },
    failure: { type: ['object', 'null'] },
    scenario: { type: ['object', 'null'] },
    score: { type: ['object', 'null'] },
    rationale: { type: 'array', items: { type: 'string' } },
    grounding: { type: ['object', 'null'] },
    resultValid: { type: 'boolean' },
    answerLeak: {
      type: 'object',
      required: ['leaked'],
      properties: { leaked: { type: 'boolean' } },
    },
    durationMs: { type: 'number' },
  },
} as const;

const schema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'id',
    'suite',
    'provider',
    'measuresModelQuality',
    'startedAt',
    'finishedAt',
    'durationMs',
    'status',
    'report',
    'metrics',
    'scenarios',
    'reliability',
    'harnessErrors',
    'limitations',
  ],
  properties: {
    schemaVersion: { const: '0.1.0' },
    id: {
      type: 'string',
      pattern: '^[0-9]{8}T[0-9]{6}Z-[a-z0-9-]{1,40}-(scripted|simulated|real_model)(-[0-9]{1,3})?$',
    },
    suite: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'version', 'split', 'synthetic', 'description'],
      properties: {
        id: { type: 'string' },
        version: { type: 'string' },
        split: { enum: ['development', 'held-out'] },
        synthetic: { type: 'boolean' },
        description: { type: 'string' },
      },
    },
    provider: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'provider', 'model', 'simulated'],
      properties: {
        kind: { enum: ['scripted', 'simulated', 'real_model'] },
        provider: { type: 'string' },
        model: { type: 'string' },
        simulated: { type: 'boolean' },
      },
    },
    measuresModelQuality: { type: 'boolean' },
    startedAt: { type: 'string' },
    finishedAt: { type: 'string' },
    durationMs: { type: 'number', minimum: 0 },
    status: { enum: ['complete', 'incomplete'] },
    report: {
      type: 'object',
      required: ['schemaVersion', 'cases', 'totals'],
      properties: {
        schemaVersion: { const: '0.1.0' },
        cases: { type: 'array', items: caseReport },
        totals: { type: 'object' },
      },
    },
    metrics: { type: 'array', items: metric },
    scenarios: { type: 'array', items: { type: 'object' } },
    reliability: { type: 'object' },
    harnessErrors: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'error'],
        properties: { id: { type: 'string' }, error: { type: 'string' } },
      },
    },
    limitations: { type: 'array', items: { type: 'string' } },
  },
} as const;

const validate = ajv.compile(schema);

export type EvaluationRead = { ok: true; run: EvaluationRun } | { ok: false; problems: string[] };

export function readEvaluationRun(value: unknown): EvaluationRead {
  if (validate(value)) {
    const run: EvaluationRun = value;
    // A real model's numbers are the only ones that may claim to measure quality.
    if (
      run.measuresModelQuality !== (run.provider.kind === 'real_model') ||
      run.provider.simulated === (run.provider.kind === 'real_model')
    )
      return { ok: false, problems: ['provider kind and the quality/simulated flags disagree'] };
    return { ok: true, run };
  }
  return {
    ok: false,
    problems: (validate.errors ?? [])
      .slice(0, 10)
      .map((e) => `${e.instancePath || '/'} ${e.message ?? 'is invalid'}`),
  };
}
