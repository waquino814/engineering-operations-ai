# 0008: Model provider recommendation

- **Status:** Accepted by the owner (2026-10-27) as the first provider; **superseded in part the same day** by the absolute no-additional-spending policy and [ADR 0013](0013-zero-spend-local-inference.md) (see "Supersession note"). The original status text follows as history: Accepted by the owner (2026-10-27) as the first provider, with the derived provider-safe schema and full internal result validation retained, and `@anthropic-ai/sdk` approved for the adapter directory only. **Not confirmed**: acceptance criteria 3 and 4 below are open, and no credential, budget or real call has been approved or made. It is the amendment to [ADR 0002](0002-ai-provider-and-external-api-policy.md) that ADR 0002 anticipates.
- **Date:** 2026-10-26
- **Depends on (accepted):** [0002](0002-ai-provider-and-external-api-policy.md) (port, opt-in external calls, credentials, budgets), [0003](0003-ground-truth-isolation.md). Proposed companions: [0006](0006-investigation-pipeline-and-limits.md) (port, token budget), [0007](0007-evidence-grounding-and-output-validation.md).

## Supersession note (2026-10-27)

This record is kept as history; the text below it is not rewritten. The owner has since set a policy that overrides its operational parts:

> **Absolute no-additional-spending constraint:** No application path, configuration setting, provider selector, UI control, or command-line option may initiate a hosted AI request or incur additional AI-service charges. Only deterministic fake execution and verified local-only inference are permitted. If local-only operation cannot be verified, execution must fail closed.

What this means for ADR 0008:

- **Hosted execution is out of the runnable application.** The runnable application may allow only the `fake` and `local` providers ([ADR 0013](0013-zero-spend-local-inference.md), proposed). The Anthropic adapter, its mapping, derived schema, tests and the pinned SDK stay in the repository, but must be unreachable from runnable application execution. No provider selector, credential, environment variable or UI option may enable hosted execution.
- **Withdrawn:** "Configuration" (`EOAI_MODEL_PROVIDER=anthropic`, `ANTHROPIC_API_KEY`), and acceptance criteria 3 and 4 (a budgeted real-bundle evaluation; cost and data-handling acceptance). No hosted evaluation, account-specific verification or live check is planned, and the rows of "Verification required before approval" that need an account or a live request will not be pursued.
- **Retained as record:** the documentation-based verification (2026-10-27), the derived-schema decision and the adapter's unit-tested mapping, which remain correct descriptions of that adapter.
- **Implementation follow-up, not done here:** `src/providers/select.ts` can still construct the Anthropic provider when `EOAI_MODEL_PROVIDER=anthropic` is set. The application layer's provider gate (ADR 0012, ADR 0013) must make that unreachable from runnable execution, with tests; the gate now exists in `src/app/provider-gate.ts` (uncommitted, 2026-10-27): the application and CLI never import `src/providers/`, enforced by `test/architecture.test.ts`. `selectProvider` itself is unchanged and unused by runnable code.

## Context

ADR 0002 keeps the domain provider-neutral and defers the model choice to E2, "after comparing quality, cost and data handling on the bundles". The E2 foundation defines the port, a fake provider, strict output validation and an evaluation harness ([ADRs 0006](0006-investigation-pipeline-and-limits.md), [0007](0007-evidence-grounding-and-output-validation.md), [0009](0009-evaluation-harness-and-scoring.md)). No real model has run on a bundle yet, so a quality comparison does not exist. This record therefore recommends a first adapter, and names what must be measured before the recommendation is confirmed.

What the workload needs:

- Reasoning over a few hundred kilobytes of mixed JSON telemetry. The request is bounded by `maxContextBytes`, default 200,000 bytes.
- One JSON object back that satisfies a closed schema, with exact identifiers quoted from the input.
- Distinguishable error classes (rate limit, overload, authentication, invalid request) to map onto the port's `ProviderError` kinds.
- An official TypeScript SDK, so the adapter stays thin.

## Options considered

- **Anthropic Claude API, through the official TypeScript SDK `@anthropic-ai/sdk`** (recommended).
- **Another hosted provider.** Comparable in shape; it was not evaluated in this change, and the port keeps it open.
- **A local model.** It needs no credentials, and no evidence leaves the machine. Whether one can follow the closed schema and quote identifiers exactly over this much JSON is unmeasured. It remains the fallback if bundles must not leave the machine (ADR 0002, "Revisit if").

## Recommendation

A first hosted adapter for the Anthropic Messages API. The statements below come from the Claude API reference bundled with Claude Code (its model table is dated 2026-10-06). They were **not** re-checked against Anthropic's live documentation in this repository, and none was tested against the API; see "Verification required before approval".

- **Model.** `claude-opus-5-5` (Claude Opus 5.5) as the default: 1M-token context, 128K maximum output, $4 / $20 per million input / output tokens. Thinking is always on, and depth is set with `output_config.effort` (default `medium`). Effort is the first cost lever to measure, before a cheaper model. Claude Sonnet 5.5 (`claude-sonnet-5-5`, $2 / $10) is the candidate to compare against on the same bundles.
- **Structured output.** `output_config.format` with a JSON schema constrains the reply to `MODEL_OUTPUT_SCHEMA`. The adapter still returns raw text, and the domain still parses and verifies it ([ADR 0007](0007-evidence-grounding-and-output-validation.md)). Constrained decoding reduces repairs; it does not replace verification. Forced `tool_choice` is rejected on this model, so tool use is not the route to JSON.
- **Limits.** `max_tokens` maps from `ModelRequest.maxOutputTokens`. Large outputs need streaming in the SDK, which the adapter would use, collecting the final message. The response's `usage` maps to `ModelReply.usage` (ADR 0006): output from `output_tokens`; input as the sum of `input_tokens`, `cache_creation_input_tokens` and `cache_read_input_tokens`, since cached input is still input. If a field is absent, the adapter leaves that count out rather than writing zero, so the investigator charges the ceiling.
- **Errors.**
  - The SDK has typed errors: `RateLimitError` (429) becomes `rate_limited`, with `retry-after` as `retryAfterMs`; 5xx and connection errors become `unavailable`; a timeout becomes `timeout`; `AuthenticationError` becomes `authentication`; `BadRequestError` becomes `rejected_request`.
  - The SDK's own retries (two by default) must be set to zero, so that retries are counted once, by the investigator, against `maxModelCalls`.
  - A `stop_reason` of `refusal` or `max_tokens` is not a reply. The adapter raises `rejected_request` for the first; for the second it returns the text, which then fails parsing and goes through repair.
- **Data handling.** Selected telemetry leaves the machine. Before any real run, the owner should confirm the organisation's data-retention terms for the chosen model; some Claude models, such as the Fable tier, require 30-day retention and are refused under zero data retention. The ground truth never leaves: the investigator cannot read it ([ADR 0003](0003-ground-truth-isolation.md)), and the evaluation harness checks every request for answer values.

**Configuration**, as ADR 0002 requires: `EOAI_MODEL_PROVIDER=anthropic` and `ANTHROPIC_API_KEY` are read only by the adapter, at startup, and are never logged. The model ID and effort are explicit configuration recorded in `run`. With nothing configured, the pipeline uses no external provider. Tests and CI keep the fake.

## Verification required before approval

Each item is an assumption of this repository until checked against the provider's current official documentation, and, where it says so, measured in an opt-in, operator-run test. None of these checks makes an API call from this repository's tests.

| Fact                                                                                                                                                                      | Source today                             | How to verify                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Model IDs `claude-opus-5-5`, `claude-sonnet-5-5` exist and are available to the owner's account and region                                                                | bundled reference, 2026-10-06            | Models API (`GET /v1/models`) with the owner's key; models documentation                           |
| Structured output (`output_config.format`) accepts `MODEL_OUTPUT_SCHEMA` as is; which keywords it supports (`pattern`, `prefixItems`, `minItems`/`maxItems`, `maxLength`) | bundled reference names the feature only | structured-outputs documentation; a dry run of the schema in an operator test                      |
| Thinking is always on for Claude Opus 5.5, effort defaults to `medium`, and thinking tokens count toward `max_tokens` and `output_tokens`                                 | bundled reference                        | models and extended-thinking documentation                                                         |
| SDK retries: default 2, on 408/409/429/5xx and connection errors; `maxRetries: 0` disables them                                                                           | bundled reference                        | `@anthropic-ai/sdk` README for the pinned version                                                  |
| Usage fields and their meaning, including cache fields; whether rejected requests (429, 529, 4xx) consume tokens                                                          | assumption                               | Messages API and rate-limit documentation; decides when an adapter may report zero usage on errors |
| Pricing: $4 / $20 (Opus 5.5) and $2 / $10 (Sonnet 5.5) per million input / output tokens                                                                                  | bundled reference, 2026-10-06            | pricing page on the day of approval                                                                |
| Rate limits for the owner's tier, and `retry-after` behaviour                                                                                                             | not known                                | rate-limit documentation and the account's console                                                 |
| Data retention and training terms for API inputs; zero-data-retention eligibility of the chosen model                                                                     | partly (Fable tier needs 30 days)        | commercial terms and privacy documentation; the organisation's agreement                           |
| Tokens per byte for this telemetry, to confirm `maxInputTokensPerCall` (default 200,000) bounds a 200,000-byte request                                                    | assumption                               | token-counting endpoint on the excerpt and a real bundle's request, operator-run                   |

## Verification record (2026-10-27)

Checked against platform.claude.com documentation (models overview, structured outputs, TypeScript SDK). No API call was made.

| Fact                                                       | Result                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model IDs, 1M context, 128K max output, pricing            | **Confirmed**: `claude-opus-5-5` $4 / $20, `claude-sonnet-5-5` $2 / $10 per MTok. Opus 5.5 thinking is adaptive and always on, default effort `medium`. Sonnet 5.5 defaults to `high`, not `medium`. Availability to the owner's account is still unchecked.                                                                                                                                                                             |
| Structured output via `output_config.format`               | **Confirmed, but `MODEL_OUTPUT_SCHEMA` is not accepted as is.** Unsupported: `minLength`/`maxLength`, `minimum`/`maximum`, `maxItems`, `minItems` above 1, `additionalProperties` other than `false` (a 400 error). `pattern` is supported in simple forms. `prefixItems` is undocumented. The adapter therefore sends a derived schema (`src/providers/anthropic/wire-schema.ts`) and the investigator still validates the full schema. |
| Refusal and `max_tokens`                                   | **Confirmed**: a refusal is HTTP 200 and billed, and its output may not match the schema; `max_tokens` can truncate invalid JSON. Matches the mapping above.                                                                                                                                                                                                                                                                             |
| SDK retries and errors                                     | **Confirmed**: default 2 retries on connection errors, 408, 409, 429 and 5xx; `maxRetries: 0` disables. Error classes by status as mapped. A non-streaming request with a large `max_tokens` is rejected by the SDK, so the adapter streams.                                                                                                                                                                                             |
| Usage fields, and whether failed calls consume tokens      | **Open.** Cache field names are not on the pages read. The 429/529/4xx question is unresolved, so every error is charged at its ceiling.                                                                                                                                                                                                                                                                                                 |
| Rate limits, data retention and ZDR terms, tokens per byte | **Open**: need the owner's account, agreement and an operator-run token count.                                                                                                                                                                                                                                                                                                                                                           |

## Not done in this change

- Added in E5 (no network): the pure request, usage, error and reply mapping, the derived wire schema, and the streaming `AnthropicProvider` over an injected client, in `src/providers/anthropic/`, with unit tests using a stubbed client. `@anthropic-ai/sdk` 1.0.0 (pinned; the first release on API version 2026-10-21) is a dependency, imported only by `provider.ts`; `test/architecture.test.ts` enforces that.
- Provider selection (`src/providers/select.ts`): `EOAI_MODEL_PROVIDER` unset, empty or `fake` gives the fake provider; `anthropic` requires `ANTHROPIC_API_KEY` and `EOAI_ANTHROPIC_MODEL` (no default model), with optional `EOAI_ANTHROPIC_EFFORT`. Any other value, or a missing setting, throws `ProviderConfigError` naming variables, never values; there is no fallback in either direction. It takes the environment as an argument and makes no request. The variable names for model and effort are this change's choice, as the ADR named only the first two.
- Not yet done: calling `selectProvider` from an application startup (none exists before E6's boundary ADR; the CLI only validates bundles); the opt-in real-bundle evaluation.
- The architecture guard still forbids every other provider SDK, and the Anthropic SDK outside the adapter directory.
- No API call, no key, no cost.

## Acceptance before this is confirmed

1. The facts above are verified and recorded here with their sources and dates.
2. The adapter is behind the port, with its error and usage mapping unit-tested against SDK error and response shapes, and no network in tests.
3. An opt-in, operator-run evaluation over real bundles, with a budget agreed in advance, reports per-case outcome, repairs, verified-reference rate and root-cause accuracy, for Claude Opus 5.5 at two effort levels and Claude Sonnet 5.5.
4. The owner accepts the cost per investigation and the data-handling terms.

## Consequences

- **Positive:** a widely documented SDK with typed errors, schema-constrained output and usage reporting fits the port with little code.
- **Negative:** evidence leaves the machine, and runs cost money; both are opt-in and bounded.
- **Negative:** the recommendation is based on documented capabilities, not measured quality on these bundles.
