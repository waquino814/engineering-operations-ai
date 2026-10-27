# Roadmap

Status: **proposed**, with one owner decision. The portfolio order, this backend first and its investigation UI after, comes from Commerce Platform's project order ([ADR 0008](adr/commerce-platform/0008-project-order.md), proposed, agreed in principle by the owner on 2026-10-25). Each milestone needs the owner's approval before it starts, and none fixes a technology by itself; technology choices are ADRs.

## Milestone order

**Owner policy (2026-10-27):**

> **Absolute no-additional-spending constraint:** No application path, configuration setting, provider selector, UI control, or command-line option may initiate a hosted AI request or incur additional AI-service charges. Only deterministic fake execution and verified local-only inference are permitted. If local-only operation cannot be verified, execution must fail closed.

It overrides every milestone below. The runnable application may allow only `fake` and `local` ([ADR 0013](adr/0013-zero-spend-local-inference.md), proposed); the hosted adapter stays in the repository but unreachable.

**Owner decision (2026-10-26): build the investigation UI before integrating a real AI provider.** Milestone IDs are stable: completed and in-progress records keep their numbers, and the scope still open in E2 and E3 moves to new milestones E5 to E7.

| Order | Milestone                                                | Status                                                                          | Depends on                                                                                  |
| ----: | -------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
|     1 | E0 Foundation, E1 intake                                 | complete                                                                        | —                                                                                           |
|     1 | E2 investigation backend, E3 evaluation: the foundations | foundations delivered (`a65e5b9`); not complete; remaining scope moved to E5–E7 | E1                                                                                          |
|     2 | E4 Investigation UI                                      | complete (2026-10-26): commit `43d5987`, CI passed                              | E2/E3 foundations and the result contract; **no** provider, credentials or external AI call |
|     3 | E5 Provider integration                                  | in progress; local Ollama provider working (2026-10-27)                         | the no-spending policy; ADR 0013 (partly accepted); no credentials                          |
|     4 | E6 End-to-end integration                                | not started; ADR 0012 partly accepted                                           | E4, the application boundary (ADR 0012), a permitted provider (`fake` or verified `local`)  |
|     5 | E7 Evaluation and hardening                              | not started                                                                     | E6; varied-timing bundles from Commerce Platform for full coverage                          |

Why this order is consistent with the decisions in force:

- Commerce Platform [ADR 0004](adr/commerce-platform/0004-frontend-sequencing.md) (accepted upstream) builds this UI "after that repository's backend and investigation workflow are functional". The workflow is functional end to end with the deterministic fake provider ([ADR 0006](adr/0006-investigation-pipeline-and-limits.md)), and it produces every result state the UI must show; the provider changes where results come from, not their contract.
- [ADR 0002](adr/0002-ai-provider-and-external-api-policy.md) keeps tests and CI free of credentials and external calls; E4 needs neither.
- The result contract the UI renders is accepted ADR 0004 as amended by [ADR 0010](adr/0010-investigation-result-contract-v0.md), accepted on 2026-10-26.

## Where this project sits

Commerce Platform's portfolio order:

1. Commerce backend and infrastructure (Commerce Platform M0 to M2).
2. Observability and incidents (Commerce Platform M3 to M5).
3. Commerce Platform UI (Commerce Platform M7).
4. **Engineering Operations AI backend**: a new, independent repository that reads incident bundles through the contract in ADR 0007 and shares no code with Commerce Platform. _This repository._
5. **AI investigation UI**: in this repository.

**Upstream status on 2026-10-26** (Commerce Platform `docs/roadmap.md`): M5 is still open. All five scenarios have produced valid bundles, and its reproducibility reruns are in progress. M6, which adds a reviewed sample bundle to Commerce Platform, has not started. Bundle schema v1 is accepted and is not affected by either.

## E0: Foundation

**Status: complete.**

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

**Status: foundation delivered in commit `a65e5b9`; E2 is not complete.** On 2026-10-26 its provider-dependent scope moved to E5 (provider integration) and E7 (diagnostic quality); its checklist below is kept as the record.

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

- [ ] **Owner review** of proposed ADRs 0006 to 0008.
- [x] ADR 0010 and its amendment to ADR 0004 (no `failure` on `inconclusive`), accepted by the owner on 2026-10-26.
- [ ] **Blocked on the owner's decision:** a real provider adapter. [ADR 0008](adr/0008-model-provider-recommendation.md) recommends one; implementing it needs approval, a credential, and an agreed budget.
- [ ] Token budget in production: needs an adapter that maps its provider's usage fields and confirms `maxInputTokensPerCall` against the provider's tokenizer ([ADR 0008](adr/0008-model-provider-recommendation.md), "Verification required before approval").
- [ ] Verification of ADR 0008's provider facts against current official documentation.
- [ ] A real bundle investigated by a real model, with a verified result.
- [ ] Semantic support of findings: whether cited evidence supports the statement is not assessed.

Done when a real Commerce Platform bundle produces a schema-valid, reference-verified result from an approved provider, within its limits, and the ADRs are accepted. After the reorder, that criterion is carried by E5 and E6, read as "a permitted provider" (`fake` or verified `local`) under the 2026-10-27 no-spending policy, not a hosted one; owner review of ADRs 0006, 0007 and 0010 stays here.

## E3: Evaluation

**Status: harness delivered in commit `a65e5b9`, synthetic cases only; E3 is not complete.** On 2026-10-26 its real-model scope moved to E7; its checklist below is kept as the record.

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

**Status: complete (2026-10-26).** Delivered in commit `43d5987`; its [GitHub Actions run](https://github.com/waquino814/engineering-operations-ai/actions/runs/40402435901) passed. Built before provider integration by the owner's decision of 2026-10-26.

Progress against the acceptance criteria below:

- [x] 1. UI stack ADR accepted: [ADR 0011](adr/0011-investigation-ui-stack.md), accepted by the owner on 2026-10-26.
- [x] 2. Every screen and state renders contract-valid fixtures: the overview, new investigation (four fixture bundles, two invalid) and detail views; eight fixture investigations covering completed, repaired, inconclusive, evidence-verification failure, provider failure, budget exceeded and not admitted.
- [x] 3. Tests pass in CI on GitHub: the CI workflow's `pnpm check` job passed on commit `43d5987` ([run 40402435901](https://github.com/waquino814/engineering-operations-ai/actions/runs/40402435901)).
- [x] 4. Coverage thresholds met for the console's source (per file, 90% lines, 80% branches), unchanged elsewhere.
- [x] 5. `pnpm eval:synthetic` matches the golden report byte for byte; investigation and evaluation tests unchanged.
- [x] 6. No provider dependency, credential or external call.

Also delivered: ADR 0010 accepted, with its amendment recorded in ADR 0004; guard tests extended to `.tsx`, which they had not been reading.

An operator-facing investigation console, inside this repository, built on deterministic fixtures and the existing investigation-result contract.

**Scope:**

- **Investigations overview:** run history with outcome status (`completed`, `inconclusive`, `budget_exceeded`, `failed`, and not admitted), case, provider and model, finding counts, and start time.
- **New investigation:** select or upload a bundle, show its validation result (valid, or the issues by rule, file and field), and start an investigation only when validation succeeds.
- **Investigation detail workspace:** summary and outcome; affected components; findings with kind, confidence, rationale and statement; evidence references (file, line, quoted identifiers); each finding's verification statements, with `semanticSupport: not_assessed` shown as such, never as verified; limitations; diagnostics (selection summary, failure class and message, limits).
- **Run details:** model calls, retries, repairs, reported and charged tokens against `maxTotalTokens`, and whether accounting is `reported` or `estimated`.
- **States:** loading, empty, validation error, failure, inconclusive and budget exceeded, each designed and tested.
- Out of scope for E4: approval workflows and evaluation-result views, named by Commerce Platform ADR 0004 for this UI; they are planned after E6.

**Design direction:** a dark enterprise incident-management and observability console. Charcoal and slate surfaces with restrained blue accents; a left navigation sidebar and a compact top bar; information-dense layouts for engineers and incident responders; evidence panels, diagnostic details, timelines, compact tables and clear status indicators. No storefront styling, oversized cards, decorative stock images or chat-style layout. Status colours never carry meaning alone: each status also has text, and contrast meets WCAG AA.

**Constraints:**

- **Stack first.** The UI stack is still an open decision ([architecture](architecture.md#open-decisions)). E4 starts with a proposed ADR choosing it, within [ADR 0001](adr/0001-runtime-and-language.md) (TypeScript), with the owner's approval. Commerce Platform ADR 0004's context expects React; that is an input, not a decision here.
- **One application, in this repository.** There is no existing frontend code here to reuse (checked 2026-10-26). Commerce Platform's own UI is in another repository and is never imported.
- **The contract is the source of truth.** Types and states come from the result contract ([docs/contracts/investigation-result/](contracts/investigation-result/README.md)); the UI reads results through `readInvestigationResult` or the published schema and handles every state the contract defines, and no others.
- **Deterministic fixtures, produced by the real code.** Result fixtures are generated by the pipeline with `FakeProvider` (as the synthetic evaluation does), covering every state; validation fixtures are real `validateBundle` reports on fixture bundles. A test fails if a fixture stops passing the contract. Fixtures never include ground truth or evaluation scores.
- **No invented API.** There is no application or HTTP boundary today: the pipeline is a library called with a bundle path. In E4 the UI reads fixtures through a typed data-source interface whose shape follows the contract. Upload, live validation, starting runs and run history need that boundary and persistence, which E6 decides; E4 records what the UI needs from it.
- **No provider, no credentials.** E4 adds no provider SDK, key or external AI call; `pnpm check` and CI stay credential-free.
- **Tests in the same change, in CI.** Every UI feature ships with automated tests that run under `pnpm check`, which CI already runs. Coverage thresholds (90% lines, 80% branches, per file) extend to the UI's source; they are not lowered. The architecture tests' dependency allowlist and no-network rule are changed only deliberately, by the UI stack ADR, and keep the investigator's isolation rules intact.
- **Nothing else changes.** Investigation and evaluation behaviour, the golden evaluation report and the leak checks stay as they are unless a documented decision requires a change. Nothing in `commerce-platform` is modified.

**Dependencies:**

- No dependency on E5: provider integration is **not** a prerequisite for the UI, and UI work needs no credentials or external AI calls.
- ~~Proposed ADR 0010~~: accepted 2026-10-26; an `inconclusive` result carries no `failure`, and the UI shows it as a valid investigation with its limitations.
- **Bundle upload** goes beyond [ADR 0005](adr/0005-bundle-intake-and-validation.md)'s local, read-only directories ("no network intake, upload or database in E1"). E4 may design the upload step against fixtures; accepting real uploads needs an ADR 0005 amendment, in E6.

**Acceptance criteria:**

1. The UI stack ADR is accepted by the owner.
2. Every screen and state above exists and renders contract-valid fixtures, including one per result state and a validation-error fixture.
3. Automated tests cover each view and state, and the fixture contract check; they run under `pnpm check` and **pass in CI on GitHub** (a local run is not enough to close the milestone).
4. Coverage thresholds are met for the UI's source, unchanged elsewhere.
5. `pnpm eval:synthetic` still matches the golden report byte for byte, and the investigation and evaluation tests are unchanged.
6. No provider dependency, credential or external call exists.

## E5: Provider integration

**Status: in progress (revised 2026-10-27).** The local Ollama provider (`src/providers/ollama/`) and the simulated Fake provider are implemented and selectable in Settings (ADR 0013). **One real run, 2026-10-27:** `gemma4:12b` through the local Ollama, started from the console's API on the synthetic provider-outage bundle, completed with 3 verified findings (root cause: the payment provider's `provider_unavailable` errors on the worker) in 1 call and 85.6 s, 8,981 input and 1,049 output tokens, every citation checked against the bundle's lines. Earlier attempts failed honestly: with the default context budget the selection was empty and the model said it had no evidence (a limits bug, fixed), and a reply with invalid JSON or wrong reference ids was rejected after the bounded repair. This is one run on a synthetic bundle, not a quality evaluation. Under the no-spending policy, E5 no longer integrates a hosted provider. Delivered so far, with no network: the Anthropic adapter, mapping, derived schema and provider selection, with stubbed-client tests. [ADR 0008](adr/0008-model-provider-recommendation.md) is superseded in part: the adapter stays in the repository but must be unreachable from runnable execution, and its funded evaluation is withdrawn. **Out of scope:** hosted-provider verification, credentials, budgets, and any work that needs spending.

Scope, [ADR 0013](adr/0013-zero-spend-local-inference.md) (partly accepted):

- Done: a provider allowlist, `fake` and `ollama`, in the application layer, with tests that every other name (hosted ones, the retired `local`) is refused; a settings file and Settings page that save the choice; a loopback-only Ollama adapter with injected-client tests and a local-only verification that runs before any prompt (no Ollama, model or network in CI); the deterministic labelled simulation; failure handling for an unavailable runtime, a missing or unverifiable model, malformed or empty replies, invented citations, timeouts and cancellation.
- Open: the Ollama server's own cloud setting cannot be verified from outside (`OLLAMA_NO_CLOUD=0` on the development machine); the full set of remote markers Ollama may add; whether the schema constraint is honoured in every case (the investigator validates regardless); a measured quality evaluation on real bundles with the chosen model (E7); excerpts of cited records in the report.

Done when the allowlist and provider pass their tests, the local-only check is reviewed by the owner, ADR 0013 is accepted, and the quality of a local model on real bundles has been evaluated. No hosted evaluation is a completion criterion. Not complete.

## E6: End-to-end integration

**Status: in progress.** [ADR 0012](adr/0012-application-boundary.md) (partly accepted) and the provider allowlist in [ADR 0013](adr/0013-zero-spend-local-inference.md) are implemented locally and pushed: the application layer (configuration, bundle access, run store, orchestration), the `investigate` and `serve` commands, the loopback HTTP API, and the console on it. `pnpm ui:dev` or `pnpm dev` starts the application and console together with data under `~/.engineering-operations-ai/`. Settings selects `Fake` (simulated output, labelled) or `Ollama` (a verified local model; real investigations run through it), persisted across restarts. Real-process end-to-end tests are in `test/e2e/`. **Not done:** uploads, a second local model's evaluation, diagnostic quality measurement (E7), excerpts of cited records in the report. After E4 and E5.

Proposed sequence ([ADR 0013](adr/0013-zero-spend-local-inference.md)): **E6a** application boundary, then a verified local provider, then a configuration UI, then a separately decided server and further hardening.

- The application layer owns configuration, provider construction, the provider gate, run storage and orchestration; startup is request-free; the investigator never chooses a provider (ADR 0003 isolation kept).
- Implement it with tests. The UI is connected to it over the loopback server; fixtures remain available by build option.
- Live end-to-end investigation requires this boundary and a permitted provider (`fake`, or `local` once verified); until then the UI shows fixtures only.

Done when an operator can validate a real bundle, start an investigation with a permitted provider (verified `local`), and see the result in the UI, with tests for the boundary passing in CI. Not complete; the criterion cannot be met until a local provider is verified and the integration route is decided.

## E7: Evaluation and hardening

**Status: not started.** After E6. Carries forward E3's real-model scope.

- Diagnostic quality: score real diagnoses per scenario, with held-out seeds and at least one held-out scenario ([ADR 0009](adr/0009-evaluation-harness-and-scoring.md)); symptom and remediation scoring; whether evidence semantically supports findings.
- Security boundaries: re-run the leak checks and isolation tests against the live path; review the API boundary.
- Reliability, observability and operational behaviour: provider failures, budgets and timeouts in live runs; logging and metrics that carry no telemetry content or credentials.
- Approval workflows and evaluation-result views in the UI (Commerce Platform ADR 0004).
- Depends on Commerce Platform for bundles with varied fault timing (ADR 0003, "Remaining risks").

Done when real-model results are scored repeatably with a per-scenario report, and the hardening items have tests in CI.
