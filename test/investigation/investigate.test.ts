import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createInvestigator,
  FakeProvider,
  INSTRUCTIONS,
  ProviderError,
  resultSchemaProblems,
  summarize,
  type EvidenceView,
  type FakeStep,
  type InvestigationResult,
  type ModelOutput,
} from '../../src/index.ts';
import { excerptView, fabricatedView, goodOutput, ref } from './support.ts';

/** ADR 0006: the investigation service, end to end, against the deterministic fake provider. */
beforeEach(() => {
  // The standard suite must never reach a network: any fetch fails the test.
  vi.stubGlobal('fetch', () => {
    throw new Error('network access attempted in a test');
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const run = async (
  view: EvidenceView,
  steps: FakeStep[],
  limits: Record<string, number> = {},
  signal?: AbortSignal,
) => {
  const provider = new FakeProvider(steps);
  const investigator = createInvestigator({
    provider,
    limits,
    now: () => 0,
    sleep: () => Promise.resolve(),
  });
  const result = await investigator.investigate(view, signal ? { signal } : {});
  expect(resultSchemaProblems(result)).toEqual([]);
  return { result, provider };
};

describe('a successful investigation', () => {
  it('returns a verified, schema-valid result with the case and file checksums', async () => {
    const view = await excerptView();
    const { result, provider } = await run(view, [
      { reply: goodOutput(view), usage: { inputTokens: 900, outputTokens: 120 } },
    ]);
    expect(result).toMatchObject({
      schemaVersion: '0.1.0',
      caseId: view.caseId,
      outcome: 'completed',
      bundle: { files: { 'logs.jsonl': { sha256: view.files['logs.jsonl'].sha256 } } },
      run: {
        provider: 'fake',
        model: 'fake-model',
        usage: {
          modelCalls: 1,
          repairAttempts: 0,
          retries: 0,
          inputTokens: 900,
          outputTokens: 120,
          chargedTokens: 1_020,
          unreportedCalls: 0,
          inconsistentReports: 0,
          tokenAccounting: 'reported',
        },
      },
    });
    expect(result.findings).toHaveLength(1);
    // Every deterministic check is stated separately; semantic support is never claimed.
    expect(result.findings[0]?.verification).toEqual({
      referenceExists: 'verified',
      identityMatches: 'verified',
      integrity: 'verified',
      includedInRequest: 'verified',
      semanticSupport: 'not_assessed',
    });
    expect(result).not.toHaveProperty('failure');
    expect(provider.remaining).toBe(0);
  });

  it('sends fixed instructions and the evidence as separate data, with lines and checksums', async () => {
    const view = await fabricatedView();
    const { provider } = await run(view, [{ reply: goodOutput(view) }]);
    const request = provider.requests[0];
    expect(request?.instructions).toBe(INSTRUCTIONS);
    expect(request?.maxOutputTokens).toBe(4_000);
    const input = JSON.parse(request?.input ?? '{}') as {
      caseId: string;
      manifest: object;
      evidence: { file: string; line: number; sha256: string; record: unknown }[];
    };
    expect(input.caseId).toBe(view.caseId);
    expect(input.manifest).toEqual(view.manifest);
    for (const e of input.evidence) {
      expect(e.sha256).toBe(view.files[e.file as 'logs.jsonl'].sha256);
      expect(e.record).toEqual(
        view.files[e.file as 'logs.jsonl'].entries.find((x) => x.line === e.line)?.value,
      );
    }
    // Telemetry text never appears in the instructions.
    expect(INSTRUCTIONS).not.toContain('connection slots');
  });

  it('accepts citations only of the records the request carried', async () => {
    const view = await fabricatedView();
    // One record fits: the highest-scoring one, a failing slow trace. Logs line 1 is admitted
    // but not sent.
    const limits = { maxEvidenceRecords: 1 };
    const unsent = goodOutput(view, {
      findings: [
        {
          ...(goodOutput(view).findings[0] as ModelOutput['findings'][number]),
          evidence: [ref(view, 'logs.jsonl', 1)],
        },
      ],
    });
    const { result, provider } = await run(view, [{ reply: unsent }, { reply: unsent }], limits);
    const sent = (
      JSON.parse(provider.requests[0]?.input ?? '{}') as {
        evidence: { file: string; line: number }[];
      }
    ).evidence.map((e) => `${e.file}:${String(e.line)}`);
    expect(sent).toEqual(['traces.jsonl:1']);
    expect(result).toMatchObject({
      outcome: 'failed',
      failure: { class: 'evidence_verification_failed' },
      findings: [],
    });
    expect(provider.requests[1]?.input).toContain('record_not_shown');

    const shown = goodOutput(view, {
      findings: [
        {
          ...(goodOutput(view).findings[0] as ModelOutput['findings'][number]),
          evidence: [ref(view, 'traces.jsonl', 1)],
        },
      ],
    });
    expect((await run(view, [{ reply: shown }], limits)).result.outcome).toBe('completed');
  });

  it('never sends answer-bearing fields or answer text', async () => {
    const view = await excerptView();
    const { provider } = await run(view, [{ reply: goodOutput(view) }]);
    const sent = `${provider.requests[0]?.instructions ?? ''}${provider.requests[0]?.input ?? ''}`;
    for (const leak of [
      'provider-outage',
      '"bundleId"',
      '"scenario"',
      '"trigger"',
      '"detection"',
      '"window"',
      '"load"',
      'ground_truth',
      'rejects every charge and lookup',
    ]) {
      expect(sent, leak).not.toContain(leak);
    }
  });

  it('merges the model’s limitations with those implied by the evidence', async () => {
    const view = await excerptView();
    const truncated: EvidenceView = {
      ...view,
      manifest: {
        ...view.manifest,
        capture: {
          ...view.manifest.capture,
          traces: {
            services: [
              {
                name: 'worker',
                truncated: true,
                truncationReasons: ['service_cap'],
                saturatedSlices: 0,
              },
            ],
          },
        },
      },
    };
    const { result } = await run(truncated, [
      { reply: goodOutput(view, { limitations: ['Only a short window was captured.'] }) },
    ]);
    expect(result.limitations).toEqual([
      'Only a short window was captured.',
      'Trace capture for worker was truncated (service_cap).',
    ]);
  });

  it('reports an inconclusive investigation as such, with no findings', async () => {
    const view = await excerptView();
    const { result } = await run(view, [
      {
        reply: goodOutput(view, {
          outcome: 'inconclusive',
          findings: [],
          remediation: [],
          limitations: ['Nothing failed.'],
        }),
      },
    ]);
    expect(result).toMatchObject({
      outcome: 'inconclusive',
      findings: [],
      limitations: ['Nothing failed.'],
    });
  });

  it('summarises a result without any statement or telemetry text', async () => {
    const view = await excerptView();
    const { result } = await run(view, [{ reply: goodOutput(view) }]);
    const summary = summarize(result);
    expect(summary).toMatchObject({
      outcome: 'completed',
      failureClass: null,
      findings: 1,
      findingsByKind: { root_cause: 1 },
      references: 2,
      remediationSteps: 1,
    });
    expect(JSON.stringify(summary)).not.toContain('A component fails');
  });
});

describe('the context budget', () => {
  it('fails as budget_exceeded when even the empty request does not fit', async () => {
    const view = await excerptView();
    const { result, provider } = await run(view, [], {
      maxContextBytes: 2_000,
      maxRecordBytes: 64,
    });
    expect(result).toMatchObject({
      outcome: 'budget_exceeded',
      failure: { class: 'resource_limit_exceeded' },
    });
    expect(result.failure?.message).toMatch(
      /^the request needs \d+ bytes; maxContextBytes is 2000$/,
    );
    expect(provider.requests).toHaveLength(0);
  });

  it('keeps the request within maxContextBytes by selecting fewer records', async () => {
    const view = await excerptView();
    const { provider } = await run(view, [{ reply: goodOutput(view) }], {
      maxContextBytes: 60_000,
    });
    const r = provider.requests[0];
    const bytes = Buffer.byteLength(
      `${r?.instructions ?? ''}${r?.input ?? ''}${JSON.stringify(r?.outputSchema)}`,
    );
    expect(bytes).toBeLessThanOrEqual(60_000);
  });
});

describe('invalid replies and the repair policy', () => {
  it('repairs once, telling the model what was wrong', async () => {
    const view = await excerptView();
    const { result, provider } = await run(view, [
      { reply: '{"schemaVersion":' },
      { reply: goodOutput(view) },
    ]);
    expect(result).toMatchObject({
      outcome: 'completed',
      run: { usage: { modelCalls: 2, repairAttempts: 1 } },
    });
    const repair = (
      JSON.parse(provider.requests[1]?.input ?? '{}') as {
        repair: { problems: string[]; previousReply: string };
      }
    ).repair;
    expect(repair.problems).toEqual(['malformed_json: the reply is not a single JSON document']);
    expect(repair.previousReply).toBe('{"schemaVersion":');
  });

  it('fails with the right class when the repair is still invalid, and never invents findings', async () => {
    const view = await excerptView();
    const bad = goodOutput(view);
    const cases: [FakeStep, string][] = [
      [{ reply: 'not json' }, 'malformed_provider_response'],
      [{ reply: { ...bad, schemaVersion: '9.0.0' } }, 'invalid_result'],
      [
        { reply: { ...bad, findings: [{ ...bad.findings[0], confidence: 'certain' }] } },
        'invalid_result',
      ],
      [
        {
          reply: {
            ...bad,
            findings: [
              {
                ...bad.findings[0],
                evidence: [{ file: 'logs.jsonl', line: 40, time: 'x', service: 'y' }],
              },
            ],
          },
        },
        'evidence_verification_failed',
      ],
    ];
    for (const [step, cls] of cases) {
      const { result, provider } = await run(view, [step, step]);
      expect(result, cls).toMatchObject({
        outcome: 'failed',
        failure: { class: cls },
        findings: [],
        remediation: [],
      });
      expect(provider.requests).toHaveLength(2);
    }
  });

  it('makes no repair attempt when maxRepairAttempts is 0', async () => {
    const view = await excerptView();
    const { result, provider } = await run(view, [{ reply: '[]' }], { maxRepairAttempts: 0 });
    expect(result.failure?.class).toBe('malformed_provider_response');
    expect(provider.requests).toHaveLength(1);
  });

  it('bounds the previous reply carried into a repair request', async () => {
    const view = await excerptView();
    const huge = `{"x": "${'y'.repeat(50_000)}"`;
    const { provider } = await run(view, [{ reply: huge }, { reply: goodOutput(view) }]);
    const repair = (
      JSON.parse(provider.requests[1]?.input ?? '{}') as { repair: { previousReply: string } }
    ).repair;
    expect(Buffer.byteLength(repair.previousReply)).toBeLessThan(7_000);
    expect(repair.previousReply.endsWith('…[truncated]')).toBe(true);
  });
});

describe('provider failures', () => {
  it('retries transient failures with capped exponential backoff, then succeeds', async () => {
    const view = await excerptView();
    const waits: number[] = [];
    const provider = new FakeProvider([
      { error: new ProviderError('unavailable', '503') },
      { error: new ProviderError('rate_limited', '429', 7_000) },
      { reply: goodOutput(view) },
    ]);
    const investigator = createInvestigator({
      provider,
      limits: { retryBaseDelayMs: 1_000, retryMaxDelayMs: 5_000 },
      now: () => 0,
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    const result = await investigator.investigate(view);
    expect(result).toMatchObject({
      outcome: 'completed',
      run: { usage: { modelCalls: 3, retries: 2 } },
    });
    // 1 s for the first retry; the provider's 7 s retry-after is capped at 5 s.
    expect(waits).toEqual([1_000, 5_000]);
  });

  it('classifies exhausted and non-retryable failures', async () => {
    const view = await excerptView();
    const cases: [ProviderError, string, number][] = [
      [new ProviderError('rate_limited', 'slow down'), 'provider_rate_limited', 3],
      [new ProviderError('unavailable', 'down'), 'provider_unavailable', 3],
      [new ProviderError('authentication', 'bad key'), 'provider_authentication', 1],
      [new ProviderError('rejected_request', 'too long'), 'provider_rejected_request', 1],
    ];
    for (const [error, cls, calls] of cases) {
      const { result, provider } = await run(view, [{ error }, { error }, { error }]);
      expect(result, cls).toMatchObject({ outcome: 'failed', failure: { class: cls } });
      expect(provider.requests, cls).toHaveLength(calls);
    }
  });

  it('times out a hung call, retries, and reports provider_timeout when retries run out', async () => {
    vi.useFakeTimers();
    const view = await excerptView();
    const provider = new FakeProvider([{ hang: true }, { hang: true }]);
    const investigator = createInvestigator({
      provider,
      limits: { perCallTimeoutMs: 1_000, maxRetries: 1, retryBaseDelayMs: 500 },
    });
    const pending = investigator.investigate(view);
    await vi.advanceTimersByTimeAsync(1_000); // first call times out
    await vi.advanceTimersByTimeAsync(500); // backoff
    await vi.advanceTimersByTimeAsync(1_000); // second call times out
    const result = await pending;
    expect(result).toMatchObject({
      outcome: 'failed',
      failure: { class: 'provider_timeout' },
      run: { usage: { modelCalls: 2, retries: 1 }, durationMs: 2_500 },
    });
    expect(result.failure?.message).toBe('timeout after 1 retries: no reply within 1000 ms');
  });

  it('records an unexpected provider error as internal_error, with credentials redacted', async () => {
    const view = await excerptView();
    const provider = {
      provider: 'broken',
      model: 'm',
      complete: () =>
        Promise.reject(
          new Error(
            'boom: Authorization: Bearer abc.def.ghi and sk-live1234567890 api_key=hunter2',
          ),
        ),
    };
    const result = await createInvestigator({ provider, now: () => 0 }).investigate(view);
    expect(result.failure).toEqual({
      class: 'internal_error',
      message: 'the provider failed unexpectedly: boom: [redacted] and [redacted] [redacted]',
    });
    for (const secret of ['abc.def.ghi', 'sk-live1234567890', 'hunter2', 'Bearer']) {
      expect(result.failure?.message, secret).not.toContain(secret);
    }
  });
});

describe('budgets, deadline and cancellation', () => {
  it('stops at the model-call budget, counting retries and repairs', async () => {
    const view = await excerptView();
    const { result, provider } = await run(
      view,
      [
        { error: new ProviderError('unavailable', 'x') },
        { reply: 'bad' },
        { reply: goodOutput(view) },
      ],
      { maxModelCalls: 2, maxRepairAttempts: 1 },
    );
    expect(result).toMatchObject({
      outcome: 'budget_exceeded',
      failure: { class: 'resource_limit_exceeded', message: 'the model call budget (2) is spent' },
    });
    expect(provider.requests).toHaveLength(2);
  });

  it('stops at the deadline, even in the middle of a call', async () => {
    vi.useFakeTimers();
    const view = await excerptView();
    const provider = new FakeProvider([{ hang: true }]);
    const investigator = createInvestigator({
      provider,
      limits: { deadlineMs: 2_000, perCallTimeoutMs: 2_000 },
    });
    const pending = investigator.investigate(view);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await pending).toMatchObject({
      outcome: 'budget_exceeded',
      failure: { class: 'resource_limit_exceeded' },
    });
  });

  it('does not start a retry the deadline leaves no time for', async () => {
    let clock = 0;
    const view = await excerptView();
    const provider = new FakeProvider([
      { error: new ProviderError('unavailable', 'x') },
      { reply: goodOutput(view) },
    ]);
    const investigator = createInvestigator({
      provider,
      limits: {
        deadlineMs: 5_000,
        perCallTimeoutMs: 1_000,
        retryBaseDelayMs: 4_000,
        retryMaxDelayMs: 4_000,
      },
      now: () => (clock += 600),
      sleep: () => Promise.resolve(),
    });
    const result = await investigator.investigate(view);
    expect(result.failure?.message).toBe(
      'the investigation deadline (5000 ms) leaves no time to retry',
    );
    expect(provider.requests).toHaveLength(1);
  });

  it('is cancelled by its signal, before or during a call', async () => {
    vi.useFakeTimers();
    const view = await excerptView();
    const before = new AbortController();
    before.abort();
    expect(
      (await run(view, [{ reply: goodOutput(view) }], {}, before.signal)).result.failure?.class,
    ).toBe('cancelled');

    const during = new AbortController();
    const provider = new FakeProvider([{ hang: true }]);
    const pending = createInvestigator({ provider }).investigate(view, { signal: during.signal });
    await vi.advanceTimersByTimeAsync(10);
    during.abort();
    await vi.advanceTimersByTimeAsync(0);
    const result: InvestigationResult = await pending;
    expect(result).toMatchObject({ outcome: 'failed', failure: { class: 'cancelled' } });
  });
});

describe('the token budget', () => {
  const ceiling = 200_000 + 4_000;

  it('charges every call, including retries and repairs, and records each one', async () => {
    const view = await excerptView();
    const { result, provider } = await run(view, [
      { error: new ProviderError('unavailable', 'down') },
      { reply: 'not json', usage: { inputTokens: 1_000, outputTokens: 50 } },
      { reply: goodOutput(view), usage: { inputTokens: 1_100, outputTokens: 200 } },
    ]);
    expect(provider.requests).toHaveLength(3);
    expect(result).toMatchObject({
      outcome: 'completed',
      run: {
        usage: {
          modelCalls: 3,
          retries: 1,
          repairAttempts: 1,
          inputTokens: 2_100,
          outputTokens: 250,
          // The failed call reported nothing, so it is charged at its ceiling.
          chargedTokens: ceiling + 2_350,
          unreportedCalls: 1,
          tokenAccounting: 'estimated',
        },
      },
    });
  });

  it('charges nothing for a failed call whose provider reports that nothing was used', async () => {
    const view = await excerptView();
    const { result } = await run(view, [
      {
        error: new ProviderError('rate_limited', '429', undefined, {
          inputTokens: 0,
          outputTokens: 0,
        }),
      },
      { reply: goodOutput(view), usage: { inputTokens: 900, outputTokens: 100 } },
    ]);
    expect(result.run.usage).toMatchObject({
      modelCalls: 2,
      chargedTokens: 1_000,
      tokenAccounting: 'reported',
    });
  });

  it('starts no call the remaining budget cannot cover at its ceiling', async () => {
    const view = await excerptView();
    const { result, provider } = await run(
      view,
      [
        { error: new ProviderError('unavailable', 'down') },
        { error: new ProviderError('unavailable', 'down') },
        { reply: goodOutput(view) },
      ],
      { maxTotalTokens: 2 * ceiling },
    );
    expect(provider.requests).toHaveLength(2);
    expect(result).toMatchObject({
      outcome: 'budget_exceeded',
      failure: {
        class: 'resource_limit_exceeded',
        message: `the token budget (${String(2 * ceiling)}) has 0 tokens left, less than one call's ceiling (${String(ceiling)})`,
      },
      findings: [],
      run: { usage: { modelCalls: 2, chargedTokens: 2 * ceiling } },
    });
  });

  it('refuses a repair after a usage report broke the per-call ceiling', async () => {
    const view = await excerptView();
    const { result, provider } = await run(view, [
      { reply: 'not json', usage: { inputTokens: 250_000, outputTokens: 10 } },
      { reply: goodOutput(view) },
    ]);
    expect(provider.requests).toHaveLength(1);
    expect(result).toMatchObject({
      outcome: 'budget_exceeded',
      failure: {
        message:
          'a usage report exceeded the per-call token ceilings, so the remaining token budget cannot be relied on',
      },
      run: { usage: { inconsistentReports: 1, tokenAccounting: 'estimated' } },
    });
  });

  it('keeps a reply whose inconsistent report still fits the budget, and says the count is estimated', async () => {
    const view = await excerptView();
    const { result } = await run(view, [
      { reply: goodOutput(view), usage: { inputTokens: 250_000, outputTokens: 10 } },
    ]);
    expect(result).toMatchObject({
      outcome: 'completed',
      run: {
        usage: { chargedTokens: 250_010, inconsistentReports: 1, tokenAccounting: 'estimated' },
      },
    });
  });

  it('discards a reply whose reported usage takes the total past the budget', async () => {
    const view = await excerptView();
    const { result } = await run(
      view,
      [{ reply: goodOutput(view), usage: { inputTokens: 210_000, outputTokens: 500 } }],
      { maxTotalTokens: ceiling + 1_000 },
    );
    expect(result).toMatchObject({
      outcome: 'budget_exceeded',
      failure: {
        class: 'resource_limit_exceeded',
        message: `the token budget (${String(ceiling + 1_000)}) was exceeded: 210500 tokens charged`,
      },
      findings: [],
    });
  });

  it('charges a timed-out call at its ceiling, since its usage is unknown', async () => {
    vi.useFakeTimers();
    const view = await excerptView();
    const provider = new FakeProvider([{ hang: true }]);
    const pending = createInvestigator({
      provider,
      limits: { perCallTimeoutMs: 1_000, maxRetries: 0 },
    }).investigate(view);
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await pending).run.usage).toMatchObject({
      modelCalls: 1,
      chargedTokens: ceiling,
      unreportedCalls: 1,
    });
  });

  it('never derives tokens from the size of the request', async () => {
    const sizes: number[] = [];
    for (const view of [await excerptView(), await fabricatedView()]) {
      const { result, provider } = await run(view, [{ reply: goodOutput(view) }]);
      sizes.push(provider.requests[0]?.input.length ?? 0);
      // An unreported call costs its configured ceiling, whatever the request's size.
      expect(result.run.usage).toMatchObject({ chargedTokens: ceiling, inputTokens: 0 });
    }
    expect(sizes[0]).not.toBe(sizes[1]);
  });
});
