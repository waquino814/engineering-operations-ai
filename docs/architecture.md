# Architecture

Status: **bundle intake is implemented (E1); the investigation workflow and evaluation harness are implemented as a foundation (E2/E3), with a fake model only.** Statements marked _decided_ come from accepted decision records; _proposed_ marks ADRs 0006 to 0009, which describe implemented code but are not approved ([index](adr/README.md)). Open questions are listed at the end.

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
 │   logs.jsonl                         │            │ UI (E4): investigations and results       │
 └──────────────────────────────────────┘            └────────────────────────────────────────────┘
```

- _Decided_ ([ADR 0007](adr/commerce-platform/0007-incident-bundle-schema-v1.md)): the incident bundle is the only contract. This repository vendors a pinned copy of the JSON Schema files for the major version it supports and validates with any JSON Schema validator. Neither repository imports the other's code, packages or build output.
- _Decided_ ([ADR 0007](adr/commerce-platform/0007-incident-bundle-schema-v1.md)): bundles describe themselves through `schemaVersion`; a consumer refuses a major version it does not support and ignores fields it does not know.
- _Decided_ ([ADR 0008](adr/commerce-platform/0008-project-order.md), **proposed, not approved**, but agreed in principle by the owner): this project is a new, independent repository, built after Commerce Platform's UI, with its own investigation UI.
- Not part of the contract, so out of bounds: Commerce Platform's database, its HTTP and admin APIs, its fault-scenario controls, and its source tree.

## Intended components

All four have code; the fourth, the console, reads the local application over its loopback HTTP API, or fixtures when built that way ([roadmap](roadmap.md)).

1. **Bundle intake** (implemented: [docs/intake.md](intake.md), [ADR 0005](adr/0005-bundle-intake-and-validation.md)). Read a bundle directory; check the five files, `schemaVersion`'s major version, each document and JSONL line against the [vendored schemas](contracts/incident-bundle/README.md), and the cross-file rules the schemas cannot express (checksums, counts, ID agreement). Reject invalid or unsupported bundles with the file and field at fault. Surface `capture.traces` truncation, so later steps know when evidence is incomplete.
2. **Investigation** (foundation implemented, _proposed_ [ADRs 0006](adr/0006-investigation-pipeline-and-limits.md) and [0007](adr/0007-evidence-grounding-and-output-validation.md)). From the blinded manifest and the three telemetry files, produce a diagnosis: the suspected root-cause component, the affected components, the evidence that supports each claim (citations to specific metric series, log records and traces), and recommended remediation steps. Only a fake model exists; the provider is recommended in _proposed_ [ADR 0008](adr/0008-model-provider-recommendation.md).
3. **Evaluation** (foundation implemented, _proposed_ [ADR 0009](adr/0009-evaluation-harness-and-scoring.md), [docs/evaluation.md](evaluation.md)). Compare a diagnosis with `ground_truth.json`. Scoring v0 covers `rootCause.component` and `affectedComponents`; the `primarySymptom` condition and `expectedRemediation` are not scored yet. Ground truth is a stable answer key: byte-identical for the same scenario, scenario version, seed and schema version.
4. **Investigation UI** (E4, complete; accepted [ADR 0011](adr/0011-investigation-ui-stack.md)): a React console, `src/ui/`, for run history, choosing and validating a bundle, and each result's findings, evidence references, verification statements, limitations, diagnostics and token usage. It talks only to a typed `InvestigationDataSource`; in E4 that is committed fixtures generated by the pipeline with the fake provider (`pnpm fixtures:ui`), and uploading or starting a run answers that it needs the application/API boundary E6 decides. Approval workflows and evaluation results, also named by Commerce Platform ADR 0004, follow in E7.

## Modules and data flow

Module boundaries are enforced by tests (`test/architecture.test.ts`, `test/ground-truth-isolation.test.ts`).

| Module               | Takes paths | Reads telemetry              | Reads the answer key                 | Talks to a model         |
| -------------------- | ----------- | ---------------------------- | ------------------------------------ | ------------------------ |
| `src/intake/`        | yes         | yes                          | contract validation only, issues out | no                       |
| `src/pipeline/`      | yes         | through intake               | no (receives the validation report)  | through the investigator |
| `src/investigation/` | **no**      | from the `EvidenceView` only | **never**                            | through `ModelProvider`  |
| `src/evaluation/`    | yes         | through the pipeline         | yes, after the investigation         | through the pipeline     |
| `src/ui/`            | **no**      | no; renders fixture results  | **never**                            | no                       |

Provider adapters hold the only provider SDK types and credentials; the runnable application may allow only the `fake` and `local` providers ([ADR 0013](adr/0013-zero-spend-local-inference.md), proposed), so the hosted adapter is unreachable from it; the domain sees `ModelRequest`, `ModelReply` and `ProviderError` only.

```mermaid
sequenceDiagram
    participant C as Caller (CLI or evaluation)
    participant P as Pipeline
    participant I as Intake
    participant V as Investigator
    participant M as ModelProvider (fake in tests)
    C->>P: runInvestigation(bundleDir, limits)
    P->>I: validateBundle(bundleDir)
    I-->>P: report (stays in the pipeline)
    P->>I: openEvidence(bundleDir)
    I-->>P: EvidenceView {caseId, blinded manifest, records}
    P->>V: investigate(view)
    V->>V: selectEvidence, buildRequest
    loop at most maxModelCalls (retries and repairs included)
        V->>M: complete(instructions, input JSON, output schema)
        M-->>V: reply text or ProviderError
        V->>V: parse, validate, verify references
    end
    V-->>P: InvestigationResult (schema-checked)
    P-->>C: result, report
    Note over C: evaluation alone then reads ground_truth.json and scores the result
```

## Principles

- **Ground truth stays out of the investigation** ([ADR 0003](adr/0003-ground-truth-isolation.md)). The investigation reads a blinded manifest and the telemetry files only; `ground_truth.json` is read by contract validation, which reports issues only, and by evaluation. Otherwise the score measures nothing.
- **Telemetry is data, not instructions** ([ADR 0002](adr/0002-ai-provider-and-external-api-policy.md)). Log messages, span attributes and labels come from the observed system and are untrusted input to any model or tool.
- **Recommend, don't act** ([ADR 0004](adr/0004-investigation-result-contract.md)). Remediation is advice, with any action behind an approval workflow; this project has no channel to change Commerce Platform.
- **Cite evidence** ([ADR 0004](adr/0004-investigation-result-contract.md)). Every conclusion points to the bundle records that support it.

## Decisions and open questions

Accepted in this repository's ADRs (2026-10-26):

| Topic                          | Proposal                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Language and runtime           | TypeScript on Node.js 24, pnpm, Ajv for JSON Schema ([ADR 0001](adr/0001-runtime-and-language.md))                                                                                                                                                                                                                                                    |
| AI provider and external calls | Provider-neutral model port; **no hosted AI request and no spending**: only deterministic fake execution and verified local-only inference, failing closed otherwise; never any external AI call in tests or CI ([ADR 0002](adr/0002-ai-provider-and-external-api-policy.md) as amended, [ADR 0013](adr/0013-zero-spend-local-inference.md) proposed) |
| Ground-truth isolation         | Two read paths; blinded evidence view; enforced by tests ([ADR 0003](adr/0003-ground-truth-isolation.md))                                                                                                                                                                                                                                             |
| Investigation result format    | Versioned JSON with findings, confidence, and line-level evidence references ([ADR 0004](adr/0004-investigation-result-contract.md))                                                                                                                                                                                                                  |
| Bundle input and validation    | Local directories, read-only; schemas by major version, pinned by checksum ([ADR 0005](adr/0005-bundle-intake-and-validation.md))                                                                                                                                                                                                                     |
| Investigation console stack    | React 19, Vite and plain CSS for the console only; Testing Library and jsdom under Vitest ([ADR 0011](adr/0011-investigation-ui-stack.md))                                                                                                                                                                                                            |

## Open decisions

Still open, with the milestone that needs them:

| Topic                         | Open question                                                                                                                                                                                                                                                                                                     |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AI model and provider (E5)    | Hosted providers are out under the no-spending policy ([ADR 0008](adr/0008-model-provider-recommendation.md) superseded in part). [ADR 0013](adr/0013-zero-spend-local-inference.md) (_proposed_) proposes `fake` and a verified local Ollama provider; local-only operation is not yet proven and stays blocked. |
| Local-first (E2)              | Whether this project, like Commerce Platform, must run fully locally without accounts or credentials.                                                                                                                                                                                                             |
| Fault-timing leakage (E2, E3) | The view hides `trigger`, `detection` and `window`, but the producer always faults 30 s after load start, which telemetry reveals. Randomising that is Commerce Platform's decision (ADR 0003, "Remaining risks").                                                                                                |
| Scoring (E3)                  | Scoring v0, root cause and affected components, is _proposed_ in [ADR 0009](adr/0009-evaluation-harness-and-scoring.md); symptom and remediation scoring are open.                                                                                                                                                |
| Semantic support (E2)         | Verification proves that cited records exist, were sent to the model, are intact and are quoted correctly; whether they support the claim is not assessed.                                                                                                                                                        |
| Application/API boundary (E6) | [ADR 0012](adr/0012-application-boundary.md) (_partly accepted_): application layer and `investigate` CLI, per-run JSON files, no uploads; the loopback server and the console's HTTP source are implemented locally (E6b) and not yet verified in CI. No runnable provider exists, so nothing runs end to end.   |
| Project order                 | Commerce Platform's ADR 0008 is still proposed. Within this repository, the owner decided on 2026-10-26 to build the UI (E4) before provider integration (E5).                                                                                                                                                    |
