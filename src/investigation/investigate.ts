import type { TelemetryFile } from '../intake/contract.ts';
import { TELEMETRY_FILES } from '../intake/contract.ts';
import type { EvidenceView } from '../intake/evidence.ts';
import { resolveLimits, type InvestigationLimits } from './config.ts';
import { failure, type Failure } from './failures.ts';
import {
  ProviderError,
  TRANSIENT_KINDS,
  type ModelProvider,
  type ModelRequest,
} from './provider.ts';
import { baseRequestBytes, buildRequest, RECORD_OVERHEAD_BYTES, type Repair } from './request.ts';
import {
  FINDING_VERIFICATION,
  parseModelOutput,
  resultSchemaProblems,
  type InvestigationResult,
  type ModelOutput,
  type OutputProblem,
} from './result.ts';
import { RESULT_SCHEMA_VERSION } from './schemas.ts';
import { selectEvidence, type Selection } from './selection.ts';
import { TokenLedger } from './usage.ts';
import { shownKey, verifyEvidence, type VerificationIssue } from './verify.ts';

/**
 * The investigation service (ADR 0006). It takes only the blinded evidence view: no bundle path,
 * no validation report, no answer file. It selects evidence, builds a bounded request, calls the
 * model through the provider port within the limits, parses and verifies the reply, and always
 * returns a schema-valid result. Expected failures are results, not exceptions.
 */
export interface InvestigatorOptions {
  provider: ModelProvider;
  limits?: Partial<Record<string, unknown>>;
  /** Milliseconds since the epoch; injectable for deterministic tests. */
  now?: () => number;
  /** Waits for a backoff delay; must reject or resolve early when the signal aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface Investigator {
  readonly limits: InvestigationLimits;
  investigate(view: EvidenceView, options?: { signal?: AbortSignal }): Promise<InvestigationResult>;
}

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });

/** A run-ending condition, carried out of the call loop. */
class Stop extends Error {
  readonly outcome: 'failed' | 'budget_exceeded';
  readonly failure: Failure;
  constructor(outcome: 'failed' | 'budget_exceeded', f: Failure) {
    super(f.message);
    this.outcome = outcome;
    this.failure = f;
  }
}

const KIND_CLASS = {
  timeout: 'provider_timeout',
  rate_limited: 'provider_rate_limited',
  unavailable: 'provider_unavailable',
  authentication: 'provider_authentication',
  rejected_request: 'provider_rejected_request',
} as const;

export function createInvestigator(options: InvestigatorOptions): Investigator {
  const limits = resolveLimits(options.limits);
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? defaultSleep;
  const { provider } = options;

  return {
    limits,
    async investigate(view, { signal } = {}) {
      const startedAt = now();
      const deadlineAt = startedAt + limits.deadlineMs;
      const usage = { modelCalls: 0, repairAttempts: 0, retries: 0 };
      const tokens = new TokenLedger(limits);
      let selection: Selection | null = null;

      const finish = (
        outcome: InvestigationResult['outcome'],
        rest: Partial<
          Pick<InvestigationResult, 'failure' | 'findings' | 'remediation' | 'limitations'>
        >,
      ): InvestigationResult => {
        const finishedAt = now();
        const result: InvestigationResult = {
          schemaVersion: RESULT_SCHEMA_VERSION,
          caseId: view.caseId,
          bundle: {
            files: Object.fromEntries(
              TELEMETRY_FILES.map((f) => [f, { sha256: view.files[f].sha256 }]),
            ) as Record<TelemetryFile, { sha256: string }>,
          },
          outcome,
          ...(rest.failure ? { failure: rest.failure } : {}),
          findings: rest.findings ?? [],
          remediation: rest.remediation ?? [],
          limitations: rest.limitations ?? [],
          selection: selection?.summary ?? null,
          run: {
            provider: provider.provider,
            model: provider.model,
            limits: { ...limits },
            usage: { ...usage, ...tokens.snapshot() },
            startedAt: new Date(startedAt).toISOString(),
            finishedAt: new Date(finishedAt).toISOString(),
            durationMs: Math.max(0, Math.round(finishedAt - startedAt)),
          },
        };
        const problems = resultSchemaProblems(result);
        if (problems.length === 0) return result;
        // Should be unreachable: report it as an internal error, in a result that is itself valid.
        return {
          ...result,
          outcome: 'failed',
          failure: failure(
            'internal_error',
            `the assembled result did not match its schema: ${problems.slice(0, 3).join('; ')}`,
          ),
          findings: [],
          remediation: [],
          limitations: [],
        };
      };

      const tokenBudgetSpent = () => {
        const s = tokens.snapshot();
        return failure(
          'resource_limit_exceeded',
          `the token budget (${String(limits.maxTotalTokens)}) was exceeded: ${String(s.chargedTokens)} tokens charged`,
        );
      };

      /** One model request, with timeouts, retries and budgets; returns the reply text. */
      const call = async (request: ModelRequest): Promise<string> => {
        for (let attempt = 0; ; attempt += 1) {
          if (signal?.aborted)
            throw new Stop('failed', failure('cancelled', 'the investigation was cancelled'));
          if (usage.modelCalls >= limits.maxModelCalls)
            throw new Stop(
              'budget_exceeded',
              failure(
                'resource_limit_exceeded',
                `the model call budget (${String(limits.maxModelCalls)}) is spent`,
              ),
            );
          const remaining = deadlineAt - now();
          if (remaining <= 0)
            throw new Stop(
              'budget_exceeded',
              failure(
                'resource_limit_exceeded',
                `the investigation deadline (${String(limits.deadlineMs)} ms) passed`,
              ),
            );
          const refusal = tokens.refusal();
          if (refusal !== null)
            throw new Stop('budget_exceeded', failure('resource_limit_exceeded', refusal));
          const timeoutMs = Math.min(limits.perCallTimeoutMs, remaining);
          usage.modelCalls += 1;

          const controller = new AbortController();
          const call_ = { timedOut: false };
          const timer = setTimeout(() => {
            call_.timedOut = true;
            controller.abort();
          }, timeoutMs);
          const onCancel = () => {
            controller.abort();
          };
          signal?.addEventListener('abort', onCancel, { once: true });
          const aborted = new Promise<never>((_, reject) => {
            controller.signal.addEventListener(
              'abort',
              () => {
                reject(new ProviderError('timeout', `no reply within ${String(timeoutMs)} ms`));
              },
              { once: true },
            );
          });
          try {
            const reply = await Promise.race([
              provider.complete(request, { signal: controller.signal }),
              aborted,
            ]);
            tokens.record(reply.usage, 'reply');
            if (tokens.exceeded) throw new Stop('budget_exceeded', tokenBudgetSpent());
            return reply.text;
          } catch (err) {
            if (err instanceof Stop) throw err;
            // Whatever ended the call, it is charged: its reported usage, or its ceiling.
            tokens.record(err instanceof ProviderError ? err.usage : undefined, 'error');
            if (tokens.exceeded) throw new Stop('budget_exceeded', tokenBudgetSpent());
            if (signal?.aborted)
              throw new Stop('failed', failure('cancelled', 'the investigation was cancelled'));
            if (call_.timedOut && deadlineAt - now() <= 0)
              throw new Stop(
                'budget_exceeded',
                failure(
                  'resource_limit_exceeded',
                  `the investigation deadline (${String(limits.deadlineMs)} ms) passed during a model call`,
                ),
              );
            if (!(err instanceof ProviderError)) {
              throw new Stop(
                'failed',
                failure(
                  'internal_error',
                  `the provider failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
                ),
              );
            }
            const kind = call_.timedOut ? 'timeout' : err.kind;
            if (!TRANSIENT_KINDS.includes(kind) || attempt >= limits.maxRetries) {
              throw new Stop(
                'failed',
                failure(
                  KIND_CLASS[kind],
                  `${kind}${attempt > 0 ? ` after ${String(attempt)} retries` : ''}: ${err.message}`,
                ),
              );
            }
            const backoff = Math.min(
              err.retryAfterMs ?? limits.retryBaseDelayMs * 2 ** attempt,
              limits.retryMaxDelayMs,
            );
            if (now() + backoff >= deadlineAt)
              throw new Stop(
                'budget_exceeded',
                failure(
                  'resource_limit_exceeded',
                  `the investigation deadline (${String(limits.deadlineMs)} ms) leaves no time to retry`,
                ),
              );
            usage.retries += 1;
            await sleep(backoff, signal ?? new AbortController().signal);
          } finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onCancel);
          }
        }
      };

      try {
        selection = selectEvidence(view, {
          maxRecords: limits.maxEvidenceRecords,
          maxRecordBytes: limits.maxRecordBytes,
          maxBytes: Math.max(
            0,
            limits.maxContextBytes -
              baseRequestBytes(view) -
              RECORD_OVERHEAD_BYTES * limits.maxEvidenceRecords,
          ),
        });
        // Exactly the records the request carries; a finding may cite no other (ADR 0007).
        const shown = new Set(selection.records.map((r) => shownKey(r.file, r.line)));
        let repair: Repair | undefined;
        for (;;) {
          const { request, bytes } = buildRequest(view, selection, limits.maxOutputTokens, repair);
          if (bytes > limits.maxContextBytes) {
            return finish('budget_exceeded', {
              failure: failure(
                'resource_limit_exceeded',
                `the request needs ${String(bytes)} bytes; maxContextBytes is ${String(limits.maxContextBytes)}`,
              ),
            });
          }
          const text = await call(request);
          const parsed = parseModelOutput(text);
          const problems: (OutputProblem | VerificationIssue)[] = parsed.ok ? [] : parsed.problems;
          let output: ModelOutput | null = null;
          let implied: string[] = [];
          if (parsed.ok) {
            const verification = verifyEvidence(parsed.output, view, shown);
            problems.push(...verification.issues);
            output = parsed.output;
            implied = verification.limitations;
          }
          if (output && problems.length === 0) {
            const limitations = [
              ...new Set([...output.limitations, ...implied, ...selection.summary.notes]),
            ];
            return finish(output.outcome, {
              findings: output.findings.map((f) => ({
                ...f,
                verification: { ...FINDING_VERIFICATION },
              })),
              remediation: output.remediation,
              limitations,
            });
          }
          if (usage.repairAttempts >= limits.maxRepairAttempts) {
            return finish('failed', { failure: classify(problems) });
          }
          usage.repairAttempts += 1;
          repair = {
            previousReply: text,
            problems: problems.map(
              (p) => `${p.code}${'field' in p && p.field ? ` at ${p.field}` : ''}: ${p.message}`,
            ),
          };
        }
      } catch (err) {
        if (err instanceof Stop) return finish(err.outcome, { failure: err.failure });
        return finish('failed', {
          failure: failure('internal_error', err instanceof Error ? err.message : String(err)),
        });
      }
    },
  };
}

/** The failure class for a reply that is still invalid after the allowed repairs. */
function classify(problems: (OutputProblem | VerificationIssue)[]): Failure {
  const codes = problems.map((p) => p.code);
  const summary = `${String(problems.length)} problem(s): ${[...new Set(codes)].join(', ')}`;
  if (codes.some((c) => c === 'malformed_json' || c === 'not_an_object' || c === 'reply_too_large'))
    return failure('malformed_provider_response', summary);
  if (
    codes.some(
      (c) =>
        c === 'unsupported_result_version' ||
        c === 'schema_violation' ||
        c === 'duplicate_finding_id' ||
        c === 'unknown_finding_reference' ||
        c === 'completed_without_findings' ||
        c === 'inconclusive_without_limitations',
    )
  )
    return failure('invalid_result', summary);
  return failure('evidence_verification_failed', summary);
}
