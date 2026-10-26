# 0011: Investigation UI stack

- **Status:** Accepted (2026-10-26), approved by the repository owner: React 19, Vite and plain CSS for the standalone investigation console. The owner accepted it after reviewing the implemented console, as the best fit with ADR 0001's single TypeScript stack, the existing Vitest toolchain (which already brings Vite) and the smallest runtime footprint that still suits a dense, stateful console.
- **History:** proposed 2026-10-26 with the E4 implementation; accepted 2026-10-26.
- **Date:** 2026-10-26
- **Depends on (accepted):** [0001](0001-runtime-and-language.md) (TypeScript, pnpm, exact pins, Vitest, ESLint, Prettier; "a credible path to a web UI (E4)"), [0002](0002-ai-provider-and-external-api-policy.md) (no credentials or external calls in tests and CI), [0003](0003-ground-truth-isolation.md), [0004](0004-investigation-result-contract.md) as amended by [0010](0010-investigation-result-contract-v0.md) (the result the UI renders). Planning: [roadmap](../roadmap.md), E4.

## Context

E4 builds an operator console for investigations before any real provider exists (owner decision, 2026-10-26). It renders the investigation-result contract from deterministic fixtures produced by the real pipeline, and has no application or API boundary yet (E6). The console is dense, interactive and stateful: tables, a validation workflow, a detail workspace with findings, evidence, verification and token usage, and loading, empty, error and outcome states.

The choice is constrained by the repository:

- One language, TypeScript, already strict and type-checked, and one maintainer. Commerce Platform [ADR 0004](commerce-platform/0004-frontend-sequencing.md), accepted upstream, says both repositories "will eventually have a React UI"; that is an input here, not a decision.
- Vitest 5, which already brings Vite 8 into the lockfile as a dependency of the test runner.
- Exact pins and minimal dependencies (ADR 0001); a guard test allows only `ajv` and `ajv-formats` at runtime.
- No build step for the library and CLI (ADR 0001): Node runs the TypeScript directly.

## Options considered

| Option                                           | Maintainability                                                                 | Accessibility                                                    | Testing                                                               | Footprint                                             | Fit                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------- |
| **React 19, plain CSS, Vite** (chosen)           | Components and typed props over the contract types; the most widely known model | Semantic HTML; mature practices; Testing Library queries by role | Testing Library + jsdom under the existing Vitest; no new test runner | `react`, `react-dom` at runtime; Vite already present | TSX is plain TypeScript; matches Commerce Platform's direction |
| Preact                                           | Same model, smaller runtime                                                     | Same as React                                                    | Testing Library supports it                                           | smaller; adds a compatibility layer for React tooling | Fewer maintainers and examples; the size gain is not needed    |
| Svelte or Vue                                    | Good, but single-file components need their own compiler and lint tooling       | Good                                                             | Their own testing libraries                                           | compiler, Vite plugin, ESLint plugin                  | A second component language beside TypeScript                  |
| Web components (Lit) or vanilla TypeScript + DOM | Manual state and rendering for a dense, stateful console                        | Possible, but every pattern is hand-built                        | Testable with jsdom, more code to test                                | smallest                                              | Hand-rolled rendering is the largest maintenance cost          |
| Server-rendered HTML from Node                   | Simple pages                                                                    | Good                                                             | Needs an HTTP server                                                  | an HTTP server and templates                          | Requires the application boundary E6 has not decided           |

## Decision

- **React 19** (`react`, `react-dom`), function components and hooks, TypeScript `.tsx` with the automatic JSX runtime. No state-management, router or component library: state is local, routing is a small hash router (`#/investigations`, `#/investigations/<id>`, `#/new`, `#/settings`), and components are written for this console.
- **Styling:** one plain CSS file with custom properties for the dark theme: charcoal and slate surfaces, restrained blue accents, status colours that always come with text. No CSS framework.
- **TypeScript:** the one existing configuration gains `jsx: react-jsx`, the DOM libraries and JSON modules; a separate browser configuration would still need Node's types, because the console imports the result reader. Guard tests, not the compiler, keep Node modules out of the console.
- **Build:** Vite, pinned at the version Vitest already uses, with no plugins: its built-in transform handles TSX. `pnpm ui:dev` serves the console; `pnpm ui:build` writes `dist/ui/` (ignored by Git). This build applies only to the UI; the library and CLI still run without one.
- **Tests:** Vitest, as today, with `@testing-library/react` and `@testing-library/dom` and a `jsdom` environment for UI test files only. No user-event, jest-dom or accessibility plugin: Testing Library's role and label queries and plain assertions cover what E4 tests.
- **Data:** the UI talks only to a typed `InvestigationDataSource` interface (`src/ui/data/types.ts`). In E4 its one implementation (`createFixtureSource`) reads committed fixture JSON, `src/ui/fixtures/fixtures.json`, validating every result with `readInvestigationResult`; operations that need a backend (upload, start) answer `unavailable` with the reason. The fixtures are generated by `pnpm fixtures:ui` (`src/evaluation/ui-fixtures.ts`, beside the other synthetic fixtures): the real pipeline with the fake provider over the synthetic bundles, and the real `validateBundle` with paths removed. E6 adds an implementation for the real application boundary behind the same interface.

**Dependencies added**, all pinned exactly, each released at least two weeks before 2026-10-26: `react` and `react-dom` 19.3.0 (runtime); `@types/react` and `@types/react-dom` 19.3.0, `@testing-library/react` 16.3.3, `@testing-library/dom` 10.4.2, `jsdom` 30.1.2 and `vite` 8.3.5 (development).

**Guard tests that change, and why:**

- The runtime dependency allowlist (`test/architecture.test.ts`) adds exactly `react` and `react-dom`. The ban on provider SDKs is unchanged.
- New guards for `src/ui/`: it imports no Node module, no intake, pipeline or evaluation code at runtime (types only), no `fetch`, and never names the answer file. It may import the result contract's reader and types and the default limits.
- The source scanners in `test/architecture.test.ts` and `test/ground-truth-isolation.test.ts` read `.tsx` as well as `.ts`. Before this, every boundary rule would have skipped the console.
- The fixture generator joins two lists: the files that touch the filesystem, and the importers of contract validation (it validates its fixture bundles). It never reads the answer key; a test checks its source.
- Coverage covers `src/**/*.{ts,tsx}` with the same per-file thresholds; the test include pattern adds `.tsx`.
- `pnpm check` adds `pnpm ui:build`, so CI proves the console bundles.

Everything else, including the investigator's isolation rules, the network ban and the golden evaluation report, is unchanged.

## Implications

- **Security and privacy:** the console holds no credentials and makes no network request; it renders contract-valid results and validation reports only. Fixtures contain no ground truth or scores, and show the blinded manifest view rather than scenario-bearing manifest fields.
- **Accessibility:** semantic landmarks, headings, labelled controls, keyboard-operable navigation and tables, text on every status, WCAG AA contrast as a design rule. There is no automated contrast checker; contrast is checked by design review.
- **Reliability:** the data-source boundary validates every result before rendering; an invalid one becomes an error state, not a broken page.
- **Cost:** a build step for the UI only, and seven new packages, two at runtime.

## Acceptance criteria

1. ~~The owner accepts this ADR~~: accepted 2026-10-26.
2. `pnpm check`, including the UI tests, coverage and `pnpm ui:build`, passes locally and in GitHub Actions.
3. The guard changes are exactly those listed above.

## Consequences

- **Positive:** the console is written in the repository's one language, tested with the existing runner, and reuses the contract types and reader directly.
- **Negative:** a UI build step and a browser-oriented TypeScript configuration beside the Node one.
- **Negative:** without a router or component library, more UI code is written here; acceptable for four views.
- **Revisit if:** E6's application boundary favours server rendering, or the console grows beyond what a hash router serves.
