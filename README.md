# Flight Diagnostics Workbench

[![CI](https://github.com/Kato-MT/Aviation-Dashboard-Project/actions/workflows/ci.yml/badge.svg)](https://github.com/Kato-MT/Aviation-Dashboard-Project/actions/workflows/ci.yml)
[![CodeQL](https://github.com/Kato-MT/Aviation-Dashboard-Project/actions/workflows/codeql.yml/badge.svg)](https://github.com/Kato-MT/Aviation-Dashboard-Project/actions/workflows/codeql.yml)
[![Pages](https://github.com/Kato-MT/Aviation-Dashboard-Project/actions/workflows/pages.yml/badge.svg)](https://kato-mt.github.io/Aviation-Dashboard-Project/)

Flight Diagnostics Workbench is a browser-based telemetry integration, diagnostics, and verification project. It accepts explicitly mapped synthetic telemetry, validates and normalizes each record, runs deterministic profile-driven checks, explains every finding with evidence, and compares a baseline run with a candidate run.

> **Data boundary:** Every bundled dataset, profile, threshold, injected fault, and stream is synthetic and unclassified. This project is an educational demonstration. It is not affiliated with any employer or government organization, does not use operational data, and is not intended for real-world flight, safety, maintenance, or certification decisions.

## What the workbench demonstrates

- Versioned CSV, JSON, browser-demo, and WebSocket adapters that produce one canonical telemetry model
- Strict validation with visible quarantine for recoverable row errors and blocking for fatal schema errors
- Stable rule IDs for value, rate, timing, sequence, freshness, schema, and profile checks
- Seeded fault injection with reproducible evidence
- Baseline-versus-candidate verification with resolved, persisting, and new finding classifications
- Four accessible views: Monitor, Diagnostics, Verification, and Configuration
- Versioned JSON verification reports and CSV finding exports without source data by default
- Reproducibility evidence, including versions, adapter, SHA-256 input hash, counts, validation results, and findings
- Optional v2.1 streaming, history analytics, and experimental learned-baseline analysis. Deterministic checks remain authoritative.

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

| Command                   | Purpose                                                                |
| ------------------------- | ---------------------------------------------------------------------- |
| `pnpm dev`                | Start the local Vite development server                                |
| `pnpm validate`           | Run formatting, static checks, unit tests, and traceability validation |
| `pnpm test:coverage`      | Run core coverage with the configured branch gate                      |
| `pnpm test:e2e`           | Run browser, accessibility, and responsive checks                      |
| `pnpm mutation`           | Run mutation testing for the deterministic core                        |
| `pnpm build`              | Create the GitHub Pages build                                          |
| `pnpm build:offline`      | Create a self-contained offline HTML artifact                          |
| `pnpm simulator`          | Start the local synthetic WebSocket simulator                          |
| `pnpm benchmark`          | Run reproducible parser and detection benchmarks                       |
| `pnpm analytics`          | Build or query the local verification-history database                 |
| `pnpm requirements:check` | Validate requirements-to-test traceability                             |
| `pnpm sbom:generate`      | Generate the release software bill of materials                        |

## Workflow

1. Select a declared synthetic profile.
2. Load a compatible CSV or versioned JSON dataset, or start a synthetic demo stream.
3. Review validation and quarantine results before trusting findings.
4. Inspect evidence in Diagnostics.
5. Load a candidate run in Verification and review resolved, persisting, and new findings.
6. Export only the evidence needed. Source records are excluded unless explicitly selected.

The workbench enforces a 10 MiB upload limit and a 250,000-sample limit with explicit errors.

## Architecture and assurance

- [Architecture](docs/architecture.md)
- [Requirements](requirements/requirements.md)
- [Traceability matrix](requirements/traceability.md)
- [Test plan](docs/test-plan.md)
- [Threat model](docs/threat-model.md)
- [Known limitations](docs/limitations.md)
- [Benchmark record](docs/benchmarks.md)
- [Mutation testing](docs/mutation-testing.md)
- [Verification-history analytics queries](docs/analytics-queries.md)
- [Experimental model card](models/MODEL_CARD.md)
- [Learned-baseline evaluation evidence](docs/model-card.md)
- [v2.1.0 completed release verification](docs/release-verification-v2.1.0.md)
- [Release verification template](docs/release-verification.md)
- [v2.0.0 candidate release notes](docs/release-notes-v2.0.0.md)
- [v2.1.0 release notes](docs/release-notes-v2.1.0.md)
- [Release screenshot protocol](docs/screenshots/README.md)
- [Configuration management](docs/configuration-management.md)
- [90-second demo](docs/demo-script.md)

## Releases

`v2.0.0` is the deterministic application-ready release. The published `v2.1.0` release adds synthetic streaming, optional learned-baseline comparison, and local SQLite analytics. Its exact-commit results are recorded in the completed release verification document. Future release numbers, coverage, performance, accessibility results, security results, and model metrics are published only when CI or signed release evidence verifies them.

The normal build is deployed at [kato-mt.github.io/Aviation-Dashboard-Project](https://kato-mt.github.io/Aviation-Dashboard-Project/). Release assets include the offline HTML application, verification and traceability reports, SBOM, SHA-256 checksums, and provenance when their release gates pass.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a change. Security reports belong in the private process described by [SECURITY.md](SECURITY.md), not a public issue.

## Author and license

Built by Kato Thompkins, a Computer Science undergraduate at Georgia Southern University.

Licensed under the [MIT License](LICENSE).
