# 0006: Investigation pipeline, module boundaries and limits

- **Status:** Proposed (2026-10-26). Implemented in the E2 foundation for review; not approved by the repository owner. Reviewed and revised on 2026-10-26 (token budget, stricter boundary tests); see "Review".
- **Date:** 2026-10-26
- **Depends on (accepted):** [0001](0001-runtime-and-language.md) (TypeScript, Ajv), [0002](0002-ai-provider-and-external-api-policy.md) (provider-neutral port, hard budgets, transient-only retries), [0003](0003-ground-truth-isolation.md) (two read paths, blinded view), [0004](0004-investigation-result-contract.md) (result shape), [0005](0005-bundle-intake-and-validation.md) (intake). Proposed companions: [0007](0007-evidence-grounding-and-output-validation.md), [0010](0010-investigation-result-contract-v0.md).

## Context

E1 delivered bundle intake: contract validation, which reads the answer key, and the blinded evidence view, which does not ([ADR 0003](0003-ground-truth-isolation.md)). E2 needs a workflow that turns that view into a result through a language model, under ADR 0002: a provider-neutral port, hard budgets on calls, tokens and time, bounded retries and explicit failure classes. No provider is integrated yet ([ADR 0008](0008-model-provider-recommendation.md)), so the workflow has to be complete, and testable, with a deterministic fake.

## Decision

**Steps.** `runInvestigation(bundleDir, options)` in `src/pipeline/run-investigation.ts`:

1. **Admission.** Validate the bundle (`validateBundle`). An invalid bundle stops with `invalid_bundle`, or `unsupported_contract_version` under rule 2, and a message that counts issues by rule without quoting paths. The report goes back to the caller, never to the investigator.
2. **Blinding.** Open the evidence view (`openEvidence`). If the evidence changed after validation, stop with `invalid_bundle`.
3. **Selection.** Choose a bounded, deterministic subset of telemetry records ([ADR 0007](0007-evidence-grounding-and-output-validation.md)).
4. **Model call.** One request: fixed instructions, plus a separate JSON input holding the blinded manifest, the selection summary and the selected records with file, line and checksum.
5. **Validation, verification and repair** ([ADR 0007](0007-evidence-grounding-and-output-validation.md)).
6. **Result.** Assemble it and validate it against the published schema ([ADR 0010](0010-investigation-result-contract-v0.md)). A result that fails its own schema becomes `internal_error`.

**Module boundaries.** Enforced by `test/architecture.test.ts` and `test/ground-truth-isolation.test.ts`, which read static imports, dynamic `import()` and `require()`.

| Module               | May                                                      | Must not                                                                                                                                                                                              |
| -------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/intake/`        | take paths, read bundle files                            | import investigation, pipeline or evaluation                                                                                                                                                          |
| `src/pipeline/`      | take a bundle path; call intake, then the investigator   | pass the path, validation report or excluded manifest fields to the investigator; name scenario constants                                                                                             |
| `src/investigation/` | receive an `EvidenceView`; call a `ModelProvider`        | import `node:fs`, `node:path`, contract validation, the pipeline or evaluation; import dynamically; read `process.env`; name the answer file, answer values or scenario constants; make network calls |
| `src/evaluation/`    | read the answer key and manifest, after an investigation | be imported by intake, pipeline or investigation                                                                                                                                                      |
| provider adapters    | hold provider SDK types and credentials                  | leak SDK types into `provider.ts` or anything the domain imports                                                                                                                                      |

The only runtime dependencies are `ajv` and `ajv-formats`; a test fails if another appears.

**The model port** (`src/investigation/provider.ts`): `ModelProvider { provider, model, complete(request, { signal }) }`. A `ModelRequest` is `{ instructions, input, outputSchema, maxOutputTokens }`; a `ModelReply` is `{ text, usage? }`, where `usage` is a `UsageReport { inputTokens?, outputTokens? }` in the provider's own tokens. Adapters raise `ProviderError(kind, message, retryAfterMs?, usage?)`, with `kind` one of `timeout`, `rate_limited`, `unavailable`, `authentication` or `rejected_request`; `usage` is set only when the provider's documented semantics say what a failed call consumed. `FakeProvider` replays scripted steps (`reply`, `error`, `hang`) and records each request.

**Limits.** These are explicit, validated and recorded in `run.limits`. Unknown keys, non-integers, values outside bounds and inconsistent combinations are rejected as `invalid_configuration` before any call.

| Limit                   | Default | Meaning                                                             |
| ----------------------- | ------: | ------------------------------------------------------------------- |
| `maxModelCalls`         |       4 | every call counts: first attempt, retries and repairs               |
| `maxRepairAttempts`     |       1 | follow-up requests after an invalid or ungrounded reply             |
| `maxRetries`            |       2 | retries per call, for transient provider errors only                |
| `retryBaseDelayMs`      |   1,000 | exponential backoff base; a provider's `retryAfterMs` wins          |
| `retryMaxDelayMs`       |  10,000 | backoff ceiling                                                     |
| `perCallTimeoutMs`      |  60,000 | each call is aborted after this                                     |
| `deadlineMs`            | 300,000 | wall-clock budget for the whole investigation                       |
| `maxOutputTokens`       |   4,000 | passed to the provider; the output ceiling charged per call         |
| `maxInputTokensPerCall` | 200,000 | the input ceiling charged per call, in provider tokens (see below)  |
| `maxTotalTokens`        | 816,000 | input plus output tokens across all calls: 4 × (200,000 + 4,000)    |
| `maxContextBytes`       | 200,000 | request size ceiling in UTF-8 bytes: instructions, schema and input |
| `maxEvidenceRecords`    |     200 | selected records                                                    |
| `maxRecordBytes`        |  16,384 | a longer record is omitted, never truncated                         |

Consistency rules: `maxRepairAttempts < maxModelCalls`; `perCallTimeoutMs ≤ deadlineMs`; `retryBaseDelayMs ≤ retryMaxDelayMs`; `maxRecordBytes ≤ maxContextBytes`; `maxInputTokensPerCall + maxOutputTokens ≤ maxTotalTokens`.

**Token budget** (`src/investigation/usage.ts`, `TokenLedger`).

- Every call is recorded once, whatever ended it: a reply, a provider error, a timeout, a cancellation or an unexpected error.
- A valid report (non-negative integers for both counts; a reply's input at least 1) is charged as reported. A missing or invalid part is charged at its ceiling: `maxInputTokensPerCall` for input, `maxOutputTokens` for output, and the call counts as unreported. A report above either ceiling is charged as reported and counted as inconsistent.
- **Before every call**, the remaining budget must cover one call at its ceiling, and no report may have been inconsistent; otherwise the run stops as `budget_exceeded` (`resource_limit_exceeded`) without calling. So, as long as the ceilings hold, the budget can never be passed.
- **After every call**, if the charged total exceeds the budget (only possible through an inconsistent report), the run stops as `budget_exceeded` and the reply is discarded.
- The result reports `inputTokens` and `outputTokens` (reported counts only), `chargedTokens`, `unreportedCalls`, `inconsistentReports`, and `tokenAccounting`: `reported` only when every call had a valid, consistent report, otherwise `estimated`.
- Nothing converts bytes to tokens. `maxContextBytes` limits request size in bytes; `maxInputTokensPerCall` is a separate, token-denominated operator setting. Its default equals `maxContextBytes` on the assumption that a request never has more tokens than UTF-8 bytes, which **must be confirmed for the chosen provider** (for example with its token-counting endpoint) before the budget is relied on in production.

**Outcomes and failure classes.** `completed` and `inconclusive` come from a verified model reply. `budget_exceeded` means a limit stopped the run (`resource_limit_exceeded`). `failed` carries one class:

| Class                                                                           | Raised when                                                                              |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `invalid_bundle`, `unsupported_contract_version`                                | admission fails                                                                          |
| `invalid_configuration`                                                         | limits are invalid                                                                       |
| `provider_timeout`, `provider_rate_limited`, `provider_unavailable`             | a transient error persists after `maxRetries`                                            |
| `provider_authentication`, `provider_rejected_request`                          | at once; never retried                                                                   |
| `malformed_provider_response`, `invalid_result`, `evidence_verification_failed` | the reply is still not JSON, not schema-valid, or not grounded after `maxRepairAttempts` |
| `resource_limit_exceeded`                                                       | calls, tokens, deadline or context size ran out (outcome `budget_exceeded`)              |
| `cancelled`                                                                     | the caller's signal aborted                                                              |
| `internal_error`                                                                | the assembled result fails its own schema, or the provider threw a non-`ProviderError`   |

Failure messages are sanitized: bearer tokens, `sk-`/`pk-`/`rk-` keys and `authorization`, `api_key`, `token`, `secret` or `password` assignments are redacted, whitespace is collapsed, and the message is cut at 300 characters. Messages the investigator writes never quote telemetry or paths; a provider's own error text is passed through after sanitizing, so an adapter must not put request content in its error messages.

## Alternatives considered

- **Tool-using, multi-step investigation** (the model asks for more records). More capable on large bundles, but harder to bound and to verify; deferred until single-request results are measured.
- **Byte-to-token estimation** (e.g. bytes ÷ 4). Rejected: tokenizers differ, and an under-estimate would let the budget be passed silently.
- **Fail closed on any unreported usage** (no further call after one). Safer on cost, but it makes every retry after a timeout impossible, since a timed-out call never reports usage. Charging the ceiling keeps retries possible while still bounding spend.
- **Provider-side token counting before each call.** Exact, but provider-specific and an extra call; left to the adapter.

## Implications

- **Security and privacy:** the investigator cannot reach a path, the environment or the answer key by construction; tests fail if a change tries. Evidence leaves the machine only through an adapter (ADR 0002).
- **Reliability:** every failure is a typed result, never an exception or a partial success. Retries are bounded per call and in total.
- **Cost:** calls, tokens and time are each capped. Unreported usage is charged at its ceiling, so the budget errs toward stopping early.

## Review (2026-10-26)

Checked against the code; corrected in this revision:

- The token budget ADR 0002 requires was missing (only bytes were capped). Implemented as above, with tests (`test/investigation/usage.test.ts`, "the token budget" in `investigate.test.ts`).
- The boundary tests read only static imports; they now also read `import()` and `require()`, forbid `process.env` in the investigator, check intake's imports, and check the pipeline for scenario constants and answer values taken from the committed example.
- The proposed amendment to ADR 0004 moved to [ADR 0010](0010-investigation-result-contract-v0.md).

Remaining, for the owner: approval of this ADR; confirmation of `maxInputTokensPerCall` per provider.

## Acceptance criteria

1. `pnpm check` passes, including the boundary, limit, budget and failure-class tests.
2. Every failure class has a test that produces it, and every produced result passes `readInvestigationResult`.
3. With the fake provider, the number of provider calls never exceeds `maxModelCalls`, and charged tokens never exceed `maxTotalTokens` unless a report is inconsistent, which stops the run.
4. A provider adapter maps its usage fields into `UsageReport`, reports zero usage on errors only where the provider documents it, and confirms `maxInputTokensPerCall` against its tokenizer.

## Consequences

- **Positive:** the whole workflow runs, fails and recovers in tests without network, credentials or cost. Each run's spend has a fixed ceiling in calls, tokens and time.
- **Negative:** the token budget is only as good as the ceilings and the adapter's usage reports; until an adapter exists, it is exercised with fake reports only.
- **Negative:** one request per attempt, with no tool use. The model sees only the selected records, so evidence outside the selection cannot be cited.
- **Revisit if:** a provider is integrated, the selection proves too narrow on real bundles, or a multi-step investigation is needed.
