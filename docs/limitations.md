# Limitations

Flight Diagnostics Workbench is an educational software engineering demonstration using synthetic, unclassified data. It is not designed, validated, or approved for real-world flight, maintenance, safety, certification, dispatch, or operational decisions.

## Data and profiles

- Bundled profiles and thresholds are synthetic examples, not real platform limits.
- The included 85-record fixture is small and exists to preserve a regression baseline.
- Adapters support declared mappings only. They reject unknown units rather than infer them.
- Quarantined rows remain visible, but analysis does not reconstruct missing information.
- SHA-256 proves byte identity, not truth, authenticity, or data quality.

## Deterministic findings

- A finding means a declared synthetic rule matched its evidence. It does not diagnose a real cause.
- Rules can miss patterns that are not encoded in the selected profile.
- Frozen-sensor and stale-feed logic depends on declared cadence and tolerance.
- Baseline-versus-candidate matching uses stable diagnostic identity and may need a versioned migration when rule semantics change.

## Streaming

- The local protocol is a demonstration and has no remote authentication or encryption.
- Dropped messages are counted but cannot be recovered without a replay source.
- Timing behavior depends on the host event loop, browser throttling, and system load.
- Multiple browser tabs or background-tab throttling can affect perceived heartbeat health.

## Live airspace

- Live observations come from a public receiver network and may be missing, delayed, duplicated, inaccurate, or unavailable. Coverage is not guaranteed.
- Callsigns, registrations, types, altitudes, positions, speeds, tracks, vertical rates, and source classifications can be absent or wrong. The workbench does not fill missing fields with guesses.
- Public surveillance data is not onboard telemetry and cannot establish aircraft health, maintenance condition, airworthiness, safety, affiliation, ownership, route, destination, or intent.
- Session trails describe only observations received by the current browser session. They are not complete flight histories and are cleared on refresh or region change.
- The configured provider documents dynamic rate limits and no project-owned service-level agreement. Backoff and a circuit breaker reduce load but cannot make an unavailable provider available.
- ADSB.lol's 2026-08-30 response confirmed general ODbL, identifiable User-Agent, error-handling, caching, and no-SLA guidance. It did not approve the exact pilot rate, viewer ceiling, no-key access, attribution wording, or transient browser-redistribution obligations, so G2 remains pending.
- The three Georgia presets are product scope and an abuse-control boundary, not a guarantee that every returned observation physically remains inside a precise polygon.
- Live Airspace requires a network connection and edge deployment. The offline artifact preserves the synthetic lab but cannot provide live aircraft observations.
- Infrastructure-provider processing and account-level logs are governed outside application storage. Review the Cloudflare account configuration and policies before production use.

## Experimental learned baseline

- Training and evaluation use generated synthetic telemetry and labeled injected faults.
- Held-out metrics do not establish real-world detection performance.
- A robust covariance model assumes relationships that may not match other data distributions.
- Per-channel contributions are diagnostic aids, not causal explanations.
- Deterministic rules remain authoritative even if model release gates pass.

## Temporal fault intelligence

- Mission phases, redundant sensors, noise, fault magnitudes, durations, and recovery behavior are generated examples. They do not represent a real aircraft or platform.
- The phase state machine and two-state Kalman estimator simplify dynamics to make transition and residual evidence inspectable. They are not navigation, control, health-management, or certification algorithms.
- Model v1 is research-evidence-only. Its separate five-channel generator, same-population comparisons, and post-hoc non-gating challenge do not measure the browser's integrated path. The challenge shows reduced recall for unseen magnitude and especially short or late onset-duration configurations; its ten nominal controls per dimension are too small for a release-quality false-positive estimate.
- Model v2 is the production-integrated advisory artifact, but its checked metrics use one selected 40-sample window from each balanced synthetic seed-label mission. They are not episode, full-stream, prevalence-weighted, independent-flight, or real-world estimates.
- V2 recorded 2 false positives among 40 selected nominal windows. The observed rate is 5 percent, but the exact one-sided 95 percent upper bound is approximately 14.92 percent. This sample does not establish an underlying false-positive rate at or below 5 percent.
- V2's weakest selected-window class is cross-sensor decoupling at 33 of 40 correct classifications, or 0.825 recall. Stuck value and simultaneous faults each record 39 of 40. Named hypotheses remain exploratory despite satisfying the declared selected-window point-estimate gate.
- An `unknown` result means the artifact abstained under its declared support rules. It does not prove that no fault exists or that unfamiliar inputs will abstain.
- Ranked hypotheses are declared synthetic labels, not definitive causes. Deterministic rules remain authoritative.
- Current temporal inference requires the registered generic fixed-wing profile, channel and unit set, 1,000 ms cadence tolerance, and 40-sample window. Other active telemetry profiles report incompatibility.

## Campaign lab

- Campaign metrics describe only the exact versioned specification, seeds, generator, detector versions, and synthetic exposure recorded in the report.
- Low-level campaign validation caps specifications at 256 KiB, results at 10 MiB, matrices at 372 cases, retained SQLite result payloads at 64 MiB, and the campaign-history database at 128 MiB. Reaching a limit fails explicitly and requires the user to archive or remove history; evidence is never silently pruned.
- A false alarm per synthetic hour is a simulation statistic, not a real-world operational rate.
- Confidence intervals quantify resampling variability in the completed synthetic cases. They do not account for generator misspecification.
- Worker cancellation is cooperative. The active synchronous case can finish before the cancellation response is emitted.
- The browser does not persist campaign reports automatically. SQLite history requires an explicit local export and developer-side ingest.
- Local Node proxy benchmarks are not browser latency claims or release timing gates.

## Analytics

- SQLite history is local and file-based. It is not a multi-user service.
- Trend quality depends on complete, comparable, schema-valid imported reports.
- Query results are descriptive and do not establish causality.
- Local database files are not encrypted by the project.

## Compatibility and scale

- Uploads are limited to 10 MiB and 250,000 samples.
- The required benchmark evidence covers 1,000, 10,000, and 100,000 samples, not the hard maximum on every device.
- Browser support is limited to versions recorded in release verification.
- The offline artifact cannot provide a network WebSocket stream without a separately started local simulator and browser permission.

## Assurance

- Automated tests, coverage, static analysis, accessibility scans, dependency review, SBOMs, checksums, and provenance reduce risk but do not prove absence of defects.
- Release metrics are valid only for the exact commit and artifacts recorded by CI.
- Public issue and release status can change after documentation is published. Verify current GitHub evidence before relying on it.
