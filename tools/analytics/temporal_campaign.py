"""SQLite persistence for synthetic temporal campaign evaluation evidence."""

from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
import math
import sqlite3
from pathlib import Path
from typing import Any, Mapping, Sequence


CAMPAIGN_SCHEMA_VERSION = "campaign.v1"
CAMPAIGN_MIGRATION_VERSION = 3
MAX_CAMPAIGN_CASES = 372
MAX_CAMPAIGN_RESULT_BYTES = 10 * 1024 * 1024
MAX_CAMPAIGN_HISTORY_PAYLOAD_BYTES = 64 * 1024 * 1024
MAX_CAMPAIGN_DATABASE_BYTES = 128 * 1024 * 1024

CAMPAIGN_MIGRATION_V1_SQL = """
CREATE TABLE IF NOT EXISTS campaign_schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campaign_runs (
    campaign_run_id TEXT PRIMARY KEY,
    schema_version TEXT NOT NULL,
    campaign_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    status TEXT NOT NULL,
    spec_sha256 TEXT NOT NULL,
    planned_cases INTEGER NOT NULL CHECK (planned_cases >= 0),
    attempted_cases INTEGER NOT NULL CHECK (attempted_cases >= 0),
    completed_cases INTEGER NOT NULL CHECK (completed_cases >= 0),
    failed_cases INTEGER NOT NULL CHECK (failed_cases >= 0),
    remaining_cases INTEGER NOT NULL CHECK (remaining_cases >= 0),
    result_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campaign_cases (
    case_id TEXT PRIMARY KEY,
    campaign_run_id TEXT NOT NULL,
    case_index INTEGER NOT NULL CHECK (case_index >= 0),
    seed INTEGER NOT NULL CHECK (seed >= 0),
    profile_id TEXT NOT NULL,
    profile_version TEXT NOT NULL,
    scenario_id TEXT NOT NULL,
    phase TEXT NOT NULL,
    status TEXT NOT NULL,
    synthetic_duration_ms REAL NOT NULL CHECK (synthetic_duration_ms >= 0),
    true_positives INTEGER NOT NULL CHECK (true_positives >= 0),
    false_positives INTEGER NOT NULL CHECK (false_positives >= 0),
    true_negatives INTEGER NOT NULL CHECK (true_negatives >= 0),
    false_negatives INTEGER NOT NULL CHECK (false_negatives >= 0),
    error_name TEXT,
    error_message TEXT,
    UNIQUE (campaign_run_id, case_index),
    UNIQUE (campaign_run_id, case_id),
    FOREIGN KEY (campaign_run_id) REFERENCES campaign_runs(campaign_run_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS campaign_detections (
    detection_id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_run_id TEXT NOT NULL,
    case_id TEXT NOT NULL,
    rule_id TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('matched', 'missing', 'unexpected')),
    detected_at_ms REAL,
    confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    details_json TEXT NOT NULL,
    FOREIGN KEY (campaign_run_id, case_id)
        REFERENCES campaign_cases(campaign_run_id, case_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS campaign_metrics (
    metric_id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_run_id TEXT NOT NULL,
    scope_type TEXT NOT NULL,
    scope_key TEXT NOT NULL,
    metric_name TEXT NOT NULL,
    metric_value REAL,
    lower_bound REAL,
    upper_bound REAL,
    metadata_json TEXT NOT NULL,
    UNIQUE (campaign_run_id, scope_type, scope_key, metric_name),
    FOREIGN KEY (campaign_run_id) REFERENCES campaign_runs(campaign_run_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_campaign_runs_created
    ON campaign_runs(created_at, campaign_run_id);
CREATE INDEX IF NOT EXISTS idx_campaign_cases_matrix
    ON campaign_cases(campaign_run_id, profile_id, phase, scenario_id, seed);
CREATE INDEX IF NOT EXISTS idx_campaign_detections_outcome
    ON campaign_detections(campaign_run_id, outcome, rule_id);
CREATE INDEX IF NOT EXISTS idx_campaign_metrics_scope
    ON campaign_metrics(campaign_run_id, scope_type, scope_key, metric_name);
"""

CAMPAIGN_MIGRATION_V2_SQL = """
ALTER TABLE campaign_cases ADD COLUMN variation_id TEXT;
ALTER TABLE campaign_cases ADD COLUMN severity_scale REAL
    CHECK (severity_scale IS NULL OR severity_scale > 0);
ALTER TABLE campaign_cases ADD COLUMN duration_scale REAL
    CHECK (duration_scale IS NULL OR duration_scale > 0);
ALTER TABLE campaign_cases ADD COLUMN onset_phase TEXT;

CREATE INDEX IF NOT EXISTS idx_campaign_cases_variation
    ON campaign_cases(
        campaign_run_id,
        variation_id,
        severity_scale,
        duration_scale,
        onset_phase
    );
"""

CAMPAIGN_MIGRATION_V3_SQL = """
DROP TABLE IF EXISTS campaign_cases_v3;
CREATE TABLE campaign_cases_v3 (
    case_id TEXT NOT NULL,
    campaign_run_id TEXT NOT NULL,
    case_index INTEGER NOT NULL CHECK (case_index >= 0),
    seed INTEGER NOT NULL CHECK (seed >= 0),
    profile_id TEXT NOT NULL,
    profile_version TEXT NOT NULL,
    scenario_id TEXT NOT NULL,
    phase TEXT NOT NULL,
    status TEXT NOT NULL,
    synthetic_duration_ms REAL NOT NULL CHECK (synthetic_duration_ms >= 0),
    true_positives INTEGER NOT NULL CHECK (true_positives >= 0),
    false_positives INTEGER NOT NULL CHECK (false_positives >= 0),
    true_negatives INTEGER NOT NULL CHECK (true_negatives >= 0),
    false_negatives INTEGER NOT NULL CHECK (false_negatives >= 0),
    error_name TEXT,
    error_message TEXT,
    variation_id TEXT,
    severity_scale REAL CHECK (severity_scale IS NULL OR severity_scale > 0),
    duration_scale REAL CHECK (duration_scale IS NULL OR duration_scale > 0),
    onset_phase TEXT,
    PRIMARY KEY (campaign_run_id, case_id),
    UNIQUE (campaign_run_id, case_index),
    FOREIGN KEY (campaign_run_id) REFERENCES campaign_runs(campaign_run_id) ON DELETE CASCADE
);

INSERT INTO campaign_cases_v3(
    case_id,
    campaign_run_id,
    case_index,
    seed,
    profile_id,
    profile_version,
    scenario_id,
    phase,
    status,
    synthetic_duration_ms,
    true_positives,
    false_positives,
    true_negatives,
    false_negatives,
    error_name,
    error_message,
    variation_id,
    severity_scale,
    duration_scale,
    onset_phase
)
SELECT
    case_id,
    campaign_run_id,
    case_index,
    seed,
    profile_id,
    profile_version,
    scenario_id,
    phase,
    status,
    synthetic_duration_ms,
    true_positives,
    false_positives,
    true_negatives,
    false_negatives,
    error_name,
    error_message,
    variation_id,
    severity_scale,
    duration_scale,
    onset_phase
FROM campaign_cases;

DROP TABLE campaign_cases;
ALTER TABLE campaign_cases_v3 RENAME TO campaign_cases;

CREATE INDEX IF NOT EXISTS idx_campaign_cases_matrix
    ON campaign_cases(campaign_run_id, profile_id, phase, scenario_id, seed);
CREATE INDEX IF NOT EXISTS idx_campaign_cases_variation
    ON campaign_cases(
        campaign_run_id,
        variation_id,
        severity_scale,
        duration_scale,
        onset_phase
    );

"""

CAMPAIGN_MIGRATIONS = (
    (1, CAMPAIGN_MIGRATION_V1_SQL),
    (2, CAMPAIGN_MIGRATION_V2_SQL),
    (3, CAMPAIGN_MIGRATION_V3_SQL),
)


def _json(value: Any) -> str:
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    )


def _utf8_size(value: str) -> int:
    return len(value.encode("utf-8"))


def _database_size(connection: sqlite3.Connection) -> int:
    page_count = int(connection.execute("PRAGMA page_count").fetchone()[0])
    page_size = int(connection.execute("PRAGMA page_size").fetchone()[0])
    return page_count * page_size


def connect_campaign_database(path: str | Path) -> sqlite3.Connection:
    connection = sqlite3.connect(str(path))
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA busy_timeout = 5000")
    return connection


def migrate_campaign_schema(connection: sqlite3.Connection) -> list[int]:
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS campaign_schema_migrations (
            version INTEGER PRIMARY KEY,
            applied_at TEXT NOT NULL
        )
        """
    )
    connection.commit()
    applied = {
        int(row[0])
        for row in connection.execute("SELECT version FROM campaign_schema_migrations")
    }
    newly_applied: list[int] = []
    for version, script in CAMPAIGN_MIGRATIONS:
        if version in applied:
            continue
        connection.commit()
        if version == 3:
            connection.execute("PRAGMA foreign_keys = OFF")
            if int(connection.execute("PRAGMA foreign_keys").fetchone()[0]) != 0:
                raise RuntimeError("Could not disable foreign keys for campaign migration v3")
        try:
            connection.executescript(
                "BEGIN IMMEDIATE;\n"
                f"{script}\n"
                "INSERT INTO campaign_schema_migrations(version, applied_at) "
                f"VALUES ({version}, '2026-07-17T00:00:00.000Z');\n"
                "COMMIT;"
            )
        except Exception:
            if connection.in_transaction:
                connection.rollback()
            raise
        finally:
            connection.execute("PRAGMA foreign_keys = ON")
            if int(connection.execute("PRAGMA foreign_keys").fetchone()[0]) != 1:
                raise RuntimeError("Campaign migrations must leave foreign keys enabled")
        newly_applied.append(version)
    return newly_applied


def _require_mapping(value: Any, path: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ValueError(f"{path} must be an object")
    return value


def _require_sequence(value: Any, path: str) -> Sequence[Any]:
    if not isinstance(value, list):
        raise ValueError(f"{path} must be an array")
    return value


def _require_string(value: Any, path: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{path} must be a nonempty string")
    return value


def _number(value: Any) -> float | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("metric value must be numeric or null")
    numeric = float(value)
    if not math.isfinite(numeric):
        raise ValueError("metric value must be finite or null")
    return numeric


def _nonnegative_integer(value: Any, path: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{path} must be a nonnegative integer")
    return value


def _spec_sha256(spec: Mapping[str, Any]) -> str:
    return hashlib.sha256(_json(spec).encode("utf-8")).hexdigest()


def _reject_nonfinite_json(constant: str) -> None:
    raise ValueError(f"nonfinite JSON constant '{constant}' is not allowed")


def _same_json_multiset(left: Sequence[Any], right: Sequence[Any]) -> bool:
    return Counter(_json(value) for value in left) == Counter(_json(value) for value in right)


def validate_campaign_result(result: Mapping[str, Any]) -> None:
    try:
        serialized = _json(result)
    except (TypeError, ValueError) as error:
        raise ValueError("campaign result must contain finite JSON values") from error
    if _utf8_size(serialized) > MAX_CAMPAIGN_RESULT_BYTES:
        raise ValueError(
            f"campaign result exceeds the {MAX_CAMPAIGN_RESULT_BYTES}-byte limit"
        )
    if result.get("schemaVersion") != CAMPAIGN_SCHEMA_VERSION:
        raise ValueError(f"schemaVersion must be {CAMPAIGN_SCHEMA_VERSION}")
    run_id = _require_string(result.get("runId"), "runId")
    campaign_id = _require_string(result.get("campaignId"), "campaignId")
    created_at = _require_string(result.get("createdAt"), "createdAt")
    status = _require_string(result.get("status"), "status")
    if status not in {"completed", "completed-with-errors", "cancelled"}:
        raise ValueError("status is unsupported")
    spec = _require_mapping(result.get("spec"), "spec")
    if spec.get("schemaVersion") != CAMPAIGN_SCHEMA_VERSION:
        raise ValueError(f"spec.schemaVersion must be {CAMPAIGN_SCHEMA_VERSION}")
    if spec.get("campaignId") != campaign_id or spec.get("createdAt") != created_at:
        raise ValueError("result metadata must match the embedded spec")
    profiles = _require_sequence(spec.get("profiles"), "spec.profiles")
    scenarios = _require_sequence(spec.get("scenarios"), "spec.scenarios")
    seeds = _require_sequence(spec.get("seeds"), "spec.seeds")
    if not profiles or not scenarios or not seeds:
        raise ValueError("campaign spec matrix dimensions must not be empty")
    planned_cases = len(profiles) * len(scenarios) * len(seeds)
    if planned_cases > MAX_CAMPAIGN_CASES:
        raise ValueError(f"campaign matrix must not exceed {MAX_CAMPAIGN_CASES} cases")

    manifest = _require_mapping(result.get("replayManifest"), "replayManifest")
    if manifest.get("schemaVersion") != CAMPAIGN_SCHEMA_VERSION:
        raise ValueError(f"replayManifest.schemaVersion must be {CAMPAIGN_SCHEMA_VERSION}")
    if manifest.get("campaignId") != campaign_id:
        raise ValueError("replayManifest.campaignId must match campaignId")
    spec_sha256 = _require_string(
        manifest.get("specSha256"), "replayManifest.specSha256"
    )
    if (
        len(spec_sha256) != 64
        or any(character not in "0123456789abcdef" for character in spec_sha256)
        or spec_sha256 != _spec_sha256(spec)
    ):
        raise ValueError("replayManifest.specSha256 does not match the embedded spec")
    if run_id != f"{campaign_id}-{spec_sha256[:16]}":
        raise ValueError("runId does not match campaignId and spec digest")

    replay_cases = _require_sequence(manifest.get("cases"), "replayManifest.cases")
    if len(replay_cases) != planned_cases:
        raise ValueError("replay manifest must contain the complete campaign matrix")
    expected_matrix: list[tuple[Mapping[str, Any], Mapping[str, Any], int]] = []
    for profile_value in profiles:
        profile = _require_mapping(profile_value, "spec.profile")
        _require_string(profile.get("profileId"), "spec.profile.profileId")
        _require_string(profile.get("profileVersion"), "spec.profile.profileVersion")
        for scenario_value in scenarios:
            scenario = _require_mapping(scenario_value, "spec.scenario")
            _require_string(scenario.get("scenarioId"), "spec.scenario.scenarioId")
            _require_string(scenario.get("phase"), "spec.scenario.phase")
            for seed_value in seeds:
                seed = _nonnegative_integer(seed_value, "spec.seed")
                expected_matrix.append((profile, scenario, seed))

    replay_ids: set[str] = set()
    for index, replay_value in enumerate(replay_cases):
        replay = _require_mapping(replay_value, f"replayManifest.cases[{index}]")
        case_id = _require_string(replay.get("caseId"), f"replay[{index}].caseId")
        if case_id in replay_ids:
            raise ValueError("replay manifest case IDs must be unique")
        replay_ids.add(case_id)
        if _nonnegative_integer(replay.get("caseIndex"), "replay.caseIndex") != index:
            raise ValueError("replay manifest case indexes must be sequential")
        expected_profile, expected_scenario, expected_seed = expected_matrix[index]
        if (
            replay.get("profile") != expected_profile
            or replay.get("scenarioId") != expected_scenario.get("scenarioId")
            or replay.get("phase") != expected_scenario.get("phase")
            or replay.get("seed") != expected_seed
            or replay.get("variation") != expected_scenario.get("variation")
        ):
            raise ValueError("replay manifest does not match the campaign matrix")

    cases = _require_sequence(result.get("cases"), "cases")
    if len(cases) > planned_cases or len(cases) > MAX_CAMPAIGN_CASES:
        raise ValueError(f"cases must not exceed {MAX_CAMPAIGN_CASES} entries")
    completed_cases = 0
    aggregate_confusion = {
        "truePositives": 0,
        "falsePositives": 0,
        "trueNegatives": 0,
        "falseNegatives": 0,
    }
    case_ids: set[str] = set()
    for index, case_value in enumerate(cases):
        campaign_case = _require_mapping(case_value, f"cases[{index}]")
        case_id = _require_string(campaign_case.get("caseId"), f"cases[{index}].caseId")
        if case_id in case_ids:
            raise ValueError("campaign result case IDs must be unique")
        case_ids.add(case_id)
        if _nonnegative_integer(campaign_case.get("caseIndex"), "case.caseIndex") != index:
            raise ValueError("campaign result case indexes must be sequential")
        replay = _require_mapping(replay_cases[index], "replay case")
        for field in ("caseId", "profile", "scenarioId", "phase", "seed"):
            if campaign_case.get(field) != replay.get(field):
                raise ValueError(f"case.{field} must match the replay manifest")
        case_status = _require_string(campaign_case.get("status"), "case.status")
        if case_status not in {"completed", "failed"}:
            raise ValueError("case.status is unsupported")
        expected_detections = list(
            _require_sequence(campaign_case.get("expectedDetections"), "case.expectedDetections")
        )
        negative_rule_ids = list(
            _require_sequence(campaign_case.get("negativeRuleIds"), "case.negativeRuleIds")
        )
        if any(not isinstance(rule_id, str) or not rule_id for rule_id in negative_rule_ids):
            raise ValueError("case.negativeRuleIds must contain nonempty strings")
        if len(set(negative_rule_ids)) != len(negative_rule_ids):
            raise ValueError("case.negativeRuleIds must be unique")
        detections = list(_require_sequence(campaign_case.get("detections"), "case.detections"))
        matches = list(
            _require_sequence(campaign_case.get("matchedDetections"), "case.matchedDetections")
        )
        missing = list(
            _require_sequence(campaign_case.get("missingDetections"), "case.missingDetections")
        )
        unexpected = list(
            _require_sequence(
                campaign_case.get("unexpectedDetections"), "case.unexpectedDetections"
            )
        )
        _require_sequence(campaign_case.get("calibration"), "case.calibration")
        matched_expected: list[Any] = []
        matched_observed: list[Any] = []
        for match_value in matches:
            match = _require_mapping(match_value, "case.matchedDetection")
            matched_expected.append(
                _require_mapping(match.get("expected"), "case.matchedDetection.expected")
            )
            matched_observed.append(
                _require_mapping(match.get("detection"), "case.matchedDetection.detection")
            )
        confusion = _require_mapping(campaign_case.get("confusion"), "case.confusion")
        confusion_counts: dict[str, int] = {}
        for key in aggregate_confusion:
            count = _nonnegative_integer(confusion.get(key), f"case.confusion.{key}")
            confusion_counts[key] = count
            if case_status == "completed":
                aggregate_confusion[key] += count
        if case_status == "completed":
            if not _same_json_multiset(
                [*matched_expected, *missing], expected_detections
            ) or not _same_json_multiset([*matched_observed, *unexpected], detections):
                raise ValueError("case detection partitions are inconsistent")
            observed_negative_rules = {
                detection.get("ruleId")
                for value in unexpected
                for detection in [_require_mapping(value, "case.unexpectedDetection")]
                if detection.get("ruleId") in negative_rule_ids
            }
            expected_confusion = {
                "truePositives": len(matches),
                "falsePositives": len(unexpected),
                "trueNegatives": len(negative_rule_ids) - len(observed_negative_rules),
                "falseNegatives": len(missing),
            }
            if confusion_counts != expected_confusion:
                raise ValueError("case.confusion does not match detection partitions")
            completed_cases += 1
        elif (
            detections
            or matches
            or unexpected
            or not _same_json_multiset(missing, expected_detections)
            or any(confusion_counts.values())
        ):
            raise ValueError("failed case evidence is inconsistent")

    failed_cases = len(cases) - completed_cases
    summary = _require_mapping(result.get("summary"), "summary")
    expected_summary = {
        "plannedCases": planned_cases,
        "attemptedCases": len(cases),
        "completedCases": completed_cases,
        "failedCases": failed_cases,
        "remainingCases": planned_cases - len(cases),
    }
    if summary != expected_summary:
        raise ValueError("summary does not match campaign case evidence")
    expected_status = (
        "cancelled"
        if len(cases) < planned_cases
        else "completed-with-errors"
        if failed_cases
        else "completed"
    )
    if status != expected_status:
        raise ValueError(f"status must be {expected_status}")

    metrics = _require_mapping(result.get("metrics"), "metrics")
    metric_confusion = _require_mapping(metrics.get("confusion"), "metrics.confusion")
    if metric_confusion != aggregate_confusion:
        raise ValueError("metrics.confusion does not match campaign case evidence")


def _insert_metric(
    connection: sqlite3.Connection,
    run_id: str,
    scope_type: str,
    scope_key: str,
    metric_name: str,
    value: Any,
    *,
    lower: Any = None,
    upper: Any = None,
    metadata: Mapping[str, Any] | None = None,
) -> None:
    connection.execute(
        """
        INSERT INTO campaign_metrics(
            campaign_run_id, scope_type, scope_key, metric_name,
            metric_value, lower_bound, upper_bound, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            run_id,
            scope_type,
            scope_key,
            metric_name,
            _number(value),
            _number(lower),
            _number(upper),
            _json(metadata or {}),
        ),
    )


def _ingest_case_detections(
    connection: sqlite3.Connection,
    run_id: str,
    campaign_case: Mapping[str, Any],
) -> None:
    case_id = _require_string(campaign_case.get("caseId"), "case.caseId")
    for match in _require_sequence(campaign_case.get("matchedDetections"), "matchedDetections"):
        match_map = _require_mapping(match, "matchedDetection")
        detection = _require_mapping(match_map.get("detection"), "matchedDetection.detection")
        connection.execute(
            """
            INSERT INTO campaign_detections(
                campaign_run_id, case_id, rule_id, outcome,
                detected_at_ms, confidence, details_json
            ) VALUES (?, ?, ?, 'matched', ?, ?, ?)
            """,
            (
                run_id,
                case_id,
                _require_string(detection.get("ruleId"), "detection.ruleId"),
                _number(detection.get("detectedAtMs")),
                _number(detection.get("confidence")),
                _json(match_map),
            ),
        )
    for expected in _require_sequence(campaign_case.get("missingDetections"), "missingDetections"):
        expected_map = _require_mapping(expected, "missingDetection")
        connection.execute(
            """
            INSERT INTO campaign_detections(
                campaign_run_id, case_id, rule_id, outcome,
                detected_at_ms, confidence, details_json
            ) VALUES (?, ?, ?, 'missing', NULL, NULL, ?)
            """,
            (
                run_id,
                case_id,
                _require_string(expected_map.get("ruleId"), "missingDetection.ruleId"),
                _json(expected_map),
            ),
        )
    for detection in _require_sequence(
        campaign_case.get("unexpectedDetections"), "unexpectedDetections"
    ):
        detection_map = _require_mapping(detection, "unexpectedDetection")
        connection.execute(
            """
            INSERT INTO campaign_detections(
                campaign_run_id, case_id, rule_id, outcome,
                detected_at_ms, confidence, details_json
            ) VALUES (?, ?, ?, 'unexpected', ?, ?, ?)
            """,
            (
                run_id,
                case_id,
                _require_string(detection_map.get("ruleId"), "unexpectedDetection.ruleId"),
                _number(detection_map.get("detectedAtMs")),
                _number(detection_map.get("confidence")),
                _json(detection_map),
            ),
        )


def _ingest_metrics(
    connection: sqlite3.Connection,
    run_id: str,
    metrics: Mapping[str, Any],
) -> None:
    confusion = _require_mapping(metrics.get("confusion"), "metrics.confusion")
    for source_name, metric_name in (
        ("truePositives", "true_positives"),
        ("falsePositives", "false_positives"),
        ("trueNegatives", "true_negatives"),
        ("falseNegatives", "false_negatives"),
    ):
        _insert_metric(
            connection, run_id, "campaign", "overall", metric_name, confusion.get(source_name)
        )

    episodes = _require_mapping(metrics.get("episodes"), "metrics.episodes")
    for name in ("precision", "recall", "f1"):
        _insert_metric(connection, run_id, "campaign", "overall", name, episodes.get(name))
    for source_name, metric_name in (
        ("falseAlarmsPerRun", "false_alarms_per_run"),
        ("falseAlarmsPerSyntheticHour", "false_alarms_per_synthetic_hour"),
        ("syntheticHours", "synthetic_hours"),
    ):
        _insert_metric(connection, run_id, "campaign", "overall", metric_name, metrics.get(source_name))

    for source_name, scope_type in (
        ("confusionByProfile", "profile"),
        ("confusionByPhase", "phase"),
        ("confusionByFault", "fault"),
    ):
        for group in _require_sequence(metrics.get(source_name), f"metrics.{source_name}"):
            group_map = _require_mapping(group, source_name)
            group_id = _require_string(group_map.get("groupId"), f"{source_name}.groupId")
            group_confusion = _require_mapping(group_map.get("confusion"), "group.confusion")
            group_episodes = _require_mapping(group_map.get("episodes"), "group.episodes")
            for key, metric_name in (
                ("truePositives", "true_positives"),
                ("falsePositives", "false_positives"),
                ("trueNegatives", "true_negatives"),
                ("falseNegatives", "false_negatives"),
            ):
                _insert_metric(
                    connection,
                    run_id,
                    scope_type,
                    group_id,
                    metric_name,
                    group_confusion.get(key),
                )
            for metric_name in ("precision", "recall", "f1"):
                _insert_metric(
                    connection,
                    run_id,
                    scope_type,
                    group_id,
                    metric_name,
                    group_episodes.get(metric_name),
                )

    for coverage in _require_sequence(
        metrics.get("scenarioCoverage"), "metrics.scenarioCoverage"
    ):
        coverage_map = _require_mapping(coverage, "scenarioCoverage")
        scenario_id = _require_string(coverage_map.get("scenarioId"), "coverage.scenarioId")
        for source_name, metric_name in (
            ("plannedCases", "planned_cases"),
            ("completedCases", "completed_cases"),
            ("casesWithAllExpected", "cases_with_all_expected"),
            ("expectedEpisodes", "expected_episodes"),
            ("detectedExpectedEpisodes", "detected_expected_episodes"),
            ("coverage", "coverage"),
        ):
            _insert_metric(
                connection,
                run_id,
                "scenario",
                scenario_id,
                metric_name,
                coverage_map.get(source_name),
            )

    for source_name, scope_key in (
        ("timeToDetection", "time_to_detection"),
        ("calibration", "calibration"),
    ):
        summary = _require_mapping(metrics.get(source_name), f"metrics.{source_name}")
        for metric_name, value in summary.items():
            if isinstance(value, (int, float)) or value is None:
                _insert_metric(
                    connection,
                    run_id,
                    "campaign",
                    scope_key,
                    metric_name,
                    value,
                )

    bootstrap = _require_mapping(metrics.get("bootstrap"), "metrics.bootstrap")
    for metric_name in ("precision", "recall", "f1"):
        interval = _require_mapping(bootstrap.get(metric_name), f"bootstrap.{metric_name}")
        _insert_metric(
            connection,
            run_id,
            "bootstrap",
            "overall",
            metric_name,
            interval.get("estimate"),
            lower=interval.get("lower"),
            upper=interval.get("upper"),
            metadata={
                "confidenceLevel": interval.get("confidenceLevel"),
                "iterations": interval.get("iterations"),
            },
        )


def ingest_campaign_result(
    connection: sqlite3.Connection, result: Mapping[str, Any]
) -> str:
    validate_campaign_result(result)
    result_json = _json(result)
    run_id = _require_string(result.get("runId"), "runId")
    summary = _require_mapping(result.get("summary"), "summary")
    manifest = _require_mapping(result.get("replayManifest"), "replayManifest")
    cases = _require_sequence(result.get("cases"), "cases")
    metrics = _require_mapping(result.get("metrics"), "metrics")
    spec = _require_mapping(result.get("spec"), "spec")
    retained_payload_bytes = int(
        connection.execute(
            """
            SELECT COALESCE(SUM(length(CAST(result_json AS BLOB))), 0)
            FROM campaign_runs
            WHERE campaign_run_id <> ?
            """,
            (run_id,),
        ).fetchone()[0]
    )
    if retained_payload_bytes + _utf8_size(result_json) > MAX_CAMPAIGN_HISTORY_PAYLOAD_BYTES:
        raise ValueError(
            "campaign history payload limit reached; archive or remove older runs before ingest"
        )
    if _database_size(connection) > MAX_CAMPAIGN_DATABASE_BYTES:
        raise ValueError(
            "campaign history database size limit reached; archive or remove older runs before ingest"
        )
    scenario_variations: dict[str, Mapping[str, Any]] = {}
    for scenario_value in _require_sequence(spec.get("scenarios"), "spec.scenarios"):
        scenario = _require_mapping(scenario_value, "spec.scenario")
        scenario_id = _require_string(scenario.get("scenarioId"), "spec.scenario.scenarioId")
        variation_value = scenario.get("variation")
        if variation_value is not None:
            scenario_variations[scenario_id] = _require_mapping(
                variation_value, "spec.scenario.variation"
            )

    with connection:
        connection.execute(
            """
            INSERT INTO campaign_runs(
                campaign_run_id, schema_version, campaign_id, created_at, status,
                spec_sha256, planned_cases, attempted_cases, completed_cases,
                failed_cases, remaining_cases, result_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(campaign_run_id) DO UPDATE SET
                schema_version = excluded.schema_version,
                campaign_id = excluded.campaign_id,
                created_at = excluded.created_at,
                status = excluded.status,
                spec_sha256 = excluded.spec_sha256,
                planned_cases = excluded.planned_cases,
                attempted_cases = excluded.attempted_cases,
                completed_cases = excluded.completed_cases,
                failed_cases = excluded.failed_cases,
                remaining_cases = excluded.remaining_cases,
                result_json = excluded.result_json
            """,
            (
                run_id,
                result["schemaVersion"],
                result["campaignId"],
                result["createdAt"],
                result.get("status"),
                manifest["specSha256"],
                summary.get("plannedCases", 0),
                summary.get("attemptedCases", 0),
                summary.get("completedCases", 0),
                summary.get("failedCases", 0),
                summary.get("remainingCases", 0),
                result_json,
            ),
        )
        connection.execute("DELETE FROM campaign_cases WHERE campaign_run_id = ?", (run_id,))
        connection.execute("DELETE FROM campaign_metrics WHERE campaign_run_id = ?", (run_id,))

        for campaign_case_value in cases:
            campaign_case = _require_mapping(campaign_case_value, "case")
            profile = _require_mapping(campaign_case.get("profile"), "case.profile")
            confusion = _require_mapping(campaign_case.get("confusion"), "case.confusion")
            scenario_id = _require_string(campaign_case.get("scenarioId"), "case.scenarioId")
            variation = scenario_variations.get(scenario_id)
            variation_id = None
            severity_scale = None
            duration_scale = None
            onset_phase = None
            if variation is not None:
                variation_id = _require_string(
                    variation.get("variationId"), "case.variation.variationId"
                )
                severity_scale = _number(variation.get("severityScale"))
                duration_scale = _number(variation.get("durationScale"))
                onset_phase = _require_string(
                    variation.get("onsetPhase"), "case.variation.onsetPhase"
                )
                if severity_scale is None or severity_scale <= 0:
                    raise ValueError("case.variation.severityScale must be positive")
                if duration_scale is None or duration_scale <= 0:
                    raise ValueError("case.variation.durationScale must be positive")
            error = campaign_case.get("error")
            error_map = _require_mapping(error, "case.error") if error is not None else {}
            connection.execute(
                """
                INSERT INTO campaign_cases(
                    case_id, campaign_run_id, case_index, seed,
                    profile_id, profile_version, scenario_id, phase, status,
                    synthetic_duration_ms, true_positives, false_positives,
                    true_negatives, false_negatives, error_name, error_message,
                    variation_id, severity_scale, duration_scale, onset_phase
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    campaign_case.get("caseId"),
                    run_id,
                    campaign_case.get("caseIndex"),
                    campaign_case.get("seed"),
                    profile.get("profileId"),
                    profile.get("profileVersion"),
                    scenario_id,
                    campaign_case.get("phase"),
                    campaign_case.get("status"),
                    campaign_case.get("syntheticDurationMs", 0),
                    confusion.get("truePositives", 0),
                    confusion.get("falsePositives", 0),
                    confusion.get("trueNegatives", 0),
                    confusion.get("falseNegatives", 0),
                    error_map.get("name"),
                    error_map.get("message"),
                    variation_id,
                    severity_scale,
                    duration_scale,
                    onset_phase,
                ),
            )
            _ingest_case_detections(connection, run_id, campaign_case)
        _ingest_metrics(connection, run_id, metrics)
        if _database_size(connection) > MAX_CAMPAIGN_DATABASE_BYTES:
            raise ValueError(
                "campaign history database size limit reached; ingestion was rolled back"
            )
    return run_id


def campaign_integrity_check(connection: sqlite3.Connection) -> dict[str, Any]:
    integrity = [str(row[0]) for row in connection.execute("PRAGMA integrity_check")]
    foreign_keys = [dict(row) for row in connection.execute("PRAGMA foreign_key_check")]
    return {
        "ok": integrity == ["ok"] and not foreign_keys,
        "integrity": integrity,
        "foreignKeyViolations": foreign_keys,
    }


def campaign_report(
    connection: sqlite3.Connection, run_id: str | None = None
) -> dict[str, Any]:
    if run_id is None:
        row = connection.execute(
            "SELECT campaign_run_id FROM campaign_runs ORDER BY created_at DESC, campaign_run_id DESC LIMIT 1"
        ).fetchone()
        if row is None:
            return {
                "run": None,
                "cases": {},
                "detections": {},
                "metrics": {},
                "variations": [],
                "evidencePolicy": {
                    "storedResultJsonIncluded": False,
                    "note": "The full versioned campaign remains in SQLite; this history report is a concise summary.",
                },
            }
        run_id = str(row[0])

    run = connection.execute(
        """
        SELECT
            campaign_run_id,
            schema_version,
            campaign_id,
            created_at,
            status,
            spec_sha256,
            planned_cases,
            attempted_cases,
            completed_cases,
            failed_cases,
            remaining_cases
        FROM campaign_runs
        WHERE campaign_run_id = ?
        """,
        (run_id,),
    ).fetchone()
    if run is None:
        raise KeyError(f"Unknown campaign run '{run_id}'")
    case_rows = connection.execute(
        """
        SELECT status, COUNT(*) AS count
        FROM campaign_cases WHERE campaign_run_id = ? GROUP BY status ORDER BY status
        """,
        (run_id,),
    ).fetchall()
    detection_rows = connection.execute(
        """
        SELECT outcome, COUNT(*) AS count
        FROM campaign_detections WHERE campaign_run_id = ? GROUP BY outcome ORDER BY outcome
        """,
        (run_id,),
    ).fetchall()
    metric_rows = connection.execute(
        """
        SELECT metric_name, metric_value
        FROM campaign_metrics
        WHERE campaign_run_id = ? AND scope_type = 'campaign' AND scope_key = 'overall'
        ORDER BY metric_name
        """,
        (run_id,),
    ).fetchall()
    variation_rows = connection.execute(
        """
        SELECT
            variation_id,
            severity_scale,
            duration_scale,
            onset_phase,
            COUNT(*) AS case_count
        FROM campaign_cases
        WHERE campaign_run_id = ? AND variation_id IS NOT NULL
        GROUP BY variation_id, severity_scale, duration_scale, onset_phase
        ORDER BY variation_id
        """,
        (run_id,),
    ).fetchall()
    return {
        "run": dict(run),
        "cases": {str(row["status"]): int(row["count"]) for row in case_rows},
        "detections": {str(row["outcome"]): int(row["count"]) for row in detection_rows},
        "metrics": {str(row["metric_name"]): row["metric_value"] for row in metric_rows},
        "variations": [dict(row) for row in variation_rows],
        "evidencePolicy": {
            "storedResultJsonIncluded": False,
            "note": "The full versioned campaign remains in SQLite; this history report is a concise summary.",
        },
    }


def _load_json(path: Path) -> Mapping[str, Any]:
    if path.stat().st_size > MAX_CAMPAIGN_RESULT_BYTES:
        raise ValueError(
            f"campaign result exceeds the {MAX_CAMPAIGN_RESULT_BYTES}-byte limit"
        )
    value = json.loads(
        path.read_text(encoding="utf-8"), parse_constant=_reject_nonfinite_json
    )
    return _require_mapping(value, str(path))


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=Path, default=Path("analytics/campaign-history.db"))
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("migrate")
    ingest_parser = subparsers.add_parser("ingest")
    ingest_parser.add_argument("result", type=Path)
    subparsers.add_parser("integrity")
    report_parser = subparsers.add_parser("report")
    report_parser.add_argument("--run-id")
    args = parser.parse_args(argv)

    args.database.parent.mkdir(parents=True, exist_ok=True)
    connection = connect_campaign_database(args.database)
    try:
        migrate_campaign_schema(connection)
        if args.command == "migrate":
            output: Any = {"migrated": True}
        elif args.command == "ingest":
            output = {"runId": ingest_campaign_result(connection, _load_json(args.result))}
        elif args.command == "integrity":
            output = campaign_integrity_check(connection)
        else:
            output = campaign_report(connection, args.run_id)
        print(json.dumps(output, indent=2, sort_keys=True, allow_nan=False))
        return 0
    finally:
        connection.close()


if __name__ == "__main__":
    raise SystemExit(main())
