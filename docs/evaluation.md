# Evaluation

Status: **harness, scoring v0.1 and an evaluation workflow (suites, stored runs, console pages) implemented, synthetic cases and test doubles only.** No model has been scored here; the one real local run on record (see the [roadmap](roadmap.md), E5) was not scored. The design is [ADR 0009](adr/0009-evaluation-harness-and-scoring.md), which is **proposed**.

## What it does

`runEvaluation(cases)` (`src/evaluation/harness.ts`, package entry `engineering-operations-ai/evaluation`) runs each case through the real pipeline (`runInvestigation`) and produces one JSON report. For each case, it then:

1. reads the answer key (`readAnswerKey`), after the investigation has returned;
2. scores the result (`scoreResult`): root cause `correct`, `incorrect`, `missing`, or `ambiguous` (more than one component named as the root cause: conflicting claims); whether a finding cites a record of the series the bundle's primary symptom is about, with the labels it matches on (`symptomEvidence`: `covered` or `not_covered`); and precision and recall of the named components against the affected components;
3. checks the result against its contract (`readInvestigationResult`), reported as `resultValid`;
4. checks every request the provider received, and the result's metadata, for the bundle's protected values (below). Any finding is an answer leak.

The report holds, per case, a count-only summary of the result (outcome, failure class, findings by kind, references, call and token usage), the score, `resultValid` and the leak check, plus totals. It contains no telemetry, paths, durations or protected values, so it is deterministic and shareable.

```sh
pnpm eval:synthetic   # writes the report to stdout; exits 1 if any case leaked
```

## Running evaluations in the product (E7)

An engineer opens **Evaluations** in the console (or calls the API below), picks a suite and where the replies come from, and gets a stored, reopenable run.

| Suites (`GET /api/evaluation-suites`) | Split       | What it is                                                                                                                                                                               |
| ------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `development` v1                      | development | The genuine `provider-outage` excerpt (seed 42) with scripted replies for correct, wrong, conflicting, partial, repaired, fabricated and inconclusive diagnoses, plus a tampered bundle. |
| `held-out` v1                         | held-out    | An invented scenario (`synthetic-cache-saturation`) that no prompt, selection or scoring code was written against. Synthetic.                                                            |

| Replies from (`provider`) | Kind recorded | What the numbers are about                                                                                                                                                                                                                                                                  |
| ------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripted`                | `scripted`    | A reply written in advance for each case. Tests the pipeline, the verification and the scoring. **Not a model.**                                                                                                                                                                            |
| `simulated`               | `simulated`   | The deterministic simulated provider over each bundle. Tests the pipeline end to end. **Not a model.**                                                                                                                                                                                      |
| `ollama`                  | `real_model`  | A local model, only if Ollama reports its cloud features disabled and the model passes the local-only check; otherwise `409 provider_blocked` with the reason, nothing run, nothing stored, no fallback. The only kind that says anything about a model, and then only about these bundles. |

`POST /api/evaluations {suiteId, provider}` runs and stores; `GET /api/evaluations` lists; `GET /api/evaluations/:id` reopens (no rerun); `GET /api/evaluations/:a/compare/:b` compares two runs of one suite and version (cases that regressed, improved or changed; flagged when the providers differ). Runs live in `<data>/evaluations/<id>.json`, are validated against a closed schema on every read, and are listed as unreadable, never repaired, when damaged. Each document records `suite`, `provider`, `measuresModelQuality`, timestamps, `report` (per-case outcome, score, rationale, failure, grounding, duration), `metrics`, `scenarios`, `reliability`, `harnessErrors` and `limitations`.

### Metrics

Each has a numerator and a denominator. "Admitted" means the bundle passed intake and was scored; a failed, over-budget or inconclusive admitted case is in the denominator and not in the numerator, and a not-admitted case is out of the diagnosis denominators but still counted in completion, validity and leak counts. An empty denominator is `not_applicable`, never zero.

| Metric                                   | Numerator / denominator                                                                                                                 |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `root_cause_correct`                     | admitted cases whose single named root-cause component is the key's / admitted cases                                                    |
| `root_cause_ambiguous` (lower is better) | admitted cases naming more than one root-cause component / admitted cases                                                               |
| `affected_precision`                     | components named that the key lists as affected / components named, summed over admitted cases                                          |
| `affected_recall`                        | affected components named / components the key lists, summed over admitted cases                                                        |
| `symptom_evidence`                       | admitted cases in which a finding cites the primary-symptom series with its labels / admitted cases                                     |
| `citation_grounding`                     | citations a second, independent read of the bundle confirms (record exists, identifiers match, file checksum unchanged) / all citations |
| `completion`                             | cases ending completed or inconclusive / all cases                                                                                      |
| `result_validity`                        | results valid against the contract / all cases                                                                                          |
| `answer_leaks` (must be 0)               | cases with a protected value in a request or result metadata / all cases                                                                |
| `remediation`                            | **not scored**: no rubric exists (see Limitations)                                                                                      |

### The split

`SCENARIO_SPLIT` (`src/evaluation/suites.ts`) maps every scenario the repository can evaluate to one side; an unregistered scenario cannot run. Before any case executes the suite's declared scenarios are checked against it, and after each case the answer key's scenario must equal the declared one, or the run aborts with a split violation. Tests check that the sides share no scenario, seed or telemetry file, and that no source outside `src/evaluation/` mentions the held-out scenario's identifiers. This is a real separation of data and code, **but the held-out scenario is invented**, so it cannot show generalization. `MISSING_FOR_FULL_HOLDOUT` lists what a full held-out evaluation needs: real bundles of other scenarios, new seeds of a real scenario, and bundles with varied fault timing; none is in this repository.

## The scoring boundary

`src/evaluation/` is the only code besides contract validation that reads `ground_truth.json`. The application layer reaches it through one file, `src/app/evaluation-service.ts`, which `test/architecture.test.ts` pins as the only module outside `src/evaluation/` allowed to import it. Intake, the pipeline and the investigator never import it; `test/architecture.test.ts` fails if one does. The investigator receives the blinded evidence view only ([ADR 0003](adr/0003-ground-truth-isolation.md)).

## Leak detection

`src/evaluation/leakage.ts`, designed in [ADR 0009](adr/0009-evaluation-harness-and-scoring.md).

**Looked for:**

- always: the ground truth's answer text (scenario name, root-cause summary, description, symptom descriptions, expected remediation, data effects), and the bundle's path and directory name;
- unless legitimately present: every other ground-truth string, and every manifest string the evidence view excludes, including fields a later producer adds. "Legitimately present" means the admitted evidence or the fixed instructions and output schema contain it.

**Where:** every full model request (minus the model's own previous reply echoed in a repair request), and the result's `caseId`, `bundle`, `failure`, `selection` and `run`.

**How:** exact; normalized (case, separators, camelCase, letter-digit boundaries); base64, base64url, percent and hex encodings.

**Not detected:** a paraphrase or translation, a value split across fields, an unlisted encoding, base64 of a value inside a larger encoded blob, or an answer inferred from the evidence. The investigator's isolation (ADR 0003, enforced by tests) is the control; this is a backstop.

A pipeline-level canary test (`test/pipeline/leakage.test.ts`) plants distinctive values in every excluded field and runs every pipeline path; none may appear in a request, result or summary.

## Synthetic cases

The ten cases use the deterministic fake provider, so they exercise the pipeline and the harness, **not** a model's diagnostic ability:

| Case                                       | Bundle                           | Expected                                                |
| ------------------------------------------ | -------------------------------- | ------------------------------------------------------- |
| `excerpt-correct`                          | committed excerpt                | completed, root cause correct                           |
| `excerpt-wrong-root-cause`                 | committed excerpt                | completed, root cause incorrect                         |
| `excerpt-conflicting-root-causes`          | committed excerpt                | completed, root cause ambiguous                         |
| `excerpt-correct-without-symptom-evidence` | committed excerpt                | completed, root cause correct, symptom series not cited |
| `excerpt-repaired-reply`                   | committed excerpt                | invalid first reply, repaired, completed                |
| `excerpt-fabricated-evidence`              | committed excerpt                | failed, `evidence_verification_failed`                  |
| `excerpt-inconclusive`                     | committed excerpt                | inconclusive                                            |
| `fabricated-correct`                       | invented scenario and components | completed, root cause correct                           |
| `fabricated-provider-down`                 | invented scenario and components | failed, `provider_unavailable`                          |
| `tampered-bundle`                          | excerpt with a changed file      | failed, `invalid_bundle`, no model call                 |

The fabricated bundle uses a scenario and component names that do not exist in Commerce Platform, which shows that the harness needs no knowledge of the real scenarios. Three cases' scripted replies carry invented usage reports (`tokenAccounting: "reported"`); the rest carry none and are charged at the call ceiling (`"estimated"`).

The report is checked into [`test/golden/synthetic-evaluation.json`](../test/golden/synthetic-evaluation.json) and compared byte for byte in CI. Any change to an outcome, score or count shows up as a diff in review.

## Holdout strategy (for real-model evaluation)

Not yet run. A local provider exists ([ADR 0013](adr/0013-zero-spend-local-inference.md)), but it is blocked unless the Ollama runtime reports its cloud features disabled, and no real bundle has been scored. On the [roadmap](roadmap.md), per-scenario scoring of real diagnoses belongs to E7.

- Tune instructions and selection only on the committed excerpt and synthetic bundles.
- Score real bundles as a held-out set: new seeds of known scenarios, and at least one scenario never used during tuning.
- Every Commerce Platform run so far uses seed 42 and faults exactly 30 s after load start. Until Commerce Platform varies fault timing, report results on such bundles as fixed-timing results (ADR 0003, "Remaining risks").
- Record the model, effort, limits and bundle checksums for every case.

## Limitations

- Synthetic results say nothing about accuracy on real incidents.
- Scoring v0.1 compares components and checks that the primary symptom's series is cited. It does not score remediation (the answer key's `expectedRemediation` is free text and no objective comparison is defined; this needs an owner-defined rubric), timeline, or whether a finding explains the symptom. `symptomEvidence: covered` means the series was cited, not that the reasoning was right.
- Reference verification proves that the cited records exist, were sent to the model, are intact and are quoted correctly, not that they support the claim (`semanticSupport: "not_assessed"`).
- Leak detection is deterministic and has the limits listed above.
- Token counts in the synthetic report are invented; they test accounting, not cost.
