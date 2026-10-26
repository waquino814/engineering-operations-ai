# 0001: Runtime and language

- **Status:** Accepted (2026-10-26), approved by the repository owner after the E1 review.
- **Date:** 2026-10-26

## Context

E1 needs a first component, bundle intake, that validates JSON documents and JSON Lines files against the vendored JSON Schema draft 2020-12 files ([contract](../contracts/incident-bundle/README.md)), hashes files, and reports structured errors. Later milestones add an AI investigation backend (E2), evaluation (E3) and an investigation UI (E4). No source document chooses a language; this repository must be buildable on its own, without Commerce Platform's code or workspace (Commerce Platform [ADR 0007](commerce-platform/0007-incident-bundle-schema-v1.md)).

Requirements that bear on the choice:

- A reliable draft 2020-12 JSON Schema validator, since the vendored schemas are the contract.
- Strong static types for the bundle and result contracts.
- Fast, deterministic tests with no services.
- A credible path to calling AI model APIs (E2) and to a web UI (E4).
- One maintainer, who already works in TypeScript on Node.js in Commerce Platform.

## Options considered

| Option                       | For                                                                                                                                                                                                                                                                                                          | Against                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| **TypeScript on Node.js 24** | Ajv is a mature, widely used draft 2020-12 validator. Strict types. Official TypeScript SDKs exist for the major model providers. One language for backend and UI. Node 24 runs TypeScript directly (type stripping), so no build step is needed for a library and CLI. The maintainer's existing toolchain. | The AI and data tooling ecosystem is smaller than Python's.                                                  |
| Python 3.12+                 | The largest AI and evaluation ecosystem; `jsonschema` supports 2020-12; pydantic for typed models.                                                                                                                                                                                                           | A second language for the UI. Typing is optional and checked separately. A new toolchain for the maintainer. |
| Go                           | Simple deployment, strong concurrency.                                                                                                                                                                                                                                                                       | Weaker JSON Schema 2020-12 options; more code for dynamic JSON; small AI SDK ecosystem.                      |

## Decision

- **Language:** TypeScript, `strict`, with `erasableSyntaxOnly` so every file runs under Node's type stripping.
- **Runtime:** Node.js 24 LTS (`.nvmrc`), ES modules. Source runs directly with `node`; `tsc` type-checks only (`noEmit`). There is no build output.
- **Package manager:** pnpm 12, pinned in `packageManager`. Dependencies are pinned to exact versions with a committed lockfile, and added only when needed.
- **JSON Schema:** Ajv 8 (`ajv/dist/2020`) with `ajv-formats`, the only runtime dependencies of E1.
- **Quality gates:** Vitest for tests and coverage, ESLint with `typescript-eslint` (strict, type-checked), Prettier. `pnpm check` runs them all.

## Consequences

- **Positive:** schema validation uses a standard validator over the vendored files, not a reimplementation. The same tooling serves E2 to E4.
- **Positive:** no build step: the CLI and tests run the TypeScript source directly.
- **Negative:** Python-only AI or evaluation libraries would need a separate process or a port. E2 should check this before choosing a provider SDK (ADR 0002).
- **Negative:** type stripping forbids TypeScript-only runtime syntax such as `enum` and parameter properties; `erasableSyntaxOnly` makes the compiler enforce that.
- **Revisit if:** E2 or E3 needs a library that only exists for Python, or the maintainer prefers a different stack before E2 starts.
