# 0005: Bundle intake and validation

- **Status:** Accepted (2026-10-26), approved by the repository owner after the E1 review.
- **Date:** 2026-10-26

## Context

Bundles are produced by Commerce Platform and copied here as directories. The contract (Commerce Platform [ADR 0007](commerce-platform/0007-incident-bundle-schema-v1.md)) is the vendored JSON Schema files plus nine validation rules, five of them cross-file, written down in the [consumer guide](../contracts/incident-bundle/README.md). Nothing downstream should ever see a bundle that fails them.

## Decision

**How bundles enter.** A bundle is a local directory, given by path. Intake reads it and never writes, renames, repairs or deletes anything in it. There is no network intake, upload or database in E1.

**Which schemas apply.**

- Intake reads `manifest.json`'s `schemaVersion` first and takes its major version.
- A major version is supported when `docs/contracts/incident-bundle/v<major>/` is vendored and registered in the code, with each file's SHA-256 pinned. E1 supports major `1` only.
- An unsupported or unreadable major version is a rule 2 issue, and then no schema validation runs: nothing is validated against a schema that was not written for it. The checks that need no schema (files present, JSONL structure, trace IDs per line, and the cross-file rules 6 to 9 on the fields present) still run, so the one report shows everything visible. The bundle is invalid either way.
- Newer minor versions within a supported major are accepted; unknown fields are ignored, as ADR 0007 requires.
- When a major version's schemas are first loaded, the files' checksums are compared with the pinned values, so a changed vendored file is a `ContractError` instead of a silently different contract.

**How validation runs.** All nine rules, in the consumer guide's order. Validation continues past an error wherever later rules can still run, so one report lists every problem. Rules that need a document that is missing or invalid are skipped for that document, not guessed.

**How errors are reported.** A `ValidationReport` with `valid`, the `schemaVersion` found, and a list of issues. Each issue has:

- `rule` and `ruleId`: the rule's number (1 to 9) and stable identifier, such as `9` and `file-integrity`;
- `file`: the bundle file, or `null` for the directory;
- `field` (a dotted path) or `line` (1-based) when one applies;
- `message`: a plain sentence saying what was expected and what was found.

Issues are sorted by rule, then file; within those they keep the checks' deterministic order (line order, then the schema's error order), so the same bundle always gives the same report. At most 20 line-level issues are listed per file and rule, followed by one issue stating how many more there were.

**Then evidence.** Intake admits a bundle for investigation only after `validateBundle` reports it valid. Admission itself (`openEvidence`) is a separate operation that never reads the answer file and re-checks the files it reads; no function combines the two, so the validation report, which names the bundle directory, never travels with the evidence ([ADR 0003](0003-ground-truth-isolation.md)).

**Limits.** Files are read whole into memory: a real bundle is under 20 MB. Streaming is deferred until bundles grow.

## Consequences

- **Positive:** one report says everything wrong with a bundle, deterministically, with the file and rule to fix.
- **Positive:** pinning the vendored schema checksums makes a contract change visible.
- **Negative:** a whole-file read limits bundle size to available memory.
- **Revisit if:** bundles exceed about 200 MB, or bundles must arrive over a network.
