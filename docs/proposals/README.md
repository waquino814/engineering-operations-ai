# Proposals

**Status of everything in this directory: proposed, not accepted.** These documents prepare owner decisions that the [roadmap](../roadmap.md) lists as open. They do not change an accepted ADR, the result contract, the incident-bundle contract, scoring v0.1 or any acceptance criterion. Nothing here is a requirement until the owner approves it and it is recorded as an ADR or in the roadmap.

Each proposal says what exists today (verified in the repository, with the file that shows it), what is proposed, what each option can and cannot establish, and the exact approval needed. Where a proposal has a code part that the existing requirements already justify, the part is marked **implemented** and the rest stays proposed.

| Document                                             | Decision it prepares                                                                   | Roadmap item it unblocks                                                 |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| [decision-register.md](decision-register.md)         | Every open owner decision in one place, with options, cost and safety, recommendation  | E5 to E7 owner reviews (ADRs 0006 to 0009 and 0013)                      |
| [remediation-scoring.md](remediation-scoring.md)     | A machine-checkable remediation outcome, or a reviewed rubric                          | E7 "Remediation scoring"                                                 |
| [finding-assessment.md](finding-assessment.md)       | Whether a finding's evidence supports it and explains the symptom                      | E7 "Whether evidence semantically supports a finding", "Symptom scoring" |
| [observability.md](observability.md)                 | Logging and metrics beyond the stored run; the opt-in event stream already implemented | E7 "Reliability, observability"                                          |
| [commerce-data-request.md](commerce-data-request.md) | The bundles Commerce Platform would need to provide for a real held-out evaluation     | E7 "Held-out seeds", "A held-out scenario", "Varied-timing bundles"      |

No proposal here asks for, or permits, a hosted provider, a paid service, a credential or a model call. The [absolute no-additional-spending policy](../roadmap.md#milestone-order) governs all of them.
