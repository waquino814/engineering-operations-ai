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

### From the command line

`pnpm eval:suite <suite-id|all> [--provider scripted|simulated] [--out <file>] [--baseline <file>]` runs the same suites offline, with no server, and prints one JSON document: `runs` (each in the stored-run format above, validated by the same reader) and a `gate`. Only `scripted` and `simulated` are accepted; a real local model runs only through the application's provider gate (ADR 0013), so this command can make no request and cannot spend anything. `--provider ollama` (or any other name) is a usage error and runs nothing.

The gate (`src/evaluation/gate.ts`) judges two things only, and uses no threshold, weight or tolerance: "worse" means strictly worse on a value with a stated direction. A baseline is a document an earlier invocation wrote with `--out`.

**Integrity findings** (every run, with or without a baseline): `run_schema_invalid` (the run fails the stored-run schema, which now also checks the shape of each case's score, grounding and scenario); `report_inconsistent` (the totals, metrics, scenario breakdown, reliability counts or status do not follow from the case reports, recomputed with the harness's own functions); `duplicate_case`; `case_not_reported` and `case_not_in_suite` (a scripted run against the suite definition); `answer_leak`; `result_invalid`; `grounding_missing` and `citation_unconfirmed` (an admitted case whose citations were not re-read, or that the independent re-read does not confirm); `run_incomplete`.

**Regression findings** (with `--baseline`): `case_regressed` (names the case, the dimension and both values: root cause, symptom series cited, completion, affected recall, affected precision, citation grounding); `case_missing` and `case_unexpected` (a case in only one of the two runs, so a baseline that lost a case cannot pass); `metric_regressed` (an aggregate metric fell, or rose if lower is better, or was scored and no longer is, with numerator and denominator); `metric_unjudgeable` (a scored metric with no declared direction in `METRIC_DIRECTION`; a test requires every metric the harness scores to be declared); `split_changed`, `scenario_set_changed` and `case_scenario_changed` (the suite or a scenario moved between development and held-out since the baseline, a scenario vanished or appeared, or a case moved to another scenario); `baseline_missing_run` (no run of that suite, version and provider kind, or a baseline recorded for another version of the suite).

**Unusable baselines are input errors (exit 2), not gate failures:** a baseline run that is incomplete, internally inconsistent (for example hand-edited), reports a case twice, or is one of several runs of the same suite, version and provider kind. Nothing can be judged against such a reference, and a gate that guessed would pass silently. A baseline written before `component_identified` existed (below) is inconsistent under this rule and must be re-recorded.

The document's `gate` holds `passed`, `problems` (the findings as sentences, `suite: reason`) and `findings` (the same facts as fields: `code`, `suite`, `case`, `metric`, `reason`, `baseline`, `current`). The per-case rules are stricter than the console's comparison view (`compareRuns`), which still reports root cause, symptom series and outcome only; the two are not the same report.

**Real models.** The strict rule is right for the deterministic suites. A real model's runs vary, so comparing them strictly would flag noise; extending this gate to a real model needs an owner-chosen tolerance rule and repeated runs, and none is invented here ([decision register](proposals/decision-register.md), D9).

| Exit code | Meaning                                                                                                                   |
| --------: | ------------------------------------------------------------------------------------------------------------------------- |
|         0 | The gate passed.                                                                                                          |
|         1 | The gate failed: any integrity or regression finding above.                                                               |
|         2 | Usage or input error (unknown suite or option, unreadable or unusable baseline, output file already exists). Nothing ran. |
|         3 | The development / held-out split was breached. No result is reported.                                                     |

The gate is about integrity, not about the diagnoses: the scripted suites contain deliberately wrong, conflicting and fabricated diagnoses, so a wrong root cause there is an expected outcome and does not fail it. `--baseline` takes a document an earlier invocation wrote with `--out` and fails on any case of the same suite, version and provider kind whose root cause, symptom citation or outcome got worse (improvements are reported by the comparison, not counted as problems); a baseline with no run of that suite and kind fails the gate rather than passing silently. `--out` never overwrites an existing file. With a fixed clock the document is byte for byte repeatable; with the real clock, only timestamps and durations differ between invocations.

Passing this gate means the pipeline, verification, scoring and split still behave as recorded. It does not mean any model is good.

### Metrics

Each has a numerator and a denominator. "Admitted" means the bundle passed intake and was scored; a failed, over-budget or inconclusive admitted case is in the denominator and not in the numerator, and a not-admitted case is out of the diagnosis denominators but still counted in completion, validity and leak counts. An empty denominator is `not_applicable`, never zero.

| Metric                                   | Numerator / denominator                                                                                                                                           |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `root_cause_correct`                     | admitted cases whose single named root-cause component is the key's / admitted cases                                                                              |
| `root_cause_ambiguous` (lower is better) | admitted cases naming more than one root-cause component / admitted cases                                                                                         |
| `affected_precision`                     | components named that the key lists as affected / components named, summed over admitted cases                                                                    |
| `affected_recall`                        | affected components named / components the key lists, summed over admitted cases                                                                                  |
| `symptom_evidence`                       | admitted cases in which a finding cites the primary-symptom series with its labels / admitted cases                                                               |
| `component_identified` (descriptive)     | components findings name (once per finding) that appear as a field value in a record the same finding cites / components named. Never gated as quality; see below |
| `citation_grounding`                     | citations a second, independent read of the bundle confirms (record exists, identifiers match, file checksum unchanged) / all citations                           |
| `completion`                             | cases ending completed or inconclusive / all cases                                                                                                                |
| `result_validity`                        | results valid against the contract / all cases                                                                                                                    |
| `answer_leaks` (must be 0)               | cases with a protected value in a request or result metadata / all cases                                                                                          |
| `remediation`                            | **not scored**: no rubric exists (see Limitations)                                                                                                                |

### Component evidence (descriptive)

`src/evaluation/relations.ts` re-reads each cited record and checks whether each component a finding names appears as a string value in a record that same finding cites. It reports `named`, `identified` and the `unidentified` pairs per case, and the aggregate `component_identified`. It is a count, not a verdict: the correct root-cause finding of the committed scripted case names `payment-provider`, whose cited records imply it (`provider_unavailable`) without carrying the string, so it counts as not found. It does not show support or causation; those stay `not_assessed` ([proposal](proposals/finding-assessment.md)).

### Is a bundle fit to evaluate with?

```sh
pnpm eval:readiness <bundle-dir> [--for development|held-out]
```

Reads files only and prints JSON `{ready, intendedSplit, scenario, findings}`; exit 0 ready, 1 not ready, 2 usage. It runs the consumer-side validation, then reports **blocking** findings (`bundle_invalid`, with each issue's rule, file, field and message and the bundle path scrubbed; `scenario_unregistered`; `split_conflict`; for `held-out`, `seed_used_for_tuning`) and **limitations** (`seed_used_for_tuning` for development, `fixed_fault_timing` at 30 s, `telemetry_truncated`). `TUNING_SEEDS` in `src/evaluation/suites.ts` lists the seeds the project was built on. This is a check on inputs; it is not evidence that held-out data exists ([data request](proposals/commerce-data-request.md)).

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
- The gate and the readiness check test integrity and inputs. They do not establish that any model is good.
