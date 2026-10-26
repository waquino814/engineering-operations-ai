# Decision records

## This repository's ADRs

None yet. This project's own decisions go here as `NNNN-title.md`, numbered from 0001. The [architecture's open decisions](../architecture.md#open-decisions) are the first candidates.

## Transferred from Commerce Platform

[`commerce-platform/`](commerce-platform/) holds verbatim copies of the Commerce Platform decision records that define this project's boundary. They keep their original numbers and text, so they are **Commerce Platform's decisions, not this repository's**. Paths they mention, such as `packages/incident-bundle` or `docs/prompts/m5-design.md`, refer to the Commerce Platform repository. A change to one of them happens upstream first, then is copied here.

Source: <https://github.com/waquino814/commerce-platform>, commit `93ad2131255eed89baa4d3ba67cbf649a49925ee`, copied 2026-10-26.

| ADR | Status upstream | Why it is here | Original path | SHA-256 |
| --- | --- | --- | --- | --- |
| [0001 Local-first architecture](commerce-platform/0001-local-first-architecture.md) | Accepted | Why Commerce Platform's incidents are local and reproducible. Its "no LLM calls" rule binds Commerce Platform only. | `docs/decisions/0001-local-first-architecture.md` | `49912f67156e6741c31ee5855a5d5ec1c13874e31056de3a9a9a3dbb93d5c97b` |
| [0004 Frontend sequencing and API-first design](commerce-platform/0004-frontend-sequencing.md) | Accepted; its sequencing would be superseded by ADR 0008 once accepted | Describes this project's UI: investigations, evidence, citations, recommendations, approval workflows and evaluation results. | `docs/decisions/0004-frontend-sequencing.md` | `3214026962a23ee105b211514d5764f6352080ff4c9e81f1d84e3963ffd7ab3c` |
| [0007 Incident bundle schema version 1](commerce-platform/0007-incident-bundle-schema-v1.md) | **Accepted** | The contract between the two repositories. | `docs/decisions/0007-incident-bundle-schema-v1.md` | `64aec1bd1d765f2d874a584f5e4c4c62a38d476f0ccce30122d1e0c55fada1ad` |
| [0008 Project order across the portfolio](commerce-platform/0008-project-order.md) | **Proposed, not approved** | Places this repository's backend and UI after Commerce Platform's UI. | `docs/decisions/0008-project-order.md` | `45636703fafd00bbc78912df43926e2403b81633c0d9114907729746fb60ef21` |

Not transferred, because they concern only Commerce Platform's internals: 0002 (order status as work queue), 0003 (plain SQL migrations), 0005 (order processing protocol) and 0006 (request-plan determinism).
