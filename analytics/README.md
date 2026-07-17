# Verification History Analytics

The local SQLite history store uses Python's standard `sqlite3` module. It is
designed for exported verification evidence, not uploaded source telemetry.
Foreign keys, versioned migrations, indexes, integrity checks, and idempotent
imports are enabled by default.

```powershell
pnpm analytics
python tools/analytics/analytics.py ingest path/to/verification-report.json
python tools/analytics/analytics.py import-benchmarks benchmark/latest.json
python tools/analytics/analytics.py import-model models/evaluation_v1.json
python tools/analytics/analytics.py integrity
```

`queries.sql` contains fourteen named analyses covering recurring faults,
regressions, resolved findings, profile comparisons, message loss, benchmark
scaling, model quality, failed requirements, injected-fault coverage, adapter
data quality, quarantine trends, severity, slow benchmarks, and verification
outcomes. The generated `analytics/history.db` file is local evidence and is not
committed.
