# Documentation index

Start with the [project README](../README.md) for what the project is, what is simulated, and how to run it.

## Understand the system

| Document                                                     | Read it for                                                                                                                 |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| [architecture.md](architecture.md)                           | Goal, boundary with Commerce Platform, components, runtime view and ports, persistence, security boundaries, open decisions |
| [commerce-platform-handoff.md](commerce-platform-handoff.md) | The incident-bundle contract, the five scenarios, the supported procedure, and what was verified                            |
| [providers-and-safety.md](providers-and-safety.md)           | Scripted vs simulated vs real local inference, the fail-closed local-only gate, unresolved owner decisions                  |
| [intake.md](intake.md)                                       | Bundle validation (nine rules), the blinded evidence view, commands                                                         |
| [evaluation.md](evaluation.md)                               | Scoring v0.1, suites, the development / held-out split, leak detection, `pnpm eval:*`                                       |

## Use and verify it

| Document                           | Read it for                                                                  |
| ---------------------------------- | ---------------------------------------------------------------------------- |
| [ui-visual-qa.md](ui-visual-qa.md) | Every console route and state, the screenshot index, defects found and fixed |
| [testing.md](testing.md)           | Testing policy, the per-file coverage guard, test layers, fakes              |
| [roadmap.md](roadmap.md)           | Milestone status (the source of truth), acceptance criteria, what is blocked |

## Decisions and contracts

| Location                                                                    | Content                                                                                                                                             |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| [adr/](adr/README.md)                                                       | This repository's ADRs 0001 to 0013 with their status (some are **proposed** or **partly accepted**), and the transferred Commerce Platform records |
| [contracts/incident-bundle/](contracts/incident-bundle/README.md)           | The pinned incident-bundle v1 schemas and consumer guide                                                                                            |
| [contracts/investigation-result/](contracts/investigation-result/README.md) | The result and model-output JSON Schemas, v0.1.0                                                                                                    |
| [examples/](examples/README.md)                                             | A genuine excerpt of a validated Commerce Platform bundle (an excerpt, not a complete bundle)                                                       |
| [images/](images/)                                                          | Console screenshots, indexed in [ui-visual-qa.md](ui-visual-qa.md)                                                                                  |

## Reading order for a new engineer

1. README, then [architecture.md](architecture.md).
2. Run `pnpm demo:seed && pnpm dev`, and click through with the Fake provider.
3. [providers-and-safety.md](providers-and-safety.md) before enabling any model.
4. [roadmap.md](roadmap.md) to see what is done, in progress and blocked.
