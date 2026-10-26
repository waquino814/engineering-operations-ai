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

**Status: in progress (2026-10-26).**

- [x] Decisions recorded as ADRs 0001 to 0005 ([index](adr/README.md)): runtime and language, AI provider policy, ground-truth isolation, investigation result contract, bundle intake. **Accepted by the owner on 2026-10-26.**
- [x] Bundle intake implemented ([docs/intake.md](intake.md)): the nine contract rules, structured and deterministic issues, unsupported majors refused, unknown fields accepted.
- [x] Tests: each rule, positive and negative, missing and malformed files, the isolation boundary, and the CLI, on small synthetic fixtures built from the committed example.
- [x] The owner approved ADRs 0001 to 0005 (2026-10-26).
- [ ] A real Commerce Platform bundle copied into a fresh clone validates. A real bundle has validated read in place; the fresh-clone check needs this work committed.

Original scope:

- Decide, as ADRs, the open questions that block code: language and runtime, JSON Schema validator, local-first or not, and ground-truth isolation ([architecture](architecture.md#open-decisions)).
- Load a bundle directory and validate it against the vendored v1 schemas and the cross-file rules in the [consumer guide](contracts/incident-bundle/README.md), naming the file and field of each defect.
- Refuse unsupported major versions; accept unknown fields and unknown scenario or component names.
- Tests cover a valid bundle and each defect class, using fixtures that live in this repository.
- Done when a real Commerce Platform bundle copied into a fresh clone validates, with no reference to a Commerce Platform checkout.

## E2: Investigation backend

- Decide the AI model and provider, and the diagnosis format with its citations.
- From a bundle's manifest and telemetry only, produce a diagnosis: root-cause component, affected components, cited evidence, and recommended remediation.
- Handle incomplete evidence, such as truncated traces, explicitly.

## E3: Evaluation

- Decide the scoring method.
- Score diagnoses against `ground_truth.json` for each of Commerce Platform's scenarios, repeatably, and report per-scenario results.

## E4: Investigation UI

- Decide the UI stack.
- Show investigations, evidence, citations, recommendations, approval workflows and evaluation results (Commerce Platform [ADR 0004](adr/commerce-platform/0004-frontend-sequencing.md)).
