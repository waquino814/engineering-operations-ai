# Handoff from Commerce Platform

How an incident produced by [Commerce Platform](https://github.com/waquino814/commerce-platform) becomes an investigation here. The two repositories stay independently runnable: nothing below imports, links or runs code across them.

## The contract

- **One interface: the incident bundle, schema version 1.** A bundle is a directory of five files: `manifest.json`, `ground_truth.json`, `traces.jsonl`, `metrics.jsonl`, `logs.jsonl`. The decision is [Commerce Platform ADR 0007](adr/commerce-platform/0007-incident-bundle-schema-v1.md); this repository keeps a pinned copy of the JSON Schemas and a consumer guide in [contracts/incident-bundle/](contracts/incident-bundle/README.md).
- **This repository reads files only.** It does not query Commerce Platform's database, call its API, or start its fault scenarios ([architecture](architecture.md#boundary-with-commerce-platform)).
- **Ground truth travels in the bundle but is never shown to the investigator.** `ground_truth.json` is read by contract validation (which reports issues only) and by evaluation. The investigator receives a blinded evidence view ([ADR 0003](adr/0003-ground-truth-isolation.md)).
- **Intake is strict about the contract and lenient about the future.** All nine rules are checked (files present, schemas, checksums, counts, ID agreement); an unsupported major version is refused; unknown fields and unknown scenario or component names are accepted ([intake](intake.md)).

## Scenarios that exist

Commerce Platform implements five fault scenarios (`pnpm incident list` there, a read-only command), each reproducible from a scenario name plus a seed:

| Scenario                 | What it simulates                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------ |
| `provider-outage`        | The payment provider is unavailable for charges and lookups; orders park in `payment_unknown`.         |
| `payment-timeouts`       | The provider stops answering a share of charge requests; the worker times out, retries, reconciles.    |
| `api-pool-exhaustion`    | A connection leak holds the orders API's whole database pool; requests fail after the connect timeout. |
| `bad-deploy-order-reads` | A release behind a flag makes a share of `GET /orders/:id` return 500.                                 |
| `poison-order`           | Orders with one product make processing hang, so claims expire and the worker can stall.               |

Only one genuine bundle excerpt (`provider-outage`, seed 42) is committed here ([docs/examples](examples/README.md)). Bundles themselves are never committed to either repository.

## Getting a bundle without running anything consequential

Running a scenario (`pnpm incident run --scenario <name> --seed <n>` in Commerce Platform) starts fault injection and load against that project's local stack. That is a consequential operation with its own approval rule in Commerce Platform's `CLAUDE.md`; **do not run it just to obtain a bundle.** Safer options:

1. **Reuse a bundle that already exists** in a Commerce Platform checkout's `incidents/` directory (it is git-ignored, so it exists only where someone ran a scenario).
2. **Check it first, read-only**, from the Commerce Platform checkout: `pnpm incident validate <bundle-dir>` makes no network call.
3. **Use the synthetic bundles** here: `pnpm demo:seed`.

## Supported procedure

```sh
# 1. Copy a complete bundle directory (the directory itself) into this project's bundles directory.
cp -R <commerce-platform>/incidents/provider-outage-42-<timestamp> ~/.engineering-operations-ai/bundles/

# 2. Validate it (exit 0 valid, 1 invalid).
pnpm validate-bundle ~/.engineering-operations-ai/bundles/provider-outage-42-<timestamp>

# 3. Open the console (pnpm dev), choose New investigation, select the bundle, check the validation, Start.
```

`<commerce-platform>` is wherever you cloned it; nothing here depends on that location. Use `EOAI_BUNDLES_DIR` to read from another directory. Copying happens by hand on purpose: the console has no upload route.

## Verified on 2026-10-27

Using a copy of the existing local bundle `provider-outage-42-20261026T123450Z` (about 17.7 MB of traces, 7,703 log records, 3,022 traces), in a scratch data directory:

| Step                                                                                    | Result                                                                                                                                                             |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Commerce Platform's own `pnpm incident validate`                                        | valid                                                                                                                                                              |
| This repository's `pnpm validate-bundle` on the copy                                    | valid, schema 1.0.0, exit 0                                                                                                                                        |
| Console validation, then **Start investigation** with the **Fake (simulated)** provider | run `completed`; the bounded selection sent 4 of 3,022 traces, 71 of 260 metric records and 6 of 7,703 log records; 3 of 3 citations re-checked against the bundle |

Screenshots: [started](images/console-12-real-commerce-bundle-started.png), [result](images/console-13-real-commerce-bundle-result.png).

**What this does and does not show.** It shows the handoff works: a real bundle passes intake, is blinded and bounded, runs through the pipeline, and produces a schema-valid result whose citations resolve to real records. It does **not** show a diagnosis: the Fake provider cites the first records by position and says so ("no analysis was performed"), and semantic support is `Not assessed`. No real model has investigated a real bundle in this repository ([providers and safety](providers-and-safety.md)). No bundle was produced during this verification: no scenario was run.

## Known limits of the handoff

- Every real bundle so far faults exactly 30 s after load start, which telemetry can reveal; varying it is Commerce Platform's decision ([ADR 0003](adr/0003-ground-truth-isolation.md), "Remaining risks").
- One scenario is represented by committed data here, so held-out evaluation uses an invented scenario and tests the split, not generalization ([evaluation](evaluation.md)).
- Schema version 1 only; a newer major version is refused until a new ADR adds it.
