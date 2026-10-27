# Proposal: data request to Commerce Platform

**Status: proposed. A request, not an agreement.** Commerce Platform decides what it produces, when, and whether it varies its fault timing ([ADR 0003](../adr/0003-ground-truth-isolation.md), "Remaining risks"; Commerce Platform's roadmap). Nothing here asks this repository to run a scenario, to touch `commerce-platform`, or to create bundles, and no evidence was invented to stand in for the missing data. This extends [commerce-platform-handoff.md](../commerce-platform-handoff.md) with what real held-out evaluation would need.

## What exists, exactly

| Item                                   | State                                                                                                                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Genuine bundle excerpt                 | `provider-outage`, seed 42, committed under [docs/examples](../examples/README.md). An excerpt: it fails intake rule 1 for its three missing full telemetry files by design.   |
| Genuine complete bundle                | One was copied locally on 2026-10-27 for a handoff check (`provider-outage-42-20261026T123450Z`); it is **not committed** and it is the same scenario and seed as the excerpt. |
| Synthetic bundles                      | Written by `src/evaluation/synthetic.ts` from the excerpt, plus the invented `synthetic-cache-saturation` (seed 7), which is the held-out suite's only data.                   |
| Scenarios Commerce Platform implements | `provider-outage`, `payment-timeouts`, `api-pool-exhaustion`, `bad-deploy-order-reads`, `poison-order` (handoff document).                                                     |
| Bundle schema                          | Version 1, accepted ([Commerce Platform ADR 0007](../adr/commerce-platform/0007-incident-bundle-schema-v1.md)). Unknown fields accepted here.                                  |

**The seed-42 `provider-outage` data is development data.** Prompts, selection and scoring were written looking at it, so it must never be relabelled as an independent or held-out input. `TUNING_SEEDS` in `src/evaluation/suites.ts` records this and `pnpm eval:readiness` enforces it.

## Development fixtures, evaluation inputs and held-out cases

| Kind                | Purpose                                            | May be looked at while tuning prompts, selection or scoring? | Where it lives                                                      |
| ------------------- | -------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------- |
| Development fixture | Build and test code (committed excerpt, synthetic) | Yes                                                          | In the repository                                                   |
| Development input   | Tune and demonstrate (real bundles, tuning seeds)  | Yes                                                          | The operator's bundles directory; never committed                   |
| Evaluation input    | Measure, repeatedly, after tuning stops            | Not the contents; only aggregate scores                      | The operator's bundles directory; never committed                   |
| Held-out case       | Measure generalization: unseen seeds and scenarios | **No**, until the evaluation is reported                     | A separate directory the tuning work does not open; never committed |

The split is by **scenario** in code (`SCENARIO_SPLIT`) and by **seed** in `TUNING_SEEDS`; a scenario with no declared side cannot be run.

## What to request (proposed minimum)

The side of each scenario is an owner decision (below); this is a default that the owner may change.

| Id  | Request                                                                                                                                              | Side (proposed)   | Why                                                                             |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------- |
| H1  | `provider-outage` with three seeds other than 42 (for example 43, 44, 45)                                                                            | Held-out seeds    | Tests unseen seeds of the development scenario                                  |
| H2  | One whole scenario not used in tuning, three seeds: `api-pool-exhaustion` (no external dependency, a different failure shape)                        | Held-out scenario | Tests an unseen scenario; the strongest generalization check available          |
| D1  | `payment-timeouts`, two seeds                                                                                                                        | Development       | A second real scenario to tune on, so tuning does not fit one scenario          |
| T1  | Any of the above generated with a **varied fault trigger offset** (for example 15 s, 30 s, 45 s, 60 s after load start)                              | As their scenario | Today every bundle faults 30 s after load start, which telemetry reveals        |
| R1  | At least one scenario with **varied retry or error-rate parameters** recorded in `faultParameters` (values differing across bundles of one scenario) | As their scenario | Lets evaluation check that a diagnosis does not depend on one parameter setting |

Remaining scenarios (`bad-deploy-order-reads`, `poison-order`) are optional extensions of the same pattern. Whether Commerce Platform varies timing or parameters, and how, is its decision; if it cannot, the bundles still help (H1, H2, D1) and results on them are reported as fixed-timing results, as the evaluation documentation already requires.

Counts are a floor for a meaningful per-scenario report, not a statistical claim: three bundles say little about accuracy, but they allow a repeatable, per-scenario table.

## Required bundle properties

- **Schema:** bundle v1 (`schemaVersion` `1.x.y`); a new major is refused here until an ADR adds it.
- **Complete:** all five files, never an excerpt. `manifest.files` checksums, byte counts and record counts must match (intake rule 9).
- **Identifiers:** `bundleId` equals the directory name; `scenario.name`, `version` and `seed` agree between manifest and ground truth (rules 6 and 7). Directory names are never changed after production. `scenario.version` increments whenever Commerce Platform changes what a scenario injects, so two bundles with equal name, version and seed are the same incident.
- **Traces:** `capture.traces.services[].truncated` should be `false`. If truncation occurs it must be recorded with its reasons (rule 8); this repository reports it to the model as a limitation, so truncated bundles are useful as a separate hard case but should be labelled.
- **Logs:** `nonJsonLines` and `droppedAdminLines` recorded per service; no unparseable lines beyond what the manifest counts.
- **Metrics:** the primary symptom's series present, with the matchers the ground truth names; a scrape step recorded (`capture.metrics.stepSeconds`).
- **Ground truth:** `rootCause.component`, `affectedComponents`, `primarySymptom`, `timeline` and `faultParameters` present, so evaluation and readiness checks can run. `expectedRemediation` stays free text unless [remediation-scoring.md](remediation-scoring.md) is adopted.
- **Timing and retry behaviour:** `timeline.triggerOffsetMs` and every varied parameter recorded in the ground truth, never only in telemetry.
- **No sensitive data:** the bundles are produced from Commerce Platform's local synthetic stack; the producer confirms no real customer or credential data is present.

## Validation before a bundle is accepted

Run in this order; stop at the first failure.

1. In Commerce Platform, read-only: `pnpm incident validate <bundle-dir>` (no network call, per the handoff document).
2. Here: `pnpm validate-bundle <dir>` (exit 0).
3. Here: `pnpm eval:readiness <dir> --for development` or `--for held-out`. It exits 1 and lists blocking findings if the bundle is invalid, its scenario has no declared side, the side conflicts with the registry, or (for held-out) its scenario and seed were already used for tuning. It lists limitations (fixed 30 s timing, truncated traces) without failing.
4. Record the bundle's `manifest.json` SHA-256, side and acceptance date in a register that holds no bundle content (proposed: a short file in this repository, so a changed or swapped bundle is detectable).
5. Only then is the scenario added to `SCENARIO_SPLIT` and to a new suite version. Adding a suite is a reviewed change, and a held-out suite is never edited after its first scored run (a changed suite is a new version).

## Leak checklist for held-out cases

Before accepting a bundle as held-out, confirm each:

- [ ] Its scenario and seed are absent from `TUNING_SEEDS` and from every committed fixture, test and prompt.
- [ ] Its scenario name, component names, metric names and log message strings appear nowhere in `src/` outside `src/evaluation/` (the existing test for the invented held-out scenario shows the pattern; it would be extended to the new identifiers).
- [ ] No one tuned prompts, selection limits or scoring while looking at its telemetry or ground truth.
- [ ] It lives outside any directory the tuning work opens, and is not copied into the committed examples.
- [ ] Its first scored run is recorded, and the suite version is frozen after it.
- [ ] Reports label the data as fixed-timing wherever `triggerOffsetMs` is 30,000.
- [ ] The held-out result is reported with the model, limits, bundle checksums and the statement that it measures that model on those bundles only.

## What this repository can check without the data (implemented)

- `pnpm eval:readiness` and its tests use bundles built from the committed excerpt, with the scenario, seed and trigger offset changed consistently, to show each finding. These are **consumer-side tests of the check**, not evidence that held-out data exists.
- The consumer validator already names the file, rule and field of every defect; `eval:readiness` surfaces the same issues, scrubbed of the bundle path, and adds the evaluation-specific findings above.
- The split registry and `TUNING_SEEDS` are tested against the suites: every development bundle's seed is listed as tuned and no held-out bundle's is.

## Dependency and decision

**Dependency:** Commerce Platform's M5 (reproducibility reruns in progress as of 2026-10-26) and M6 (a reviewed sample bundle) are upstream and not started or finished; running scenarios is a consequential operation under Commerce Platform's own approval rule.

**Owner decisions:**

1. Which scenarios are development and which held-out (default above).
2. Whether to ask Commerce Platform for varied timing and parameters (T1, R1), and to own `scenario.version` bumps.
3. Where held-out bundles live and who is trusted not to tune on them.
4. Approval of the acceptance register in step 4.

Until the bundles exist, the held-out requirements in the roadmap stay open. Nothing here changes them.
