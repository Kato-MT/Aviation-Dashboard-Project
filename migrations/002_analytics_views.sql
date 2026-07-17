CREATE VIEW IF NOT EXISTS run_quality_summary AS
SELECT
    r.run_id,
    r.created_at,
    r.profile_id,
    r.profile_version,
    r.verification_status,
    r.accepted_records,
    r.quarantined_records,
    r.validation_errors,
    COUNT(f.finding_id) AS finding_count,
    SUM(CASE WHEN f.severity IN ('error', 'critical') THEN 1 ELSE 0 END) AS severe_finding_count
FROM runs AS r
LEFT JOIN findings AS f ON f.run_id = r.run_id
GROUP BY r.run_id;

CREATE VIEW IF NOT EXISTS fault_detection_summary AS
SELECT
    scenario_id,
    COUNT(*) AS injections,
    SUM(detected) AS detected,
    ROUND(1.0 * SUM(detected) / COUNT(*), 6) AS detection_rate
FROM injected_faults
GROUP BY scenario_id;

