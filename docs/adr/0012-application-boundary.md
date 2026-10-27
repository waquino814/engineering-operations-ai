# 0012: Application boundary

- **Status:** **Partly accepted** (2026-10-27); amended the same day by the provider allowlist `fake` and `ollama` (ADR 0013). Where this record says `local` is blocked or that `fake` has no replies, read: `local` is now `ollama`, gated by local-only verification, and `fake` runs the labelled simulation. Accepted by the owner: the application layer and the `investigate` CLI as the first slice, uploads out of scope, one JSON file per run with no database. **Constrained by** the absolute no-spending policy below and the proposed provider allowlist in ADR 0013. **Server (section 6):** implemented locally on the owner's instruction for milestone E6b (2026-10-27). Sections 1 to 6 are implemented locally and uncommitted or committed locally only; CI is not verified. The local provider is not implemented.

> **Absolute no-additional-spending constraint:** No application path, configuration setting, provider selector, UI control, or command-line option may initiate a hosted AI request or incur additional AI-service charges. Only deterministic fake execution and verified local-only inference are permitted. If local-only operation cannot be verified, execution must fail closed.

- **Date:** 2026-10-27
- **Depends on (accepted):** [0002](0002-ai-provider-and-external-api-policy.md) (port; no calls in tests or CI; its opt-in external calls are superseded by the policy above), [0003](0003-ground-truth-isolation.md), [0005](0005-bundle-intake-and-validation.md) (local read-only directories; no upload or database), [0008](0008-model-provider-recommendation.md) (the hosted adapter, kept in the repository but unreachable from the application; superseded in part), [0010](0010-investigation-result-contract-v0.md), [0011](0011-investigation-ui-stack.md) (the `InvestigationDataSource` interface). Proposed companions: [0006](0006-investigation-pipeline-and-limits.md), [0007](0007-evidence-grounding-and-output-validation.md). Planning: [roadmap](../roadmap.md), E6.

## Context

Today the pipeline is a library: `runInvestigation(bundleDir, { provider, limits })` validates a bundle, opens the blinded view and returns a result (`src/pipeline/run-investigation.ts`). `selectProvider(env)` turns configuration into a provider and makes no request (`src/providers/select.ts`). The CLI only validates (`node src/cli.ts validate`). The console reads fixtures through `InvestigationDataSource` and answers "unavailable" to upload and start (`src/ui/data/types.ts`). Nothing reads the environment at startup, stores a result, lists runs or serves the UI.

The roadmap's E6 criterion is that an operator can validate a real bundle, start an investigation and see the result in the UI; under the no-spending policy the provider can only be `fake` or a verified `local` one, never a hosted one, so that wording is to be revised with the roadmap (E6). The boundary must make a hosted run impossible (section 4).

Constraints carried forward: ground truth, the validation report and bundle paths never reach the investigator (ADR 0003); bundles are local, read-only directories (ADR 0005); CI and tests use the fake provider and no network (ADR 0002); the investigation layer reads no environment and no filesystem (ADR 0006's boundary tests).

## Options considered

| Option                                                                                                                  | Fits E6's done criterion                                 | New attack and cost surface                           | Verdict                                                            |
| ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------ |
| A. Application core and CLI `investigate`, results kept as files; the UI reads fixtures only                            | Validates and investigates; the UI cannot show live runs | None beyond the CLI; no hosted run is possible        | Necessary first slice; not enough alone                            |
| B. A. plus a loopback HTTP adapter implementing `InvestigationDataSource` over the same core, serving the built console | Yes                                                      | A listening socket on the operator's machine          | Second slice; needs separate approval                              |
| C. A hosted service with accounts, uploads and a database                                                               | Yes, and more                                            | Network exposure, multi-user data, stored credentials | Rejected for E6: beyond the roadmap and ADR 0005; revisit after E7 |

## Decision (proposed)

### 1. One application core, two thin entry points

A new layer, `src/app/`, is the composition root. It owns everything that touches the outside world: environment, filesystem, provider construction, the run store. The CLI and the optional server are thin adapters over it. The investigator, selection, verification and the pipeline keep their current rules; the architecture tests gain `src/app/` as the only new place allowed to use `node:fs`, with the run store as the only module that writes.

The core exposes four operations, each returning data, not printing:

| Operation                      | Does                                                                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `listBundles()`                | Lists the bundles under the configured bundles directory (section 3).                                                                       |
| `validateBundle(bundleId)`     | Runs `validateBundle` and returns the operator-side report mapped to the console's `BundleValidation`; never stored with a result.          |
| `startInvestigation(bundleId)` | Validates, runs `runInvestigation` with the configured provider and limits, validates the result against its schema, stores it, returns it. |
| `listRuns()` / `getRun(id)`    | Reads stored results, each re-validated with `readInvestigationResult` on read.                                                             |

### 2. Configuration and startup

- The entry point (`src/cli.ts`, or the server's `main`) is the only code that reads `process.env`. It passes a plain object to the core. Everything else takes configuration as an argument, as `selectProvider` already does.
- Settings: the provider (`fake` or `local` only, ADR 0013), plus `EOAI_BUNDLES_DIR` and `EOAI_RUNS_DIR` (section 3). No hosted-provider setting and no credential is read by the runnable application. Settings are validated against a closed schema and never hold secrets. Limits keep `resolveLimits` and its bounds; no new override path is added in the first slice.
- **Startup validates configuration and constructs objects. It makes no network request.** Startup builds no network client and contacts nothing, including a local server: the first request of any kind happens only inside `startInvestigation` after a bundle has validated. Startup never lists models or checks any service. A test stubs `fetch` to throw and runs startup with each allowlisted provider selected (the pattern of `test/providers/select.test.ts`).
- A missing or malformed setting stops startup with a configuration error naming variables, never values. There is no fallback from a requested provider to another one.

### 3. Input and output

- **Input:** a bundle is a directory under `EOAI_BUNDLES_DIR`, chosen by an opaque id that is a single path segment of that directory. The core resolves it against the configured root and rejects separators, `..`, symlinks that leave the root and non-directories. No arbitrary path is accepted from the UI, and the CLI's `validate <dir>` keeps accepting a path because it never reaches a provider.
- **Uploads stay out of scope.** ADR 0005 is not amended. The console's `uploadBundle` keeps answering "unavailable". Revisit with E7 or later.
- **Output:** one JSON file per run in `EOAI_RUNS_DIR`, named from a UTC timestamp and the result's `caseId`, written to a temporary file and renamed, never inside a bundle directory (ADR 0005: read-only). The content is exactly the `InvestigationResult`, which already carries no path, validation report or ground truth. A file that fails `readInvestigationResult` is reported as unreadable and listed as such, never repaired. Run history is the directory listing; there is no database.
- **Not stored:** validation reports (they name the bundle directory, ADR 0003), the request sent to the model, and credentials. Whether to store request text for audit is not decided here.
- Bundle ids and labels are shown to the operator only. They may contain the scenario name (ADR 0003), so they are never written into a result or sent to the investigator.

### 4. The CLI: `investigate`

`node src/cli.ts investigate <bundle-id> [--json]`, beside `validate`.

- Exit codes: `0` a result was stored with outcome `completed` or `inconclusive`; `1` a result was stored with outcome `failed`, `budget_exceeded` or not admitted; `2` usage or configuration error, with no result and no request (`validate` already uses 2 for usage and contract errors).
- Output: the run id and a one-line summary (`summarize`) on stdout, errors on stderr, `--json` for the result. Ctrl-C aborts the run through `AbortSignal`; the investigator returns a result for the cancellation as it does today.
- **Provider gate.** The application layer holds an allowlist of exactly `fake` and `local`. Any other provider name, including `anthropic`, is refused with exit 2 before a bundle is read or any request made. The allowlist is code, not configuration: no flag, environment variable, setting or UI control adds to it, and the rejected `--confirm-billable` guard does not exist in any form. The provider gate is the application layer's own; `selectProvider` and the hosted adapter are not wired into it.
- **`fake`** is for deterministic tests, CI, fixtures and the synthetic evaluation. From the command line, `fake` has no scripted replies, so `investigate` explains that no runnable provider is configured instead of running it.
- **`local`** means verified local-only inference through the existing Ollama installation ([ADR 0013](0013-zero-spend-local-inference.md)). It is **blocked**: `investigate` refuses it until the local-only checks are implemented and tested. If local-only operation cannot be verified, the run does not start (fail closed).
- **Consequence:** in this slice `investigate` is exercised by tests through an injected provider. The value of the first slice is the tested core: bundle listing and validation, the run store, the provider gate, exit codes and error handling.

### 5. Cost bound

The application makes no hosted request, so it incurs no AI-service charge. The investigator's token ceiling (ADR 0006, default `maxTotalTokens` 816,000) still bounds a local run's work; no price or currency figure is part of this decision.

### 6. The loopback server — implemented locally (E6b), CI not verified

Built for E6b on the owner's instruction (2026-10-27). Differences from the sketch below are listed after it. `src/app/http-server.ts` adds an HTTP adapter over the same core, started by `node src/cli.ts serve` and serving the built console:

- Binds to `127.0.0.1` only; refuses any other `Host` header (against DNS rebinding); no CORS; state-changing requests accept only `application/json` and an `Origin` equal to the server's own. No authentication in this slice, because it is loopback and single-operator; exposing it beyond the machine is out of scope and would need a new ADR.
- Routes follow `InvestigationDataSource` one to one: `GET /api/bundles`, `GET /api/bundles/:id/validation`, `GET /api/investigations`, `GET /api/investigations/:id`, `POST /api/investigations` with `{ bundleId }`. Responses are the existing console types; results are the contract. `uploadBundle` has no route.
- `POST /api/investigations` goes through the same provider gate as the CLI (section 4): it cannot start a hosted run, and there is no flag. One run at a time; a second request while one is running is refused. Startup of the server never starts a run.
- Errors reach the console as `{ status: 'error', kind, message }` with HTTP status 400 for a bad request, 404 for an unknown id, 409 for a run already in progress and 500 for an unexpected failure. Provider failures are not HTTP errors: they are stored results with `outcome: 'failed'` and a failure class, which the console already renders.
- Tests use the core with the fake provider and an in-process server on an ephemeral loopback port; no external network, no credentials. The architecture test allows `node:http` in `src/app/http-server.ts` only.
- The console gets an HTTP implementation of `InvestigationDataSource` beside the fixture one. Fixtures remain the default build and the test source; the live source is selected explicitly when the server serves the console.

**As built (E6b)**, with the differences from the sketch above:

- Routes: `GET /healthz`, `GET /api/runs`, `GET /api/runs/:id`, `GET /api/bundles`, `GET /api/bundles/:id/validation`, `POST /api/investigations` (body exactly `{ "bundleId": string }`), and `GET` of the built console (`dist/ui`, read into memory at startup and served by exact path). Validation responses carry no directory path: messages are scrubbed of it and metadata is the blinded view's.
- The server is created through `createApplication`, so a refused provider or a bad configuration stops it before it listens. The provider gate is therefore the same for every request; `anthropic`, unknown values and `local` cannot start it.
- Status codes: 400 invalid request or id, 403 unexpected `Host` or cross-origin `Origin`, 404, 405, 413 (body over 16 KiB), 415, **429 `busy`** (not 409), **409 `no_runnable_provider`**, 500 `run_unreadable` or `internal_error`. Error bodies are `{ error: { code, message } }` with fixed messages.
- Listen host: `127.0.0.1` or `::1` (`localhost` is an alias for `127.0.0.1`); anything else throws before listening. Shutdown aborts a running investigation, lets in-flight requests answer for up to two seconds, then closes.
- The console's HTTP source (`src/ui/data/http-source.ts`) is the default; `VITE_EOAI_SOURCE=fixture` selects fixtures. Uploads are not supported. A refused start is shown as "nothing ran", and a failed one as an alert.
- Not claimed: the server has no authentication and relies on loopback binding plus Host and Origin checks; a local process on the same machine can still call it. With no runnable provider, nothing can be investigated end to end.

## Not decided here

- Hosted deployment, accounts, authentication, uploads, a database, a job queue, concurrency beyond one run, approval workflows and evaluation views (roadmap: after E6 or E7).
- Any hosted-provider evaluation: out of scope under the no-spending policy. A local-model evaluation is an E7 question (ADR 0013).

## Decisions for the owner

Decided on 2026-10-27:

1. **Approved:** the application layer in `src/app/` and the `investigate` CLI as the first E6 slice (sections 1 to 4).
2. **Policy:** zero additional spending, with no confirmation flag or override (the policy above). Provider allowlist `fake` and `local` (ADR 0013, proposed).
3. **Confirmed:** uploads stay out of scope; ADR 0005 is not amended.
4. **Confirmed:** one JSON file per run in `EOAI_RUNS_DIR`, no database.

Deferred:

5. The loopback HTTP server (section 6): the owner instructed its implementation (E6b, 2026-10-27). It is built and tested locally; CI is not verified.

## Acceptance before this is accepted

1. The owner decides items 1 to 5 (decided; item 5 by the E6b instruction).
2. Architecture tests are updated for `src/app/` (filesystem) and, if approved, `src/app/http-server.ts` (`node:http`), with the investigator's rules unchanged.
3. Tests cover: startup makes no request with each allowlisted provider selected; misconfiguration stops startup; `investigate` with `fake` and no scripted replies explains that no provider is runnable; every provider outside `fake` and `local` (`anthropic` included) is refused before any bundle is read or request made, with nothing that overrides it; `local` is refused until its checks exist; bundle ids cannot escape the bundles root; stored results round-trip through `readInvestigationResult`; no stored or returned result contains a path, validation report or answer value.
4. `pnpm check` passes locally and in CI, with no credentials and no network.

## Consequences

- **Positive:** configuration, provider construction and storage live in one place that is easy to test; no application path can spend money; the console's existing data-source interface needs no change.
- **Positive:** the first slice has no listening socket.
- **Negative:** a loopback server, if approved, is a new surface, small but real; loopback binding, Host and Origin checks and one-run-at-a-time are the mitigation.
- **Negative:** without a database, run history is a directory listing; fine for one operator, not for many.
