# Bundle intake

The intake module, `src/intake/`, admits incident bundles: it validates them against the vendored v1 contract ([consumer guide](contracts/incident-bundle/README.md)) and gives the investigator a blinded view of the evidence. Decisions: [ADR 0005](adr/0005-bundle-intake-and-validation.md) (intake and validation) and [ADR 0003](adr/0003-ground-truth-isolation.md) (ground-truth isolation), both accepted.

## Public interface

Exported from `src/index.ts`:

| Export                                                                                                                                                                         | Purpose                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `validateBundle(dir, { readFile? })`                                                                                                                                           | Contract validation: all nine rules over the five files. Returns a `ValidationReport` `{ valid, bundleDir, schemaVersion, issues }`. Never throws for a bad bundle, never writes.                                                                                                                          |
| `openEvidence(dir, { readFile? })`                                                                                                                                             | Investigator admission: reads `manifest.json` and the three telemetry files only, re-checks them, and returns the blinded `EvidenceView`, or throws `EvidenceError`. Never opens `ground_truth.json`. Run by intake after `validateBundle` reports the bundle valid; hand the investigator the view alone. |
| `investigatorManifest(manifest)`                                                                                                                                               | Builds the investigator's manifest from a schema-valid manifest, by allowlist.                                                                                                                                                                                                                             |
| `validateRecord(kind, value, major?)`                                                                                                                                          | Validates one telemetry record, or a manifest, against the vendored schema, outside a bundle.                                                                                                                                                                                                              |
| `RULES`, `ValidationIssue`, `EvidenceView`, `InvestigatorManifest`, `EXCLUDED_MANIFEST_FIELDS`, `BUNDLE_FILES`, `TELEMETRY_FILES`, `SUPPORTED_MAJOR_VERSIONS`, `ContractError` | Types and constants.                                                                                                                                                                                                                                                                                       |

`readFile` is injectable so tests can observe or fail reads; it defaults to Node's `fs.readFile`.

**`ValidationIssue`:** `{ rule, ruleId, file, field?, line?, message }`, for example:

```json
{
  "rule": 9,
  "ruleId": "file-integrity",
  "file": "logs.jsonl",
  "field": "files.logs.jsonl.records",
  "message": "manifest.json files.logs.jsonl.records is 5, but logs.jsonl has 4"
}
```

Issues are sorted by rule, then file (`null` for the directory, then manifest, ground truth, traces, metrics, logs), and keep the checks' deterministic order within those. At most 20 line-level issues are listed per file and rule; one more issue counts the rest.

**`EvidenceView`:** `{ caseId, manifest, files }`, and nothing else ([ADR 0003](adr/0003-ground-truth-isolation.md)).

- `caseId`: the first 16 hex characters of the manifest's SHA-256; unique per run, unchanged by renaming the directory.
- `manifest`: an `InvestigatorManifest`, built from an allowlist: `schemaVersion`; `services[]` (`name`, `version`, `instanceId`); `capture.traces.services[]` (`name`, `truncated`, `truncationReasons`, `saturatedSlices`); `capture.metrics.stepSeconds`; `capture.logs.services[]` (`name`, `nonJsonLines`); and `files` for the three telemetry files. Everything else is excluded, including `bundleId`, `scenario`, `createdAt`, `window`, `trigger`, `detection`, `producer`, `infrastructure`, `load`, the rest of `capture`, the answer file's checksum, and any field a later producer adds. `EXCLUDED_MANIFEST_FIELDS` records why.
- `files[name]`: the file's `sha256`, `bytes`, `records` and `entries`, each record with its 1-based `line`, for evidence references ([ADR 0004](adr/0004-investigation-result-contract.md)).

## Rules

| #   | `ruleId`                  | Checks                                                                                                     | Where                                          |
| --- | ------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 1   | `files-present`           | the directory, and each of the five files exists and is readable                                           | both paths                                     |
| 2   | `supported-major-version` | `manifest.json`'s `schemaVersion` is semver with a vendored major (1); otherwise no schema validation runs | both paths                                     |
| 3   | `document-schema`         | `manifest.json` and `ground_truth.json` parse as UTF-8 JSON and match their schemas                        | manifest: both; ground truth: validation only  |
| 4   | `jsonl-records`           | UTF-8, final newline, no blank lines, valid JSON, each record matches its schema                           | both paths                                     |
| 5   | `one-trace-per-line`      | all spans on a `traces.jsonl` line share one `traceId`                                                     | both paths                                     |
| 6   | `bundle-id`               | `bundleId` equals the directory's name                                                                     | validation only                                |
| 7   | `scenario-agreement`      | `scenario.name`, `version` and `seed` agree between manifest and ground truth                              | validation only                                |
| 8   | `truncation-flag`         | `truncated` is true exactly when `truncationReasons` is not empty                                          | validation only                                |
| 9   | `file-integrity`          | SHA-256, byte count and record count of each file match `manifest.files`                                   | ground truth: validation only; telemetry: both |

## Command line

```sh
pnpm validate-bundle <bundle-dir>          # human-readable; exit 0 valid, 1 invalid, 2 usage or contract error
pnpm validate-bundle <bundle-dir> --json   # the ValidationReport as JSON
```

The committed example is an excerpt, so it fails rule 1 for exactly its three missing telemetry files, and passes every other rule.

## Development

```sh
pnpm install          # Node 24 (.nvmrc) and pnpm 12 (packageManager)
pnpm test             # Vitest
pnpm test:coverage    # with per-file thresholds: 90% lines, 80% branches
pnpm typecheck        # tsc, no emit: source runs directly under Node's type stripping
pnpm lint             # ESLint, typescript-eslint strict type-checked
pnpm format:check     # Prettier; the vendored copies are excluded so their bytes never change
pnpm check            # all of the above
```

Tests build small synthetic bundles in temporary directories from the committed example's manifest, ground truth and excerpt lines (`test/support.ts`), and break them one rule at a time. No large or production bundle is committed, and the example is never written to.

## Limitations

- Files are read whole into memory; a real bundle is under 20 MB (ADR 0005).
- The vendored schema files are read from `docs/contracts/` at run time and pinned by SHA-256; a changed file is a `ContractError`, not a different contract.
- Only major version 1 is supported.
- Isolation risks outside the manifest view, such as the producer's fixed fault timing, are listed in [ADR 0003](adr/0003-ground-truth-isolation.md), "Remaining risks".

## Contract ambiguities

Points the contract (Commerce Platform ADR 0007 and its design) leaves open, with the behavior chosen here:

- **Ground-truth version.** Rule 2 reads only the manifest's version. The ground-truth schema itself requires major 1 (`^1\.\d+\.\d+$`), so a ground truth with another major fails rule 3. Whether the two versions must otherwise agree is not stated; they are not compared.
- **Directory names.** Rule 6 makes the directory name part of the contract, so a copied bundle must keep its name. Renaming a bundle invalidates it.
- **Record count without a final newline.** The guide defines `records` as the line count; a final line without `\n` is counted (as Commerce Platform's validator does) and also reported under rule 4.
- **Byte order mark.** Not mentioned. A leading UTF-8 BOM is accepted by the decoder and counted in the checksum.
- **Duplicate traces.** A trace should appear on one line only (Commerce Platform's capture deduplicates), but no rule checks it, and neither does this validator.
- **Answer leakage through the manifest.** The contract does not separate investigator-visible fields from answer-revealing ones; ADR 0003 blinds `bundleId`, `scenario` and the ground-truth checksum here.
