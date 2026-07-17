# Verification-history analytical queries

The local history store analyzes versioned evidence reports, not uploaded source telemetry. It uses Python's standard `sqlite3`, enables foreign keys, applies ordered migrations, and runs integrity checks. The executable source of truth is [`analytics/queries.sql`](../analytics/queries.sql).

Every query is read-only and uses fixed SQL. Imports use parameterized statements. No report value becomes executable SQL.

## Query catalog

| Name                           | Question answered                                                                                    | Important interpretation boundary                                                       |
| ------------------------------ | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `recurring_faults`             | Which stable rule IDs occur most often and across the most runs?                                     | Frequency does not establish a common cause.                                            |
| `newly_introduced_regressions` | Which rule IDs most often appear with `new` classification?                                          | Depends on comparable baseline/candidate identity.                                      |
| `resolved_findings`            | Which rule IDs are most often classified resolved?                                                   | Resolution means absent in the candidate, not permanently fixed.                        |
| `profile_comparison`           | How many runs and passing runs exist by profile version, and what is the average quarantine count?   | Synthetic profiles can differ in inputs and rules, so this is descriptive.              |
| `source_message_loss`          | Which synthetic sources have recorded dropped messages?                                              | A zero count proves only that the importer received no recorded drop evidence.          |
| `benchmark_scaling`            | How do average duration and throughput change by benchmark and sample count?                         | Compare only equivalent environment and configuration records.                          |
| `model_quality_trend`          | How do recorded precision, recall, F1, false-positive rate, and gate status change by model version? | Metrics apply only to the recorded held-out synthetic seeds.                            |
| `failed_requirements`          | Which stable requirements most often record `fail` or `blocked`?                                     | A missing result is not counted as a pass or failure.                                   |
| `injected_fault_coverage`      | How many declared faults were injected and detected by scenario?                                     | This is synthetic scenario coverage, not real-world detection performance.              |
| `adapter_data_quality`         | How many records are accepted or quarantined by adapter, and what is the quarantine rate?            | Different datasets can make adapter rates incomparable.                                 |
| `quarantine_trend`             | How do quarantined records and validation errors change by day?                                      | Date aggregation can combine unlike profiles and versions.                              |
| `severity_distribution`        | What is the finding distribution by declared severity?                                               | Severity is profile and rule metadata, not a measured impact.                           |
| `slowest_benchmarks`           | Which recorded benchmark runs have the longest duration?                                             | Host environment is required before calling a run a regression.                         |
| `verification_outcomes`        | How many runs have each verification status, with average accepted records and validation errors?    | Status counts require complete imported evidence and do not imply production readiness. |

## Tables

The migration-controlled schema contains:

- `runs`: version, profile, adapter, dataset hash, row accounting, validation, comparison, and preserved report JSON;
- `sources`: per-run synthetic source profile, schema, accepted records, and dropped-message count;
- `findings`: stable rule, severity, source, time, classification, observed value, condition, and evidence;
- `injected_faults`: scenario, seed-derived identity, source, expected rule, and detected result;
- `requirement_results`: stable requirement, status, test IDs, and evidence;
- `benchmarks`: name, sample count, timing, throughput, memory, and environment;
- `model_evaluations`: model version, held-out seeds, precision, recall, F1, false-positive rate, and gate result.

## Commands

```powershell
pnpm analytics
python tools/analytics/analytics.py ingest path/to/verification-report.json
python tools/analytics/analytics.py integrity
```

Generated `analytics/history.db` files are local artifacts. Do not commit them or publish them as application source data.
