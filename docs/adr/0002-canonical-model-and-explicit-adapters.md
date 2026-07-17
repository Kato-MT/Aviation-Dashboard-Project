# ADR 0002: Canonical model and explicit adapters

- Status: Accepted
- Date: 2026-07-17

## Context

CSV, JSON, and streaming inputs use different envelopes, timestamps, and field names. Allowing each feature to read external input directly would duplicate validation and produce inconsistent findings.

## Decision

All external formats pass through a versioned `TelemetryAdapter` into one canonical `TelemetryRun`. Field and unit mappings must be explicit. Missing units are errors and are never guessed. Invalid rows are quarantined with evidence; fatal run errors block analysis.

## Consequences

- Rule and verification logic is input-format independent.
- Equivalent CSV and JSON fixtures can be tested for canonical equality.
- New formats require an adapter contract and conformance tests.
- Some superficially readable files are rejected instead of being interpreted ambiguously.
