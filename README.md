# Engineering Operations AI

An AI-powered engineering operations system that investigates operational incidents: it reads the evidence a running system produced, works out what broke, and recommends what to do about it.

Its first evidence source is [Commerce Platform](https://github.com/waquino814/commerce-platform), a separate project whose purpose is to produce realistic, reproducible incidents. Each incident arrives as an **incident bundle**: the traces, metrics and logs captured during a fault, plus a ground truth describing what actually broke.

## Status

**Foundation only.** This repository holds the project's documentation and the incident-bundle contract it consumes. There is no application code yet, and no technology has been chosen. The next step is the first milestone in [docs/roadmap.md](docs/roadmap.md).

## Boundaries

- **Independent repository.** Its own dependencies, build, tests, CI and releases. It never imports Commerce Platform's code, packages or build output, and never reaches outside its own directory.
- **One contract.** The only interface with Commerce Platform is the incident bundle, schema version 1, defined by Commerce Platform's [ADR 0007](docs/adr/commerce-platform/0007-incident-bundle-schema-v1.md). This repository keeps a pinned copy of that contract in [docs/contracts/incident-bundle/](docs/contracts/incident-bundle/README.md).
- **Evidence in, conclusions out.** It reads bundles as files. It does not query Commerce Platform's database, call its APIs, or start its fault scenarios.

## Documentation

| Document                                                             | Content                                                                    |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| [docs/architecture.md](docs/architecture.md)                         | Intended system, its boundary with Commerce Platform, and open decisions    |
| [docs/roadmap.md](docs/roadmap.md)                                   | Milestones: the investigation backend first, the investigation UI after     |
| [docs/contracts/incident-bundle/](docs/contracts/incident-bundle/README.md) | The incident-bundle v1 contract: JSON Schema files and a consumer guide |
| [docs/examples/](docs/examples/README.md)                            | A genuine excerpt of a validated Commerce Platform bundle                   |
| [docs/adr/](docs/adr/README.md)                                      | Decision records, including those transferred from Commerce Platform        |

## Getting incident bundles

Bundles are not committed to either repository (ADR 0007). To get one, run a scenario in a local Commerce Platform checkout, following its README: for example, `pnpm incident run --scenario provider-outage --seed 42` writes `incidents/provider-outage-42-<timestamp>/`. Copy that directory wherever this project reads its input; nothing here depends on where Commerce Platform is checked out.

## Provenance

Material transferred from Commerce Platform was copied from <https://github.com/waquino814/commerce-platform> at commit `93ad2131255eed89baa4d3ba67cbf649a49925ee` on 2026-10-26. Each copied file is listed, with its original path and SHA-256, next to it: [docs/adr/README.md](docs/adr/README.md), [docs/contracts/incident-bundle/README.md](docs/contracts/incident-bundle/README.md) and [docs/examples/README.md](docs/examples/README.md).
