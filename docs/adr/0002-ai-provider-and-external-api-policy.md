# 0002: AI provider and external API policy

- **Status:** Accepted (2026-10-26), approved by the repository owner after the E1 review. The model and provider themselves are still to be chosen in E2, as an amendment.
- **Date:** 2026-10-26

## Context

The investigation backend (E2) will use a language model to reason over incident evidence. No source document names a model or provider, or says whether external API calls are allowed; Commerce Platform's "no LLM calls" rule ([its ADR 0001](commerce-platform/0001-local-first-architecture.md)) binds only that repository. External calls cost money, need credentials, fail in ways tests must not depend on, and send evidence off the machine.

## Decision

**Provider independence.**

- The investigation domain depends on a small model port, an interface defined in E2 that takes structured prompts and returns structured output. Provider SDKs live only in adapters behind that port.
- The model and provider are chosen in E2, as an amendment to this ADR, after comparing quality, cost and data handling on the bundles. A local model is an acceptable adapter.

**When external calls are permitted.** All of these must hold:

- The operator has enabled it explicitly, through configuration (`EOAI_MODEL_PROVIDER` and the provider's credential variable). With no configuration, there is no external call.
- The run is not a test or CI run. Tests and CI use a deterministic fake adapter and never hold credentials.
- The input contains only evidence the investigator may see: the manifest view and telemetry files, never `ground_truth.json` ([ADR 0003](0003-ground-truth-isolation.md)).

**Credentials and configuration.**

- Credentials come only from environment variables, are validated at startup, and are never logged, written to results, or committed. A `.env` file, if used, is ignored by Git; an `.env.example` documents names only.
- The model name, timeouts, retry count and budget are explicit configuration, recorded in each investigation result ([ADR 0004](0004-investigation-result-contract.md)).

**Cost control.** Each investigation has a hard budget: maximum model calls, input and output tokens, and wall-clock time. Exceeding any of them stops the investigation with an explicit `budget_exceeded` outcome, never a partial result presented as complete. Token and call usage is recorded in the result.

**Failure handling.**

- Timeouts and a bounded number of retries, with backoff, only for transient errors (rate limits, 5xx, network).
- Authentication, invalid-request and content-policy errors are not retried.
- A failed investigation records the failure class; it never fabricates findings to fill the gap.

**Untrusted evidence.** Telemetry text (log messages, span attributes, labels) is data, not instructions, and is passed to a model in a form that keeps it separate from the prompt's instructions.

## Consequences

- **Positive:** E1 and the tests incur no cost and need no credentials. Switching provider means writing one adapter.
- **Positive:** budgets make a run's cost bounded and visible.
- **Negative:** the port has to be designed without knowing the provider; E2 may need to amend it.
- **Revisit if:** a provider is chosen (E2), or bundles must not leave the machine, which would require a local model.
