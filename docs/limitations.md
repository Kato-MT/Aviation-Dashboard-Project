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

## Experimental learned baseline

- Training and evaluation use generated synthetic telemetry and labeled injected faults.
- Held-out metrics do not establish real-world detection performance.
- A robust covariance model assumes relationships that may not match other data distributions.
- Per-channel contributions are diagnostic aids, not causal explanations.
- Deterministic rules remain authoritative even if model release gates pass.

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
