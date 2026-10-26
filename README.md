# Engineering Operations AI

An AI-powered engineering operations system that investigates operational incidents: it reads the evidence a running system produced, works out what broke, and recommends what to do about it.

Its first evidence source is [Commerce Platform](https://github.com/waquino814/commerce-platform), a separate project whose purpose is to produce realistic, reproducible incidents. Each incident arrives as an **incident bundle**: the traces, metrics and logs captured during a fault, plus a ground truth describing what actually broke.

## Status

**E1 complete; the E2/E3 foundation is in progress.**

- **Bundle intake** (E1) validates incident bundles against the vendored contract (all nine rules) and opens a blinded evidence view that never reads the ground truth ([docs/intake.md](docs/intake.md)). [ADRs 0001 to 0005](docs/adr/README.md) were **accepted** by the owner on 2026-10-26.
- **The investigation workflow** (E2 foundation) runs end to end against a deterministic fake model: admission, blinding, evidence selection, one bounded model request, strict output validation, evidence-reference verification, bounded repair and retries, and a schema-checked result. **No real model provider is integrated**, so no real diagnosis has been produced.
- **The evaluation harness** (E3 foundation) scores results against the ground truth behind a separate boundary, checks every model request for answer leaks, and produces a deterministic report from eight synthetic cases ([docs/evaluation.md](docs/evaluation.md)).
- Their decisions, [ADRs 0006 to 0010](docs/adr/README.md), are **proposed**, not approved; ADR 0010 includes an amendment to accepted ADR 0004 that the code already follows. There is no UI code.

TypeScript on Node.js 24, with pnpm ([ADR 0001](docs/adr/0001-runtime-and-language.md)):

```sh
pnpm install
pnpm check                              # format, lint, typecheck, tests with coverage
pnpm validate-bundle <bundle-dir>       # validate a bundle; exit 0 valid, 1 invalid
pnpm eval:synthetic                     # synthetic evaluation report; exit 1 on an answer leak
```

## How an investigation runs

```
bundle dir ─▶ validateBundle ─▶ openEvidence ─▶ selectEvidence ─▶ ModelProvider ─▶ parse + verify ─▶ result
 (pipeline)    (reads answer     (blinded view,   (deterministic,   (fake in tests;  (repair once if
               key; report       no path, no      bounded)          no real adapter  invalid)
               stays here)       answer key)                        yet)
                                                                                     evaluation reads the
                                                                                     answer key afterwards
```

| Module                                     | Role                                                                                     |
| ------------------------------------------ | ---------------------------------------------------------------------------------------- |
| [`src/intake/`](src/intake/)               | bundle validation and the blinded evidence view                                          |
| [`src/pipeline/`](src/pipeline/)           | `runInvestigation(bundleDir, options)`: admission, then the investigator                 |
| [`src/investigation/`](src/investigation/) | limits, model port and fake, selection, request, parsing, verification, the investigator |
| [`src/evaluation/`](src/evaluation/)       | answer key, scoring, the harness, synthetic cases (package entry `./evaluation`)         |

See [docs/architecture.md](docs/architecture.md) for the boundaries and the data flow, and [docs/testing.md](docs/testing.md) for the testing policy: every feature or fix ships with tests in the same change.

## Continuous integration

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs the quality gates on every pull request to `main`, every push to `main`, and on demand (`workflow_dispatch`). It installs the pinned toolchain (Node.js from `.nvmrc`, pnpm from `packageManager`), installs dependencies from the committed lockfile, and runs `pnpm check`: formatting, lint, typecheck, and the tests with their coverage thresholds. It needs only this repository: no Commerce Platform checkout, service, secret or AI provider. Its token can only read the repository.

To reproduce it locally from a clean clone:

```sh
pnpm install --frozen-lockfile
pnpm check
```

## Boundaries

- **Independent repository.** Its own dependencies, build, tests, CI and releases. It never imports Commerce Platform's code, packages or build output, and never reaches outside its own directory.
- **One contract.** The only interface with Commerce Platform is the incident bundle, schema version 1, defined by Commerce Platform's [ADR 0007](docs/adr/commerce-platform/0007-incident-bundle-schema-v1.md). This repository keeps a pinned copy of that contract in [docs/contracts/incident-bundle/](docs/contracts/incident-bundle/README.md).
- **Evidence in, conclusions out.** It reads bundles as files. It does not query Commerce Platform's database, call its APIs, or start its fault scenarios.

## Documentation

| Document                                                                        | Content                                                                  |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| [docs/architecture.md](docs/architecture.md)                                    | Intended system, its boundary with Commerce Platform, and open decisions |
| [docs/intake.md](docs/intake.md)                                                | The bundle intake module: interface, rules, commands, limitations        |
| [docs/testing.md](docs/testing.md)                                              | Testing policy, coverage guard, test layers, fakes                       |
| [docs/evaluation.md](docs/evaluation.md)                                        | Evaluation harness, scoring v0, synthetic cases, holdout strategy        |
| [docs/contracts/investigation-result/](docs/contracts/investigation-result/v0/) | The investigation result and model-output JSON Schemas, v0.1.0           |
| [docs/roadmap.md](docs/roadmap.md)                                              | Milestones: the investigation backend first, the investigation UI after  |
| [docs/contracts/incident-bundle/](docs/contracts/incident-bundle/README.md)     | The incident-bundle v1 contract: JSON Schema files and a consumer guide  |
| [docs/examples/](docs/examples/README.md)                                       | A genuine excerpt of a validated Commerce Platform bundle                |
| [docs/adr/](docs/adr/README.md)                                                 | Decision records, including those transferred from Commerce Platform     |

## Getting incident bundles

Bundles are not committed to either repository (ADR 0007). To get one, run a scenario in a local Commerce Platform checkout, following its README: for example, `pnpm incident run --scenario provider-outage --seed 42` writes `incidents/provider-outage-42-<timestamp>/`. Copy that directory wherever this project reads its input; nothing here depends on where Commerce Platform is checked out.

## Provenance

Material transferred from Commerce Platform was copied from <https://github.com/waquino814/commerce-platform> at commit `93ad2131255eed89baa4d3ba67cbf649a49925ee` on 2026-10-26. Each copied file is listed, with its original path and SHA-256, next to it: [docs/adr/README.md](docs/adr/README.md), [docs/contracts/incident-bundle/README.md](docs/contracts/incident-bundle/README.md) and [docs/examples/README.md](docs/examples/README.md).
