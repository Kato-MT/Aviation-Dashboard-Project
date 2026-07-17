# Changelog

All notable changes are documented here. This project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- v2.1 synthetic streaming, optional learned-baseline analysis, and local verification-history analytics are staged behind documented release gates.

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

[Unreleased]: https://github.com/Kato-MT/Aviation-Dashboard-Project/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/Kato-MT/Aviation-Dashboard-Project/compare/v1.0.0...v2.0.0
[1.0.0]: https://github.com/Kato-MT/Aviation-Dashboard-Project/releases/tag/v1.0.0
