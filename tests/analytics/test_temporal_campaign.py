from __future__ import annotations

import copy
import hashlib
import json
import sqlite3
import unittest
import uuid
from pathlib import Path
from typing import Any
from unittest.mock import patch

import tools.analytics.temporal_campaign as temporal_campaign

from tools.analytics.temporal_campaign import (
    CAMPAIGN_MIGRATION_V1_SQL,
    CAMPAIGN_MIGRATION_VERSION,
    MAX_CAMPAIGN_CASES,
    MAX_CAMPAIGN_RESULT_BYTES,
    campaign_integrity_check,
    campaign_report,
    connect_campaign_database,
    ingest_campaign_result,
    migrate_campaign_schema,
    validate_campaign_result,
)


def _group(group_id: str) -> dict[str, Any]:
    return {
        "groupId": group_id,
        "confusion": {
            "truePositives": 1,
            "falsePositives": 1,
            "trueNegatives": 1,
            "falseNegatives": 1,
        },
        "episodes": {"precision": 0.5, "recall": 0.5, "f1": 0.5},
    }


def _campaign_result() -> dict[str, Any]:
    result: dict[str, Any] = {
        "schemaVersion": "campaign.v1",
        "runId": "pending",
        "campaignId": "temporal-evaluation",
        "createdAt": "2026-07-17T00:00:00.000Z",
        "status": "completed",
        "spec": {
            "schemaVersion": "campaign.v1",
            "campaignId": "temporal-evaluation",
            "createdAt": "2026-07-17T00:00:00.000Z",
            "profiles": [
                {"profileId": "fixed-wing", "profileVersion": "1.0.0"}
            ],
            "scenarios": [
                {
                    "scenarioId": "temporal-disorder",
                    "phase": "cruise",
                    "variation": {
                        "variationId": "high-long-descent",
                        "generatorScenarioId": "oscillation",
                        "severityScale": 1.35,
                        "durationScale": 1.25,
                        "onsetPhase": "descent",
                    },
                }
            ],
            "seeds": [17],
        },
        "replayManifest": {
            "schemaVersion": "campaign.v1",
            "campaignId": "temporal-evaluation",
            "specSha256": "pending",
            "cases": [
                {
                    "caseId": "case-001",
                    "caseIndex": 0,
                    "profile": {
                        "profileId": "fixed-wing",
                        "profileVersion": "1.0.0",
                    },
                    "scenarioId": "temporal-disorder",
                    "phase": "cruise",
                    "seed": 17,
                    "variation": {
                        "variationId": "high-long-descent",
                        "generatorScenarioId": "oscillation",
                        "severityScale": 1.35,
                        "durationScale": 1.25,
                        "onsetPhase": "descent",
                    },
                }
            ],
        },
        "summary": {
            "plannedCases": 1,
            "attemptedCases": 1,
            "completedCases": 1,
            "failedCases": 0,
            "remainingCases": 0,
        },
        "cases": [
            {
                "caseId": "case-001",
                "caseIndex": 0,
                "seed": 17,
                "profile": {
                    "profileId": "fixed-wing",
                    "profileVersion": "1.0.0",
                },
                "scenarioId": "temporal-disorder",
                "phase": "cruise",
                "status": "completed",
                "syntheticDurationMs": 3_600_000,
                "expectedDetections": [
                    {"ruleId": "temporal.out-of-order", "episodeStartMs": 100},
                    {"ruleId": "temporal.gap", "episodeStartMs": 200},
                ],
                "negativeRuleIds": ["sensor.frozen", "nominal.safe"],
                "detections": [
                    {
                        "ruleId": "temporal.out-of-order",
                        "detectedAtMs": 125,
                        "confidence": 0.95,
                    },
                    {
                        "ruleId": "sensor.frozen",
                        "detectedAtMs": 300,
                        "confidence": 0.2,
                    },
                ],
                "confusion": {
                    "truePositives": 1,
                    "falsePositives": 1,
                    "trueNegatives": 1,
                    "falseNegatives": 1,
                },
                "matchedDetections": [
                    {
                        "expected": {
                            "ruleId": "temporal.out-of-order",
                            "episodeStartMs": 100,
                        },
                        "detection": {
                            "ruleId": "temporal.out-of-order",
                            "detectedAtMs": 125,
                            "confidence": 0.95,
                        },
                        "timeToDetectionMs": 25,
                    }
                ],
                "missingDetections": [
                    {"ruleId": "temporal.gap", "episodeStartMs": 200}
                ],
                "unexpectedDetections": [
                    {
                        "ruleId": "sensor.frozen",
                        "detectedAtMs": 300,
                        "confidence": 0.2,
                    }
                ],
                "calibration": [
                    {"confidence": 0.95, "correct": True, "abstained": False},
                    {"confidence": 0.2, "correct": False, "abstained": False},
                ],
            }
        ],
        "metrics": {
            "confusion": {
                "truePositives": 1,
                "falsePositives": 1,
                "trueNegatives": 1,
                "falseNegatives": 1,
            },
            "episodes": {"precision": 0.5, "recall": 0.5, "f1": 0.5},
            "confusionByProfile": [_group("fixed-wing@1.0.0")],
            "confusionByPhase": [_group("cruise")],
            "confusionByFault": [_group("temporal-disorder")],
            "scenarioCoverage": [
                {
                    "scenarioId": "temporal-disorder",
                    "plannedCases": 1,
                    "completedCases": 1,
                    "casesWithAllExpected": 0,
                    "expectedEpisodes": 2,
                    "detectedExpectedEpisodes": 1,
                    "coverage": 0.5,
                }
            ],
            "falseAlarmsPerRun": 1,
            "falseAlarmsPerSyntheticHour": 1,
            "syntheticHours": 1,
            "timeToDetection": {
                "count": 1,
                "minimumMs": 25,
                "maximumMs": 25,
                "meanMs": 25,
                "medianMs": 25,
                "p95Ms": 25,
            },
            "calibration": {
                "sampleCount": 2,
                "abstentionCount": 0,
                "abstentionRate": 0,
                "brierScore": 0.02125,
                "expectedCalibrationError": 0.125,
            },
            "bootstrap": {
                metric_name: {
                    "estimate": 0.5,
                    "lower": 0.25,
                    "upper": 0.75,
                    "confidenceLevel": 0.95,
                    "iterations": 200,
                }
                for metric_name in ("precision", "recall", "f1")
            },
        },
    }
    return _seal_campaign_result(result)


def _seal_campaign_result(result: dict[str, Any]) -> dict[str, Any]:
    spec = result["spec"]
    spec["campaignId"] = result["campaignId"]
    spec["createdAt"] = result["createdAt"]
    digest = hashlib.sha256(
        json.dumps(
            spec,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            allow_nan=False,
        ).encode("utf-8")
    ).hexdigest()
    result["runId"] = f"{result['campaignId']}-{digest[:16]}"
    result["replayManifest"]["campaignId"] = result["campaignId"]
    result["replayManifest"]["specSha256"] = digest
    return result


class TemporalCampaignAnalyticsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.database = Path.cwd() / f".campaign-test-{uuid.uuid4().hex}.db"
        self.connection = connect_campaign_database(self.database)
        self.assertEqual(
            migrate_campaign_schema(self.connection), [1, 2, CAMPAIGN_MIGRATION_VERSION]
        )

    def tearDown(self) -> None:
        self.connection.close()
        for suffix in ("", "-shm", "-wal"):
            candidate = Path(f"{self.database}{suffix}")
            if candidate.exists():
                candidate.unlink()

    def test_migration_is_idempotent_and_creates_contract(self) -> None:
        self.assertEqual(migrate_campaign_schema(self.connection), [])
        self.assertEqual(self.connection.execute("PRAGMA foreign_keys").fetchone()[0], 1)
        tables = {
            row[0]
            for row in self.connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        }
        self.assertTrue(
            {
                "campaign_schema_migrations",
                "campaign_runs",
                "campaign_cases",
                "campaign_detections",
                "campaign_metrics",
            }.issubset(tables)
        )
        indexes = {
            row[0]
            for row in self.connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'index'"
            )
        }
        self.assertTrue(
            {
                "idx_campaign_runs_created",
                "idx_campaign_cases_matrix",
                "idx_campaign_detections_outcome",
                "idx_campaign_metrics_scope",
                "idx_campaign_cases_variation",
            }.issubset(indexes)
        )
        columns = {
            row[1] for row in self.connection.execute("PRAGMA table_info(campaign_cases)")
        }
        self.assertTrue(
            {"variation_id", "severity_scale", "duration_scale", "onset_phase"}.issubset(
                columns
            )
        )

    def test_v1_database_upgrades_to_queryable_variation_columns(self) -> None:
        connection = sqlite3.connect(":memory:")
        try:
            connection.executescript(CAMPAIGN_MIGRATION_V1_SQL)
            connection.execute(
                "INSERT INTO campaign_schema_migrations(version, applied_at) VALUES (1, ?)",
                ("2026-07-17T00:00:00.000Z",),
            )
            self.assertEqual(migrate_campaign_schema(connection), [2, 3])
            columns = {row[1] for row in connection.execute("PRAGMA table_info(campaign_cases)")}
            self.assertIn("variation_id", columns)
            self.assertEqual(migrate_campaign_schema(connection), [])
            self.assertEqual(connection.execute("PRAGMA foreign_keys").fetchone()[0], 1)
        finally:
            connection.close()

    def test_failed_migration_rolls_back_ddl_and_restores_foreign_keys(self) -> None:
        connection = sqlite3.connect(":memory:")
        failing_script = """
        CREATE TABLE rolled_back_marker(value INTEGER);
        INSERT INTO table_that_does_not_exist(value) VALUES (1);
        """
        try:
            with patch.object(
                temporal_campaign, "CAMPAIGN_MIGRATIONS", ((99, failing_script),)
            ):
                with self.assertRaises(sqlite3.OperationalError):
                    temporal_campaign.migrate_campaign_schema(connection)
            self.assertIsNone(
                connection.execute(
                    "SELECT name FROM sqlite_master WHERE name = 'rolled_back_marker'"
                ).fetchone()
            )
            self.assertEqual(connection.execute("PRAGMA foreign_keys").fetchone()[0], 1)
        finally:
            connection.close()

    def test_foreign_keys_reject_orphan_cases(self) -> None:
        with self.assertRaises(sqlite3.IntegrityError):
            self.connection.execute(
                """
                INSERT INTO campaign_cases(
                    case_id, campaign_run_id, case_index, seed, profile_id,
                    profile_version, scenario_id, phase, status,
                    synthetic_duration_ms, true_positives, false_positives,
                    true_negatives, false_negatives
                ) VALUES (
                    'orphan', 'missing-run', 0, 1, 'profile', '1.0.0',
                    'scenario', 'cruise', 'completed', 0, 0, 0, 0, 0
                )
                """
            )

    def test_ingestion_is_idempotent_and_preserves_evidence(self) -> None:
        result = _campaign_result()
        self.assertEqual(ingest_campaign_result(self.connection, result), result["runId"])
        ingest_campaign_result(self.connection, result)

        self.assertEqual(
            self.connection.execute("SELECT COUNT(*) FROM campaign_runs").fetchone()[0],
            1,
        )
        self.assertEqual(
            self.connection.execute("SELECT COUNT(*) FROM campaign_cases").fetchone()[0],
            1,
        )
        self.assertEqual(
            self.connection.execute(
                "SELECT COUNT(*) FROM campaign_detections"
            ).fetchone()[0],
            3,
        )
        outcomes = {
            row[0]: row[1]
            for row in self.connection.execute(
                "SELECT outcome, COUNT(*) FROM campaign_detections GROUP BY outcome"
            )
        }
        self.assertEqual(outcomes, {"matched": 1, "missing": 1, "unexpected": 1})
        self.assertGreaterEqual(
            self.connection.execute("SELECT COUNT(*) FROM campaign_metrics").fetchone()[0],
            30,
        )
        variation = self.connection.execute(
            """
            SELECT variation_id, severity_scale, duration_scale, onset_phase
            FROM campaign_cases WHERE case_id = 'case-001'
            """
        ).fetchone()
        self.assertEqual(
            tuple(variation), ("high-long-descent", 1.35, 1.25, "descent")
        )

    def test_case_identity_is_scoped_to_each_campaign_run(self) -> None:
        first = _campaign_result()
        second = copy.deepcopy(first)
        second["campaignId"] = "temporal-evaluation-copy"
        second["createdAt"] = "2026-07-17T00:01:00.000Z"
        _seal_campaign_result(second)

        ingest_campaign_result(self.connection, first)
        ingest_campaign_result(self.connection, second)

        self.assertEqual(
            self.connection.execute("SELECT COUNT(*) FROM campaign_runs").fetchone()[0],
            2,
        )
        self.assertEqual(
            self.connection.execute("SELECT COUNT(*) FROM campaign_cases").fetchone()[0],
            2,
        )
        self.assertEqual(
            self.connection.execute(
                "SELECT COUNT(*) FROM campaign_cases WHERE case_id = 'case-001'"
            ).fetchone()[0],
            2,
        )
        self.assertEqual(
            self.connection.execute(
                "SELECT COUNT(*) FROM campaign_detections WHERE case_id = 'case-001'"
            ).fetchone()[0],
            6,
        )
        self.assertEqual(
            campaign_report(self.connection)["run"]["campaign_run_id"],
            second["runId"],
        )

    def test_integrity_and_report_summarize_latest_run(self) -> None:
        result = _campaign_result()
        ingest_campaign_result(self.connection, result)
        self.assertEqual(
            campaign_integrity_check(self.connection),
            {"ok": True, "integrity": ["ok"], "foreignKeyViolations": []},
        )

        report = campaign_report(self.connection)
        self.assertEqual(report["run"]["campaign_run_id"], result["runId"])
        self.assertNotIn("result_json", report["run"])
        self.assertFalse(report["evidencePolicy"]["storedResultJsonIncluded"])
        self.assertEqual(
            report["variations"],
            [
                {
                    "variation_id": "high-long-descent",
                    "severity_scale": 1.35,
                    "duration_scale": 1.25,
                    "onset_phase": "descent",
                    "case_count": 1,
                }
            ],
        )
        self.assertEqual(report["cases"], {"completed": 1})
        self.assertEqual(
            report["detections"], {"matched": 1, "missing": 1, "unexpected": 1}
        )
        self.assertEqual(report["metrics"]["f1"], 0.5)
        with self.assertRaises(KeyError):
            campaign_report(self.connection, "unknown-run")

    def test_validation_rejects_malformed_contract_without_partial_write(self) -> None:
        result = _campaign_result()
        invalid = copy.deepcopy(result)
        invalid["schemaVersion"] = "campaign.v0"
        with self.assertRaisesRegex(ValueError, "campaign.v1"):
            validate_campaign_result(invalid)
        with self.assertRaises(ValueError):
            ingest_campaign_result(self.connection, invalid)
        self.assertEqual(
            self.connection.execute("SELECT COUNT(*) FROM campaign_runs").fetchone()[0],
            0,
        )

        forged_digest = _campaign_result()
        forged_digest["replayManifest"]["specSha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "does not match"):
            validate_campaign_result(forged_digest)

        forged_summary = _campaign_result()
        forged_summary["summary"]["completedCases"] = 0
        with self.assertRaisesRegex(ValueError, "summary"):
            validate_campaign_result(forged_summary)

        nonfinite = _campaign_result()
        nonfinite["metrics"]["episodes"]["f1"] = float("nan")
        with self.assertRaisesRegex(ValueError, "finite JSON"):
            validate_campaign_result(nonfinite)

        forged_partition = _campaign_result()
        forged_partition["cases"][0]["unexpectedDetections"] = []
        with self.assertRaisesRegex(ValueError, "partitions"):
            validate_campaign_result(forged_partition)

    def test_validation_bounds_case_count_and_payload_size(self) -> None:
        excessive_cases = _campaign_result()
        excessive_cases["cases"] = [
            {**excessive_cases["cases"][0], "caseId": f"case-{index:03d}"}
            for index in range(MAX_CAMPAIGN_CASES + 1)
        ]
        with self.assertRaisesRegex(ValueError, "cases must not exceed"):
            validate_campaign_result(excessive_cases)

        excessive_payload = _campaign_result()
        excessive_payload["spec"]["note"] = "x" * MAX_CAMPAIGN_RESULT_BYTES
        with self.assertRaisesRegex(ValueError, "byte limit"):
            validate_campaign_result(excessive_payload)


if __name__ == "__main__":
    unittest.main()
