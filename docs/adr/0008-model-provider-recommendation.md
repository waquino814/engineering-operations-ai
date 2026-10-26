# 0008: Model provider recommendation

- **Status:** Proposed (2026-10-26). A recommendation only: no adapter is implemented, no credential exists, and no external call has been made. **Not ready for approval** until the facts in "Verification required before approval" are checked against the provider's current official documentation. Choosing the provider is the owner's decision; if approved, this becomes the amendment to [ADR 0002](0002-ai-provider-and-external-api-policy.md) that ADR 0002 anticipates.
- **Date:** 2026-10-26
- **Depends on (accepted):** [0002](0002-ai-provider-and-external-api-policy.md) (port, opt-in external calls, credentials, budgets), [0003](0003-ground-truth-isolation.md). Proposed companions: [0006](0006-investigation-pipeline-and-limits.md) (port, token budget), [0007](0007-evidence-grounding-and-output-validation.md).

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

## Not done in this change

- No `@anthropic-ai/sdk` dependency was added; `test/architecture.test.ts` still forbids provider SDKs, and would be relaxed for an adapter directory only.
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
