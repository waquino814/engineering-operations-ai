# Engineering Operations AI

An AI-powered engineering operations system that investigates operational incidents: it reads the evidence a running system produced, works out what broke, and recommends what to do about it.

Its first evidence source is [Commerce Platform](https://github.com/waquino814/commerce-platform), a separate project whose purpose is to produce realistic, reproducible incidents. Each incident arrives as an **incident bundle**: the traces, metrics and logs captured during a fault, plus a ground truth describing what actually broke.

## Status

**E1 in progress.** The first component, **bundle intake**, is implemented and tested: it validates incident bundles against the vendored contract (all nine rules) and opens a blinded evidence view that never reads the ground truth. See [docs/intake.md](docs/intake.md). Its architecture decisions, [ADRs 0001 to 0005](docs/adr/README.md), were **accepted** by the owner on 2026-10-26. There is no investigation, evaluation or UI code yet.

TypeScript on Node.js 24, with pnpm ([ADR 0001](docs/adr/0001-runtime-and-language.md)):

```sh
pnpm install
pnpm check                              # format, lint, typecheck, tests with coverage
pnpm validate-bundle <bundle-dir>       # validate a bundle; exit 0 valid, 1 invalid
```

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

| Document                                                                    | Content                                                                  |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| [docs/architecture.md](docs/architecture.md)                                | Intended system, its boundary with Commerce Platform, and open decisions |
| [docs/intake.md](docs/intake.md)                                            | The bundle intake module: interface, rules, commands, limitations        |
| [docs/roadmap.md](docs/roadmap.md)                                          | Milestones: the investigation backend first, the investigation UI after  |
| [docs/contracts/incident-bundle/](docs/contracts/incident-bundle/README.md) | The incident-bundle v1 contract: JSON Schema files and a consumer guide  |
| [docs/examples/](docs/examples/README.md)                                   | A genuine excerpt of a validated Commerce Platform bundle                |
| [docs/adr/](docs/adr/README.md)                                             | Decision records, including those transferred from Commerce Platform     |

## Getting incident bundles

Bundles are not committed to either repository (ADR 0007). To get one, run a scenario in a local Commerce Platform checkout, following its README: for example, `pnpm incident run --scenario provider-outage --seed 42` writes `incidents/provider-outage-42-<timestamp>/`. Copy that directory wherever this project reads its input; nothing here depends on where Commerce Platform is checked out.

## Provenance

Material transferred from Commerce Platform was copied from <https://github.com/waquino814/commerce-platform> at commit `93ad2131255eed89baa4d3ba67cbf649a49925ee` on 2026-10-26. Each copied file is listed, with its original path and SHA-256, next to it: [docs/adr/README.md](docs/adr/README.md), [docs/contracts/incident-bundle/README.md](docs/contracts/incident-bundle/README.md) and [docs/examples/README.md](docs/examples/README.md).
