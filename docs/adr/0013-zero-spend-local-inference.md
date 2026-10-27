# 0013: Zero-spend local inference

- **Status:** **Partly accepted by the owner's instruction** (2026-10-27): the `fake` and `ollama` providers and their selection are implemented (see "Implementation record"). The rest is the original proposal, written under the owner's absolute no-spending policy; where the two differ the record governs. No local-only guarantee is proven; every enforcement claim below is a design to be verified by tests, and the feature stays **blocked** until it is. Decisions that need the owner are listed in "Decisions and gaps".
- **Date:** 2026-10-27
- **Depends on (accepted):** [0002](0002-ai-provider-and-external-api-policy.md) (provider-neutral port, no AI calls in tests or CI), [0003](0003-ground-truth-isolation.md), [0005](0005-bundle-intake-and-validation.md), [0008](0008-model-provider-recommendation.md) (hosted adapter; see "Relation to ADR 0008"). Partly accepted: [0012](0012-application-boundary.md) (application layer, `investigate` CLI, no billable run). Planning: [roadmap](../roadmap.md), E5 to E7.

> **Absolute no-additional-spending constraint:** No application path, configuration setting, provider selector, UI control, or command-line option may initiate a hosted AI request or incur additional AI-service charges. Only deterministic fake execution and verified local-only inference are permitted. If local-only operation cannot be verified, execution must fail closed.

## Implementation record (2026-10-27, owner instruction)

The owner instructed that Settings offer `Fake` and `Ollama`, and that Ollama run against the model already installed on this machine. This section records what was built. Where it differs from the proposal below, this section governs. The proposal text is kept as history.

- **Allowlist:** `fake` and `ollama` (the name `local` is retired and now refused like any unknown name). Hosted providers stay unreachable: nothing in `src/app/`, `src/cli.ts`, the server or the console imports `src/providers/anthropic/` or `src/providers/select.ts`, enforced by `test/architecture.test.ts`.
- **Selection:** a closed `settings.json` in the data directory (`{version, provider, ollamaModel}`), validated on read and write, written atomically with mode 0600, no secret and no URL. `PUT /api/settings` validates on the server; `EOAI_MODEL_PROVIDER` pins the choice and the page then cannot change it. The provider is built per run from the saved selection, so changing it changes the backend path.
- **Fake:** `SimulatedProvider` (`src/investigation/simulated-provider.ts`) produces a deterministic, verified-by-the-investigator placeholder: one `symptom` finding, `low` confidence, citing the first record of each file the request carried, with `SIMULATED` in every field it writes. It is shown as "Simulated" in the console and stored as provider `fake`, model `simulated-deterministic-v1`.
- **Ollama:** `src/providers/ollama/`. The endpoint must be `http` on a loopback address (default `http://127.0.0.1:11434`, `EOAI_OLLAMA_URL` to change), redirects refused, only `/api/tags`, `/api/show` and `/api/chat` reachable. `verifyLocalModel` runs before every investigation: the model must be installed, have weights of at least 10 MB in `/api/tags`, carry only known fields in both `/api/tags` and `/api/show` (an unknown or remote-looking field blocks it), and not be named like a cloud model. A model that fails stays selectable but is reported blocked, and no prompt is sent. Models are never pulled; discovery only reads the model list.
- **The runtime's cloud setting (added 2026-10-27, after the first real run):** `GET /api/status` on Ollama 0.40.11 reports `{"cloud":{"disabled":bool,"source":string}}`. The check reads it first and requires `disabled: true`; a runtime that reports it enabled, does not report it, or reports a shape with any unknown field is blocked before any prompt, with the setting to change (`OLLAMA_NO_CLOUD=1`, or `"disable_ollama_cloud": true` in `~/.ollama/server.json`) and a restart of Ollama, which the application never does. On the development machine it reports `disabled: false`, so real inference is blocked there. **What this establishes and what it does not:** it is the runtime's own report of its own setting, read once per investigation; it is not proof about the runtime's code or network behaviour, and nothing monitors it during a run. The first real run (a 85.6 s `gemma4:12b` investigation, recorded in the roadmap) happened under the earlier check, which looked only at the model's metadata and a loopback endpoint; it is not evidence that the runtime was cloud-incapable. Status fields and model markers beyond those listed above, and the schema keywords Ollama's structured output supports, are still undocumented; the adapter sends the derived wire schema and relies on the investigator's validation either way.
- **Quality control kept:** the reply is parsed, validated against the full model-output schema and verified against the records actually sent, with the same one bounded repair; a fabricated citation or malformed reply becomes a `failed` run with no findings, never a success. Local limits (`LOCAL_LIMITS` in `src/app/application.ts`): 48,000 bytes of context, 40 records, 3,000 output tokens, a 32,768-token window requested, 400 s per call, 20 min per investigation. `think` is off and the temperature is 0.
- **Added later the same day:** `GET /api/runs/:id/evidence` re-reads a run's cited records from the original bundle (a sidecar `<run>.meta.json` records the bundle id; the result itself still names no bundle) and checks that each exists, matches its quoted identifiers, and lies in a file whose checksum equals the one the run recorded; it never opens anything but the three telemetry files.
- **Not built:** per-agent settings (one agent), streaming progress, a way to cancel from the console (the client disconnecting cancels the run).
- **Measured once:** see the roadmap for the real run recorded on 2026-10-27.

## Context

The owner's rule is zero additional spending. ADR 0012 therefore refuses every provider but the fake one in the application, which leaves `investigate` with nothing runnable from the command line. A local model served by Ollama is the one route to genuine inference at no charge. This record proposes it and the policy around it; it does not choose a model or claim one is adequate.

### What the fake provider is (verified by reading the code, 2026-10-27)

- **Where:** `src/investigation/fake-provider.ts`, class `FakeProvider implements ModelProvider`, constructed as `new FakeProvider(steps, model = 'fake-model')`. It is exported from `src/index.ts`. In production code only `src/evaluation/synthetic.ts` (a `fake(...)` helper, model `scripted`), `src/evaluation/ui-fixtures.ts` and `src/providers/select.ts` construct it; the rest are tests. `selectProvider` returns `new FakeProvider(options.fakeSteps ?? [])`.
- **What it returns:** nothing of its own. Each `complete()` call shifts the next **scripted `FakeStep`** and returns it: `{ reply: string | object, usage? }`, `{ error: ProviderError }`, or `{ hang: true }` (settles only when the call's signal aborts, as a `timeout` error). With no step left it rejects with `Error('FakeProvider has no scripted step left')`. There is no fixed output, no generation and no read of the request beyond recording it in `requests`.
- **Scenarios it can simulate (all scripted by the caller):** success (a valid `ModelOutput`), `inconclusive` (a valid reply with that outcome; `src/evaluation/synthetic.ts` case with `inconclusive`), failure and rejection (`ProviderError` of any `ProviderErrorKind`, with optional retry delay and usage), truncation (a reply that is cut-off JSON, as in `excerpt-repaired-reply`, which then goes through the repair path), timeouts (`hang`), unreported or reported usage, and a provider that throws a plain `Error` (recorded as `internal_error`, `src/investigation/investigate.ts`).
- **Does the investigation process the evidence?** Yes, on the investigator side, and no on the model side. `buildRequest` (`src/investigation/request.ts`) builds the real request from the blinded view; `selection.ts` picks the records; `verify.ts` resolves every reference in the reply against the admitted records actually sent, with checksums and quoted identifiers; `result.ts` validates the output. The fake model does not read the evidence: its reply is whatever the test scripted. A fake "success" proves the investigator's plumbing and verification, not that any model can diagnose anything. The synthetic evaluation's scores measure scripted replies, not diagnostic ability.
- **Network:** `FakeProvider` imports only `./provider.ts` and has no I/O of its own (verified by reading it). It cannot trigger a real provider: it holds no client, and `selectProvider` constructs the Anthropic adapter only for `EOAI_MODEL_PROVIDER=anthropic`. The tests that keep this true are `test/architecture.test.ts` (no `fetch(`, `XMLHttpRequest`, `WebSocket` or `node:http/https/net/tls/dgram` in any source; the SDK only in `src/providers/anthropic/`), `test/investigation/investigate.test.ts` (a global `fetch` stub that throws, in `beforeEach`) and `test/providers/select.test.ts` (the same stub, asserted uncalled). **Limits:** the stubbed-`fetch` tests only cover `fetch`; the source scan is textual; nothing blocks a socket opened some other way. The conclusion "no network" rests on the code reading plus those tests, not on a sandbox.
- **What the tests do and do not prove:** they prove the investigator's handling of every scripted case: parsing, repair limits, retries and backoff, deadlines, cancellation, the token ledger (reported, missing, inconsistent usage), reference verification and ground-truth isolation (`test/pipeline/leakage.test.ts`, `test/ground-truth-isolation.test.ts`). They do not prove any model's quality, the behavior of a real provider, tokens-per-byte, or the cost.

## Decision (proposed)

### 1. Provider policy

| Provider                 | Permitted                                                                                                            | Where                                             |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Fake                     | Always. Deterministic tests, fixtures, the evaluation harness, CI.                                                   | `src/investigation/fake-provider.ts`              |
| Local (Ollama, proposed) | Only after local-only operation is verified, section 2. Otherwise blocked.                                           | a new adapter directory, not built in this change |
| Hosted (Anthropic)       | **Not in the runnable application.** The adapter and tests stay in the repository, unreachable from any entry point. | `src/providers/anthropic/`                        |

The application gate from ADR 0012 section 4 generalises: it holds an allowlist of `{fake, local}`. Anything else, including `anthropic`, is refused before a bundle is read. There is no override flag, environment variable, setting or UI control that adds a provider to the allowlist; changing the allowlist is a code change under review, with a new ADR.

### 2. Local-only enforcement (design, unproven)

A loopback address is necessary but not sufficient, so the design is layered and fails closed:

1. **Endpoint.** The default is `http://127.0.0.1:11434` (Ollama's documented default bind, checked 2026-10-27). The configured URL must have scheme `http`, no credentials, no path beyond the API's, and a host that is a literal loopback address (`127.0.0.0/8`, `::1`) or exactly `localhost` resolved by the adapter to loopback only. Any other host, any redirect, and any DNS result that is not loopback are refused. Redirects are not followed.
2. **No hosted models.** Ollama documents cloud models, which need sign-in or an API key and run on ollama.com (docs.ollama.com/cloud, 2026-10-27). **Whether a local server forwards a request for such a model to the cloud is not documented on the pages read.** The design therefore does not rely on the server: the adapter lists installed models through `GET /api/tags` and refuses a model that is not listed, whose entry carries any remote marker, or whose name matches the cloud naming Ollama uses. Because the field names that mark a remote model are not confirmed, an entry with **any unrecognised field** is refused until the owner has an offline check of the installed version's `/api/tags` shape (see "Technical uncertainties").
3. **Operator step, documented not trusted.** Ollama documents `OLLAMA_NO_CLOUD=1` or `"disable_ollama_cloud": true` in `~/.ollama/server.json` to disable cloud features (docs.ollama.com/faq, 2026-10-27). The runbook tells the operator to set it, and the adapter cannot verify it from outside. It is a second layer, not the guarantee.
4. **Fail closed.** If any check cannot be completed (server unreachable, unexpected response shape, model absent, a non-loopback socket peer), the run does not start and the result is a failure with a distinct class; nothing falls back to another provider, hosted or fake.
5. **Residual risks, stated:** a loopback port may be forwarded elsewhere by the operator or by a proxy; the Ollama server's own behavior is outside this repository; a future Ollama version may add routes. If layers 1 and 2 cannot be tested to the owner's satisfaction, the local provider **stays blocked** and the application keeps only the fake provider.

### 3. Model selection

- A configurable model identifier (`EOAI_OLLAMA_MODEL`, a name as `ollama list` prints it), validated by pattern. No default model: choosing one needs the evaluation that does not exist yet.
- **Discovery** is an explicit operator action (a CLI subcommand or a button), never at startup: one `GET /api/tags` to the configured loopback endpoint, listing installed, non-remote models. No model is pulled, no Ollama process is started or restarted by this repository, and a missing model is reported with the operator's own `ollama pull` command as text only.

### 4. Configuration and its UI

- **Settings:** provider (`fake` or `local`), Ollama endpoint, model identifier, per-call output limit (`maxOutputTokens`), input and total token limits, and timeouts, all within `resolveLimits`' existing bounds. Connection status is a read-only result of the same discovery call.
- **Per-agent settings are out of scope:** the investigator is one agent making sequential calls. There is no multi-agent architecture to configure, and none is proposed.
- **UI:** the console (ADR 0011) gets a settings view only after the application boundary exists, and it can only choose among allowlisted providers. It has no field that accepts an arbitrary URL for a non-loopback host and no "hosted" option. It calls the application layer; it never talks to Ollama, and the browser never receives the endpoint beyond what it needs to display.
- **Persistence:** non-secret settings in one JSON file in the data directory, validated against a closed schema (Ajv, `additionalProperties: false`) on every read and write; unknown or invalid content makes startup fail, with no partial use. No secrets exist: Ollama needs no key, and an `ANTHROPIC_API_KEY`-style setting is not read by the runnable application. Nothing executable is stored: no commands, scripts, URLs outside the loopback rule, or paths outside the configured directories. Environment variables may override the file for the same closed set of keys.

### 5. Application boundary and the investigator

The application layer (ADR 0012) owns configuration, the allowlist gate, provider construction and policy enforcement, and calls `runInvestigation`. The investigator, selection, verification and the pipeline never choose or construct a provider and do not read the environment; they receive a `ModelProvider` and keep the rules of ADR 0006. The adapter lives in its own directory, with its own network permission in `test/architecture.test.ts` (loopback HTTP via `fetch` in that directory only, SDK-free), narrowing the rule rather than weakening it.

### 6. Result integrity

Unchanged and required of any local adapter: the reply is raw text; the investigator parses it, validates it against the full `MODEL_OUTPUT_SCHEMA`, verifies every reference against the records sent, enforces `maxRepairAttempts`, the model-call and token budgets, and keeps `inconclusive` for an investigation that cannot support findings. Structured output (`format` with a JSON schema, which `/api/chat` accepts, docs.ollama.com/api/chat, 2026-10-27) reduces repairs and is not trusted; the derived-schema approach of ADR 0008 applies if the server rejects keywords, which is not yet checked. A local model's `semanticSupport` stays `not_assessed`. Usage maps from `prompt_eval_count` and `eval_count` to `UsageReport`; when absent the investigator charges the ceiling. Local inference costs no money but is still bounded by the same token and time budgets.

### 7. Failure handling

All map onto the existing `ProviderErrorKind`s and failure classes; none is retried beyond the limits.

| Situation                                                                                   | Kind / outcome                                                                                 |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Server unreachable, refused connection                                                      | `unavailable`, retried within limits, then `provider_unavailable`                              |
| Model not installed or refused by policy                                                    | Not a provider call: the application stops before the run with a configuration error           |
| Request exceeds the loaded context window                                                   | `rejected_request`; the adapter sets `num_ctx` explicitly and the limit is an operator setting |
| Call exceeds `perCallTimeoutMs`                                                             | `timeout`, aborting the request                                                                |
| Malformed or truncated JSON (how truncation is signalled by `done_reason` is not confirmed) | Reply returned as text; the existing parse, repair and `invalid_model_output` path             |
| Out of memory or the server exits mid-call                                                  | `unavailable`; the run ends within the retry limit; the repository never restarts the service  |
| Resource exhaustion on the host                                                             | The deadline and token limits end the run; no further guard is claimed                         |

### 8. Tests and CI

Deterministic and offline: the adapter takes an injected HTTP client (as `AnthropicProvider` takes an injected SDK client), tested against recorded response fixtures. Tests cover the loopback validator (including `localhost`, IPv6, userinfo, redirects, decimal and hex host forms), the model-name policy, refusal of unrecognised `/api/tags` entries, error and usage mapping, and that the application gate refuses `anthropic` with no override. CI needs no Ollama, no model, no credential and no network; the stubbed-`fetch` pattern stays in the standard suite. A test that touches a real Ollama is operator-run, opt-in, and not part of `pnpm check`.

### 9. Resource expectations (not measured)

Local inference trades money for hardware. Larger models need more memory and disk (often several gigabytes to tens of gigabytes per model) and run faster on a GPU with enough VRAM; on CPU only they can be slow enough to hit `perCallTimeoutMs`. The default request ceiling is 200,000 input tokens, which many local models' context windows do not allow at a practical memory cost, so limits will likely need lowering for local use. **None of this has been measured here, and no model is claimed adequate;** diagnostic quality on real bundles is an E7 question, answered with an evaluation the owner runs offline.

### 10. Security

Any server or UI over this (ADR 0012 section 6, if approved) binds `127.0.0.1` only, checks `Host` and `Origin`, accepts JSON only for state-changing requests, validates every input, and never proxies to Ollama or exposes its endpoint. The configuration cannot name another host (section 2). The Ollama server is the operator's: this repository does not start it, expose it, change its bind address or open a firewall.

### 11. Relation to other records and proposed order

- **ADR 0002:** its opt-in external calls are replaced by the policy above; the port and the no-calls-in-CI rule stand (amendment note in ADR 0002).
- **ADR 0008:** history kept, with a supersession note. The hosted adapter stays in the repository but is unreachable from the runnable application; its acceptance criteria 3 and 4 are withdrawn.
- **ADR 0012:** the application layer owns the allowlist gate; the loopback server is deferred to a separate decision.

Proposed order, none started and none complete:

1. **E6a:** the application layer, the provider gate (`fake` and `local` allowlist) and the `investigate` CLI (ADR 0012).
2. **Verified local provider:** the loopback validator and the injected-client Ollama adapter with fixtures. Blocked from real use until section 2 is verified by implementation and tests.
3. **Configuration UI:** provider, model, connection status and limits (section 4), after the application layer exists. How the console reaches the application layer is part of the next item.
4. **Server decision:** a separate decision on a loopback server, from the console's actual integration needs.
5. **Hardening and E7:** an operator-run, offline, zero-cost evaluation with a chosen local model; further hardening.

## Decisions and gaps

**Safe to propose now (this record):** the provider allowlist `{fake, local}`; hosted providers unreachable from the application; the layered local-only design; no default model; explicit discovery only; the closed settings schema; per-agent settings out of scope; offline fixtures in CI; the proposed order.

**Needs the owner:**

1. Accept the allowlist policy, and that the hosted adapter stays in the repository but unreachable.
2. Confirm the supersession note on ADR 0008 and the rewording of E5 and E6 that this change made (done in the documents; proposed to the owner, not an implementation).
3. Accept that the local provider stays blocked until the local-only tests pass and the owner reviews them.
4. Decide the loopback server separately (ADR 0012, deferred), and how the configuration UI reaches the application layer.
5. Which local model to try first, and the hardware it runs on, when an offline evaluation is run.

**Technical uncertainties for no-cost, offline investigation:**

- The exact `GET /api/tags` response of the installed Ollama version, and how it marks cloud or remote models; read from the installed version's own documentation and a local response the owner captures, not from a request this repository makes.
- Whether and when a local server forwards a cloud-named model to ollama.com, and whether `OLLAMA_NO_CLOUD=1` blocks it fully, from Ollama's source or documentation.
- Which JSON Schema keywords Ollama's structured output supports, to decide whether the ADR 0008 derived schema is needed.
- Tokens per byte for the chosen model's tokenizer, and the context window it can sustain on the owner's hardware, to set `maxInputTokensPerCall`.
- How reliably a small local model follows the closed output schema (E7).

**Blocked until implementation and tests exist:** the local-only guarantee, the Ollama adapter, model discovery, the settings file and view, the allowlist gate, and every claim in section 2 beyond "designed".

## Consequences

- **Positive:** the only inference path that can ever run is deterministic fake execution or a loopback local model; the rule is enforced in code and tests, not by a flag.
- **Positive:** the investigator and its contracts do not change.
- **Negative:** no hosted model, so no measure of frontier-model quality; local quality is unknown and may be poor on this task.
- **Negative:** the local-only guarantee depends partly on Ollama's own behavior, which this repository cannot control; the feature may remain blocked.
