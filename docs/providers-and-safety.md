# Providers and safety

What produces an investigation's text, what is simulated, and the local-only safety requirement. Authoritative sources: [ADR 0012](adr/0012-application-boundary.md), [ADR 0013](adr/0013-zero-spend-local-inference.md) (both **partly accepted**), [ADR 0002](adr/0002-ai-provider-and-external-api-policy.md) as amended, and the [roadmap](roadmap.md).

## The policy

Owner policy of 2026-10-27 ([roadmap](roadmap.md#milestone-order)):

> No application path, configuration setting, provider selector, UI control, or command-line option may initiate a hosted AI request or incur additional AI-service charges. Only deterministic fake execution and verified local-only inference are permitted. If local-only operation cannot be verified, execution must fail closed.

In code, `PERMITTED_PROVIDERS = ['fake', 'ollama']` ([`src/app/provider-gate.ts`](../src/app/provider-gate.ts)). It is not configurable: any other name, including `anthropic` and the retired `local`, is refused at startup or on request. A dormant hosted adapter remains in the source tree for history and is not imported by the application layer.

## Scripted, simulated and real

| Kind                 | Where it appears                                           | What it is                                                                                                                                                                                  | Measures a model?                      |
| -------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| **Scripted**         | Evaluation suites, tests                                   | A test double replaying a reply written in advance for each case, including deliberately wrong, conflicting and fabricated ones. Tests pipeline, verification and scoring.                  | No                                     |
| **Simulated (Fake)** | Console runs and evaluations with the Fake provider        | Deterministic placeholder output, labelled `Simulated · simulated-deterministic-v1` in the list, detail, limitations and remediation. Cites the first record of each file by position.      | No                                     |
| **Real local model** | Console runs and evaluations with Ollama, **when allowed** | Genuine inference by a model already installed in your own Ollama, after the local-only check passes. Output is untrusted model text: parsed strictly, references verified, schema-checked. | Only if you evaluate it; none has been |

The UI always says which one produced a run. A simulated result is not a diagnosis, and its "root cause" shows `No root cause stated`.

## The local-only requirement

Before any prompt is sent, the Ollama adapter requires **all** of:

1. the runtime is on a loopback address (`EOAI_OLLAMA_URL` must be `http` on loopback or startup fails);
2. the runtime's own `GET /api/status` reports its cloud features **disabled**;
3. the model is installed with local weights and known metadata;
4. no unknown remote marker or status field (an unknown field blocks).

If any check fails, the application **fails closed**: it sends nothing, stores nothing, shows the reason in Settings and on Start, and never falls back to another provider or invents findings. It never changes Ollama's settings; to enable local inference you must set `OLLAMA_NO_CLOUD=1` (or `"disable_ollama_cloud": true`) and restart Ollama yourself.

**What this does not guarantee.** The check reads the runtime's report of its own setting. It is not proof about Ollama's code or network behaviour, and it cannot prevent another process on the machine from calling the loopback server. The HTTP server has no authentication and relies on loopback binding, `Host` and `Origin` checks, `application/json` only, a 16 KiB body limit and one run at a time.

## State on the development machine (2026-10-27)

- Ollama there reports `cloud.disabled: false`, so **real local inference is blocked** by the check. Nothing was run against Ollama during the documentation and screenshot work, and the owner's Ollama and saved settings were not changed.
- One real run exists from before the check was tightened: `gemma4:12b` on the synthetic provider-outage bundle, 3 verified findings, 85.6 s. It named the worker as root cause where the answer key says the payment provider, so scoring v0.1 would mark it incorrect. It is a single run on a synthetic bundle, not a quality evaluation.

## Unresolved decisions and facts

Recorded in the ADRs and roadmap; none is resolved by this documentation.

- **Owner review** of the local-only check, and acceptance of ADR 0013 (currently partly accepted). ADRs 0006 to 0009 remain **proposed**.
- The full set of remote markers and status fields Ollama may add over time.
- Whether the output-schema constraint is honoured by every model path (the investigator validates regardless).
- Token accounting for local runs: unreported usage is charged at the configured ceiling (`unreportedCalls` in the run panel); a provider tokenizer has not been verified against `maxInputTokensPerCall`.
- Semantic support of findings is not assessed anywhere.
- Remediation scoring needs an owner-defined rubric.
- A measured evaluation of a local model on real bundles, and varied-timing bundles from Commerce Platform.

## Cost

Everything in this repository's tests, CI, fixtures, evaluation commands (`pnpm eval:synthetic`, `pnpm eval:suite`) and the Fake provider runs without a network or any AI service. `pnpm eval:suite` accepts only `scripted` and `simulated`; `--provider ollama` is a usage error.
