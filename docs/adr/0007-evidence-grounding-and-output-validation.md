# 0007: Evidence grounding, model-output validation and repair

- **Status:** Proposed (2026-10-26). Implemented in the E2 foundation for review; not approved by the repository owner. Reviewed and revised on 2026-10-26; see "Review".
- **Date:** 2026-10-26
- **Depends on (accepted):** [0002](0002-ai-provider-and-external-api-policy.md) (telemetry is data, not instructions), [0003](0003-ground-truth-isolation.md) (the admitted view), [0004](0004-investigation-result-contract.md) (every finding cites evidence; a verifier rejects bad references). Proposed companions: [0006](0006-investigation-pipeline-and-limits.md), [0010](0010-investigation-result-contract-v0.md).

## Context

ADR 0004 requires every finding to cite records that exist, and a verifier that rejects a result whose references fail. Model output is untrusted: it can be malformed, cite lines that do not exist or that it was never shown, quote identifiers the record does not contain, or reach for files the investigator must not see. The model sees only part of the evidence, chosen without knowledge of the scenarios.

## Decision

**Strict parsing** (`parseModelOutput`). The reply must be at most 1,000,000 bytes and one JSON object, with a supported model-output `schemaVersion` (`0.1.0`), satisfying the closed output schema. Nothing is defaulted, coerced or extracted from surrounding prose. Problem codes: `reply_too_large`, `malformed_json`, `not_an_object`, `unsupported_result_version`, `schema_violation`.

**Reference verification** (`verifyEvidence(output, view, shown)`). Each reference is checked against the admitted view and the exact set of records sent to the model (`shown`), not the disk:

| Check               | Fails with                                                                                                                                   | Guarantee when it passes                                                                                                            |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Reference exists    | `path_outside_bundle`, `unknown_file`, `line_out_of_range`, `record_not_admitted`                                                            | the file is admitted telemetry (never `ground_truth.json`) and the line holds an admitted record                                    |
| Included in request | `record_not_shown`                                                                                                                           | the record was in the evidence the model was given                                                                                  |
| Integrity           | `checksum_mismatch`                                                                                                                          | the file's SHA-256 was recomputed at admission and equals `bundle.files`; a quoted `sha256` matched                                 |
| Source identity     | `missing_identity`, `inapplicable_field`, `identity_mismatch`, `sample_not_found`, `span_not_found`                                          | metrics: series name and exact labels, quoted samples present; logs: `time` and `service`; traces: `traceId`, and `spanId` if given |
| Output coherence    | `duplicate_reference`, `duplicate_finding_id`, `unknown_finding_reference`, `completed_without_findings`, `inconclusive_without_limitations` | the output is internally consistent                                                                                                 |

A finding that passes every check carries, in the result:

```json
"verification": {
  "referenceExists": "verified",
  "identityMatches": "verified",
  "integrity": "verified",
  "includedInRequest": "verified",
  "semanticSupport": "not_assessed"
}
```

**Whether the cited records support the statement is not assessed** by anything, and the schema allows no other value for `semanticSupport`, so a result cannot claim more than the code checks. Statements remain the model's claims. When cited traces come from a service whose capture was truncated, a limitation says so.

**Bounded repair.** If parsing or verification fails, up to `maxRepairAttempts` (default 1) follow-up requests repeat the same evidence and add the problem list and the previous reply, truncated to 6,000 bytes. Each counts against `maxModelCalls` and the token budget ([ADR 0006](0006-investigation-pipeline-and-limits.md)). If the last reply still fails, the run fails with `malformed_provider_response`, `invalid_result` or `evidence_verification_failed`. A result is accepted whole or not at all.

**Deterministic, scenario-agnostic selection** (`selectEvidence`). Records are scored by generic signals only:

- **Logs:** severity level. Repeated messages are grouped by service, level and message, and each group keeps its first and last occurrence.
- **Metrics:** error-like label values, and change across samples. Histogram buckets score lower.
- **Traces:** error status or error-like attributes, and spans in the slowest decile.

Ties break on file order (logs, metrics, traces), then line; chosen records are emitted in file and line order. Selection stops at `maxEvidenceRecords` or the context budget, and records longer than `maxRecordBytes` are omitted, never cut. A per-file summary of what was selected and why the rest was omitted goes to the model and into the result. Selection never uses scenario names, signatures, fault timings, the seed, or a fixed offset from the start of the capture; tests scan the investigator and pipeline for scenario vocabulary, answer values from the committed example, and run-protocol constants.

**Telemetry as data.** Instructions are fixed text; all evidence goes in a separate JSON input document, and the instructions tell the model never to follow text inside it (ADR 0002).

## Alternatives considered

- **Lenient parsing** (extract JSON from prose, default missing fields). Rejected: it hides model errors and makes results depend on parser heuristics.
- **Keeping the valid findings of a partly invalid reply.** Rejected: a result would mix checked and unchecked claims; the repair loop is the remedy.
- **A single `verified` flag per finding.** Rejected in review: it could be read as "the claim is verified". Each guarantee is now stated separately.
- **Model-based support checking** (a second model judges support). Possible later; it would be a new, non-deterministic status needing its own evaluation, and a new schema version.

## Implications

- **Security:** a reference to the answer file, a path, or a record the model was not shown cannot reach a result.
- **Reliability:** deterministic: the same bundle, limits and reply always give the same verdict.
- **Cost:** a failed check costs one repair call at most by default.

## Review (2026-10-26)

- **Defect corrected:** the previous text said a reference must be "among the records the model was shown", but the code checked only that the record was admitted, so a model could cite a real record it had never been given. The verifier now takes the shown set and rejects such references (`record_not_shown`), with unit and end-to-end tests.
- **Clarified:** the single `{ references, support }` verification object became five separate statements ([ADR 0010](0010-investigation-result-contract-v0.md)), and tests reject any stronger claim.

## Acceptance criteria

1. Each verification code has a test that produces it, and a passing reference is accepted (`test/investigation/verify.test.ts`).
2. End to end, a reply citing an admitted but unsent record fails as `evidence_verification_failed` after its repair.
3. The result schema rejects every verification value other than those above (`test/investigation/result-contract.test.ts`).
4. Selection is identical across runs and names no scenario, answer value or run-protocol constant.

## Consequences

- **Positive:** a fabricated, misquoted, unsent or answer-key reference cannot reach a result.
- **Negative:** reference verification is necessary but not sufficient: a real, shown record may not support the claim, and the result says so.
- **Negative:** heuristic selection can miss the decisive record on unfamiliar faults; the selection summary makes that visible but does not prevent it.
- **Revisit if:** held-out evaluation shows selection misses, or a support check is designed.
