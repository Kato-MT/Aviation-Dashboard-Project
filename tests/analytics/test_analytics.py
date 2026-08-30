from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from tools.analytics.analytics import (
    DEFAULT_MIGRATIONS,
    DEFAULT_QUERIES,
    connect_database,
    import_benchmarks,
    import_model_evaluation,
    ingest_verification_report,
    integrity_check,
    load_named_queries,
    markdown_report,
    migrate,
    run_analytical_queries,
)


class AnalyticsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.database = Path(self.temporary.name) / "history.db"
        self.connection = connect_database(self.database)
        migrate(self.connection, DEFAULT_MIGRATIONS)

    def tearDown(self) -> None:
        self.connection.close()
        self.temporary.cleanup()

    def test_migrations_create_required_tables_and_indexes(self) -> None:
        tables = {
            row[0]
            for row in self.connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        }
        self.assertTrue(
            {
                "runs",
                "sources",
                "findings",
                "injected_faults",
                "requirement_results",
                "benchmarks",
                "model_evaluations",
            }.issubset(tables)
        )
        indexes = {
            row[0]
            for row in self.connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'index'"
            )
        }
        self.assertIn("idx_findings_run_rule", indexes)
        self.assertIn("idx_benchmarks_size", indexes)

    def test_migrations_are_idempotent(self) -> None:
        self.assertEqual(migrate(self.connection, DEFAULT_MIGRATIONS), [])
        count = self.connection.execute("SELECT COUNT(*) FROM schema_migrations").fetchone()[0]
        self.assertEqual(count, 2)

    def test_ingests_run_children_and_is_idempotent(self) -> None:
        report = {
            "runId": "run-test-001",
            "createdAt": "2026-07-17T00:00:00.000Z",
            "status": "pass",
            "profile": {"id": "included-baseline", "version": "1.0.0"},
            "provenance": {
                "applicationVersion": "2.0.0",
                "adapter": "legacy-csv",
                "datasetHash": "abc123",
            },
            "recordCounts": {"accepted": 85, "quarantined": 0, "validationErrors": 0},
            "sources": [{"sourceId": "baseline", "acceptedRecords": 85}],
            "findings": [
                {
                    "findingId": "finding-1",
                    "ruleId": "baseline.overspeed",
                    "severity": "warning",
                    "sourceId": "baseline",
                    "timestamp": "2026-01-01T00:00:01.000Z",
                    "classification": "persisting",
                    "observedValue": 501,
                    "expectedCondition": "airspeed <= synthetic threshold",
                    "evidence": {"sampleIndex": 1},
                }
            ],
            "injectedFaults": [
                {"faultId": "fault-1", "scenarioId": "overspeed", "detected": True}
            ],
            "requirementResults": [
                {"requirementId": "REQ-DIAG-001", "status": "pass", "testIds": ["T-1"]}
            ],
        }
        self.assertEqual(ingest_verification_report(self.connection, report), "run-test-001")
        ingest_verification_report(self.connection, report)
        self.assertEqual(self.connection.execute("SELECT COUNT(*) FROM runs").fetchone()[0], 1)
        self.assertEqual(self.connection.execute("SELECT COUNT(*) FROM findings").fetchone()[0], 1)
        self.assertEqual(self.connection.execute("SELECT accepted_records FROM runs").fetchone()[0], 85)

    def test_ingests_minimized_diagnostic_verification_v2_report(self) -> None:
        finding = {
            "findingId": "finding-v2",
            "fingerprint": "stable-fingerprint-v1",
            "ruleId": "baseline.overspeed",
            "ruleLabel": "Synthetic overspeed condition",
            "severity": "warning",
            "sourceId": "synthetic-source-1",
            "observedValue": 525,
            "expectedCondition": "speed <= 520 kts",
            "evidence": {"message": "Synthetic speed exceeded the threshold."},
            "origin": "rule-engine",
        }
        report = {
            "reportSchemaVersion": "diagnostic-report.v1",
            "generatedAt": "2026-08-29T00:00:00.000Z",
            "run": {
                "runId": "candidate-v2",
                "schemaVersion": "telemetry.v1",
                "adapterId": "legacy-csv",
                "adapterVersion": "2.0.0",
                "profileId": "included-baseline",
                "profileVersion": "1.0.0",
                "fatal": False,
                "provenance": {
                    "applicationVersion": "2.2.0",
                    "datasetSha256": "b" * 64,
                    "acceptedRecords": 85,
                    "quarantinedRecords": 1,
                },
                "validationIssues": [
                    {
                        "code": "NONNUMERIC_VALUE",
                        "disposition": "recoverable",
                        "message": "Candidate row was quarantined.",
                    }
                ],
                "quarantinedRows": [{"rowNumber": 12, "issueCodes": ["NONNUMERIC_VALUE"]}],
            },
            "analysis": {"runId": "candidate-v2", "findings": [finding]},
            "injectedFaults": [
                {
                    "faultId": "candidate-v2:stale-feed:seed-1337",
                    "scenarioId": "stale-feed",
                    "seed": 1337,
                    "target": "canonical",
                    "expectedRuleIds": [
                        "time.timestamp.gap",
                        "feed.source.stale",
                    ],
                    "detectedRuleIds": [
                        "time.timestamp.gap",
                        "feed.source.stale",
                    ],
                    "detected": True,
                    "synthetic": True,
                }
            ],
            "verification": {
                "schemaVersion": "verification.v2",
                "status": "pass",
                "candidate": {"fatalValidationIssueCount": 0},
                "resolved": [],
                "persisting": [
                    {
                        "fingerprint": "stable-fingerprint-v1",
                        "baseline": finding,
                        "candidate": finding,
                    }
                ],
                "newlyIntroduced": [],
                "provenance": {
                    "applicationVersion": "3.0.0-dev",
                    "profileId": "included-baseline",
                    "profileVersion": "1.0.0",
                },
                "requirementResults": [
                    {
                        "requirementId": "FDW-VER-001",
                        "status": "pass",
                        "testIds": ["TC-VER-001"],
                        "evidence": "Baseline and candidate compared.",
                    }
                ],
            },
            "exportPolicy": {"sourceDataIncluded": False},
        }

        self.assertEqual(
            ingest_verification_report(self.connection, report), "candidate-v2"
        )
        run = self.connection.execute("SELECT * FROM runs").fetchone()
        self.assertEqual(run["application_version"], "3.0.0-dev")
        self.assertEqual(run["adapter"], "legacy-csv@2.0.0")
        self.assertEqual(run["dataset_hash"], "b" * 64)
        self.assertEqual(run["accepted_records"], 85)
        self.assertEqual(run["quarantined_records"], 1)
        self.assertEqual(run["verification_status"], "pass")
        imported_finding = self.connection.execute("SELECT * FROM findings").fetchone()
        self.assertEqual(imported_finding["classification"], "persisting")
        requirement = self.connection.execute(
            "SELECT * FROM requirement_results"
        ).fetchone()
        self.assertEqual(requirement["requirement_id"], "FDW-VER-001")
        self.assertEqual(json.loads(requirement["test_ids_json"]), ["TC-VER-001"])
        fault = self.connection.execute("SELECT * FROM injected_faults").fetchone()
        self.assertEqual(fault["fault_id"], "candidate-v2:stale-feed:seed-1337")
        self.assertEqual(fault["scenario_id"], "stale-feed")
        self.assertEqual(fault["expected_rule_id"], "time.timestamp.gap")
        self.assertEqual(fault["detected"], 1)
        details = json.loads(fault["details_json"])
        self.assertEqual(details["seed"], 1337)
        self.assertEqual(
            details["expectedRuleIds"],
            ["time.timestamp.gap", "feed.source.stale"],
        )
        self.assertEqual(
            details["detectedRuleIds"],
            ["time.timestamp.gap", "feed.source.stale"],
        )

    def test_foreign_keys_reject_orphans(self) -> None:
        with self.assertRaises(sqlite3.IntegrityError):
            self.connection.execute(
                "INSERT INTO sources(run_id, source_id) VALUES ('missing-run', 'source')"
            )

    def test_imports_benchmarks_and_model_metrics(self) -> None:
        benchmark_count = import_benchmarks(
            self.connection,
            {
                "recordedAt": "2026-07-17T00:00:00.000Z",
                "environment": {"node": "v24"},
                "results": [
                    {
                        "name": "profile-rule-engine",
                        "sampleCount": 1000,
                        "durationMs": 10,
                        "throughputPerSecond": 100000,
                    }
                ],
            },
        )
        evaluation_id = import_model_evaluation(
            self.connection,
            {
                "modelVersion": "1.0.0",
                "generatedAt": "2026-07-17T00:00:00.000Z",
                "evaluation": {
                    "seeds": [701],
                    "metrics": {
                        "precision": 0.9,
                        "recall": 0.95,
                        "f1": 0.924,
                        "falsePositiveRate": 0.01,
                    },
                },
                "qualityGate": {"passed": True},
            },
        )
        self.assertEqual(benchmark_count, 1)
        self.assertTrue(evaluation_id.startswith("model-"))
        self.assertEqual(self.connection.execute("SELECT COUNT(*) FROM benchmarks").fetchone()[0], 1)
        self.assertEqual(
            self.connection.execute("SELECT quality_gate_passed FROM model_evaluations").fetchone()[0],
            1,
        )

    def test_integrity_check_passes(self) -> None:
        self.assertEqual(
            integrity_check(self.connection),
            {"ok": True, "integrity": ["ok"], "foreignKeyViolations": []},
        )

    def test_fourteen_named_queries_execute_and_render(self) -> None:
        queries = load_named_queries(DEFAULT_QUERIES)
        self.assertGreaterEqual(len(queries), 14)
        results = run_analytical_queries(self.connection, DEFAULT_QUERIES)
        self.assertEqual(set(results), set(queries))
        report = markdown_report(results)
        self.assertIn("# Verification History Analytics", report)
        self.assertIn("## Recurring Faults", report)


if __name__ == "__main__":
    unittest.main()
