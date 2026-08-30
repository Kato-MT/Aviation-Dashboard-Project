# Security Hardening Proposal: Centralize runtime and release policy

## Decision

Choose how the project should own source mode, origin and route policy, response headers, admission limits, artifact hygiene, disablement, and operator recovery before any hosted or real-source gate can open.

## Executive Recommendation

We have three options.

1. **Patch and document the current controls:** remove the current artifact-path leak, add static security headers, and write runbooks while leaving policy ownership distributed across existing files.
2. **Create one typed runtime and release policy contract:** validate bindings once, use a closed route table and stable reason codes, keep the kill switch deploy-time and disabled by default, sanitize generated deployment artifacts, and bind runbooks and artifact tests to the same contract. This is the recommended option.
3. **Add a mutable operations control plane:** introduce authenticated runtime pause/quota state and a Cloudflare Rate Limiting binding. This improves emergency control after deployment, but creates a new privileged service and should wait for G1 requirements and account policy.

I inspected the route handler, provider fetch boundary, origin checks, map and WebSocket limits, generated Worker configuration, CSP entries, admission scope, and release firebreak tests. The existing controls are unusually strong for a portfolio project. The issue is not a missing basic allowlist. It is that several release-critical invariants remain distributed or implied, and the generated deploy artifact currently carries absolute local filesystem paths. I recommend Option 2 because it removes that release blocker while making future configuration drift easier to reject before deployment.

## Evidence

| Evidence        | Finding or document                  | What it establishes                                                                                                                                                                    |
| --------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `E18`           | Fixed provider configuration         | The real source is limited to one origin, three fixed point paths, GET, no query, no credentials, and no redirect following; mock dispatch uses only its service binding.              |
| `E15`           | Worker route and origin boundary     | API routes, methods, query strings, stream upgrade, source-disabled state, and explicit WebSocket origins are checked, but raw environment strings are parsed inside request handling. |
| `E12`           | Isolate-local request admission      | Total, health, snapshot, stream, and map controls are bounded, but the declared scope is one Worker isolate.                                                                           |
| `E13`           | Bounded acknowledged delivery        | Regional viewer, byte, message, ACK, and control-rate limits protect each Durable Object.                                                                                              |
| `E16`           | Map route controls                   | Fixed asset manifest, byte ranges, conditions, response bytes, and R2 identity are enforced.                                                                                           |
| `E04` and `E05` | Connected HTML CSP entries           | Connected entries use a restrictive CSP meta policy, but response headers and `frame-ancestors` are not owned by a checked static header file.                                         |
| `E07`           | Static route redirects               | The public directory contains `_redirects` but no `_headers` artifact in the reviewed collection.                                                                                      |
| `E20`           | Disabled-by-default Worker contract  | Production Live mode and observability are disabled; generated configuration still contains local build values.                                                                        |
| `E09`           | Build configuration tests            | Build targets, source identity, offline isolation, and route precedence are tested. The current checks do not reject absolute local paths in generated Worker metadata.                |
| `E10`           | Publication firebreak tests          | Candidate build-once sequencing and v2/v3 publication separation fail closed.                                                                                                          |
| `E24`           | Candidate retention boundary         | Retention copies generated artifact text without a general absolute-path privacy filter.                                                                                               |
| `E25`           | Live build configuration             | Local connected origins are compiled into the unreleased production-disabled build, so a real release target needs a separate validated origin contract.                               |
| `G01`           | Generated Worker deployment metadata | The current generated Wrangler JSON contains absolute local workspace paths in `configPath` and `userConfigPath`.                                                                      |
| `W05`           | Cloudflare Rate Limiting binding     | The binding is per location, eventually consistent, and not exact global accounting.                                                                                                   |
| `W06`           | Cloudflare Static Assets headers     | A checked-in `_headers` file can apply CSP and related headers to static asset responses.                                                                                              |

The observed release artifact `dist-live/airspace_worker/wrangler.json` contains `configPath` and `userConfigPath` values rooted at the local Windows user workspace. The retained-candidate process copies the generated artifact, so this is a concrete artifact-hygiene blocker rather than a hypothetical concern. It does not expose credentials, but it leaks a local username and directory structure and makes the candidate less reproducible.

The source also states that request admission is isolate-local. This is honest and useful, but it means those token buckets cannot be described as account-wide abuse prevention. A distributed attacker or traffic spread across locations can reach separate counters. That limitation belongs in the operating envelope and G1 controls.

## Current Design And Failure Mode

The Worker currently derives policy in several places. `configuredLiveSource` and `configuredProvider` own provider mode and fixed egress. `allowedOrigin` parses `ALLOWED_ORIGINS` per request. `handleApi` owns route and method policy. `WorkerRequestAdmission`, `RegionalDelivery`, and `handleMapAsset` each own a different capacity boundary. HTML meta tags own most browser policy. Vite and Wrangler generate deployment metadata, while release tests inspect a subset of the result.

Each local control is understandable. The structural problem appears when we ask one release question: can an invalid or privacy-unsafe configuration become a candidate? Today there is no single validated runtime-policy object or candidate policy manifest that answers that question. Some mistakes fail at request time, some at build time, some only in browser behavior, and the absolute-path leak does not fail at all.

Operational procedures are similarly distributed. The roadmap names kill switch, quota exhaustion, provider-term change, stale feed, and rollback, but there is no executable runbook set tied to stable reason codes and exact artifacts. Established WebSockets also need an explicit disablement story. The top-level Worker can reject new requests after a disabled deployment, but an already upgraded regional connection is no longer traversing that request handler.

## Desired Invariants

- Every build target produces one validated, immutable runtime-policy manifest before a candidate can be retained.
- Production and mock capabilities are mutually exclusive. Production remains Live-disabled until separate authorization closes the provider gate.
- Provider egress is a capability with one fixed origin and three fixed paths, never a caller-supplied URL.
- Allowed origins are canonical, bounded, duplicate-free, and target-appropriate. Loopback origins are rejected from a release candidate.
- Only the declared API, map, static, and rollback routes exist; unsupported methods, queries, bodies, upgrades, and conditions fail closed.
- Static HTML responses carry checked response headers, including a CSP that can enforce `frame-ancestors`; offline remains a separate no-connect artifact.
- No retained or deployable artifact contains an absolute workspace path, local username, secret, token, mock-only binding, or unexpected source map.
- Disablement has a tested effect on new requests and established regional sessions, while Replay, Lab, Evidence, and rollback remain available.
- Quota and admission limits have an explicit scope. Approximate platform rate limiting is never described as exact billing or global accounting.
- Every operator procedure has entry evidence, bounded actions, stop conditions, rollback, and a verification receipt.

## Constraints And Non-Goals

- No runtime admin endpoint, secret, account binding, or remote control plane is authorized in the current local phase.
- We must preserve provider neutrality, the three fixed regions, the exact v2 rollback bytes, and the current zero-network offline artifact.
- The current candidate and cloud publication paths remain blocked.
- HSTS and final origin policy depend on an approved HTTPS deployment target and should not be guessed from local loopback builds.
- Cloudflare rate limiting is defense in depth, not exact global or per-account accounting.
- This proposal does not authorize real provider access, cloud deployment, or publication.

## Before Architecture

[Before architecture](../diagrams/runtime-policy-before.mmd)

The before view shows several effective local enforcement points, but no single policy owner. Raw environment strings can reach separate parsers, static headers are not part of the current public artifact set, and operator procedures are not bound to a machine-checked state vocabulary.

## Options

### Option 1: Patch and document the current controls

This baseline keeps the current architecture. We would remove or relativize generated `configPath` and `userConfigPath`, add a checked `_headers` file, reject loopback origins in a release candidate, and write the five required runbooks. Each existing module would retain its policy ownership.

The strongest case is speed and low migration risk. Provider, route, origin, map, delivery, and publication controls already have substantial tests. A focused patch can close the concrete artifact leak and header gap without changing runtime control flow. The concern is recurrence. Future build targets or routes still have to remember several independent checks, and the release verifier still assembles a policy conclusion from unrelated files.

I would accept Option 1 only as a tactical bridge if the project needs to close artifact hygiene before the central contract is ready. The direct artifact and header fixes remain necessary in every option.

[Option 1 architecture](../diagrams/runtime-policy-baseline-after.mmd)

| Change            | Before                               | After                                         | Security consequence                 | Cost                        |
| ----------------- | ------------------------------------ | --------------------------------------------- | ------------------------------------ | --------------------------- |
| Artifact metadata | Absolute local config paths retained | Paths removed and verifier rejects recurrence | Closes local identity leakage        | Focused sanitizer and tests |
| Static policy     | CSP meta only                        | Checked `_headers` plus existing meta         | Adds response-level browser policy   | Header compatibility tests  |
| Procedures        | Roadmap prose                        | Five operator runbooks                        | Makes failure handling repeatable    | Documentation and rehearsal |
| Ownership         | Distributed                          | Still distributed                             | Tactical issues close, drift remains | Lowest migration cost       |

### Option 2: Create one typed runtime and release policy contract

This option introduces a pure `RuntimePolicy` compiler that consumes build target and bindings and returns an immutable validated policy. Provider mode, origin set, fixed routes, CSP/connect origins, admission scope, feature gates, release identity, and disable reason become typed values. Request handlers receive the compiled policy rather than reparsing raw strings. Build tools emit a minimized policy manifest and sanitize generated Wrangler metadata before candidate retention.

The most important security effect is not fewer lines. It is one fail-closed place to state combinations that must never exist: production plus mock binding, release plus loopback origin, enabled real source without a provider gate receipt, unexpected route, missing security headers, or artifact path outside the candidate. This also gives the UI and runbooks stable reason codes such as `source-disabled`, `terms-hold`, `quota-hold`, `upstream-stale`, `admission-limited`, and `internal-fault` without exposing arbitrary error text.

We should keep disablement deploy-time in this option. A deployment setting or build binding is less convenient than a button, but it avoids creating an authenticated mutation surface before there is an operator identity system. Established regional sessions need a tested generation or policy-epoch check so a disabled deployment closes their sockets and stops polling rather than only rejecting new requests.

The migration cost is moderate because policy touches several modules and build tools. It can remain reversible: compile the new object in parallel, assert equivalence with current decisions, then switch consumers one boundary at a time. What gives me pause is accidental over-centralization. Delivery byte and ACK invariants should remain enforced next to delivery. The policy contract should own configured limits and compatibility, not move every fast-path check into one giant module.

[Option 2 architecture](../diagrams/runtime-policy-central-contract-after.mmd)

| Change             | Before                            | After                                             | Security consequence                              | Cost                                  |
| ------------------ | --------------------------------- | ------------------------------------------------- | ------------------------------------------------- | ------------------------------------- |
| Environment        | Raw strings parsed by consumers   | One immutable validated policy                    | Invalid combinations fail before serving          | New compiler and compatibility layer  |
| Routes and origins | Inline checks                     | Closed route/origin tables from policy            | Reduces drift and release-only mistakes           | Refactor plus exhaustive matrix tests |
| Browser policy     | CSP meta only                     | Build-derived meta plus checked response headers  | Enforces clickjacking/referrer/feature boundaries | Target-specific header generation     |
| Artifact policy    | Partial verifier                  | Minimized manifest and forbidden-path/secret scan | Blocks local paths and unexpected capabilities    | Build and candidate-tool changes      |
| Disablement        | New requests see deploy-time mode | New and established sessions obey a policy epoch  | Closes residual active-session polling            | DO lifecycle and recovery tests       |
| Operations         | Human interpretation              | Stable reason codes and bound runbooks            | Faster, safer incident decisions                  | Rehearsal and receipt tooling         |

### Option 3: Add a mutable operations control plane

A dedicated operations object would hold pause, quota, source, and policy-epoch state. An authenticated operator could change it without rebuilding. A Cloudflare Rate Limiting binding could add fast per-location abuse resistance before the Worker reaches route-specific admission. The application would still keep local semaphores and regional delivery limits.

This option has the best emergency response after deployment. It can stop existing regional sessions, set a terms hold, or impose a tighter quota without waiting for a full deployment. Platform rate limiting also reduces load earlier than isolate-local counters. The tradeoff is new ambient authority. We would need operator authentication, secret or identity bindings, audit events, state availability, cache invalidation, replay protection, and a recovery path when the control object is unavailable. A mistaken or compromised control becomes deployment-wide.

Cloudflare documents the Rate Limiting binding as per location, eventually consistent, and unsuitable for exact accounting. It is therefore useful defense in depth but cannot replace the existing hard regional limits or a budget stop. I do not recommend adding this control plane before G1 defines who operates it, how access is authenticated, and what account-level rules and costs are approved.

[Option 3 architecture](../diagrams/runtime-policy-mutable-control-after.mmd)

| Change             | Before                                | After                                              | Security consequence                             | Cost                                             |
| ------------------ | ------------------------------------- | -------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------ |
| Kill switch        | Deploy-time configuration             | Authenticated mutable state                        | Faster emergency stop, larger privileged surface | Identity, secret, audit, and availability design |
| Abuse control      | Isolate and region local              | Per-location platform rate limit plus local limits | Earlier distributed defense                      | External binding and eventual consistency        |
| Policy propagation | Constructor and request configuration | Cached policy epoch across Worker and DO           | Can stop established sessions                    | Cache, polling, and fail-closed semantics        |
| Operations         | Deployment workflow                   | Control API and audit path                         | Better responsiveness                            | Highest operational burden                       |

## Comparison

| Dimension   | Option 1: patch and document                         | Option 2: typed policy contract                                           | Option 3: mutable control plane                                  |
| ----------- | ---------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Security    | Closes known artifact and header gaps; drift remains | Strongest local prevention of invalid combinations and artifact leaks     | Strong emergency control, but adds a privileged mutation surface |
| Performance | Neutral                                              | Small startup/build validation; fast paths keep local checks              | Additional rate-limit and control-state reads or cache checks    |
| Memory      | Neutral                                              | Small immutable policy object                                             | Cached policy state and control-object memory                    |
| Reliability | Existing behavior                                    | Improves deterministic startup and disablement; migration risk is bounded | New control-plane availability and split-brain concerns          |
| Operability | Runbooks only                                        | Stable reasons, one manifest, deploy-time control                         | Best live response, highest setup and incident burden            |
| Migration   | Smallest                                             | Moderate, phased, reversible                                              | Largest and dependent on account/identity decisions              |

## Recommendation

I recommend Option 2. It is proportionate to the current release blockers, keeps sensitive authority out of an unauthenticated runtime API, and creates a stable base for R3 tests and runbooks. Option 1's artifact sanitizer and static headers should be the first work package inside Option 2, so the immediate defects close early. Option 3 should remain a G1 design choice.

This recommendation changes if Kato requires sub-minute remote disablement after deployment and approves an operator identity model. In that case, Option 3 may be worth its additional authority and availability cost, but it should still consume the typed policy vocabulary from Option 2.

## Evidence Coverage And Residual Risk

| Evidence                                        | Option 1             | Option 2                                           | Option 3                                          | Tactical protection still required                         |
| ----------------------------------------------- | -------------------- | -------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------- |
| `E18` — Fixed provider capability               | Preserves            | Centralizes compatibility                          | Centralizes and makes mutable                     | Fixed egress checks remain at the actual fetch boundary    |
| `E15` — Distributed route/origin policy         | Mitigates with tests | Addresses through typed route/origin tables        | Addresses through typed policy plus control state | Request-time fail-closed checks remain local               |
| `E12` — Isolate-local admission                 | Unaffected           | Makes scope explicit                               | Mitigates with platform rate limiting             | Regional viewer/byte limits remain authoritative           |
| `E04/E05/E07` — Missing static response headers | Addresses            | Addresses and derives from policy                  | Addresses and derives from policy                 | Browser acceptance must inspect actual built responses     |
| `E09` — Artifact paths not rejected             | Addresses directly   | Addresses through manifest sanitizer and verifier  | Addresses through the same release contract       | Exact candidate scan remains mandatory                     |
| `E10` — Publication firebreaks                  | Preserves            | Extends                                            | Extends                                           | Build-once and zero-retry candidate rules remain mandatory |
| `E24` — Candidate retention copies metadata     | Addresses directly   | Addresses through an allowlisted artifact contract | Addresses through the same release contract       | Retention must fail before copying forbidden text          |
| `G01` — Generated absolute workspace paths      | Removes the fields   | Replaces raw metadata with a minimized manifest    | Replaces raw metadata with the same manifest      | Sentinel path and username scan remains mandatory          |
| `E20` — Deploy-time disabled source             | Preserves            | Strengthens for established sessions               | Replaces with mutable state plus disabled default | Real-source enablement remains separately authorized       |

Residual risk includes platform processing outside application controls, denial spread across Cloudflare locations, a permitted origin redistributing public data, configuration mistakes in account-owned routes, and a compromised account bypassing repository gates. The local design can reduce these risks but cannot claim account or provider assurance before G1 and G2.

## Migration And Rollout

For Option 2, first add artifact sanitization and the static header file without changing runtime behavior. Next compile `RuntimePolicy` in parallel and assert its decisions equal the current provider, origin, route, and mode behavior. Migrate one consumer at a time. Add a policy epoch or equivalent established-session shutdown mechanism only after deterministic DO tests prove no extra provider polling or reconnect loop. Finally bind runbooks and release receipts to stable reason codes.

Rollback is staged. The artifact sanitizer and verifier can remain even if runtime-policy consumption rolls back. Consumers can temporarily return to existing functions while the compiled policy stays as an assertion. A policy-epoch feature must be default-off until its session teardown cases pass. No migration changes the approved v2 rollback bytes.

## Validation Plan

- Exhaustively test every build target, provider mode, mock binding, provider origin, allowed origin, release identity, and route combination.
- Reject empty, duplicated, credential-bearing, path-bearing, noncanonical, wildcard, loopback-in-release, and oversized origins.
- Build every target and scan all candidate files for absolute Windows/POSIX paths, usernames, secrets, source maps, unexpected bindings, mock identifiers, and unsupported routes.
- Serve the actual built assets and assert CSP, `frame-ancestors`, content-type, referrer, permissions, cache, and cross-origin policies on HTML, scripts, fonts, map ranges, API errors, and WebSocket handshakes.
- Exercise disablement before connection, during an established stream, during provider backoff, and after DO hibernation. Acceptance requires no further provider poll after the bounded stop point and continued Replay, Lab, Evidence, and rollback availability.
- Exercise admission under multiple isolates and document the observed scope. At G1 only, compare platform rate limiting with local counters without calling it exact accounting.
- Enforce bundle budgets and record map and Lab chunk sizes. Add 500-aircraft p95 paint and 2,000-record browser-safety harnesses before freezing G0.
- Rehearse provider-term hold, quota hold, stale feed, internal fault, and rollback using synthetic sources only.

## Implementation Work Packages

1. Sanitize generated deployment metadata and add an exact forbidden-capability and forbidden-path artifact scanner.
2. Add target-specific static security headers and built-response browser tests.
3. Define the pure `RuntimePolicy` compiler, reason-code vocabulary, and exhaustive combination tests.
4. Route provider, origin, API, map, build, and release consumers through the compiled policy while preserving local enforcement.
5. Add established-session disablement and deterministic stop/recovery tests.
6. Write and test kill-switch, quota-exhaustion, provider-term-change, stale-feed, internal-fault, and rollback runbooks.
7. Add explicit performance budgets and retained-artifact inspection to the G0 gate.
8. Evaluate mutable control and Cloudflare rate limiting only after G1 account and operator decisions.

## Open Questions

- What exact production origin and custom domain will replace loopback values in a release candidate?
- Is deploy-time disablement fast enough, or does the operating model require sub-minute remote control?
- Which security headers need target-specific values for map workers, downloads, and the retained v2 route?
- Should production retain any Workers Logs, or keep invocation logs disabled and rely on native aggregate metrics plus the application contract?
- What client paint and bundle budgets should block G0 on Kato's target laptop and mobile profile?
