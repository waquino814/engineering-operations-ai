# 0009: Evaluation harness, scoring v0 and leak detection

- **Status:** Proposed (2026-10-26). Implemented in the E2/E3 foundation for review; not approved by the repository owner. Reviewed and revised on 2026-10-26 (leak detection hardened); see "Review".
- **Date:** 2026-10-26
- **Depends on (accepted):** [0003](0003-ground-truth-isolation.md) (evaluation is the only other reader of the answer key; hold out seeds and scenarios; vary timing), [0004](0004-investigation-result-contract.md). Proposed companions: [0006](0006-investigation-pipeline-and-limits.md). Accepted since: [0010](0010-investigation-result-contract-v0.md) (2026-10-26).

## Context

E3 must score investigations against `ground_truth.json`, repeatably, without the scoring becoming a channel for the answer. Before a real model exists, the harness itself must be proven deterministic and leak-free, and its leak checks must be stated with their limits.

## Decision

**The scoring boundary.** `src/evaluation/` is a separate package entry (`engineering-operations-ai/evaluation`). It alone reads the answer key (`readAnswerKey`, validated against the vendored ground-truth schema) and the full manifest, only after the investigation has returned. No other module imports it, statically or dynamically, or names its functions; tests enforce that.

**Scoring v0** (`scoreResult`):

- `rootCause`: `correct` if a `root_cause` finding names the answer's root-cause component, `incorrect` if it names another, `missing` if there is none.
- `affected`: precision and recall of every component the findings name against the answer's affected components, rounded to three decimals; precision is `null` when nothing is named.
- Failed and budget-exceeded results have no findings, so they score `missing`. A result without a case (refused at admission) gets no score.

Symptom, timeline and remediation scoring are not in v0 (ADR 0004 leaves this open).

**Leak detection** (`src/evaluation/leakage.ts`). For each case the harness lists the bundle's protected values and looks for them in every channel the investigator controls.

- **Protected values:**
  - _always checked:_ the answer text in the ground truth (scenario name, root-cause summary, description, symptom descriptions, expected remediation, data effects), the bundle's path and directory name;
  - _checked unless legitimately present:_ every other ground-truth string (components, metric names, matchers, fault parameters) and every manifest string the evidence view excludes, found by walking the whole manifest against the view's allowlist, so a field a later producer adds is protected without being listed. "Legitimately present" means it occurs in the admitted evidence, or in the fixed instructions and output schema, which are the same for every bundle.
  - values under 8 characters once normalized are skipped as too common.
- **Channels:** every full model request (instructions, input and output schema, but not the model's own previous reply echoed in a repair request), and the result's metadata (`caseId`, `bundle`, `failure`, `selection`, `run`).
- **Matching:** exact; normalized (case, separators, camelCase, letter-digit boundaries and single letters ignored, so `PROVIDER OUTAGE`, `providerOutage` and a reformatted timestamp match); encoded (base64, base64url, percent and hex).
- **Report:** per case, the number of values checked and skipped, and each finding's channel, source and match type, never the value. `pnpm eval:synthetic` exits 1 on any finding.

**Other leak controls:**

- A pipeline-level canary test plants distinctive values in every excluded manifest field, an unaudited future field, the ground truth and the directory name, then runs success, repair, verification failure, provider failure, token-budget, cancellation, configuration and admission paths: no canary may appear in any request, result or summary.
- Architecture tests forbid the investigator and pipeline from importing evaluation, naming its functions, importing dynamically, reading the environment, or containing scenario names, answer values from the committed example, or run-protocol constants.

**What the checks do not guarantee.** They cannot detect a paraphrase or translation of the answer (a test records this), a value split across fields or encoded in a way not listed, or an answer the model infers from legitimate evidence; and base64 is found only when the value was encoded on its own. Isolation by construction (ADR 0003) is the control; these checks are a regression backstop.

**Determinism.** A fixed clock, no durations, no values in the report: the same cases give a byte-identical report. The golden copy, [`test/golden/synthetic-evaluation.json`](../../test/golden/synthetic-evaluation.json), is compared byte for byte in CI. Each case also records `resultValid`, whether its result passes `readInvestigationResult`.

**Synthetic cases, v0.** Eight cases with the fake provider (see [docs/evaluation.md](../evaluation.md)); some scripted replies carry usage reports and some none, to exercise both kinds of token accounting. They test the harness and the pipeline, not a model.

**Holdout strategy**, for real-model evaluation (not yet run): tune only on the committed excerpt and synthetic bundles; score real bundles as a held-out set of new seeds and at least one unseen scenario; report results on fixed-timing bundles as such until Commerce Platform varies fault timing (ADR 0003); record model, effort, limits and bundle checksums per case.

## Alternatives considered

- **Exact-text scan of three answer fields** (the previous version). Kept as the "exact" match, but too narrow: it missed reformatting, encodings and every manifest field.
- **A model as leak judge.** Could catch paraphrases, but is non-deterministic, costs money and itself reads the answer; out of scope for deterministic CI.
- **Scanning the model's findings for answer text.** Rejected: a correct diagnosis legitimately names the answer's components.

## Implications

- **Security and privacy:** the report never contains protected values, so it can be shared.
- **Reliability:** deterministic; false positives are possible (a generic value that happens to appear), and are resolved by policy, never by deleting the value from the list.
- **Cost:** none; no model call.

## Review (2026-10-26)

- The exact-text check covered three ground-truth fields and requests only. It now covers all answer text, all excluded manifest fields including unknown ones, the bundle location, result metadata, and transformed and encoded forms, with positive controls for each and a recorded negative for paraphrase.
- The first run of the new check flagged `manifest.load.profile` (the word "incident") in the fixed instructions in seven cases: a false positive, resolved by treating the fixed request text as legitimate for excluded metadata (never for answer text).
- `AnswerKey.secrets` was removed; leak checking no longer lives in the answer-key reader.

## Acceptance criteria

1. `pnpm eval:synthetic` produces the golden report byte for byte, with zero leak findings and `resultValid: true` for every case.
2. Each claimed match type has a positive control; the paraphrase limit has a test.
3. The canary test passes on every pipeline path listed above.
4. Breaking the boundary (an evaluation import in the investigator, a path in a failure message, a fault timestamp in a request) fails a test.

## Consequences

- **Positive:** the answer key is read in one audited place, after the fact, and every request and result is checked for leaks with stated limits.
- **Negative:** synthetic cases measure plumbing, not diagnosis quality. No claim about model accuracy can be made until real bundles are scored.
- **Revisit if:** real-model results exist, or symptom and remediation scoring is decided.

## Implementation record (2026-10-27)

ADR 0009 stays **Proposed**; this records what E7 built on it, not an acceptance. Scoring v0.1 adds `ambiguous` root causes and primary-symptom series coverage, independent citation re-verification, per-case rationales and aggregate metrics with explicit numerators and denominators. The holdout strategy above is implemented as a scenario-level split registry with run-time and test-time enforcement; the held-out scenario is synthetic, so the "new seeds and at least one unseen **real** scenario" part is not met. Remediation scoring is not implemented because the ground truth gives no rubric. See [docs/evaluation.md](../evaluation.md).
