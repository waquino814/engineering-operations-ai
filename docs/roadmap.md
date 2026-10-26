# Roadmap

Status: **proposed.** The order, backend first and investigation UI after, comes from Commerce Platform's project order ([ADR 0008](adr/commerce-platform/0008-project-order.md), proposed, agreed in principle by the owner on 2026-10-25). The milestones below are this repository's first proposal; each needs the owner's approval before it starts, and none fixes a technology.

## Where this project sits

Commerce Platform's portfolio order:

1. Commerce backend and infrastructure (Commerce Platform M0 to M2).
2. Observability and incidents (Commerce Platform M3 to M5).
3. Commerce Platform UI (Commerce Platform M7).
4. **Engineering Operations AI backend**: a new, independent repository that reads incident bundles through the contract in ADR 0007 and shares no code with Commerce Platform. _This repository._
5. **AI investigation UI**: in this repository.

**Upstream status on 2026-10-26** (Commerce Platform `docs/roadmap.md`): M5 is still open. All five scenarios have produced valid bundles, and its reproducibility reruns are in progress. M6, which adds a reviewed sample bundle to Commerce Platform, has not started. Bundle schema v1 is accepted and is not affected by either.

## E0: Foundation (this change)

- README, architecture and roadmap describe the project and its boundary.
- The incident-bundle v1 contract is vendored with provenance, and the consumer rules beyond JSON Schema are written down.
- Relevant Commerce Platform decision records are transferred, with their status.
- A genuine bundle excerpt documents real data.

## E1: Technology decisions and bundle intake

**Status: complete (2026-10-26).**

- [x] Decisions recorded as ADRs 0001 to 0005 ([index](adr/README.md)): runtime and language, AI provider policy, ground-truth isolation, investigation result contract, bundle intake. **Accepted by the owner on 2026-10-26.**
- [x] Bundle intake implemented ([docs/intake.md](intake.md)): the nine contract rules, structured and deterministic issues, unsupported majors refused, unknown fields accepted.
- [x] Tests: each rule, positive and negative, missing and malformed files, the isolation boundary, and the CLI, on small synthetic fixtures built from the committed example.
- [x] The owner approved ADRs 0001 to 0005 (2026-10-26).
- [x] A real Commerce Platform bundle copied into a fresh clone validates: checked on a fresh clone of commit `64957eb`, with no reference to a Commerce Platform checkout.

Original scope:

- Decide, as ADRs, the open questions that block code: language and runtime, JSON Schema validator, local-first or not, and ground-truth isolation ([architecture](architecture.md#open-decisions)).
- Load a bundle directory and validate it against the vendored v1 schemas and the cross-file rules in the [consumer guide](contracts/incident-bundle/README.md), naming the file and field of each defect.
- Refuse unsupported major versions; accept unknown fields and unknown scenario or component names.
- Tests cover a valid bundle and each defect class, using fixtures that live in this repository.
- Done when a real Commerce Platform bundle copied into a fresh clone validates, with no reference to a Commerce Platform checkout.

## E2: Investigation backend

**Status: in progress. The foundation is implemented, uncommitted, for review; E2 is not complete.**

Original scope:

- Decide the AI model and provider, and the diagnosis format with its citations.
- From a bundle's manifest and telemetry only, produce a diagnosis: root-cause component, affected components, cited evidence, and recommended remediation.
- Handle incomplete evidence, such as truncated traces, explicitly.

Completed (foundation):

- [x] Provider-neutral model port and deterministic fake provider ([ADR 0006](adr/0006-investigation-pipeline-and-limits.md), proposed).
- [x] Pipeline: admission, blinding, deterministic scenario-agnostic selection, one bounded request with telemetry as data.
- [x] Strict output parsing, evidence-reference verification and one bounded repair ([ADR 0007](adr/0007-evidence-grounding-and-output-validation.md), proposed).
- [x] Validated limits, timeouts, transient-only retries with backoff, deadline, cancellation and 14 failure classes; sanitized failure messages.
- [x] Result schema v0.1.0 published under [docs/contracts/investigation-result/](contracts/investigation-result/v0/), checked against the code.
- [x] Truncated traces reported as limitations.
- [x] A total token budget across all calls, charging unreported usage at configured ceilings ([ADR 0006](adr/0006-investigation-pipeline-and-limits.md)); tested with fake usage reports only.
- [x] References restricted to the records actually sent to the model; separate verification statements, semantic support marked not assessed ([ADR 0007](adr/0007-evidence-grounding-and-output-validation.md)).
- [x] Result states, compatibility policy and consumer reader, with tests for every state and malformed combination ([ADR 0010](adr/0010-investigation-result-contract-v0.md), proposed).
- [x] Tests for each of the above, with no network; module boundaries enforced ([docs/testing.md](testing.md)).

In progress or blocked:

- [ ] **Owner review** of proposed ADRs 0006 to 0008 and 0010. **Blocking before commit:** ADR 0010's change to accepted ADR 0004 (`failure` on `inconclusive`).
- [ ] **Blocked on the owner's decision:** a real provider adapter. [ADR 0008](adr/0008-model-provider-recommendation.md) recommends one; implementing it needs approval, a credential, and an agreed budget.
- [ ] Token budget in production: needs an adapter that maps its provider's usage fields and confirms `maxInputTokensPerCall` against the provider's tokenizer ([ADR 0008](adr/0008-model-provider-recommendation.md), "Verification required before approval").
- [ ] Verification of ADR 0008's provider facts against current official documentation.
- [ ] A real bundle investigated by a real model, with a verified result.
- [ ] Semantic support of findings: whether cited evidence supports the statement is not assessed.

Done when a real Commerce Platform bundle produces a schema-valid, reference-verified result from an approved provider, within its limits, and the ADRs are accepted.

## E3: Evaluation

**Status: in progress. The harness is implemented with synthetic cases only; E3 is not complete.**

Original scope:

- Decide the scoring method.
- Score diagnoses against `ground_truth.json` for each of Commerce Platform's scenarios, repeatably, and report per-scenario results.

Completed (foundation):

- [x] A separate scoring boundary: only `src/evaluation/` reads the answer key, after the investigation ([ADR 0009](adr/0009-evaluation-harness-and-scoring.md), proposed).
- [x] Scoring v0: root cause, and precision and recall of affected components.
- [x] Deterministic leak detection over every request and the result's metadata: answer text, excluded and unknown manifest fields, the bundle location; exact, normalized and encoded matches; positive controls, a recorded paraphrase limit, and a pipeline-level canary test.
- [x] A deterministic report from eight synthetic cases, compared byte for byte in CI (`pnpm eval:synthetic`, [docs/evaluation.md](evaluation.md)).

In progress or blocked:

- [ ] **Owner review** of proposed ADR 0009.
- [ ] Paraphrased or inferred leaks: outside what deterministic checks can detect; isolation by construction remains the control.
- [ ] **Blocked on E2's provider:** scoring real diagnoses on real bundles, per scenario, with held-out seeds and scenarios.
- [ ] **Depends on Commerce Platform:** bundles with varied fault timing (ADR 0003, "Remaining risks").
- [ ] Symptom and remediation scoring.

Done when real bundles, including held-out seeds and at least one held-out scenario, are scored repeatably by an approved model, with a per-scenario report.

## E4: Investigation UI

- Decide the UI stack.
- Show investigations, evidence, citations, recommendations, approval workflows and evaluation results (Commerce Platform [ADR 0004](adr/commerce-platform/0004-frontend-sequencing.md)).
