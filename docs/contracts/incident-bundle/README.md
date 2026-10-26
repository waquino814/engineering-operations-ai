# Incident bundle contract, version 1

The contract between Commerce Platform, which writes incident bundles, and this repository, which reads them. It consists of the decision record [ADR 0007](../../adr/commerce-platform/0007-incident-bundle-schema-v1.md) (**accepted**) and the JSON Schema files in [`v1/`](v1/). This guide restates what a consumer needs from Commerce Platform's design documents; where this guide and ADR 0007 differ, ADR 0007 wins.

## Vendored files

Copied unchanged from <https://github.com/waquino814/commerce-platform> at commit `93ad2131255eed89baa4d3ba67cbf649a49925ee` on 2026-10-26. Upstream they are generated from Commerce Platform's Zod schemas, and a drift test keeps them in step; here they are a pinned copy.

| File | Validates | Original path | SHA-256 |
| --- | --- | --- | --- |
| [v1/manifest.schema.json](v1/manifest.schema.json) | `manifest.json` | `docs/schemas/incident-bundle/v1/manifest.schema.json` | `5a0f6e3f153ea71b3187318302538da3e887a1bed202164a36afe475d46b9d8d` |
| [v1/ground-truth.schema.json](v1/ground-truth.schema.json) | `ground_truth.json` | `docs/schemas/incident-bundle/v1/ground-truth.schema.json` | `589b08c5d4de52cb960a0fabe50829525babf6b0c3230286371e061e9456b441` |
| [v1/trace-record.schema.json](v1/trace-record.schema.json) | each line of `traces.jsonl` | `docs/schemas/incident-bundle/v1/trace-record.schema.json` | `fdd5760206bb2ea0dfa6a27f55f5a0eded854669509f6fcbfd245d62de081bc1` |
| [v1/metrics-record.schema.json](v1/metrics-record.schema.json) | each line of `metrics.jsonl` | `docs/schemas/incident-bundle/v1/metrics-record.schema.json` | `504d29b675f48874e84b42893dec9778f2b99f8938f2decf4ba0219433d8f17e` |
| [v1/logs-record.schema.json](v1/logs-record.schema.json) | each line of `logs.jsonl` | `docs/schemas/incident-bundle/v1/logs-record.schema.json` | `17fbf3ada612eff2c58b0105d76e22fc6afaca097fdbae9d8b7577ed9b03e994` |

The set is complete and self-contained: every file is JSON Schema draft 2020-12, and no file references another (`$ref` does not occur). Each `$id` (`https://commerce-platform.local/schemas/incident-bundle/v1/...`) is an identifier only; nothing is fetched from it.

**Updating the copy.** Copy the files again from a Commerce Platform commit, record the new commit and checksums above, and read upstream's ADRs for any change. Within major version 1, newer files only add optional fields. A new major version arrives in a new directory, `v<N>/`, with a new ADR; add it beside `v1/` rather than replacing it.

## Layout

One directory per run, named by its bundle ID, `<scenario>-<seed>-<YYYYMMDDTHHMMSSZ>`:

```
provider-outage-42-20261026T122230Z/
  manifest.json      volatile: run identity, windows, detection, producer, capture details, file checksums
  ground_truth.json  deterministic: what the fault was and how it should show
  traces.jsonl       one trace per line, OTLP JSON TracesData
  metrics.jsonl      one Prometheus series per line
  logs.jsonl         one normalized log record per line
```

## Validating a bundle

JSON Schema covers each document and line. A conforming consumer also applies the cross-file rules below, which Commerce Platform's validator (`packages/incident-bundle/src/validator.ts`) enforces and which no schema can express. Apply them in this order:

1. **All five files exist.**
2. **Supported major version.** Read `manifest.json`'s `schemaVersion` (semver) and refuse the bundle unless its major version is one you support (here: `1`). Within a supported major version, accept unknown fields.
3. **Documents match their schemas:** `manifest.json` and `ground_truth.json`, each parsed as one JSON value.
4. **JSONL is well formed** for each of `traces.jsonl`, `metrics.jsonl` and `logs.jsonl`: UTF-8; every record is one line ending in `\n`, including the last; no blank lines; an empty file has zero records and is valid. Each line matches its record schema.
5. **One trace per line:** every span on a `traces.jsonl` line has the same `traceId`.
6. **`bundleId` equals the directory name.**
7. **Scenario agreement:** `manifest.scenario` and `ground_truth.scenario` have the same `name`, `version` and `seed`.
8. **Truncation flag:** for each `manifest.capture.traces.services[i]`, `truncated` is true exactly when `truncationReasons` is not empty.
9. **File integrity:** for each of `ground_truth.json`, `traces.jsonl`, `metrics.jsonl` and `logs.jsonl`, `manifest.files.<name>` gives `sha256` (64 lowercase hex characters of the file's bytes), `bytes` (its size) and `records` (1 for `ground_truth.json`, the line count for a JSONL file), and all three must match. The manifest does not describe itself.

Report each failure with the file, and the field or line where there is one.

## Semantics

**Common.** Objects are loose: a consumer ignores fields it does not know. Timestamps are ISO 8601 UTC with milliseconds, such as `2026-10-25T14:03:07.250Z`. Scenario names and component identifiers are an open vocabulary matching `^[a-z][a-z0-9-]*$`: accept values you have not seen.

**`manifest.json`** is volatile and never compared byte for byte.

- `window`: `loadStartedAt`, `loadEndedAt`, and `captureFrom`/`captureTo`, which bound the telemetry queries.
- `trigger`: the actual fault window. `stoppedAt` is `null` if the stop was not confirmed.
- `detection`: when the producer observed the primary symptom. `detectedAt` and `latencyMs` are `null` if it did not. This is the producer's own check, not an answer key.
- `producer`: `repository` (`"commerce-platform"`), the 40-character `commit`, and `dirty`, true if the producing working tree had uncommitted changes.
- `services`, `infrastructure.images`, `load` (profile, seed, `planHash`, `runPrefix`): what produced the telemetry.
- `capture.traces.services[]`: per service, how many traces were captured and whether the set is complete. `truncationReasons` is a subset of `slice_saturated` (a time slice hit Jaeger's search limit) and `service_cap` (the 5,000-trace cap per service). Treat a truncated trace set as incomplete evidence. `capture.metrics` and `capture.logs` record series counts and log records per service.

**`ground_truth.json`** is the answer key.

- It is a pure function of the scenario name, the scenario's integer `version`, the seed and the schema version. It is canonical JSON (UTF-8, sorted keys, two-space indent, final newline) and contains no timestamps, run IDs, order IDs or commit. Two bundles of the same scenario and seed are byte-identical here unless the scenario `version` or the schema version changed.
- Fields: `description`, `rootCause` `{ component, summary }`, sorted `affectedComponents`, `faultParameters` (flat), `timeline` `{ triggerOffsetMs, durationMs }` relative to the load start, `primarySymptom`, `secondarySymptoms` (informational; a run need not show them), `dataEffects`, `expectedRemediation`.
- A **condition** is structured, not a query string: `signal` (`"metric"`), `metric`, exact-equality `matchers`, `evaluation` (`increase` for counters, `max_over_time` for gauges), `windowSeconds`, `comparison` (`gt`, `gte`, `lt`, `lte`), `threshold`, `deadlineSeconds` and `description`. Commerce Platform evaluates it as the PromQL `sum(<evaluation>(<metric>{<matchers>}[<windowSeconds>s])) <comparison> <threshold>`, with `max` in place of `sum` for `max_over_time`. Any consumer may evaluate it its own way over `metrics.jsonl`.

**`metrics.jsonl`**: one Prometheus series per line, sorted by `name` and then by the canonical JSON of `labels`. `labels` holds every label except `__name__`, all strings. `samples` are `[unixSeconds, value]` pairs in ascending time; `value` is the **string** Prometheus returned, which may be `NaN`, `+Inf` or `-Inf`, so parse it as a float. Samples cover the capture window plus 1 minute on each side, at the step in `capture.metrics.stepSeconds`.

**`logs.jsonl`**: one record per line, in time order per service, services concatenated in name order. Required: `service`, `time`, `level`, `message`, `attributes`. `trace_id` (32 hex) and `span_id` (16 hex) appear only when the source line had them, and join logs to traces.

**`traces.jsonl`**: one OTLP JSON `TracesData` object per line, `{ "resourceSpans": [...] }`, with hex trace and span IDs. Validation is structural only: a non-empty `resourceSpans` array, each entry with a `scopeSpans` array, each span with a string `name`, a 32-hex `traceId`, a 16-hex `spanId` and a string `startTimeUnixNano`. Parent links, span kinds, attribute types and ordering are not checked, so any OTLP reader can be used. Line order is not meaningful. Spans under `/admin` are removed before writing.

## Versioning

From ADR 0007:

- **Minor (1.x):** optional fields, new optional files, new scenarios or component identifiers, new optional attributes. A consumer built for an older 1.x accepts a newer 1.x bundle.
- **Patch:** documentation only; never changes what validates.
- **Major:** anything else that changes a field, type, file format, meaning or determinism. It comes with a new ADR and a new `v<N>/` schema directory.

## Not in the contract

These describe Commerce Platform as of commit `93ad213`. They help when reading real bundles, but they are observations, not guarantees, and may change in any version.

- **Scenarios.** Five exist: `bad-deploy-order-reads`, `payment-timeouts`, `provider-outage`, `api-pool-exhaustion` and `poison-order`. Each primary symptom is a counter `increase` over 60 s, threshold 0, deadline 120 s. Component identifiers seen so far are `orders-api`, `worker`, `payment-provider` and `orders-api-pool`.
- **Run timing.** The incident CLI starts load at T, triggers the fault at T+30 s for 90 s, and loads for about 150 s.
- **Payment errors in traces.** A failed provider call appears on its span (`payment.charge` or `payment.lookup_or_void`) as the attribute `payment.result = "error"`, while the span status is left unset. Do not rely on span status alone to find errors.
- **Sizes.** A real bundle is about 9 to 20 MB, mostly `traces.jsonl` (about 1,500 to 3,000 traces).
