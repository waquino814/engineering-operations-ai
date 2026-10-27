# Testing

## Policy

**Every new feature or bug fix must ship with automated tests in the same change.** A bug fix includes a test that fails without the fix. Coverage thresholds are never lowered to make a change pass; if code is hard to cover, make it testable (as `src/evaluation/cli.ts` exposes `main` and `isEntryPoint`).

## Commands

```sh
pnpm check            # format, lint, typecheck, tests with coverage: what CI runs
pnpm test             # tests only
pnpm test:coverage    # tests with per-file coverage thresholds
pnpm eval:synthetic   # the synthetic evaluation report, on stdout
pnpm eval:suite all   # the versioned suites with a pass/fail gate (see docs/evaluation.md)
pnpm eval:readiness <bundle-dir> [--for development|held-out]   # is a bundle fit to evaluate with
```

## Coverage guard

[`vitest.config.ts`](../vitest.config.ts) measures every file under `src/**/*.ts`, including files no test imports, and applies the thresholds **per file**: 90% of lines and 80% of branches. A new source file without tests therefore reports 0% and fails `pnpm test:coverage`, and so `pnpm check` and CI.

This was demonstrated on 2026-10-26 by adding an untested `src/investigation/untested-feature.ts`. The run exited 1:

```
ERROR: Coverage for lines (0%) does not meet global threshold (90%) for src/investigation/untested-feature.ts
```

The file was then removed.

## Test layers

| Layer               | Files                                                                                                                     | What it proves                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contract and intake | `contract.test.ts`, `validate-bundle.test.ts`, `unsupported-version.test.ts`, `cli.test.ts`                               | the nine bundle rules, positive and negative; the CLI                                                                                                                                                                                                                                                                                                                              |
| Isolation           | `ground-truth-isolation.test.ts`                                                                                          | the evidence view never reads the answer key or carries excluded fields ([ADR 0003](adr/0003-ground-truth-isolation.md))                                                                                                                                                                                                                                                           |
| Architecture        | `architecture.test.ts`                                                                                                    | module boundaries, no network or provider SDK, the allowed runtime dependencies ([ADR 0006](adr/0006-investigation-pipeline-and-limits.md))                                                                                                                                                                                                                                        |
| Investigation units | `investigation/*.test.ts`                                                                                                 | limits validation, token accounting (`usage.test.ts`), strict parsing, reference verification including records not sent, selection, failure sanitising, the investigator's control flow and token budget                                                                                                                                                                          |
| Result contract     | `investigation/result-contract.test.ts`, `investigation/schemas.test.ts`                                                  | every result state valid in code and in the published schema; malformed combinations, unsupported versions and unsupportable verification claims rejected; schema files match the code ([ADR 0010](adr/0010-investigation-result-contract-v0.md))                                                                                                                                  |
| Pipeline            | `pipeline/run-investigation.test.ts`, `pipeline/leakage.test.ts`                                                          | admission, blinding and what reaches the model; canary values in every excluded field never reach a request, result or summary on any path                                                                                                                                                                                                                                         |
| Evaluation          | `evaluation/harness.test.ts`, `evaluation/leakage.test.ts`, `evaluation/suite-cli.test.ts`                                | scoring, leak detection (a positive control per match type, a recorded paraphrase limit), the golden report, the CLI                                                                                                                                                                                                                                                               |
| Gate and inputs     | `evaluation/gate.test.ts`, `evaluation/suite-cli.test.ts`, `evaluation/relations.test.ts`, `evaluation/readiness.test.ts` | each integrity and regression finding on a tampered copy of a real suite run (missing or unexpected cases, inconsistent reports, unconfirmed citations, worse metrics, split moves, unusable baselines); the component-evidence relation; evaluation-input readiness                                                                                                               |
| Operational events  | `app/events.test.ts`                                                                                                      | what each event carries and never carries, a throwing sink changes nothing, the opt-in `serve --events stderr` stream                                                                                                                                                                                                                                                              |
| Console             | `ui/*.test.ts(x)`                                                                                                         | fixtures regenerate byte for byte, pass the result contract and the published schema, cover every state, and carry no answer text; the data source; view-model derivations; each screen and state (loading, empty, error, validation error, the four outcomes and not admitted), navigation and primary interactions, under jsdom ([ADR 0011](adr/0011-investigation-ui-stack.md)) |

## Rules for tests

- **No network, no credentials, no cost.** Model behaviour comes from `FakeProvider`, which replays scripted replies, errors or hangs, and records each request. Investigator tests replace the global `fetch` with a function that throws, so an accidental call fails loudly.
- **Deterministic time.** The investigator takes `now` and `sleep`; tests inject them, or use Vitest's fake timers for timeouts and backoff. No test waits on a real clock.
- **Small fixtures, built in the repository.** Bundles are made from the committed excerpt ([docs/examples/](examples/README.md)) by `test/support.ts`, or written by `src/evaluation/synthetic.ts`, in temporary directories. No test reads a Commerce Platform checkout or a real incident run.
- **Golden files** live in `test/golden/`, are excluded from Prettier, and are compared byte for byte. To update one deliberately, regenerate it with `pnpm eval:synthetic > test/golden/synthetic-evaluation.json` and review the diff.
- **Sabotage-check new guards.** When adding a test that guards a boundary, break the boundary once locally and confirm the test fails, and confirm the break really reached the code path (one 2026-10-26 sabotage first edited a size estimate instead of the request, and passed for that reason). Done so far:
  - E2 foundation: a `node:fs` import in investigation, a verifier that skipped identity checks, a scenario name in selection, unlimited repairs;
  - E7 gate (2026-10-27): the citation re-read check, the metric-regression rule, the missing-case rule and the split-move rule were each disabled once; the matching tests failed each time;
  - review hardening (2026-10-26): a verifier ignoring which records were sent, a bundle path in a failure message, unreported usage charged as zero, a schema allowing a semantic-support claim, a dynamic import of scoring code in the investigator, a fault timestamp in the request.
- **Fake usage is explicit.** A `FakeProvider` step has usage only if the test gives it one; without it, the call is charged at its ceiling, as an unreported real call would be.
