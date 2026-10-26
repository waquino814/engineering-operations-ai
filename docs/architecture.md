# Architecture

Status: **intended design, not yet implemented.** Statements marked _decided_ come from accepted decision records; everything else is a proposal or an open question, listed at the end.

## Goal

Investigate operational incidents from their evidence, the way an on-call engineer would: detect what is wrong, diagnose the root cause, and recommend remediation. Commerce Platform's incident bundles supply the evidence and, separately, the ground truth that lets the investigation be scored.

The purpose comes from Commerce Platform's decision records: the bundles exist so this project can "practice detection, diagnosis and remediation" ([ADR 0007](adr/commerce-platform/0007-incident-bundle-schema-v1.md), Context), and its UI is to "show incident investigations, evidence, citations, recommendations, approval workflows, and evaluation results" ([ADR 0004](adr/commerce-platform/0004-frontend-sequencing.md), Context).

## Boundary with Commerce Platform

```
 Commerce Platform (separate repository)            Engineering Operations AI (this repository)
 ┌──────────────────────────────────────┐            ┌────────────────────────────────────────────┐
 │ fault scenario + load  →  telemetry  │            │ intake: validate against the vendored v1   │
 │ incident CLI writes a bundle:        │   files    │   JSON Schema + cross-file rules           │
 │   manifest.json  ground_truth.json   │ ─────────▶ │ investigation: evidence → diagnosis        │
 │   traces.jsonl  metrics.jsonl        │  (copied)  │ evaluation: diagnosis vs ground truth      │
 │   logs.jsonl                         │            │ UI (later): investigations and results     │
 └──────────────────────────────────────┘            └────────────────────────────────────────────┘
```

- _Decided_ ([ADR 0007](adr/commerce-platform/0007-incident-bundle-schema-v1.md)): the incident bundle is the only contract. This repository vendors a pinned copy of the JSON Schema files for the major version it supports and validates with any JSON Schema validator. Neither repository imports the other's code, packages or build output.
- _Decided_ ([ADR 0007](adr/commerce-platform/0007-incident-bundle-schema-v1.md)): bundles describe themselves through `schemaVersion`; a consumer refuses a major version it does not support and ignores fields it does not know.
- _Decided_ ([ADR 0008](adr/commerce-platform/0008-project-order.md), **proposed, not approved**, but agreed in principle by the owner): this project is a new, independent repository, built after Commerce Platform's UI, with its own investigation UI.
- Not part of the contract, so out of bounds: Commerce Platform's database, its HTTP and admin APIs, its fault-scenario controls, and its source tree.

## Intended components

These are responsibilities, not modules; no code or technology is chosen.

1. **Bundle intake.** Read a bundle directory; check the five files, `schemaVersion`'s major version, each document and JSONL line against the [vendored schemas](contracts/incident-bundle/README.md), and the cross-file rules the schemas cannot express (checksums, counts, ID agreement). Reject invalid or unsupported bundles with the file and field at fault. Surface `capture.traces` truncation, so later steps know when evidence is incomplete.
2. **Investigation.** From `manifest.json` and the three telemetry files, produce a diagnosis: the suspected root-cause component, the affected components, the evidence that supports each claim (citations to specific metric series, log records and traces), and recommended remediation steps.
3. **Evaluation.** Compare a diagnosis with `ground_truth.json`: `rootCause.component`, `affectedComponents`, the `primarySymptom` condition, and `expectedRemediation`. Ground truth is a stable answer key: byte-identical for the same scenario, scenario version, seed and schema version.
4. **Investigation UI** (after the backend): investigations, evidence, citations, recommendations, approval workflows and evaluation results, per ADR 0004.

## Principles (proposed)

- **Ground truth stays out of the investigation.** The investigation reads `manifest.json` and the telemetry files only; `ground_truth.json` is read by evaluation alone. Otherwise the score measures nothing. To decide (see below).
- **Telemetry is data, not instructions.** Log messages, span attributes and labels come from the observed system and are untrusted input to any model or tool.
- **Recommend, don't act.** Remediation is advice, with any action behind an approval workflow; this project has no channel to change Commerce Platform.
- **Cite evidence.** Every conclusion points to the bundle records that support it.

## Open decisions

None of these is decided by any source document. Each needs the owner's decision, ideally as an ADR in [docs/adr/](adr/README.md).

| Topic | Open question |
| --- | --- |
| Language and runtime | Not specified anywhere. |
| AI model and provider | Which model, hosted or local, and whether external API calls are allowed. Commerce Platform's "no LLM calls" rule ([ADR 0001](adr/commerce-platform/0001-local-first-architecture.md)) binds only that repository. |
| Local-first | Whether this project, like Commerce Platform, must run fully locally without accounts or credentials. |
| Ground-truth isolation | Whether the investigation may ever read `ground_truth.json` (proposed: no). |
| Diagnosis format | The structure of an investigation's output and its citations. |
| Scoring | How a diagnosis is scored against ground truth, per field. |
| Bundle input | Where bundles are read from, and whether this repository stores any (Commerce Platform keeps them out of Git, except a reviewed sample). |
| JSON Schema validator | Which validator, once a language is chosen; the schemas are draft 2020-12. |
| Investigation UI stack | Not specified; decided when the UI milestone starts. |
| Project order | ADR 0008 is still proposed in Commerce Platform. |
