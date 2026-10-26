# 0010: Investigation result contract v0: states, compatibility and amendment to ADR 0004

- **Status:** Proposed (2026-10-26). Not approved by the repository owner. Until it is, the code deviates from the accepted [ADR 0004](0004-investigation-result-contract.md) on the points listed under "Amendment", and that deviation must be resolved before the E2 work is committed.
- **Date:** 2026-10-26

## Context

[ADR 0004](0004-investigation-result-contract.md), accepted, fixes the result's shape and says it stays at version `0.1.0` "until E2 stabilises it". The E2 foundation publishes the first concrete schema, [`docs/contracts/investigation-result/v0/`](../contracts/investigation-result/v0/), and in doing so had to decide three things ADR 0004 left open or stated differently. ADR 0004 is also internally inconsistent: its field table says `failure` is "present unless `completed`", while its rules say "`inconclusive` is a valid, expected outcome", which a failure record contradicts.

## Decision

### Result states

`outcome` decides the state; every other field must agree with it. The schema enforces each row, and [`readInvestigationResult`](../../src/investigation/result.ts) adds the rules a schema cannot express.

| State                            | `outcome`         | `caseId`, `bundle` | `failure`                                                                   | `findings` | `remediation` | `limitations` |
| -------------------------------- | ----------------- | ------------------ | --------------------------------------------------------------------------- | ---------- | ------------- | ------------- |
| Completed investigation          | `completed`       | set                | absent                                                                      | ≥ 1        | any           | any           |
| Valid inconclusive investigation | `inconclusive`    | set                | absent                                                                      | any        | any           | ≥ 1           |
| Run stopped by a limit           | `budget_exceeded` | set                | `resource_limit_exceeded`                                                   | 0          | 0             | any           |
| Run failed after admission       | `failed`          | set                | any other class except the admission classes                                | 0          | 0             | any           |
| Not admitted                     | `failed`          | `null`             | `invalid_bundle`, `unsupported_contract_version` or `invalid_configuration` | 0          | 0             | any           |

A consumer distinguishes the three cases the brief names:

- **completed:** `outcome == "completed"`;
- **valid inconclusive:** `outcome == "inconclusive"`, an investigation that ran correctly and explains in `limitations` why the evidence does not support a conclusion;
- **failed to execute or validate:** `failure` is present, which happens exactly when `outcome` is `failed` or `budget_exceeded`. `caseId == null` additionally says the bundle or configuration was refused before any investigation.

Other rules beyond the schema: finding IDs are unique; remediation addresses only existing findings; `repairAttempts + retries ≤ modelCalls`; `chargedTokens ≥ inputTokens + outputTokens`; `tokenAccounting` is `reported` exactly when no call was unreported or inconsistent.

### Amendment to ADR 0004 (proposed)

1. **`failure` only on `failed` and `budget_exceeded`.** ADR 0004 requires it on `inconclusive` too. The amendment treats inconclusive as a successful investigation with a negative conclusion, consistent with ADR 0004's own rule that it is "valid, expected". The alternative that keeps ADR 0004's wording is a new failure class such as `insufficient_evidence` on every inconclusive result; it was rejected because it makes "failed to execute" and "concluded nothing" look alike to consumers that branch on `failure`.
2. **`verification` on every finding**, stating each deterministic check separately and `semanticSupport: "not_assessed"` ([ADR 0007](0007-evidence-grounding-and-output-validation.md)). Additive.
3. **`selection`**, the closed summary of which records the model saw and why others were omitted, `null` before admission. Additive.
4. **`run.usage` token accounting** (`chargedTokens`, `unreportedCalls`, `inconsistentReports`, `tokenAccounting`) and the two token limits in `run.limits` ([ADR 0006](0006-investigation-pipeline-and-limits.md)). Additive; `inputTokens` and `outputTokens` keep their ADR 0002 meaning, now precisely "as reported by the provider".
5. **`caseId` and `bundle` are `null`** when admission fails, since there is no admitted case. ADR 0004 does not cover a result without a case.

**Compatibility with ADR 0004:** changes 2 to 5 add fields or constrain values ADR 0004 left open; they change no existing field's meaning. Change 1 is **not** backwards-compatible with ADR 0004's text: an inconclusive result valid under ADR 0004 (with `failure`) is invalid here, and the reverse. No document was ever published under ADR 0004 (it was accepted before any code produced results), so no stored result is affected; the incompatibility is with the accepted text, which is why this needs the owner's approval rather than a silent edit.

### Versioning and compatibility policy

- The result and the model output are versioned separately (`RESULT_SCHEMA_VERSION`, `MODEL_OUTPUT_VERSION`), both `0.1.0` today. The model output is an internal contract with the model; the result is the public one.
- **`0.1.0` is defined by the first committed schema.** Changes made before that commit, in uncommitted review work, do not bump it.
- **While the major version is 0:** every change to a published schema bumps the minor version, even an additive one, and consumers accept only the exact `major.minor` they were built for. Patch versions are for documentation-only changes. The schemas are closed (`additionalProperties: false`), so a consumer validating with an older schema would reject a newer document anyway; exact matching makes that explicit.
- **From 1.0.0** (ADR 0004: "once E2 stabilises"): minor versions only add optional fields or relax constraints; consumers accept any minor of their major and ignore unknown fields; a new major needs an ADR, as ADR 0004 says.
- A consumer checks `schemaVersion` first and refuses an unsupported version without interpreting anything else (`unsupported_result_version`), then validates the schema, then the rules above. The published JSON Schema files are checked against the code's schemas by a test, and real results of every state are validated against the published files.

## Consequences

- **Positive:** a consumer can tell success, a negative conclusion and a failure apart from two fields, and malformed combinations are rejected mechanically. Tests cover every state and twenty-plus malformed combinations.
- **Positive:** the result cannot claim more verification than the code performs.
- **Negative:** strict 0.x versioning means every schema change breaks old consumers until 1.0; acceptable while the only consumers are in this repository.
- **Open (owner):** approve change 1, or direct the code back to ADR 0004's wording with a failure class for inconclusive results.

## Acceptance criteria

1. The owner approves or rejects change 1, and ADR 0004 is amended (or the code changed) accordingly.
2. `pnpm check` passes with the result-state tests (`test/investigation/result-contract.test.ts`), the schema drift test and the golden evaluation report.
3. Every result the pipeline produces in tests and in the synthetic evaluation passes `readInvestigationResult` (`resultValid: true` in the report).
