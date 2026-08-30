# Security Hardening Proposal: Own a privacy-safe operational evidence plane

## Decision

Choose where the project should own application, provider, delivery, and freshness evidence without creating a movement database or turning request metadata into a new privacy surface.

## Executive Recommendation

We have three serious choices.

1. **Extend the existing regional contract:** add a versioned, allowlisted operational-health contract to the existing regional Durable Objects and explicit health route. Keep invocation logs disabled. This is the recommended local R3 option.
2. **Create a central OperationsLedger:** send coarse events from the Worker and each region to one dedicated Durable Object. This gives stronger deployment-wide correlation at the cost of a new availability and write-amplification boundary.
3. **Use Cloudflare-native analytics:** combine native Worker and Durable Object metrics with privacy-minimized Analytics Engine points. This is attractive for hosted operations, but it depends on G1 account policy, vendor retention, adaptive sampling, and external authorization.

I inspected the current health, polling, metric, delivery, storage, and release boundaries. The existing regional coordinator already owns the most trustworthy provider state and a tested aggregate-only retention model. Under the current local-first and free-tier-conscious constraints, I recommend Option 1. Option 3 can supplement it after G1 validates the account policy. Option 2 becomes preferable only if the project later needs exact cross-region correlation that cannot be satisfied by on-demand regional aggregation and platform-native availability metrics.

## Evidence

| Evidence        | Finding or document                  | What it establishes                                                                                                                                                                |
| --------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `E03`           | Ultra roadmap R3 exit gate           | R3 requires application and provider SLIs, privacy inspection, operator-visible failure classification, and safe disablement.                                                      |
| `E15`           | Worker route and health boundary     | `/api/v1/health` performs an explicit bounded read of all three regional objects, but its top-level status remains `ok` whenever the reads themselves succeed.                     |
| `E17`           | Thirty-day aggregate feed metrics    | Per-region storage already retains hourly poll, success, failure, rate-limit, validation, aircraft-count, and latency buckets for 30 days.                                         |
| `E19`           | Regional polling and health state    | The coordinator distinguishes disabled, connecting, live, degraded, retry-blocked, and sequence-exhausted provider states and persists only control fields plus aggregate metrics. |
| `E13`           | Bounded acknowledged delivery        | Exact ACK windows, delivery bytes, send failures, and timeouts are enforced, but historical aggregate ACK health is not exposed to the health contract.                            |
| `E11`           | Aggregate metric privacy tests       | Tests prove the current metric record excludes aircraft IDs, callsigns, registrations, latitude, and longitude and expires at 30 days.                                             |
| `E20`           | Disabled observability configuration | Worker observability and invocation logs are explicitly disabled in the checked configuration.                                                                                     |
| `W01`           | Cloudflare Durable Objects metrics   | Namespace, request, memory, and WebSocket metrics can be queried outside application storage.                                                                                      |
| `W02`           | Cloudflare Workers Logs              | Invocation logs contain request, response, and related metadata and have plan-dependent retention.                                                                                 |
| `W03` and `W04` | Analytics Engine limits and sampling | Custom aggregate points are bounded and retained for three months, but adaptive sampling is not exact event accounting.                                                            |

The observed facts are that provider health is already precise per region, storage is already minimized, and delivery correctness is already enforced. The structural inference is that operational evidence has no single privacy owner: provider metrics live in each region, delivery outcomes live in socket attachments and transient control flow, route availability is external, and the top-level health response does not classify application failure separately from upstream stale or empty data.

## Current Design And Failure Mode

The current design deliberately avoids ordinary logging. That is a strong privacy default, but it also means we can answer only part of an operator's first question during an incident: is the application broken, or is the upstream feed stale, empty, rate-limited, or disabled? A successful `/health` request proves that the Worker and three Durable Object reads completed. Each regional payload then exposes useful state. It does not produce one versioned operational contract for application reachability, WebSocket establishment, admission rejection, validation rejection, ACK health, provider age, contact age, position age, and error class.

The gap is not missing raw detail. Adding aircraft identifiers or request-level logs would make the design worse. The gap is ownership of a small allowlisted set of aggregate facts and reason codes, bound to the same build and release identity as the user-visible Evidence route.

## Desired Invariants

- Every operational field is explicitly allowlisted by a versioned schema before it can be stored, returned, or attached to release evidence.
- Operational evidence never contains aircraft IDs, callsigns, registrations, coordinates, trails, provider payloads, request IP addresses, user-agent strings, full URLs, or client-generated identifiers.
- Application, provider, delivery, admission, and freshness states remain distinguishable. `empty`, `stale`, `rate-limited`, `disabled`, and `application-unavailable` are not collapsed into one generic failure.
- Stored application-owned aggregates expire at or before the declared 30-day boundary.
- The health read remains explicit, bounded, same-origin, poll-free, and unable to start provider work.
- Exact delivery safety remains enforced by the existing ACK state machine. Operational counters may summarize it, but never replace its correctness tests.
- Static and API availability claims come from release-bound synthetic probes or platform metrics, not from an endpoint claiming its own availability.

## Constraints And Non-Goals

- We must preserve the three fixed regional objects, viewer-driven polling, no persistent aircraft snapshot, and current provider-neutral contract.
- We should not add an unauthenticated operations endpoint, request tracing IDs derived from users, or a database of individual events.
- We do not yet know the approved Cloudflare plan, account-level retention settings, alerting destination, or operating budget.
- Local evidence cannot measure global platform availability.
- The design is not an exact billing or safety accounting system.

## Before Architecture

[Before architecture](../diagrams/operational-evidence-before.mmd)

The before view shows why the existing health endpoint is useful but incomplete. It can read each region's current state and stored poll aggregates. Worker-route availability and delivery history sit outside that contract, while platform metrics are not yet tied to release evidence.

## Options

### Option 1: Extend the existing regional contract

This option keeps the current trust boundary and adds a strict `operations.v1` projection. Each `RegionalFeedHub` would expose only aggregate provider, freshness, viewer, delivery, and validation buckets. The top-level health route would classify application, provider, delivery, and freshness independently and return stable reason codes. Static/API reachability would remain a release-bound synthetic probe rather than a self-reported percentage.

The attractive part is reuse. Provider cadence, retry state, last success, provider-generated time, validation counts, and metric retention already belong to the regional owner. Delivery counters can be accumulated in memory and flushed at a bounded interval, with an explicit best-effort label if a hibernation loses an unflushed operational count. We should not write on every ACK, because that would convert a safety signal into avoidable storage amplification. Exact ACK enforcement continues in `RegionalDelivery`; the SLI is a bounded summary.

What gives me pause is aggregation precision. A health request can accurately classify current regional state, but historical application availability still needs synthetic probes or platform metrics. That limitation should remain visible rather than being hidden behind a false deployment-wide percentage.

[Option 1 architecture](../diagrams/operational-evidence-regional-contract-after.mmd)

| Change        | Before                                | After                                                          | Security consequence                                  | Cost                                        |
| ------------- | ------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------- |
| Health schema | Top-level `ok` plus regional payloads | Versioned application/provider/delivery/freshness states       | Reduces ambiguous incidents without exposing raw data | Schema, parser, UI, and compatibility tests |
| Metrics       | Provider poll aggregates only         | Allowlisted provider plus coarse delivery/admission aggregates | One privacy owner and one denylist scanner            | Bounded periodic writes and reads           |
| Availability  | Implicit local/browser checks         | Release-bound synthetic probe evidence                         | Prevents self-certifying availability claims          | CI and G1 probe work                        |
| Retention     | Provider aggregates at 30 days        | All application-owned operational aggregates at 30 days        | Preserves the no-movement-database boundary           | Cleanup and corruption tests                |

### Option 2: Create a central OperationsLedger

A dedicated `OperationsLedger` Durable Object would receive coarse event classes from the Worker, every regional coordinator, and delivery layer. It could correlate route results, admissions, WebSocket establishment, provider outcomes, and ACK outcomes into one deployment-wide contract. A single owner makes cross-region windows and alert thresholds easier to reason about.

The strongest case for this option is accuracy and consistency. One schema and one transaction owner can reject unknown dimensions and apply one retention policy. It also avoids asking the health route to synthesize historical meaning from three independent stores. The central ledger, however, becomes a new hot path and availability dependency. If every request or ACK reports an event, cost and subrequest amplification can become worse than the observability gap. Buffering reduces writes but introduces loss and recovery semantics. A failure in the ledger must never block airspace delivery, which makes the metrics necessarily lossy or demands a queue.

I would be comfortable with this option only after a measured G1 workload shows that bounded batching stays comfortably inside the approved request, write, CPU, and duration envelope, and only if deployment-wide exact correlation becomes a real operator requirement.

[Option 2 architecture](../diagrams/operational-evidence-ledger-after.mmd)

| Change        | Before                                            | After                                      | Security consequence                                     | Cost                                         |
| ------------- | ------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------- | -------------------------------------------- |
| Control owner | Metrics split across regional and transient state | One aggregate ledger                       | Strongest schema and retention ownership                 | New privileged stateful component            |
| Event flow    | No telemetry subrequests                          | Coarse event submissions                   | Better correlation, larger abuse and failure surface     | Additional subrequests, writes, buffering    |
| Availability  | Regional paths independent                        | Ledger must fail open for product delivery | Metrics failure is containable if explicitly nonblocking | More complex retry and loss semantics        |
| Operations    | Read three current states                         | Query one historical view                  | Simpler dashboards                                       | New deployment, migration, and rollback work |

### Option 3: Use Cloudflare-native analytics

This option keeps application storage narrow and uses Cloudflare's native Worker and Durable Object metrics for requests, CPU, memory, storage, and WebSocket activity. A small Analytics Engine binding could accept only numeric counters and low-cardinality enum labels for provider and delivery outcomes. Invocation logs would remain disabled.

This is appealing because global platform availability and resource evidence belong at the platform layer. It avoids building a custom global ledger and can observe static-asset and Worker behavior that an application endpoint cannot. The cost is external policy. Analytics Engine retains data for three months and uses adaptive sampling, so it is suitable for aggregate trends, not exact receipts. Account roles, dataset access, retention, billing, and export policy become part of the privacy boundary. None of those settings have been inspected in this local review.

Option 3 should therefore be a G1 supplement, not the only local contract. It becomes preferable when Kato approves the account policy and when the product needs hosted availability and resource dashboards more than exact application-owned event counts.

[Option 3 architecture](../diagrams/operational-evidence-platform-after.mmd)

| Change              | Before                       | After                                      | Security consequence                                      | Cost                                      |
| ------------------- | ---------------------------- | ------------------------------------------ | --------------------------------------------------------- | ----------------------------------------- |
| Platform visibility | Unbound account metrics      | Release-linked native metrics              | Covers availability and resources without raw app storage | Account configuration and access control  |
| Custom metrics      | None                         | Numeric, low-cardinality points            | Can remain identifier-free by construction                | Three-month vendor retention and sampling |
| Logs                | Disabled                     | Invocation and custom logs remain disabled | Avoids request metadata becoming routine evidence         | Less incident-level detail                |
| Portability         | Provider-neutral application | Cloudflare-specific operations layer       | Runtime data plane remains portable, operations less so   | G1-only setup and ongoing review          |

## Comparison

| Dimension   | Option 1: regional contract                              | Option 2: central ledger                                      | Option 3: native analytics                                                              |
| ----------- | -------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Security    | Improves privacy ownership with smallest new surface     | Improves central enforcement but adds a privileged event sink | Improves platform visibility if labels stay allowlisted; vendor policy becomes in scope |
| Performance | Small bounded regional reads and periodic aggregate work | Adds cross-component submissions and possible serialization   | Low application overhead, external write and query path                                 |
| Memory      | Small regional counters                                  | Buffers and central window state                              | Minimal application memory                                                              |
| Reliability | Preserves existing regional failure isolation            | Ledger must fail open and tolerate loss                       | Depends on platform analytics availability and sampling                                 |
| Operability | Best fit for current local workflow                      | Strongest custom historical view, highest burden              | Strong hosted dashboards after G1                                                       |
| Migration   | Incremental and reversible                               | New binding, object migration, event plumbing                 | New account binding, policy, queries, and access roles                                  |

## Recommendation

I recommend Option 1 under the current constraints. It closes the largest local ambiguity while preserving the project's strongest privacy and reliability decisions. We should design its schema so Option 3 can later consume the same enum and counter vocabulary without changing product semantics. We should not implement Option 2 until measured usage and an operator need justify its write and availability costs.

This recommendation changes if G1 confirms that native metrics fully cover the required availability and WebSocket SLIs with acceptable privacy and retention, or if cross-region historical correlation becomes an explicit release requirement.

## Evidence Coverage And Residual Risk

| Evidence                            | Option 1                                | Option 2                         | Option 3                                     | Tactical protection still required                       |
| ----------------------------------- | --------------------------------------- | -------------------------------- | -------------------------------------------- | -------------------------------------------------------- |
| `E15` — Worker health ambiguity     | Addresses with typed top-level states   | Addresses through the ledger     | Mitigates through dashboards                 | Keep explicit bounded health read                        |
| `E17` — Existing aggregate metrics  | Extends                                 | Replaces or mirrors              | Supplements                                  | Preserve 30-day cleanup until migration proves otherwise |
| `E13` — ACK outcomes not aggregated | Mitigates with coarse regional counters | Addresses with central events    | Mitigates with custom points                 | Exact ACK enforcement and tests remain authoritative     |
| `E11` — Privacy retention tests     | Extends to the new schema               | Must be recreated for the ledger | Must be enforced by label and account policy | Recursive forbidden-field and storage inspection tests   |
| `E20` — Logs disabled               | Preserves                               | Preserves                        | Preserves invocation-log disablement         | Artifact test must reject accidental log enablement      |

Residual risk remains that platform infrastructure processes request metadata outside application storage, a permitted client can redistribute public data, synthetic probes do not represent every geography, and aggregate metrics can hide rare events. The design must keep those limitations visible.

## Migration And Rollout

For Option 1, introduce the schema and pure classifier first. Add it behind the existing explicit health action, with no browser polling. Extend regional counters in bounded increments and preserve the old health fields for one compatibility window. Inspect Durable Object storage, browser storage, downloaded reports, screenshots, and built artifacts for forbidden fields. Roll back by disabling the new projection while retaining the existing health response and all product routes.

Option 2 would require a separate migration plan, binding, ledger schema, fail-open event client, bounded batching, retention alarm, load model, and rollback that removes the event path without touching Live delivery. Option 3 must wait for G1 account, budget, retention, role, and dataset approval.

## Validation Plan

- Unit-test every state classification: application unavailable, provider disabled, never connected, empty, stale, rate-limited, retrying, delivery degraded, and live.
- Property-test the operational schema and reject unknown keys, unbounded text, identifiers, coordinates, payloads, IPs, URLs, and user agents recursively.
- Inspect real local Durable Object storage before and after success, failure, inactivity, cleanup, and restart.
- Prove the health read performs no provider poll and remains bounded, abortable, same-origin, and user initiated.
- Add delivery counter fault tests for ACK success, timeout, send failure, invalid control, and hibernation loss labeling.
- Benchmark added reads, writes, CPU, and response bytes under the existing smoke and maximum profiles. Decision threshold: no release gate regression and preserved operating headroom.
- At G1 only, compare application aggregates with native Worker and Durable Object metrics and document sampling or attribution gaps.

## Implementation Work Packages

1. Define `operations.v1`, reason codes, privacy allowlist, compatibility policy, and stable tests.
2. Add bounded regional aggregate snapshots and coarse delivery/admission counters without per-aircraft or per-client dimensions.
3. Classify top-level application, provider, delivery, and freshness states in the explicit health route.
4. Render the contract in Evidence without background polling and preserve static Evidence when unavailable.
5. Add storage, report, screenshot, browser-persistence, and build-artifact privacy inspection.
6. Add release-bound synthetic availability receipts locally, then connect platform metrics only after G1 approval.

## Open Questions

- Is best-effort delivery SLI history acceptable locally, or does the release require exact ACK accounting?
- Which operational windows are useful: current, one hour, 24 hours, or all three?
- Should aircraft-count aggregates remain in operational evidence, or should privacy minimization remove them despite their current aggregate-only status?
- Which Cloudflare account roles, retention settings, and alert destinations would Kato approve at G1?
