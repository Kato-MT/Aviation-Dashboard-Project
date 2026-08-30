# Security Hardening Review: Aviation Dashboard v3 R3

Selection record: Kato approved Operational Evidence Option 1 (`regional-operations-contract`) plus Runtime Policy Option 2 (`central-runtime-policy-contract`) on 2026-08-29 for local R3 implementation in the `feat/live-airspace-v3` checkout. This approval does not authorize commit, push, provider contact, Cloudflare mutation, billing, deployment, or publication.

## Evidence Basis

This review originally derived two design opportunities from a 26-file pre-implementation inventory at Git revision `80c1e47b1d3662163f297b67e8a3c86477159231`. That digest is historical. The current selected-implementation source is identified by `hardening/r3/selected-evidence.manifest.json`, which pins the exact selected options, 16 requirements, 16 test cases, regular-file evidence inventory, dirty source-content identity, and collection digest. The review did not inspect a Cloudflare account, contact a flight-data provider, enable real aircraft access, deploy, or mutate external state.

The original review found two ownership gaps: operational truth was split between provider and application state, while runtime and release policy was distributed across configuration, Worker, client, artifact, and runbook boundaries. The selected local implementation now closes both gaps through `operations.v1`, one compiled runtime policy and versioned numeric limit contract, sanitized artifacts and response policy, aggregate-only privacy inspection, deterministic browser gates, and candidate-bound runbook and acceptance receipts. Frozen-source and external gates remain separate.

## Constraints

- Keep the implementation local-first, privacy-preserving, provider-neutral, and compatible with the current free-tier-conscious architecture.
- Keep Live disabled by default. Do not deploy, enable billing, contact a provider, or capture real aircraft data during R3 local work.
- Preserve Replay, Lab, Evidence, the unified offline artifact, the v2 dashboard, and the current regional Durable Object design unless a selected option explicitly changes a boundary.
- Store no aircraft identities, callsigns, registrations, coordinates, trails, provider payloads, client IP addresses, or arbitrary error strings in operational evidence.
- Keep the resolved generated artifact path disclosure as a mandatory regression gate. It exposed local workspace identity, not an API credential.
- Require the selected evidence manifest to match the current source and exact approved contract before an R3 gate can pass.

## Opportunity Portfolio

| Opportunity                                   | Evidence                                                                                                                                                                         | Options                                                                                          | Recommendation                                                                    | Proposal                                                           |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Own a privacy-safe operational evidence plane | Regional health aggregation, aggregate metrics, polling state, delivery controls, and explicit Evidence health action (`E15`, `E17`, `E19`)                                      | 1. Extend the regional contract. 2. Add a central ledger. 3. Use platform-native analytics.      | Select Option 1 under the current local-first constraints.                        | [Operational evidence proposal](proposals/operational-evidence.md) |
| Centralize runtime and release policy         | Provider and route allowlists, isolate admission, build policy, candidate retention, deployment configuration, and generated metadata (`E12`, `E18`, `E20`, `E24`, `E25`, `G01`) | 1. Patch distributed controls. 2. Add one typed policy contract. 3. Add a mutable control plane. | Select Option 2, beginning with artifact sanitation and checked response headers. | [Runtime policy proposal](proposals/runtime-policy.md)             |

## Recommendation Summary

I recommend selecting the two options together: extend the existing regional operations contract, and centralize runtime and release decisions in one typed policy contract. They solve different parts of the same release problem. The first makes application health, provider health, freshness, valid-empty airspace, partial regional failure, delivery, and admission outcomes explicit without retaining aircraft detail. The second makes disabled-by-default behavior, provider egress, origin policy, headers, artifact privacy, session shutdown, quotas, performance budgets, and release receipts derive from one reviewable source.

This pair is proportionate because it reuses the current Durable Object ownership model and does not introduce a new hosted service or privileged operator API. The central ledger becomes preferable only if measured usage requires exact cross-region event correlation. A mutable operations control plane becomes preferable only if Kato requires sub-minute remote disablement and first approves an authenticated operator identity model. Platform-native analytics can supplement the selected local contract after G1, but it should not replace exact application-owned health semantics.

The recommended pair is selected and locally implemented on the current dirty tree. The machine-verifiable selected manifest records the exact implementation evidence without claiming that local files prove a retained candidate, hosted behavior, or release. Account-wide quota controls and platform behavior remain G1 evidence; provider authorization and real-source validation remain G2; deployment and publication remain G3.

## Next Decisions

The selected path is item 1. The alternatives remain documented for rollback and future review:

1. **Selected 2026-08-29:** Operational Evidence Option 1 plus Runtime Policy Option 2.
2. Refine one proposal or acceptance threshold before selection.
3. Choose an alternative option and accept its recorded costs and residual risks.
4. Reject either opportunity and keep its current release gate open.

After every material source change, refresh and verify the selected evidence manifest before treating local R3 evidence as current. G1 account inspection, G2 authorized real-source validation, and G3 deployment or publication remain separately authorized gates.
