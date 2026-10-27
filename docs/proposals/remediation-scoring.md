# Proposal: remediation scoring

**Status: proposed. Not accepted.** Scoring v0.1 ([ADR 0009](../adr/0009-evaluation-harness-and-scoring.md), itself proposed) does not score remediation: the metric `remediation` is present and reads `not_scored`. This document prepares the decision that would change that.

## What exists today (verified)

**Answer key.** `expectedRemediation` in `ground_truth.json` is a required, non-empty array of non-empty strings and nothing more ([schema](../contracts/incident-bundle/v1/ground-truth.schema.json)). The genuine excerpt ([docs/examples](../examples/README.md)) holds two:

1. `"Restore the payment provider."`
2. `"Let the parked orders be rechecked, or recheck them sooner, and confirm none stay in payment_unknown."`

The second is a compound instruction with a verification clause and a fork ("or"). Neither string names an action type, a target in a closed vocabulary, or an observable outcome.

**Other fields checked for a verifiable outcome.** `faultParameters` (for example `{"error": "provider_unavailable", "operations": "charge,lookup_or_void"}`) describes the injected fault, not the fix. `dataEffects` is free text about consequences. `primarySymptom` and `secondarySymptoms` are machine-checkable metric conditions (metric, matchers, comparison, threshold, deadline), but they say what the fault looks like, not what remediation resolves it. `timeline` holds offsets. **No existing field expresses a remediation outcome in a machine-checkable form**, so no deterministic remediation scoring can be implemented against the current contract without inventing one.

**Result side.** A result's `remediation` is `[{ step: string, addresses: [findingId] }]`: free text plus links to findings ([schema](../contracts/investigation-result/README.md)). The verifier checks that `addresses` names real findings, not that the step is a sensible action.

**Why not text similarity.** Overlap between a model's step and `expectedRemediation` rewards wording, not correctness: "Restart the payment provider" overlaps heavily with "Restore the payment provider" and may be a different (and wrong, or impossible) action; "Bring the upstream payment service back" overlaps little and may be exactly right. Similarity would also invite tuning prompts to the answer text, a leak by another route ([ADR 0003](../adr/0003-ground-truth-isolation.md)).

## The ambiguity, in short

The key says what a human wants done; the contract gives no way to ask "did the investigation recommend that, and nothing harmful?" without a human reading both.

## Options

### A. A structured remediation outcome in the contract (machine-checkable)

Commerce Platform would add, beside `expectedRemediation`, a list of expected actions from a closed vocabulary; the result would carry the same fields on each step; this repository would match them exactly.

What it can verify: that a step proposes an expected kind of action on an expected target; that no step proposes an action the key marks harmful; recall and precision over actions, with numerators and denominators like every other metric.

What it cannot verify: that the action would work, that its order or timing is right, that the prose around it is accurate, or any action outside the vocabulary. It scores what the vocabulary can express, and it needs the model to emit the closed fields (a change to the output schema and prompt, tested on scripted and local replies only).

Cost: a Commerce Platform schema addition, an output-schema addition here, migration (below). No spending.

### B. A reviewed rubric, no automatic score

A human reviewer reads each result's remediation steps beside the key and records a verdict per expected item (`covered`, `partly_covered`, `not_covered`) and per step (`appropriate`, `inappropriate`, `unsafe`, `cannot_tell`) in a separate review record (the same record type as [finding-assessment.md](finding-assessment.md)). The harness would aggregate recorded verdicts, never infer them.

What it can verify: what a person judged, for the cases they reviewed, with the rubric version recorded. What it cannot: repeatability without agreement checks between reviewers; scale (it costs reviewer time, not money); any case nobody reviewed, which stays `not_scored`.

Cost: no schema change to the bundle or the result. Reviewer time.

### C. Outcome by re-running the scenario with the fix applied

Apply the recommended action in Commerce Platform's stack and watch the primary symptom resolve. This is the only option that tests whether a remediation works. It requires running Commerce scenarios and executing model output, both consequential operations that this repository's rules forbid and Commerce Platform's rules gate. **Out of scope; listed so it is not rediscovered.**

### D. Text similarity or a model-as-judge

Rejected, not proposed: similarity is not correctness (above), and a model judge adds a provider, its cost and circularity. A hosted judge is unreachable under the policy; a local one has no demonstrated reliability.

## Recommendation

A and B together, in this order of effort: **B immediately** (it needs no upstream change, and gives the first honest remediation signal on whatever reviewed cases exist), **A as the durable contract** if Commerce Platform is willing to own the action vocabulary. This is a recommendation about structure; the evidence in the repository does not show which vocabulary is right, and that choice belongs to Commerce Platform.

## Illustrative contract for option A

Illustrative only. Names, kinds and the vocabulary are for the owner and Commerce Platform to set.

Answer key (bundle schema 1.1.0, an optional addition; schema 1.0.0 bundles remain valid and simply have no expected actions):

```json
"expectedRemediationActions": [
  { "id": "R1", "kind": "restore_dependency", "target": "payment-provider", "required": true },
  { "id": "R2", "kind": "recheck_parked_work", "target": "worker", "required": false }
],
"harmfulActions": [
  { "kind": "restart_component", "target": "worker" }
]
```

Result and model output (result schema 0.2.0, an optional field on each step):

```json
"remediation": [
  {
    "step": "Restore the payment provider, then recheck parked orders.",
    "addresses": ["F1"],
    "action": { "kind": "restore_dependency", "target": "payment-provider" }
  }
]
```

`kind` is an enum from a published list; `target` must be a component name that appears in the evidence view (so a model cannot invent a target; the existing component-name rule for findings is the model). The step text stays free, and is never scored.

## Example outcomes (option A, provider-outage)

| Result's step                                                 | Outcome                                                 | Why                                                                    |
| ------------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------- |
| `action: restore_dependency / payment-provider`               | **positive**: R1 matched                                | Exact kind and target                                                  |
| `action: restart_component / worker`                          | **negative**: unmatched, and listed in `harmfulActions` | Not an expected action; the key marks it harmful                       |
| `action: scale_up / orders-api`                               | **negative**: unmatched, not harmful                    | Counts against precision only                                          |
| No `action` field, free text "bring the payment service back" | **indeterminate**: `unscored`                           | The step cannot be matched; it is reported as unscored, never as wrong |
| `action: other`                                               | **indeterminate**                                       | The vocabulary has no value for it; a reviewer (option B) may judge    |
| Result `inconclusive`, no steps                               | **missing**                                             | Counts in the denominator, not the numerator, like every other metric  |

Proposed metrics, with the same counting rules as the existing ones: `remediation_recall` = required expected actions matched / required expected actions, over admitted cases; `remediation_precision` = steps with an action that match / steps with an action; `remediation_harm` (lower is better) = steps matching a harmful action / steps with an action; `remediation_unscored_steps` = steps with no usable action, reported as a count so it cannot hide. No weights and no thresholds are proposed.

## Compatibility and migration

- **Bundles.** Adding optional fields is a minor version of the bundle schema; this repository already accepts unknown fields and refuses only unsupported majors ([intake](../intake.md)). Existing bundles stay valid and their remediation stays `not_scored`.
- **The genuine excerpt.** Its `ground_truth.json` is real Commerce Platform output and its checksum is recorded in the manifest, so it must not be edited here. Option A would score it only if Commerce Platform re-emitted that bundle with the new fields. Until then, the genuine data stays unscored.
- **Synthetic cases and the golden report.** The synthetic bundles are written by `src/evaluation/synthetic.ts` and may carry the new fields; adding them changes the golden report once, deliberately, reviewed as a diff. The eight scripted development cases and two held-out cases would gain `action` fields in their scripted replies.
- **Result contract.** An optional field on a step is a backward-compatible addition; [ADR 0010](../adr/0010-investigation-result-contract-v0.md)'s compatibility policy decides its version number; the consumer reader, the published JSON Schemas, the model-output schema and the console's remediation panel change with it, each with tests. Stored runs without the field stay readable.
- **Isolation.** The vocabulary may appear in prompts; the key's expected actions must not (a leak test covers them like every protected value).

## Decision required from the owner

1. Choose: **A**, **B**, both, or neither (remediation stays `not_scored`).
2. If A: ask Commerce Platform to own the action vocabulary (`kind` list and target rules) and to emit the optional fields from a new minor bundle version; approve the result-contract minor version here.
3. If B: approve a rubric (the verdict values above are a draft) and name who reviews, since a reviewer's judgement is the only measure.

Until then nothing in this repository scores remediation, and the metric keeps its `not_scored` note.
