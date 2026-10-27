# Proposal: assessing evidence support and symptom explanation

**Status: proposed (the assessment contract); one deterministic part implemented.** Results say `semanticSupport: "not_assessed"` for every finding and the result schema allows no other value ([ADR 0007](../adr/0007-evidence-grounding-and-output-validation.md), [ADR 0010](../adr/0010-investigation-result-contract-v0.md)). Nothing in this document changes that.

## What is checked today, deterministically

Each row is enforced by code and covered by tests; a finding reaches a result only if all of the first four pass.

| Check                                                                                                              | Where                                                                                   | What it proves                                        |
| ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| The cited file is an admitted telemetry file; the line holds an admitted record                                    | `src/investigation/verify.ts`                                                           | The record exists                                     |
| The record was in the evidence actually sent to the model                                                          | same                                                                                    | The model could have seen it                          |
| The quoted identifiers (series and labels, time and service, trace and span) are the record's                      | `checkIdentity` in `verify.ts`                                                          | The citation is quoted correctly; no contradiction    |
| A quoted checksum matches, and the file's checksum equals the run's                                                | same                                                                                    | The evidence is intact                                |
| No duplicate references, no duplicate finding ids, remediation addresses real findings                             | `verify.ts`, `result.ts`                                                                | Internal consistency                                  |
| Every citation re-read from the bundle by a second implementation                                                  | `src/app/evidence.ts`, `citation_grounding` metric, gate finding `citation_unconfirmed` | A saved result still points where it says             |
| The primary symptom's series is cited with its labels                                                              | `src/evaluation/score.ts`, `symptom_evidence`                                           | The diagnosis rests on the symptomatic series         |
| **New (implemented):** each component a finding names appears as a field value in a record that same finding cites | `src/evaluation/relations.ts`, `component_identified` metric                            | A descriptive link between a finding and its evidence |

**What none of this proves.** That a cited record supports the statement, or explains the symptom, or that the named component caused anything. Citation existence is not support.

### The new check, and its limits

`component_identified` counts, over all findings, the named components that appear as a string value in a record the same finding cites (a log `service`, a metric label value, a span's `service.name`, any field). It is a count with a numerator and a denominator, not a verdict, and it fails nothing.

Measured on the committed scripted cases (see `test/golden/synthetic-evaluation.json`): the correct root-cause finding names `payment-provider`, cites the payment-call counter and a log line carrying `ProviderError: provider_unavailable`, and no cited field carries the string `payment-provider`, so it is counted as **not found** although the diagnosis is correct. The records imply the component; they do not name it. A count of "found" is therefore neither necessary nor sufficient for support, and the metric must never be read as quality. It exists to make one thing visible and objective: a finding naming a component that none of its evidence mentions at all (the shape of an unsupported claim, and of the Fake provider's positional citations).

### What cannot be made deterministic from the current contract

- **Support.** Whether a log line or a counter justifies "the provider is down" needs reading and domain judgement. No field in a result or a bundle encodes it.
- **Explains the symptom.** The key's `primarySymptom` is a metric condition; whether a finding's reasoning accounts for it is causal, and the key holds no causal graph.
- **Causal correctness.** The key names one root-cause component; it does not say what else would be a defensible root cause.

## Proposed assessment contract (separate from the result)

A **review record** is a separate document, never part of the result, so the result's `not_assessed` stays truthful about what the code did.

```json
{
  "schemaVersion": "0.1.0",
  "runId": "20261027T123000Z-0123456789abcdef",
  "findingId": "F1",
  "rubricVersion": "1",
  "reviewer": { "kind": "human", "id": "reviewer-1" },
  "reviewedAt": "2026-10-28T09:00:00Z",
  "supports": "supports | partly_supports | does_not_support | cannot_tell",
  "explainsPrimarySymptom": "yes | partly | no | cannot_tell",
  "citedRecordsRelevant": { "relevant": 2, "irrelevant": 0, "of": 2 }
}
```

- Stored under `<data>/reviews/`, validated against a closed schema on every read, never repaired, never overwriting (the pattern the evaluation store already uses).
- Reviewer ids are labels chosen by the operator; no free-text field is part of the contract, so a review cannot carry telemetry or answer text into a log.
- Aggregates (support rate, symptom-explained rate) would be computed from recorded records only, over **reviewed** findings, with the number reviewed beside every rate. Unreviewed findings stay `not_assessed`, never counted as supported or unsupported.
- A review never changes a stored result.

### Draft rubric (for the owner to replace)

- `supports`: a reader who sees only the cited records, not the statement, would reach the statement or a close restatement. `partly_supports`: the records are consistent with it but do not single it out. `does_not_support`: the records are unrelated to or contradict it. `cannot_tell`: the reviewer cannot decide from the records.
- `explainsPrimarySymptom`: whether the finding's statement, if true, would produce the series the key names as the primary symptom.
- Two reviewers on a sample, with agreement reported, before any rate is quoted.

### Illustrative cases (the verdicts are examples, not judgements)

| Case                                                                                                                 | Plausible verdict                   | Why it is hard                                                                                  |
| -------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------- |
| Root cause `payment-provider`, citing the payment-call counter and a `lookup_failed` log with `provider_unavailable` | `supports`                          | The component is implied by an error string, not named; `component_identified` says "not found" |
| Same finding citing only a database span                                                                             | `does_not_support`                  | Citations exist and verify; they are about something else                                       |
| Finding names `worker` as cause, with the same good citations                                                        | `partly_supports`                   | The worker shows the symptom; the evidence points past it                                       |
| Fake provider's positional citation                                                                                  | `does_not_support` or `cannot_tell` | Verified and meaningless; the reason `semanticSupport` exists                                   |

## Limitations

Human review costs reviewer time and is subjective; a handful of reviewed cases from one scenario says little about a model. A model-as-judge is not proposed: a hosted one is unreachable under the policy, a local one's reliability is unmeasured, and a model judging a model's output is circular. Review records do not remove the need for real bundles (see [commerce-data-request.md](commerce-data-request.md)).

## Decision required from the owner

1. Is human review in scope, and who reviews? If not, support and symptom explanation stay `not_assessed` indefinitely, and that is an acceptable, honest end state.
2. Approve or replace the draft rubric, and the review-record contract above.
3. Accept `component_identified` as a descriptive metric (already implemented, never gated), or ask for it to be removed. It is in the stored-run format and in the golden report.
