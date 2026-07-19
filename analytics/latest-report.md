# Verification History Analytics

## Recurring Faults

| rule_id | occurrences | affected_runs |
| --- | --- | --- |
| baseline.overspeed | 5 | 1 |
| baseline.rapid-descent | 3 | 1 |
| baseline.fuel-change | 1 | 1 |

## Newly Introduced Regressions

No matching records.

## Resolved Findings

No matching records.

## Profile Comparison

| profile_id | profile_version | runs | passing_runs | average_quarantined_records |
| --- | --- | --- | --- | --- |
| included-baseline | 1.0.0 | 1 | 0 | 0.0 |

## Source Message Loss

No matching records.

## Benchmark Scaling

| benchmark_name | sample_count | measurements | average_duration_ms | average_throughput_per_second |
| --- | --- | --- | --- | --- |
| profile-rule-engine | 1000 | 1 | 1.194 | 837520.938 |
| profile-rule-engine | 10000 | 1 | 10.673 | 936934.911 |
| profile-rule-engine | 100000 | 1 | 68.229 | 1465646.707 |

## Model Quality Trend

| model_version | evaluated_at | precision | recall | f1 | false_positive_rate | quality_gate_passed |
| --- | --- | --- | --- | --- | --- | --- |
| 1.0.0 | 2026-07-17T00:00:00.000Z | 0.84507 | 1.0 | 0.916031 | 0.011702 | 1 |

## Failed Requirements

No matching records.

## Injected Fault Coverage

No matching records.

## Adapter Data Quality

| adapter | runs | accepted_records | quarantined_records | quarantine_rate |
| --- | --- | --- | --- | --- |
| legacy-csv@2.0.0 | 1 | 85 | 0 | 0.0 |

## Quarantine Trend

| run_date | quarantined_records | validation_errors |
| --- | --- | --- |
| 2026-07-19 | 0 | 0 |

## Severity Distribution

| severity | findings | affected_runs |
| --- | --- | --- |
| warning | 6 | 1 |
| error | 3 | 1 |

## Slowest Benchmarks

| benchmark_name | sample_count | duration_ms | throughput_per_second | recorded_at |
| --- | --- | --- | --- | --- |
| profile-rule-engine | 100000 | 68.229 | 1465646.707 | 2026-07-19T21:57:32.381Z |
| profile-rule-engine | 10000 | 10.673 | 936934.911 | 2026-07-19T21:57:32.381Z |
| profile-rule-engine | 1000 | 1.194 | 837520.938 | 2026-07-19T21:57:32.381Z |

## Verification Outcomes

| verification_status | runs | average_accepted_records | average_validation_errors |
| --- | --- | --- | --- |
| not-run | 1 | 85.0 | 0.0 |

