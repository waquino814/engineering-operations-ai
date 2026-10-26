# Investigation result contract

The JSON documents this project produces, and the one it asks a model to produce. Version **0.1.0** of each; the design is [ADR 0004](../../adr/0004-investigation-result-contract.md) (accepted) with the amendment and compatibility policy in [ADR 0010](../../adr/0010-investigation-result-contract-v0.md) (accepted 2026-10-26).

| File                                                                       | Content                                                              |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| [v0/investigation-result.schema.json](v0/investigation-result.schema.json) | The result consumers read: JSON Schema draft 2020-12, closed objects |
| [v0/model-output.schema.json](v0/model-output.schema.json)                 | What a model must return; parsed strictly, then verified             |

The files are generated from `src/investigation/schemas.ts`; a test fails if they differ.

## Reading a result

1. Check `schemaVersion`. Accept only `0.1.0`; while the major version is 0, a different minor is a different contract.
2. Validate against the schema. Then apply the rules it cannot express: unique finding IDs, remediation that addresses existing findings, and usage that adds up. `readInvestigationResult` in `src/investigation/result.ts` does all three steps.
3. Branch on `outcome`:

| `outcome`         | Meaning                                                                                     | `failure`                 |
| ----------------- | ------------------------------------------------------------------------------------------- | ------------------------- |
| `completed`       | The investigation concluded; at least one finding                                           | absent                    |
| `inconclusive`    | The investigation ran correctly and found the evidence insufficient; `limitations` says why | absent                    |
| `budget_exceeded` | A limit stopped the run; nothing was found                                                  | `resource_limit_exceeded` |
| `failed`          | The run did not complete; nothing was found. `caseId: null` means it never started          | its class                 |

## What a finding's `verification` means

| Field               | Value          | Meaning                                                                                        |
| ------------------- | -------------- | ---------------------------------------------------------------------------------------------- |
| `referenceExists`   | `verified`     | each cited file is admitted telemetry and the line holds an admitted record                    |
| `identityMatches`   | `verified`     | the quoted identifiers (series and labels, time and service, trace and span) are the record's  |
| `integrity`         | `verified`     | the file's SHA-256 was recomputed at admission and equals `bundle.files`; a quoted one matched |
| `includedInRequest` | `verified`     | every cited record was in the evidence sent to the model                                       |
| `semanticSupport`   | `not_assessed` | nothing checks that the records support the statement; treat statements as the model's claims  |

No other values are allowed. A future check that assesses support would need new code and a new schema version.

## Token usage

`run.usage.inputTokens` and `outputTokens` are the provider's reported counts. `chargedTokens` is what the budget counted, including the configured ceiling for any call whose usage was not reported. `tokenAccounting` is `estimated` when any call was unreported or reported above a ceiling. See [ADR 0006](../../adr/0006-investigation-pipeline-and-limits.md).
