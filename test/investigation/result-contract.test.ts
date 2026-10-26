import { readFile } from 'node:fs/promises';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  createInvestigator,
  FakeProvider,
  ProviderError,
  readInvestigationResult,
  runInvestigation,
  type InvestigationResult,
} from '../../src/index.ts';
import { makeBundle } from '../support.ts';
import { bundles, excerptView, goodOutput } from './support.ts';

/**
 * The result states and how a consumer tells them apart (ADR 0004; proposed amendment ADR 0010;
 * docs/contracts/investigation-result/README.md). Valid examples come from real runs; malformed
 * ones are those examples with one rule broken.
 */
type Json = Record<string, unknown>;
const results: Record<string, InvestigationResult> = {};
const ceiling = 204_000;

beforeAll(async () => {
  const view = await excerptView();
  const investigate = async (steps: ConstructorParameters<typeof FakeProvider>[0], limits = {}) =>
    createInvestigator({ provider: new FakeProvider(steps), limits, now: () => 0 }).investigate(
      view,
    );
  results.completed = await investigate([{ reply: goodOutput(view) }]);
  results.inconclusive = await investigate([
    {
      reply: goodOutput(view, {
        outcome: 'inconclusive',
        findings: [],
        remediation: [],
        limitations: ['Nothing in the selected evidence points to a failing component.'],
      }),
    },
  ]);
  results.failed = await investigate([{ error: new ProviderError('authentication', '401') }]);
  results.budgetExceeded = await investigate([{ error: new ProviderError('unavailable', '503') }], {
    maxTotalTokens: ceiling,
  });
  const invalid = await makeBundle({ after: { 'logs.jsonl': 'nope\n' } });
  results.notAdmitted = (
    await runInvestigation(invalid, { provider: new FakeProvider([]), now: () => 0 })
  ).result;
  results.badConfiguration = (
    await runInvestigation((await bundles()).excerpt, {
      provider: new FakeProvider([]),
      limits: { maxModelCalls: 0 },
      now: () => 0,
    })
  ).result;
});

const published = async () => {
  const schema = JSON.parse(
    await readFile(
      new URL(
        '../../docs/contracts/investigation-result/v0/investigation-result.schema.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as object;
  return new Ajv2020({ strict: true, allErrors: true }).compile(schema);
};
const mutate = (name: string, change: (r: Json) => void): Json => {
  const copy = structuredClone(results[name]) as unknown as Json;
  change(copy);
  return copy;
};
const codes = (value: unknown) => {
  const read = readInvestigationResult(value);
  return read.ok ? [] : [...new Set(read.problems.map((p) => p.code))];
};

describe('each result state', () => {
  it('is produced as a valid document, accepted by the code and by the published schema', async () => {
    const validate = await published();
    for (const [name, result] of Object.entries(results)) {
      expect(readInvestigationResult(result), name).toEqual({ ok: true, result });
      expect(validate(result), name).toBe(true);
    }
  });

  it('is distinguished by outcome, failure and caseId alone', () => {
    const shape = (r: InvestigationResult) => [
      r.outcome,
      r.failure?.class ?? null,
      r.caseId !== null,
    ];
    expect(shape(results.completed as InvestigationResult)).toEqual(['completed', null, true]);
    expect(shape(results.inconclusive as InvestigationResult)).toEqual([
      'inconclusive',
      null,
      true,
    ]);
    expect(shape(results.failed as InvestigationResult)).toEqual([
      'failed',
      'provider_authentication',
      true,
    ]);
    expect(shape(results.budgetExceeded as InvestigationResult)).toEqual([
      'budget_exceeded',
      'resource_limit_exceeded',
      true,
    ]);
    expect(shape(results.notAdmitted as InvestigationResult)).toEqual([
      'failed',
      'invalid_bundle',
      false,
    ]);
    expect(shape(results.badConfiguration as InvestigationResult)).toEqual([
      'failed',
      'invalid_configuration',
      false,
    ]);
  });
});

describe('malformed combinations', () => {
  const failure = { class: 'provider_timeout', message: 'x' };
  const cases: [string, string, (r: Json) => void][] = [
    ['completed with a failure', 'completed', (r) => (r.failure = failure)],
    ['completed without findings', 'completed', (r) => ((r.findings = []), (r.remediation = []))],
    ['inconclusive with a failure', 'inconclusive', (r) => (r.failure = failure)],
    ['inconclusive without limitations', 'inconclusive', (r) => (r.limitations = [])],
    ['failed without a failure', 'failed', (r) => delete r.failure],
    [
      'failed with findings',
      'failed',
      (r) => (r.findings = (results.completed as InvestigationResult).findings),
    ],
    [
      'failed with remediation',
      'failed',
      (r) => (r.remediation = [{ step: 's', addresses: ['F1'] }]),
    ],
    ['budget_exceeded for a provider failure', 'budgetExceeded', (r) => (r.failure = failure)],
    [
      'failed for a spent budget',
      'failed',
      (r) => (r.failure = { class: 'resource_limit_exceeded', message: 'x' }),
    ],
    ['an unknown outcome', 'completed', (r) => (r.outcome = 'partial')],
    ['an unknown failure class', 'failed', (r) => (r.failure = { class: 'oops', message: 'x' })],
    [
      'no case but an inconclusive outcome',
      'inconclusive',
      (r) => ((r.caseId = null), (r.bundle = null)),
    ],
    [
      'no case, for a provider failure',
      'failed',
      (r) => ((r.caseId = null), (r.bundle = null), (r.selection = null)),
    ],
    [
      'no case but bundle checksums',
      'notAdmitted',
      (r) => (r.bundle = (results.completed as InvestigationResult).bundle),
    ],
    [
      'a case refused at admission',
      'failed',
      (r) => (r.failure = { class: 'invalid_bundle', message: 'x' }),
    ],
    ['a case without bundle checksums', 'completed', (r) => (r.bundle = null)],
    ['an unknown top-level field', 'completed', (r) => (r.scenario = 'x')],
    ['an unknown selection field', 'completed', (r) => ((r.selection as Json).bundleId = 'x')],
    [
      'partial limits',
      'completed',
      (r) => delete (r.run as { limits: Json }).limits.maxTotalTokens,
    ],
    ['an unknown limit', 'completed', (r) => ((r.run as { limits: Json }).limits.seed = 42)],
    [
      'usage without the token charge',
      'completed',
      (r) => delete (r.run as { usage: Json }).usage.chargedTokens,
    ],
    [
      'an unknown token accounting',
      'completed',
      (r) => ((r.run as { usage: Json }).usage.tokenAccounting = 'exact'),
    ],
  ];
  for (const [label, base, change] of cases) {
    it(`rejects ${label}`, async () => {
      const value = mutate(base, change);
      expect(codes(value)).toEqual(['schema_violation']);
      expect((await published())(value)).toBe(false);
    });
  }
});

describe('finding verification claims', () => {
  const verification = (change: (v: Json) => void) =>
    mutate('completed', (r) => {
      change((r.findings as { verification: Json }[])[0]?.verification as Json);
    });
  it('cannot claim semantic support, which nothing assesses', () => {
    for (const value of ['supported', 'verified', 'partially_supported'])
      expect(codes(verification((v) => (v.semanticSupport = value))), value).toEqual([
        'schema_violation',
      ]);
  });
  it('cannot weaken, omit or add a check', () => {
    for (const field of ['referenceExists', 'identityMatches', 'integrity', 'includedInRequest']) {
      expect(codes(verification((v) => (v[field] = 'not_verified'))), field).toEqual([
        'schema_violation',
      ]);
      expect(codes(verification((v) => Reflect.deleteProperty(v, field))), field).toEqual([
        'schema_violation',
      ]);
    }
    expect(codes(verification((v) => (v.humanReviewed = 'verified')))).toEqual([
      'schema_violation',
    ]);
    expect(
      codes(mutate('completed', (r) => delete (r.findings as Json[])[0]?.verification)),
    ).toEqual(['schema_violation']);
  });
});

describe('versions', () => {
  it('rejects unsupported, missing or mistyped versions before anything else', () => {
    for (const version of ['0.2.0', '1.0.0', '0.1', 1, null, undefined]) {
      const value = mutate('completed', (r) => {
        if (version === undefined) delete r.schemaVersion;
        else r.schemaVersion = version;
      });
      const read = readInvestigationResult(value);
      expect(read.ok, String(version)).toBe(false);
      expect(read.ok ? [] : read.problems, String(version)).toEqual([
        expect.objectContaining({ code: 'unsupported_result_version' }),
      ]);
    }
  });

  it('rejects documents that are not objects', () => {
    for (const value of [null, [], 'result', 3])
      expect(codes(value), JSON.stringify(value)).toEqual(['not_an_object']);
  });
});

describe('rules beyond the schema', () => {
  it('rejects remediation for unknown findings and duplicate finding ids', () => {
    expect(
      codes(mutate('completed', (r) => (r.remediation = [{ step: 's', addresses: ['F9'] }]))),
    ).toEqual(['inconsistent_result']);
    expect(
      codes(
        mutate(
          'completed',
          (r) => (r.findings = [...(r.findings as Json[]), ...(r.findings as Json[])]),
        ),
      ),
    ).toEqual(['inconsistent_result']);
  });

  it('rejects usage that does not add up', () => {
    const usage = (change: (u: Json) => void) =>
      mutate('completed', (r) => {
        change((r.run as { usage: Json }).usage);
      });
    expect(codes(usage((u) => (u.retries = 5)))).toEqual(['inconsistent_result']);
    expect(codes(usage((u) => ((u.inputTokens = 10), (u.chargedTokens = 5))))).toEqual([
      'inconsistent_result',
    ]);
    expect(codes(usage((u) => (u.tokenAccounting = 'reported')))).toEqual(['inconsistent_result']);
    expect(
      codes(
        usage((u) => {
          u.tokenAccounting = 'estimated';
          u.unreportedCalls = 0;
        }),
      ),
    ).toEqual(['inconsistent_result']);
  });
});
