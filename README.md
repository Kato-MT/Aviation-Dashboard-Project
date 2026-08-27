# Flight Diagnostics Workbench

[![CI](https://github.com/Kato-MT/Aviation-Dashboard-Project/actions/workflows/ci.yml/badge.svg)](https://github.com/Kato-MT/Aviation-Dashboard-Project/actions/workflows/ci.yml)
[![CodeQL](https://github.com/Kato-MT/Aviation-Dashboard-Project/actions/workflows/codeql.yml/badge.svg)](https://github.com/Kato-MT/Aviation-Dashboard-Project/actions/workflows/codeql.yml)
[![Pages](https://github.com/Kato-MT/Aviation-Dashboard-Project/actions/workflows/pages.yml/badge.svg)](https://kato-mt.github.io/Aviation-Dashboard-Project/)

Flight Diagnostics Workbench is a browser-based telemetry integration, diagnostics, and verification project. It accepts explicitly mapped synthetic telemetry, validates and normalizes each record, runs deterministic profile-driven checks, explains every finding with evidence, and compares a baseline run with a candidate run. Version 2.2 adds phase-aware sensor fusion, temporal fault hypotheses, and reproducible synthetic evaluation campaigns.

> **Data boundary:** Every bundled dataset, profile, threshold, injected fault, and stream is synthetic and unclassified. This project is an educational demonstration. It is not affiliated with any employer or government organization, does not use operational data, and is not intended for real-world flight, safety, maintenance, or certification decisions.

## What the workbench demonstrates

- Versioned CSV, JSON, browser-demo, and WebSocket adapters that produce one canonical telemetry model
- Strict validation with visible quarantine for recoverable row errors and blocking for fatal schema errors
- Stable rule IDs for value, rate, timing, sequence, freshness, schema, and profile checks
- Seeded fault injection with reproducible evidence
- Baseline-versus-candidate verification with resolved, persisting, and new finding classifications
- Five views in a restrained, minimalist interface with labeled controls, keyboard paths, visible statuses, and responsive styling: Monitor, Diagnostics, Verification, Investigation, and Configuration
- Versioned JSON verification reports and CSV finding exports without source data by default
- Reproducibility evidence, including versions, adapter, SHA-256 input hash, counts, validation results, and findings
- Optional v2.1 streaming, history analytics, and experimental learned-baseline analysis
- Two explicitly separated temporal evidence tracks: a v1 research-only artifact with same-population baselines and a non-gating challenge, and a v2 production-integrated advisory artifact trained on the actual Investigation projection
- Deterministic mission-phase hysteresis, redundant-sensor Kalman estimation, innovation evidence, and ten seeded temporal fault scenarios
- Selected-sample comparison of authoritative deterministic rules, advisory robust covariance, supporting Kalman innovations, and advisory temporal hypotheses
- Captured Investigation waveform comparison with exact profile, cadence, sample-count, and sample-index compatibility instead of silent alignment
- A worker-backed campaign lab with three severity, duration, and onset-phase parameter sets per fault family, partial cancellation evidence, deterministic replay manifests, confusion and calibration metrics, confidence intervals, SQLite ingestion, and minimized JSON exports

Deterministic checks remain authoritative. Learned results rank declared synthetic hypotheses only. The integrated v2 metrics describe 440 balanced, selected 40-sample windows, not complete mission streams, independent flights, or real-world performance. The checked artifact records 391 true positives, 2 false positives, 38 true negatives, and 9 false negatives. Cross-sensor decoupling is the weakest named class at 33 of 40 correct selected windows; stuck value and simultaneous faults each record 39 of 40. The nominal false-positive point estimate is 2 of 40, or 5 percent, but its exact one-sided 95 percent upper bound is about 14.92 percent, so this sample does not establish a population rate at or below 5 percent.

## Preserved regression fixture

The included [`data/flight.csv`](data/flight.csv) fixture is the compatibility baseline from the original dashboard:

| Property               | Verified value                                                     |
| ---------------------- | ------------------------------------------------------------------ |
| Accepted records       | 85                                                                 |
| Overspeed findings     | 5                                                                  |
| Rapid-descent findings | 3                                                                  |
| Fuel-change findings   | 1                                                                  |
| Total legacy findings  | 9                                                                  |
| SHA-256                | `b3b50781afde9b3895707109e40e86b2fae82ed8e38cc4e964d9cb2de327b700` |

These values are regression expectations for the included synthetic dataset, not detection-performance or real-world accuracy claims.

## Quick start

Requirements:

- Node.js 22 or newer
- pnpm 11.9.0, as pinned by the repository package manager declaration and lockfile
- Python 3.11 or newer for v2.1 analytics and learned-model tooling

```powershell
git clone https://github.com/Kato-MT/Aviation-Dashboard-Project.git
cd Aviation-Dashboard-Project
corepack enable
corepack prepare pnpm@11.9.0 --activate
pnpm install --frozen-lockfile
pnpm dev
```

Open the local URL printed by Vite. The application has no runtime CDN dependency. The release offline artifact runs without a network connection.

## Commands

| Command                   | Purpose                                                                          |
| ------------------------- | -------------------------------------------------------------------------------- |
| `pnpm dev`                | Start the local Vite development server                                          |
| `pnpm validate`           | Run the local validation bundle; browser and accessibility gates remain separate |
| `pnpm test:coverage`      | Run core coverage with the configured branch gate                                |
| `pnpm test:e2e`           | Run browser, accessibility, and responsive checks                                |
| `pnpm mutation`           | Run mutation testing for the deterministic core                                  |
| `pnpm build`              | Create the GitHub Pages build                                                    |
| `pnpm build:offline`      | Create a self-contained offline HTML artifact                                    |
| `pnpm simulator`          | Start the local synthetic WebSocket simulator                                    |
| `pnpm benchmark`          | Run reproducible parser and deterministic-rule benchmarks                        |
| `pnpm benchmark:temporal` | Run reproducible local Node proxy temporal and campaign benchmarks               |
| `pnpm analytics`          | Build or query the local verification-history database                           |
| `pnpm analytics:campaign` | Query the temporal campaign-history database                                     |
| `pnpm ml:train`           | Regenerate covariance and temporal artifacts and parity evidence                 |
| `pnpm requirements:check` | Validate requirements-to-test traceability                                       |
| `pnpm sbom:generate`      | Generate the release software bill of materials                                  |

## Workflow

1. Select a declared synthetic profile.
2. Load a compatible CSV or versioned JSON dataset, or start a synthetic demo stream.
3. Review validation and quarantine results before trusting findings.
4. Inspect evidence in Diagnostics.
5. Use Investigation to reproduce a seeded temporal mission, review phase and fusion evidence, and optionally enable advisory hypotheses.
6. Run a multi-seed campaign in the worker lab and review expected, missing, and unexpected detections.
7. Load a candidate run in Verification and review resolved, persisting, and new findings.
8. Export only the evidence needed. Source records are excluded unless explicitly selected.

The workbench enforces a 10 MiB upload limit and a 250,000-sample limit with explicit errors.

## Architecture and assurance

- [Architecture](docs/architecture.md)
- [Live Airspace v3.0 implementation and release gates](docs/live-airspace.md)
- [Live Airspace edge-coordinator decision](docs/adr/0007-live-airspace-edge-coordinator.md)
- [Requirements](requirements/requirements.md)
- [Traceability matrix](requirements/traceability.md)
- [Test plan](docs/test-plan.md)
- [Threat model](docs/threat-model.md)
- [Known limitations](docs/limitations.md)
- [Benchmark record](docs/benchmarks.md)
- [Temporal benchmark evidence](docs/benchmarks-temporal.md)
- [Mutation testing](docs/mutation-testing.md)
- [Verification-history analytics queries](docs/analytics-queries.md)
- [Experimental model card](models/MODEL_CARD.md)
- [Learned-baseline evaluation evidence](docs/model-card.md)
- [Temporal fault intelligence architecture](docs/temporal-intelligence.md)
- [Temporal model evidence](docs/temporal-model-evidence.md)
- [Temporal research model card, v1](models/TEMPORAL_MODEL_CARD.md)
- [Production-integrated advisory model card, v2](models/TEMPORAL_INTEGRATION_MODEL_CARD.md)
- [Temporal test plan](docs/temporal-test-plan.md)
- [Temporal threat model](docs/temporal-threat-model.md)
- [v2.1.0 completed release verification](docs/release-verification-v2.1.0.md)
- [Release verification template](docs/release-verification.md)
- [v2.0.0 release notes](docs/release-notes-v2.0.0.md)
- [v2.1.0 release notes](docs/release-notes-v2.1.0.md)
- [v2.2.0 release notes](docs/release-notes-v2.2.0.md)
- [Release screenshot protocol](docs/screenshots/README.md)
- [Configuration management](docs/configuration-management.md)
- [90-second demo](docs/demo-script.md)
- [v2.2 approximately two-minute demo](docs/demo-script-v2.2.md)

## Releases

`v2.0.0` established the deterministic application-ready baseline. `v2.1.0` added synthetic streaming, optional learned-baseline comparison, and local SQLite analytics. Version 2.2 adds the Investigation and campaign workflows described above. The GitHub Releases page, protected checks, and attached exact-commit evidence are authoritative for publication status. Future coverage, performance, accessibility, security, and model claims are published only when current evidence verifies them.

The normal build is deployed at [kato-mt.github.io/Aviation-Dashboard-Project](https://kato-mt.github.io/Aviation-Dashboard-Project/). Release assets include the offline HTML application, verification and traceability reports, SBOM, SHA-256 checksums, and provenance when their release gates pass.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a change. Security reports belong in the private process described by [SECURITY.md](SECURITY.md), not a public issue.

## Author and license

Built by Kato Thompkins, a Computer Science undergraduate at Georgia Southern University.

Licensed under the [MIT License](LICENSE).
