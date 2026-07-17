-- name: recurring_faults
SELECT rule_id, COUNT(*) AS occurrences, COUNT(DISTINCT run_id) AS affected_runs
FROM findings GROUP BY rule_id ORDER BY affected_runs DESC, occurrences DESC, rule_id;

-- name: newly_introduced_regressions
SELECT rule_id, COUNT(*) AS newly_introduced
FROM findings WHERE classification = 'new' GROUP BY rule_id
ORDER BY newly_introduced DESC, rule_id;

-- name: resolved_findings
SELECT rule_id, COUNT(*) AS resolved
FROM findings WHERE classification = 'resolved' GROUP BY rule_id
ORDER BY resolved DESC, rule_id;

-- name: profile_comparison
SELECT profile_id, profile_version, COUNT(*) AS runs,
       SUM(CASE WHEN verification_status = 'pass' THEN 1 ELSE 0 END) AS passing_runs,
       ROUND(AVG(quarantined_records), 3) AS average_quarantined_records
FROM runs GROUP BY profile_id, profile_version ORDER BY profile_id, profile_version;

-- name: source_message_loss
SELECT source_id, SUM(dropped_messages) AS dropped_messages, COUNT(DISTINCT run_id) AS runs
FROM sources GROUP BY source_id HAVING SUM(dropped_messages) > 0
ORDER BY dropped_messages DESC, source_id;

-- name: benchmark_scaling
SELECT benchmark_name, sample_count, COUNT(*) AS measurements,
       ROUND(AVG(duration_ms), 3) AS average_duration_ms,
       ROUND(AVG(throughput_per_second), 3) AS average_throughput_per_second
FROM benchmarks GROUP BY benchmark_name, sample_count ORDER BY benchmark_name, sample_count;

-- name: model_quality_trend
SELECT model_version, evaluated_at, ROUND(precision, 6) AS precision,
       ROUND(recall, 6) AS recall, ROUND(f1, 6) AS f1,
       ROUND(false_positive_rate, 6) AS false_positive_rate, quality_gate_passed
FROM model_evaluations ORDER BY evaluated_at, model_version;

-- name: failed_requirements
SELECT requirement_id, COUNT(*) AS failures, MAX(r.created_at) AS latest_failure
FROM requirement_results AS rr JOIN runs AS r ON r.run_id = rr.run_id
WHERE rr.status IN ('fail', 'blocked') GROUP BY requirement_id
ORDER BY failures DESC, requirement_id;

-- name: injected_fault_coverage
SELECT scenario_id, COUNT(*) AS injections, SUM(detected) AS detected,
       ROUND(1.0 * SUM(detected) / COUNT(*), 6) AS detection_rate
FROM injected_faults GROUP BY scenario_id ORDER BY scenario_id;

-- name: adapter_data_quality
SELECT adapter, COUNT(*) AS runs, SUM(accepted_records) AS accepted_records,
       SUM(quarantined_records) AS quarantined_records,
       ROUND(1.0 * SUM(quarantined_records) /
             NULLIF(SUM(accepted_records + quarantined_records), 0), 6) AS quarantine_rate
FROM runs GROUP BY adapter ORDER BY adapter;

-- name: quarantine_trend
SELECT substr(created_at, 1, 10) AS run_date, SUM(quarantined_records) AS quarantined_records,
       SUM(validation_errors) AS validation_errors
FROM runs GROUP BY substr(created_at, 1, 10) ORDER BY run_date;

-- name: severity_distribution
SELECT severity, COUNT(*) AS findings, COUNT(DISTINCT run_id) AS affected_runs
FROM findings GROUP BY severity ORDER BY findings DESC, severity;

-- name: slowest_benchmarks
SELECT benchmark_name, sample_count, ROUND(duration_ms, 3) AS duration_ms,
       ROUND(throughput_per_second, 3) AS throughput_per_second, recorded_at
FROM benchmarks ORDER BY duration_ms DESC LIMIT 20;

-- name: verification_outcomes
SELECT verification_status, COUNT(*) AS runs,
       ROUND(AVG(accepted_records), 3) AS average_accepted_records,
       ROUND(AVG(validation_errors), 3) AS average_validation_errors
FROM runs GROUP BY verification_status ORDER BY verification_status;

