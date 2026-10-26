# 0003: Ground-truth isolation

- **Status:** Accepted (2026-10-26), approved by the repository owner after the E1 review. The rule that investigation code never reads `ground_truth.json` or receives answer-bearing fields is the owner's requirement (E1 brief and review); the mechanism below was approved with it.
- **Date:** 2026-10-26

## Context

`ground_truth.json` is the answer key: the root cause, affected components, primary symptom, fault timeline and expected remediation (Commerce Platform [ADR 0007](commerce-platform/0007-incident-bundle-schema-v1.md)). An investigation that can see it, or anything derived from it, proves nothing, and its evaluation score is meaningless.

The answer can leak without opening that file. An audit of `manifest.json` against all eight real Commerce Platform bundles (five scenarios, commit `93ad213`) judged each field by what its value means, not by its name, and found:

- the directory name and `bundleId` start with the scenario name;
- `scenario` is the answer key's identity: name, version and seed;
- `trigger.startedAt` is always exactly 30.0 s after `window.captureFrom`, which always equals `window.loadStartedAt`, so either window start gives the fault start;
- `trigger.requestedDurationMs` equals the ground truth's `timeline.durationMs`;
- `detection` is the moment the ground truth's own primary-symptom condition became true, measured from the fault start, with the ground truth's deadline;
- `files["ground_truth.json"].sha256` fingerprints the scenario and seed, because ground truth is deterministic;
- `load.seed` is the scenario seed, and `load.planHash` fingerprints it;
- `capture.traces.services[].traces` and `capture.metrics.series[].seriesCount` vary by scenario. For example, the worker's trace count ranges from 182 to 1,522, and some series exist only under some faults. They summarise the evidence, so the investigator can count them itself, but they hand over the conclusion for free;
- `capture.traces.droppedAdminSpans` and `capture.logs.services[].droppedAdminLines` count traffic on the fault-control channel.

## Decision

1. **Two separate operations.**
   - **Contract validation** (`validateBundle`) reads all five files, because the contract requires checking `ground_truth.json`'s schema, checksum and scenario agreement. It is run by intake, and its report never goes to an investigator: it names the bundle directory.
   - **Investigator admission** (`openEvidence`) reads only `manifest.json`, `traces.jsonl`, `metrics.jsonl` and `logs.jsonl`, re-checks them, and returns the evidence view. It never opens, stats or hashes `ground_truth.json`, and works when that file is absent or unreadable. It does not import contract validation. No function combines the two.
2. **An allowlisted view.** The view is `{ caseId, manifest, files }`. Its manifest is built by picking the fields below, never by copying the manifest and deleting some, so a field a later 1.x producer adds stays out until it is audited.

   | Field kept                                                                               | Why it is safe                                             | Why it is needed               |
   | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------ |
   | `schemaVersion`                                                                          | the same for every scenario                                | reading the records            |
   | `services[]`: `name`, `version`, `instanceId`                                            | the same service set in every run                          | interpreting the telemetry     |
   | `capture.traces.services[]`: `name`, `truncated`, `truncationReasons`, `saturatedSlices` | describes the capture's completeness, not the fault        | stating limitations (ADR 0004) |
   | `capture.metrics.stepSeconds`                                                            | a capture setting                                          | interpreting sample spacing    |
   | `capture.logs.services[]`: `name`, `nonJsonLines`                                        | describes parsing completeness                             | stating limitations            |
   | `files` for the three telemetry files: `sha256`, `bytes`, `records`                      | per-run checksums; the counts are derivable from the files | evidence references (ADR 0004) |

   **Excluded:**
   - `bundleId`, `scenario`, `createdAt`, `window`, `trigger`, `detection`, `producer`, `infrastructure`, `load`;
   - in `capture`: every other `traces` and `metrics` field (the slice settings, `droppedAdminSpans`, per-service `traces`, `series` with `seriesCount`) and `logs.services[]`'s `records` and `droppedAdminLines`;
   - the answer file's `files` entry.

   The reasons are recorded per field in `EXCLUDED_MANIFEST_FIELDS` (`src/intake/evidence.ts`).

3. **No path, no name.** `caseId` is the first 16 hex characters of the manifest's SHA-256: unique per run, the same for a renamed copy, and one-way. The view holds no directory path. Intake calls `openEvidence` and hands the investigator the view alone; investigation code receives an `EvidenceView`, never a path.
4. **Evaluation stays separate.** Scoring (E3) is the only other code that reads ground truth, after an investigation, with its result as input.
5. **Enforcement by tests:**
   - the evidence loader's file reads are recorded, and none is the answer file;
   - the loader works without the answer file, or with it unreadable;
   - the view's key paths equal the allowlist exactly;
   - no excluded field is present, and no excluded value appears: the scenario name, bundle ID, path, answer checksum, commit and plan hash nowhere in the view; the trigger, detection, window, creation time and run prefix nowhere in its manifest;
   - unknown fields added at any depth, even ones holding the scenario name, are dropped;
   - a renamed copy gives an identical view;
   - errors from the loader carry neither the scenario name nor the path;
   - only the contract and contract validation name the answer file, and only the CLI and the package index import contract validation.

## Consequences

- **Positive:** the investigator cannot see the answer or the fault window through the manifest, by construction, and the tests fail if a change tries to show it.
- **Positive:** an unaudited field cannot leak through a contract minor version; it has to be added to the allowlist deliberately.
- **Negative:** the investigator gets no stated observation window; it reads time ranges from the telemetry itself.

**Remaining risks**, outside what the manifest view can control:

- **The producer's fixed protocol.** Telemetry starts with the load: the first log record is 5 ms after the load starts. Every Commerce Platform run triggers its fault 30 s later, for 90 s. Investigation code that knows this protocol can locate the fault window. It must not encode run-protocol constants, and E3 should test with varied timing. The robust fix is upstream: randomise the trigger offset and duration in Commerce Platform. That would change its ground-truth timeline, so it is a decision for that repository.
- **Fixed seeds.** Every run so far uses seed 42, and each scenario has a characteristic signal; for example, only `provider-outage` produces `lookup_or_void` errors. A model tuned on these bundles could memorise scenario signatures rather than investigate. E3 should hold out seeds and scenarios.
- **Telemetry content** is evidence by design, so the symptoms are in it. The producer's own leakage check (its criterion C3b) keeps scenario names, `/admin` paths and the word "fault" out. This repository does not re-check that; it could, cheaply, if needed.
- **The path given to `openEvidence`** names the scenario. Nothing in E1 can stop future investigation code from calling `openEvidence` itself; E2 must keep that call in intake.
