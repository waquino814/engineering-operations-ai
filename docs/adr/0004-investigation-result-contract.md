# 0004: Investigation result contract

- **Status:** Accepted (2026-10-26), approved by the repository owner after the E1 review, as the initial direction. It defines the shape E2 must produce; nothing in E1 produces results, and the format stays at version 0.1.0 until E2 stabilises it.
- **Date:** 2026-10-26
- **Amended:** 2026-10-26 by [ADR 0010](0010-investigation-result-contract-v0.md) (accepted); see "Amendment" at the end. The text above it is the original decision, unchanged.

## Context

An investigation's output feeds evaluation (E3), the UI (E4) and human review. It must be structured, versioned, traceable to the exact bundle records it relies on, and honest about uncertainty. A conclusion without evidence, or evidence that cannot be found again in the bundle, is worse than none.

## Decision

The result is one JSON document, `investigation-result.json`, version `0.1.0` until E2 stabilises it, then `1.0.0`, with the same compatibility policy as the bundle contract: minor versions add optional fields, a major version needs an ADR. A JSON Schema file will be committed under `docs/contracts/investigation-result/` with the first implementation in E2.

**Top-level fields:**

| Field           | Content                                                                                                                                                                                                          |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion` | semver string                                                                                                                                                                                                    |
| `caseId`        | the evidence view's opaque case ID ([ADR 0003](0003-ground-truth-isolation.md))                                                                                                                                  |
| `bundle`        | `{ files: { "<name>": { sha256 } } }` for the telemetry files used, so every reference can be checked against the exact bytes; `caseId` identifies the manifest, whose full checksum the investigator never sees |
| `outcome`       | `completed`, `inconclusive`, `budget_exceeded` or `failed`                                                                                                                                                       |
| `failure`       | present unless `completed`: `{ class, message }`                                                                                                                                                                 |
| `findings`      | the conclusions, below; empty unless supported                                                                                                                                                                   |
| `remediation`   | recommended steps, each citing the findings it addresses; advice only                                                                                                                                            |
| `limitations`   | known gaps, such as truncated traces (`capture.traces`) or missing signals                                                                                                                                       |
| `run`           | model and provider (or `none`), configuration, budgets and their use, start and end times                                                                                                                        |

**A finding:** `{ id, kind, statement, components, confidence, evidence }`.

- `kind`: `root_cause`, `affected_component` or `symptom`.
- `components`: component identifiers in the bundle's open vocabulary, such as `worker`.
- `confidence`: `high`, `medium` or `low`, with a one-sentence `rationale`. Qualitative levels avoid implying calibrated probabilities.
- `evidence`: at least one reference. A finding without evidence is not allowed.

**An evidence reference** points to a record that exists:

- `{ file: "metrics.jsonl", line, series: { name, labels }, samples?: [[unixSeconds, value]] }`
- `{ file: "logs.jsonl", line, time, service }`
- `{ file: "traces.jsonl", line, traceId, spanId? }`

`line` is the 1-based line number in the file whose SHA-256 is in `bundle.files`. A verifier must be able to open that line and find the quoted identifiers; E2 includes such a verifier, and a result that fails it is rejected.

**Rules:**

- Every finding cites evidence; claims without it go in `limitations` or are omitted.
- No field derives from `ground_truth.json`.
- `inconclusive` is a valid, expected outcome when the evidence does not support a conclusion.

## Consequences

- **Positive:** evaluation and the UI can check every claim against the source bytes. Fabricated evidence is detectable mechanically.
- **Negative:** line numbers tie a reference to one exact file; a re-captured bundle needs a new investigation. That is intended.
- **Open:** whether findings also state the symptom as a structured condition comparable with `primarySymptom`, which would make scoring easier but tempt overfitting to the ground-truth format. To decide in E3.

## Amendment (2026-10-26, ADR 0010)

Accepted by the repository owner on 2026-10-26. Where it differs from the text above, this amendment governs; the full reasoning, the result states and the compatibility policy are in [ADR 0010](0010-investigation-result-contract-v0.md).

- **`failure` is present only when `outcome` is `failed` or `budget_exceeded`.** An `inconclusive` result carries no `failure`: it is a valid investigation that states in `limitations` why the evidence does not support a conclusion. This replaces "present unless `completed`" in the field table, which contradicted this ADR's own rule that `inconclusive` is a valid, expected outcome.
- Additive, as ADR 0010 lists: each finding's `verification` statements, the `selection` summary, token accounting in `run.usage`, and `caseId` and `bundle` as `null` when a bundle or configuration is refused before any investigation.
- The result stays at version `0.1.0`, with the versioning policy in ADR 0010.
