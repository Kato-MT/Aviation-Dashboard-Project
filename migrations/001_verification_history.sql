CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    application_version TEXT NOT NULL,
    profile_id TEXT NOT NULL,
    profile_version TEXT NOT NULL,
    adapter TEXT NOT NULL,
    dataset_hash TEXT NOT NULL,
    accepted_records INTEGER NOT NULL CHECK (accepted_records >= 0),
    quarantined_records INTEGER NOT NULL CHECK (quarantined_records >= 0),
    validation_errors INTEGER NOT NULL CHECK (validation_errors >= 0),
    verification_status TEXT NOT NULL CHECK (verification_status IN ('pass', 'fail', 'blocked', 'not-run')),
    comparison_status TEXT NOT NULL,
    report_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sources (
    run_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    profile_id TEXT,
    schema_version TEXT,
    accepted_records INTEGER NOT NULL DEFAULT 0 CHECK (accepted_records >= 0),
    dropped_messages INTEGER NOT NULL DEFAULT 0 CHECK (dropped_messages >= 0),
    PRIMARY KEY (run_id, source_id),
    FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS findings (
    finding_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    rule_id TEXT NOT NULL,
    severity TEXT NOT NULL,
    source_id TEXT,
    finding_time TEXT,
    classification TEXT NOT NULL DEFAULT 'unclassified',
    observed_json TEXT NOT NULL,
    expected_condition TEXT NOT NULL,
    evidence_json TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS injected_faults (
    run_id TEXT NOT NULL,
    fault_id TEXT NOT NULL,
    scenario_id TEXT NOT NULL,
    source_id TEXT,
    injected_at TEXT,
    expected_rule_id TEXT,
    detected INTEGER NOT NULL CHECK (detected IN (0, 1)),
    details_json TEXT NOT NULL,
    PRIMARY KEY (run_id, fault_id),
    FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS requirement_results (
    run_id TEXT NOT NULL,
    requirement_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pass', 'fail', 'blocked', 'not-run')),
    test_ids_json TEXT NOT NULL,
    evidence TEXT NOT NULL,
    PRIMARY KEY (run_id, requirement_id),
    FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS benchmarks (
    benchmark_id TEXT PRIMARY KEY,
    run_id TEXT,
    recorded_at TEXT NOT NULL,
    benchmark_name TEXT NOT NULL,
    sample_count INTEGER NOT NULL CHECK (sample_count > 0),
    duration_ms REAL NOT NULL CHECK (duration_ms >= 0),
    throughput_per_second REAL NOT NULL CHECK (throughput_per_second >= 0),
    peak_heap_bytes INTEGER CHECK (peak_heap_bytes IS NULL OR peak_heap_bytes >= 0),
    environment_json TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS model_evaluations (
    evaluation_id TEXT PRIMARY KEY,
    run_id TEXT,
    model_version TEXT NOT NULL,
    evaluated_at TEXT NOT NULL,
    dataset_seeds_json TEXT NOT NULL,
    precision REAL NOT NULL CHECK (precision BETWEEN 0 AND 1),
    recall REAL NOT NULL CHECK (recall BETWEEN 0 AND 1),
    f1 REAL NOT NULL CHECK (f1 BETWEEN 0 AND 1),
    false_positive_rate REAL NOT NULL CHECK (false_positive_rate BETWEEN 0 AND 1),
    quality_gate_passed INTEGER NOT NULL CHECK (quality_gate_passed IN (0, 1)),
    details_json TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_runs_created_at ON runs(created_at);
CREATE INDEX IF NOT EXISTS idx_runs_profile ON runs(profile_id, profile_version);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(verification_status);
CREATE INDEX IF NOT EXISTS idx_findings_run_rule ON findings(run_id, rule_id);
CREATE INDEX IF NOT EXISTS idx_findings_rule_time ON findings(rule_id, finding_time);
CREATE INDEX IF NOT EXISTS idx_findings_classification ON findings(classification);
CREATE INDEX IF NOT EXISTS idx_faults_scenario ON injected_faults(scenario_id, detected);
CREATE INDEX IF NOT EXISTS idx_requirements_status ON requirement_results(requirement_id, status);
CREATE INDEX IF NOT EXISTS idx_benchmarks_size ON benchmarks(benchmark_name, sample_count);
CREATE INDEX IF NOT EXISTS idx_model_evaluations_version ON model_evaluations(model_version, evaluated_at);

