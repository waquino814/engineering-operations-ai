# Examples

## `provider-outage-42-20261026T122230Z/`: an excerpt of a real bundle

**An excerpt, not a complete bundle.** The full bundle is about 20 MB, and Commerce Platform keeps bundles out of Git except for one reviewed sample planned in its M6 ([ADR 0007](../adr/commerce-platform/0007-incident-bundle-schema-v1.md)). So this directory holds the bundle's two JSON documents unchanged, plus a few genuine lines from each telemetry file. The JSONL lines are copied byte for byte; nothing is edited, generated or reformatted.

**Source.** The bundle `incidents/provider-outage-42-20261026T122230Z/`, produced by Commerce Platform's incident CLI on 2026-10-26 with `pnpm incident run --scenario provider-outage --seed 42`, from clean commit `93ad2131255eed89baa4d3ba67cbf649a49925ee` (`producer.dirty: false`). Commerce Platform's validator reported it valid, and its symptom was detected 15,005 ms after the trigger.

| File here | Content | SHA-256 |
| --- | --- | --- |
| `manifest.json` | the bundle's manifest, unchanged | `535734e901cc236d8439ecf1f08b1a5d41db4c47aea46b3d8adee9dc77a652d2` |
| `ground_truth.json` | the bundle's ground truth, unchanged (byte-identical to Commerce Platform's committed golden file for this scenario and seed) | `c9d5b17b50251a09d226d0f8bd4ddcf17b45f1acc8eabc706e1aaed36cc237db` |
| `metrics.excerpt.jsonl` | lines 13 and 12 of 209: the primary-symptom series (`lookup_or_void` errors), then the `charge` error series | |
| `logs.excerpt.jsonl` | lines 2, 3596, 3646 and 6416 of 7,711: an order created by the API, then the worker's `charge_outcome_unknown`, `lookup_failed` and `payment_unknown` records | |
| `traces.excerpt.jsonl` | lines 382 and 2 of 3,023: a worker trace with a failed `payment.lookup_or_void` call, and a `POST /orders` trace | |

**What validates.** Each document and each excerpt line matches its v1 JSON Schema in [docs/contracts/incident-bundle/](../contracts/incident-bundle/README.md). The directory as a whole does **not** pass bundle validation, by design: its telemetry files are excerpts with different names, so the manifest's `files` checksums and counts (rule 9), which describe the full files, do not apply. Use a complete bundle from Commerce Platform to test the full procedure.

**Reading it.** `ground_truth.json` says the payment provider rejected every charge and lookup, and names the primary symptom: an increase in `commerce_payment_calls_total{job="worker", payment_operation="lookup_or_void", payment_result="error"}`. The metrics, logs and traces excerpts show that same failure from three angles: the counter rising, the worker logging each failed charge, lookup and parked order, and the failed call recorded on its span as `payment.result = "error"`.
