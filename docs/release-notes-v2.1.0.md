# Flight Diagnostics Workbench v2.1.0

> Published on July 17, 2026, after every applicable gate passed on commit `4439cbe06f5c7e85fba523e25cc04b3eba2c7f98`. See the [completed release verification](release-verification-v2.1.0.md).

Flight Diagnostics Workbench v2.1.0 activates the expanded synthetic communications, learned-baseline comparison, verification-history analytics, and assurance tooling that were staged behind the deterministic v2.0 release boundary.

## Highlights

- Versioned `hello`, `telemetry`, `heartbeat`, and `end` WebSocket messages
- Multiple synthetic sources, connection-health metrics, bounded queues, and bounded reconnect backoff
- Seeded disconnect, latency, jitter, dropped-packet, duplicate, reorder, stale-heartbeat, schema-mismatch, and queue-pressure scenarios
- Experimental robust-covariance anomaly score with per-channel residual contributions
- Side-by-side learned and deterministic findings, with deterministic rules remaining authoritative
- Versioned model, held-out evaluation, model card, seeds, limitations, and Python-to-TypeScript inference parity evidence
- SQLite verification history with migrations, foreign keys, indexes, integrity checks, fourteen documented analytical queries, and trend reports
- Reproducible parser property tests, mutation testing, performance benchmarks, and a documented native-first gate for a future optional development container

## Release gates

The learned detector is enabled only when its committed held-out evaluation meets both declared gates: F1 of at least 0.85 and false-positive rate of at most 5 percent. The tagged release assets carry the exact model metrics, benchmark environment and seeds, verification report, history-analytics report, model card, inference parity vector, SBOM, checksums, Monitor, Diagnostics, Configuration, and mobile screenshots, and artifact provenance.

## Important boundary

Every dataset, profile, threshold, source, stream, and injected scenario is synthetic and unclassified. This project is not affiliated with an employer or government organization and is not intended for real-world flight, safety, maintenance, or certification decisions.

Known constraints are documented in [limitations.md](limitations.md).
