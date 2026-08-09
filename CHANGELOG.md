# Changelog

All notable changes are documented here. This project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- Stabilized temporal-model distance summation across supported Python runtimes so exact artifact and configuration hashes reproduce without changing the published model identity.
- Enforced the supported RFC 3339-compatible timestamp contract for versioned JSON input instead of accepting locale-dependent or calendar-rollover values.
- Aligned CSV diagnostics and canonical metadata on positive 1-based retained-record positions, with mutation-resistant coverage.

## [2.2.0] - 2026-07-19

### Added

- Versioned profile-specific model registry with explicit schema, channel, unit, cadence, window, artifact, configuration, quality-gate, and user-enablement compatibility results.
- Deterministic synthetic mission-phase state machine with hysteresis, redundant sensor measurements, two-state Kalman estimation, innovation residuals, and uncertainty bands.
- Ten seeded temporal fault scenarios with onset, duration, recovery, phase, and synthetic-unclassified evidence.
- Two compact 40-sample causal temporal artifacts with distinct roles: v1 research-only evidence with calibration-set abstention thresholds, same-population baselines, and a non-gating challenge; and a v2 production-integrated advisory artifact fitted on the actual Investigation projection with Python-to-TypeScript parity.
- V2 selected-window evidence now reports its 391/2/38/9 confusion counts, weakest-class count of 33/40 for cross-sensor decoupling, and exact one-sided 95 percent false-positive upper bound of approximately 14.92 percent beside the 2/40 point estimate.
- Investigation view with linked temporal traces, phase and lifecycle markers, replay, residuals, exact-compatibility captured waveform overlays, and selected-sample four-way evidence that preserves deterministic authority.
- Versioned campaign contracts, worker-backed execution, progress, cancellation, contained failures, deterministic replay manifests, expected/missing/unexpected comparisons, confidence intervals, and minimized JSON exports.
- Ordered SQLite temporal campaign migrations with run-scoped case identity, queryable variation dimensions, integrity checks, idempotent ingestion, concise reporting, retained full evidence, and reproducible Node proxy benchmarks.
- Temporal architecture, ADR, test plan, threat model, model evidence, limitations, release notes, and an approximately two-minute demo script.
- Digest-pinned optional development-container configuration and a required CI job that validates and builds both application forms without publishing a container image.

### Changed

- Application package and displayed configuration version advanced to v2.2.0.
- Core coverage scope now includes campaign, investigation, temporal model, registry, phase, fusion, and scenario modules.
- The five-view interface now uses a quieter minimalist visual system with flatter surfaces, restrained aviation-blue accents, clearer hierarchy, and responsive chart containment while preserving the established workbench identity.
- Temporal documentation now labels v1 research evidence separately from v2 production-integrated advisory evidence. V2 quality values are reported as balanced selected-window observations, not episode, full-stream, population, or real-world estimates, and weak per-fault classification remains explicit.

### Security

- Validated campaign input is bounded to 4 profiles, 64 scenarios, 12 seeds, 372 total cases, and 256 KiB specifications. Results are limited to 10 MiB, with 128 detections and 2,048 calibration observations per case; SQLite history limits retained result payloads to 64 MiB and the database to 128 MiB. Reaching a limit fails explicitly instead of silently discarding evidence.
- Temporal exports remain synthetic and unclassified. Campaign reports omit source telemetry, and Investigation reports exclude generated samples, point traces, and series unless the user explicitly selects source inclusion.

## [2.1.0] - 2026-07-17

### Added

- Versioned WebSocket protocol, local Node simulator, in-browser demo adapter, and multiple synthetic source support.
- Heartbeat health, bounded reconnect backoff, visible queue pressure, and dropped-message accounting.
- Seeded communications faults for disconnects, latency, jitter, packet loss, duplicates, reordering, stale heartbeat, schema mismatch, and queue pressure.
- Experimental robust-covariance anomaly scoring with per-channel residual contributions and deterministic side-by-side comparison.
- Versioned Python model training, held-out evaluation evidence, TypeScript inference parity, and a model quality gate.
- SQLite verification history with migrations, foreign keys, indexes, integrity checks, fourteen analytical queries, and generated trend reporting.
- Seeded parser property tests, mutation testing, reproducible 1,000, 10,000, and 100,000-sample benchmarks, and a documented native-first gate for a future optional development container.

## [2.0.0] - 2026-07-17

### Added

- Strict TypeScript architecture with versioned CSV and JSON telemetry adapters.
- Three synthetic profiles, profile-driven deterministic rules, and seeded fault injection.
- Evidence-backed diagnostics and baseline-versus-candidate verification workflows.
- Monitor, Diagnostics, Verification, and Configuration views with keyboard and responsive support.
- Versioned JSON verification reports, CSV findings exports, and a self-contained offline application.
- Golden regression coverage for the included 85-record synthetic dataset and its exact 5/3/1 finding distribution.
- Requirements traceability, architecture and assurance documentation, release evidence, and automated GitHub workflows.

### Changed

- Displayed product name changed from the original telemetry dashboard name to Flight Diagnostics Workbench.
- Documentation now identifies Georgia Southern University as the author's current school.

### Security

- Removed runtime CDN dependencies in favor of pinned build dependencies and local font assets.
- Added explicit upload limits, safe text rendering, dependency auditing, CodeQL, an SBOM, checksums, and release verification.

## [1.0.0] - 2026-02-23

### Added

- Original static telemetry dashboard with charts, gauges, alerts, replay controls, CSV loading, and incident-report export.
- Included 85-record synthetic CSV fixture with the preserved 5 overspeed, 3 rapid-descent, and 1 fuel-change regression baseline.

[Unreleased]: https://github.com/Kato-MT/Aviation-Dashboard-Project/compare/v2.2.0...HEAD
[2.2.0]: https://github.com/Kato-MT/Aviation-Dashboard-Project/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/Kato-MT/Aviation-Dashboard-Project/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/Kato-MT/Aviation-Dashboard-Project/compare/v1.0.0...v2.0.0
[1.0.0]: https://github.com/Kato-MT/Aviation-Dashboard-Project/releases/tag/v1.0.0
