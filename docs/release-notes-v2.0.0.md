# Flight Diagnostics Workbench v2.0.0

## Status: Released July 17, 2026

Flight Diagnostics Workbench v2.0.0 modernizes the original static dashboard into a versioned telemetry integration, deterministic diagnostics, and baseline-versus-candidate verification project while preserving its dark visual identity and replay workflow.

## Highlights

- Strict TypeScript and Vite build with local pinned runtime dependencies and fonts
- Explicit legacy CSV and versioned JSON adapters into one canonical telemetry model
- Visible fatal validation and recoverable row quarantine without silent numeric coercion or row loss
- Three versioned synthetic profiles and stable evidence-backed rule IDs
- Seeded synthetic fault scenarios with reproducible manifests
- Monitor, Diagnostics, Verification, and Configuration views
- Versioned JSON reports and CSV findings that exclude source samples by default
- Keyboard, focus, reduced-motion, non-color status, responsive, and named-state support
- Normal GitHub Pages build and self-contained offline HTML artifact
- Requirements traceability, security automation, SBOM, checksums, and provenance

## Preserved compatibility baseline

The included synthetic fixture remains controlled at 85 accepted records and the expected 5 overspeed, 3 rapid-descent, and 1 fuel-change finding distribution. These are fixture regression results, not real-world detection metrics.

## Important boundary

Every bundled dataset, profile, threshold, stream, and fault scenario is synthetic and unclassified. The project is not affiliated with an employer or government organization and is not intended for real-world flight, safety, maintenance, or certification decisions.

## Evidence

The published release assets include the offline application, traceability and verification reports, SBOM, SHA-256 checksums, and GitHub artifact provenance. Test, coverage, accessibility, audit, and visual claims remain limited to the evidence attached to the tagged release.

Known constraints are documented in [limitations.md](limitations.md).
