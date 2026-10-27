# Proposal: observability beyond the stored run

**Status: proposed, with an opt-in event stream implemented.** The roadmap's E7 table says "no logging or metrics beyond the stored run". This document specifies what to add, separates what exists from what is proposed, and records the one low-risk part that is already built.

## What exists today (verified)

| Capability                                                      | Where                                                              | Notes                                                                  |
| --------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| Stored investigation with usage, outcome, failure class, timing | `<data>/runs/<id>.json` (`run.usage`, `run.durationMs`, `failure`) | Per run, validated on read; token accounting `reported` or `estimated` |
| Count-only summary safe for logs                                | `summarize` in `src/investigation/summary.ts`                      | No statements, rationales, telemetry                                   |
| Fourteen failure classes, sanitized messages                    | `src/investigation/failures.ts`                                    | Messages are scrubbed of paths and secrets                             |
| Stable HTTP error codes, no paths or stack traces               | `src/app/http-server.ts`, tested                                   | `/healthz`, `/api/status`                                              |
| Stored evaluation runs with reliability counts and durations    | `<data>/evaluations/<id>.json` (`reliability`)                     | Timeouts, failures by class, harness errors, per-case duration         |
| Gate findings as fields                                         | `pnpm eval:suite` (`gate.findings`)                                | Code, suite, case, metric, reason                                      |
| Process output                                                  | `scripts/dev.ts` startup lines, `serve` "listening on …"           | No request log, no structured log                                      |
| **Implemented now:** opt-in operational events                  | `src/app/events.ts`, `serve --events stderr`                       | Off by default; four events; closed fields; tested                     |

No metrics endpoint, tracing or request log exists, and none is proposed to be added without a decision (below).

## Implemented: operational events

`node src/cli.ts serve --events stderr` writes one JSON object per line to stderr. Without the flag the application writes nothing. The application layer emits, through an injected sink (`AppDeps.events`):

| Event                    | When                           | Fields                                                                                                                                                                                           |
| ------------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `investigation.finished` | A run was stored (any outcome) | `runId`, `bundleId`, `provider`, `model`, `simulated`, `outcome`, `failureClass`, `findings`, `references`, `modelCalls`, `repairs`, `retries`, `chargedTokens`, `tokenAccounting`, `durationMs` |
| `investigation.refused`  | Nothing ran                    | `reason`: `provider_blocked`, `invalid_bundle_id`, `bundle_not_found`                                                                                                                            |
| `evaluation.finished`    | A suite run was stored         | `evaluationId`, `suiteId`, `suiteVersion`, `providerKind`, `measuresModelQuality`, `status`, `cases`, `completed`, `failed`, `notAdmitted`, `harnessErrors`, `answerLeaks`, `durationMs`         |
| `evaluation.refused`     | Nothing ran                    | `reason`: `unknown_suite`, `provider_blocked`                                                                                                                                                    |

Every line also carries `v` (format version, 1), `event` and `at` (ISO time). **Correlation:** `runId` and `evaluationId` are the stored documents' own ids, so an event leads to its record and a record to its event. **Error categories:** `failureClass` (the pipeline's closed set) and `reason` (a closed set above). **Privacy by construction:** the sink writes only the listed fields; a string that is not an identifier (`[A-Za-z0-9][A-Za-z0-9._:@+-]{0,119}`) is replaced by `(withheld)`; non-finite numbers become `null`; a sink that throws never changes the outcome of the work. Tests assert that no event field name suggests free text, that a path, a message or a URL cannot reach a line, and that default `serve` writes nothing.

## Proposed (not implemented)

### More events

| Event              | Purpose                              | Fields (all closed, bounded)                                                               |
| ------------------ | ------------------------------------ | ------------------------------------------------------------------------------------------ |
| `provider.checked` | Local-only check result before a run | `provider`, `runnable`, `reasonCode` (closed codes, not the message)                       |
| `bundle.validated` | Validation outcome                   | `bundleId`, `valid`, `issueCount`, `rules` (rule ids as a list)                            |
| `http.request`     | Latency and status per route         | `route` (the route pattern, never the path), `method`, `status`, `durationMs`, `requestId` |
| `evaluation.gate`  | CLI gate result                      | `exitCode`, `findingCodes` with counts, `suiteIds`                                         |

`requestId` would be a per-request random id returned in a response header so a client report can be matched to a log line. `reasonCode` requires turning the provider check's messages into a closed list first (they are sentences today).

### Metrics (names, types, labels)

Proposed as counters and histograms **derived from the event stream**, not as a monitoring stack:

| Metric                                                                           | Type      | Labels (bounded sets only)                                |
| -------------------------------------------------------------------------------- | --------- | --------------------------------------------------------- |
| `eoai_investigations_total`                                                      | counter   | `outcome`, `failure_class`, `provider` (`fake`, `ollama`) |
| `eoai_investigation_duration_seconds`                                            | histogram | `provider`                                                |
| `eoai_model_calls_total`, `eoai_model_retries_total`, `eoai_model_repairs_total` | counter   | `provider`                                                |
| `eoai_tokens_charged_total`                                                      | counter   | `accounting` (`reported`, `estimated`)                    |
| `eoai_refusals_total`                                                            | counter   | `kind` (`investigation`, `evaluation`), `reason`          |
| `eoai_evaluation_runs_total`                                                     | counter   | `suite`, `provider_kind`, `status`                        |
| `eoai_evaluation_answer_leaks_total`                                             | counter   | `suite` (must stay 0)                                     |
| `eoai_gate_findings_total`                                                       | counter   | `code`                                                    |

**Forbidden labels:** run, evaluation, bundle, case and request ids; model names beyond the configured one; anything derived from telemetry, findings or error text. Cardinality is bounded by the closed sets above.

### Operational use cases

1. _Did last night's evaluation regress?_ `evaluation.finished` with `answerLeaks > 0` or `status: incomplete`; the gate's finding codes.
2. _Why is the console empty?_ `investigation.refused` with `provider_blocked` versus no events at all.
3. _Is a local model timing out?_ `investigation.finished` with `failureClass: provider_timeout` and `durationMs`.
4. _Is token accounting reliable?_ The share of runs with `tokenAccounting: estimated`.
5. _Did something leak?_ `evaluation.finished.answerLeaks` and the gate's `answer_leak` finding.

## Requirements (apply to everything above)

- **No secrets, credentials, URLs, paths, environment values, prompts, replies, telemetry, finding text, remediation text or exception text** in any event or metric.
- **Bounded cardinality:** a label or field is a number, a flag, or a member of a set closed in code; an identifier is allowed only where it names a stored document.
- **No new service, dependency or deployment.** Events go to stderr; the operator may redirect them. Nothing is sent anywhere. Rotation and retention are the operator's, since the application writes no file.
- **Observability cannot change behaviour:** a failing sink is ignored; emission happens after the work is stored.
- **Same isolation rules:** events are operator-side and must not enter any prompt; the answer-leak checks keep covering requests.

## Decision required from the owner

1. Approve the opt-in event stream as built (default off, stderr, four events), or ask for it to be removed.
2. Decide whether to add the proposed events and request ids, and whether metrics stay offline aggregations of the event stream or become a loopback `GET /api/metrics` endpoint (a new API surface; not recommended before real use justifies it).
3. If any of this should be on by default, say so; nothing here changes the default.
