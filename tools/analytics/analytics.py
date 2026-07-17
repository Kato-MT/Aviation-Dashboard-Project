#!/usr/bin/env python3
"""SQLite verification-history migration, ingestion, and reporting CLI."""

from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DATABASE = REPOSITORY_ROOT / "analytics" / "history.db"
DEFAULT_MIGRATIONS = REPOSITORY_ROOT / "migrations"
DEFAULT_QUERIES = REPOSITORY_ROOT / "analytics" / "queries.sql"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def stable_id(prefix: str, value: Any) -> str:
    digest = hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()[:24]
    return f"{prefix}-{digest}"


def as_mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def as_sequence(value: Any) -> Sequence[Any]:
    return value if isinstance(value, list) else []


def nested(document: Mapping[str, Any], *paths: str, default: Any = None) -> Any:
    for path in paths:
        current: Any = document
        found = True
        for component in path.split("."):
            if not isinstance(current, Mapping) or component not in current:
                found = False
                break
            current = current[component]
        if found and current is not None:
            return current
    return default


def integer(value: Any, default: int = 0) -> int:
    if isinstance(value, bool):
        return int(value)
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return default


def number(value: Any, default: float = 0.0) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return default
    return result if result == result and result not in (float("inf"), float("-inf")) else default


def normalize_status(value: Any) -> str:
    statuses = {
        "pass": "pass",
        "passed": "pass",
        "nominal": "pass",
        "fail": "fail",
        "failed": "fail",
        "failure": "fail",
        "blocked": "blocked",
        "not-run": "not-run",
        "not_run": "not-run",
        "pending": "not-run",
    }
    return statuses.get(str(value).strip().lower(), "not-run")


def connect_database(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA journal_mode = WAL")
    connection.execute("PRAGMA synchronous = NORMAL")
    return connection


def migrate(connection: sqlite3.Connection, directory: Path = DEFAULT_MIGRATIONS) -> list[str]:
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS schema_migrations (
            migration_name TEXT PRIMARY KEY,
            sha256 TEXT NOT NULL,
            applied_at TEXT NOT NULL
        )
        """
    )
    applied = {
        row["migration_name"]: row["sha256"]
        for row in connection.execute("SELECT migration_name, sha256 FROM schema_migrations")
    }
    newly_applied: list[str] = []
    for migration_path in sorted(directory.glob("*.sql")):
        sql = migration_path.read_text(encoding="utf-8")
        digest = hashlib.sha256(sql.encode("utf-8")).hexdigest()
        if migration_path.name in applied:
            if applied[migration_path.name] != digest:
                raise RuntimeError(
                    f"Applied migration {migration_path.name} was modified; add a new migration instead."
                )
            continue
        connection.executescript(sql)
        connection.execute(
            "INSERT INTO schema_migrations(migration_name, sha256, applied_at) VALUES (?, ?, ?)",
            (migration_path.name, digest, utc_now()),
        )
        connection.commit()
        newly_applied.append(migration_path.name)
    return newly_applied


def integrity_check(connection: sqlite3.Connection) -> dict[str, Any]:
    integrity_rows = [row[0] for row in connection.execute("PRAGMA integrity_check")]
    foreign_key_rows = [dict(row) for row in connection.execute("PRAGMA foreign_key_check")]
    return {
        "ok": integrity_rows == ["ok"] and not foreign_key_rows,
        "integrity": integrity_rows,
        "foreignKeyViolations": foreign_key_rows,
    }


def ingest_verification_report(connection: sqlite3.Connection, document: Mapping[str, Any]) -> str:
    telemetry_run = as_mapping(document.get("telemetryRun"))
    provenance = as_mapping(document.get("provenance"))
    validation = as_mapping(document.get("validation"))
    comparison = as_mapping(document.get("comparison"))
    counts = as_mapping(document.get("recordCounts"))
    run_id = str(
        nested(
            document,
            "runId",
            "verificationRunId",
            "telemetryRun.runId",
            "provenance.runId",
            default=stable_id("run", document),
        )
    )
    created_at = str(
        nested(document, "createdAt", "generatedAt", "provenance.generatedAt", default=utc_now())
    )
    accepted_records = integer(
        nested(
            document,
            "recordCounts.accepted",
            "recordCounts.acceptedRecords",
            "telemetryRun.acceptedRecords",
            default=len(as_sequence(telemetry_run.get("samples"))),
        )
    )
    quarantined_records = integer(
        nested(
            document,
            "recordCounts.quarantined",
            "recordCounts.quarantinedRecords",
            "telemetryRun.quarantinedRecords",
            default=len(as_sequence(telemetry_run.get("quarantinedRows"))),
        )
    )
    validation_issues = as_sequence(validation.get("issues"))
    validation_errors = integer(
        nested(document, "recordCounts.validationErrors", "validation.errorCount", default=None),
        default=sum(
            1
            for issue in validation_issues
            if str(as_mapping(issue).get("severity", "")).lower() in {"error", "fatal"}
        ),
    )
    status = normalize_status(
        nested(document, "status", "verification.status", "comparison.status", default="not-run")
    )
    profile_id = str(
        nested(document, "profileId", "profile.id", "provenance.profileId", default="unknown")
    )
    profile_version = str(
        nested(document, "profileVersion", "profile.version", "provenance.profileVersion", default="unknown")
    )

    connection.execute(
        """
        INSERT INTO runs(
            run_id, created_at, application_version, profile_id, profile_version, adapter,
            dataset_hash, accepted_records, quarantined_records, validation_errors,
            verification_status, comparison_status, report_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET
            created_at = excluded.created_at,
            application_version = excluded.application_version,
            profile_id = excluded.profile_id,
            profile_version = excluded.profile_version,
            adapter = excluded.adapter,
            dataset_hash = excluded.dataset_hash,
            accepted_records = excluded.accepted_records,
            quarantined_records = excluded.quarantined_records,
            validation_errors = excluded.validation_errors,
            verification_status = excluded.verification_status,
            comparison_status = excluded.comparison_status,
            report_json = excluded.report_json
        """,
        (
            run_id,
            created_at,
            str(provenance.get("applicationVersion", document.get("applicationVersion", "unknown"))),
            profile_id,
            profile_version,
            str(provenance.get("adapter", document.get("adapter", "unknown"))),
            str(provenance.get("datasetHash", document.get("datasetHash", "unknown"))),
            accepted_records,
            quarantined_records,
            validation_errors,
            status,
            str(comparison.get("outcome", comparison.get("status", "not-compared"))),
            canonical_json(document),
        ),
    )

    sources = list(as_sequence(document.get("sources")) or as_sequence(telemetry_run.get("sources")))
    if not sources:
        sample_source_ids = sorted(
            {
                str(as_mapping(sample).get("sourceId"))
                for sample in as_sequence(telemetry_run.get("samples"))
                if as_mapping(sample).get("sourceId")
            }
        )
        sources = [{"sourceId": source_id} for source_id in sample_source_ids]
    for source_value in sources:
        source = as_mapping(source_value)
        source_id = str(source.get("sourceId", source_value if isinstance(source_value, str) else "unknown"))
        connection.execute(
            """
            INSERT INTO sources(run_id, source_id, profile_id, schema_version, accepted_records, dropped_messages)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(run_id, source_id) DO UPDATE SET
                profile_id = excluded.profile_id,
                schema_version = excluded.schema_version,
                accepted_records = excluded.accepted_records,
                dropped_messages = excluded.dropped_messages
            """,
            (
                run_id,
                source_id,
                source.get("profileId", profile_id),
                source.get("schemaVersion"),
                integer(source.get("acceptedRecords")),
                integer(source.get("droppedMessages")),
            ),
        )

    findings = as_sequence(document.get("findings")) or as_sequence(comparison.get("findings"))
    for index, finding_value in enumerate(findings):
        finding = as_mapping(finding_value)
        finding_id = str(finding.get("findingId") or finding.get("id") or stable_id("finding", [run_id, index, finding]))
        observed = finding.get("observedValue", finding.get("observed", None))
        evidence = finding.get("evidence", {})
        expected = finding.get("expectedCondition", finding.get("expected", "Not provided"))
        connection.execute(
            """
            INSERT INTO findings(
                finding_id, run_id, rule_id, severity, source_id, finding_time,
                classification, observed_json, expected_condition, evidence_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(finding_id) DO UPDATE SET
                severity = excluded.severity,
                classification = excluded.classification,
                observed_json = excluded.observed_json,
                expected_condition = excluded.expected_condition,
                evidence_json = excluded.evidence_json
            """,
            (
                finding_id,
                run_id,
                str(finding.get("ruleId", "unknown")),
                str(finding.get("severity", "unknown")),
                finding.get("sourceId") or finding.get("source"),
                finding.get("timestamp") or finding.get("time"),
                str(finding.get("classification", finding.get("comparison", "unclassified"))),
                canonical_json(observed),
                expected if isinstance(expected, str) else canonical_json(expected),
                canonical_json(evidence),
            ),
        )

    faults = as_sequence(document.get("injectedFaults"))
    for index, fault_value in enumerate(faults):
        fault = as_mapping(fault_value)
        fault_id = str(fault.get("faultId") or stable_id("fault", [run_id, index, fault]))
        connection.execute(
            """
            INSERT INTO injected_faults(
                run_id, fault_id, scenario_id, source_id, injected_at,
                expected_rule_id, detected, details_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(run_id, fault_id) DO UPDATE SET
                detected = excluded.detected,
                details_json = excluded.details_json
            """,
            (
                run_id,
                fault_id,
                str(fault.get("scenarioId", fault.get("id", "unknown"))),
                fault.get("sourceId"),
                fault.get("timestamp") or fault.get("injectedAt"),
                fault.get("expectedRuleId"),
                int(bool(fault.get("detected", False))),
                canonical_json(fault),
            ),
        )

    requirements = as_sequence(document.get("requirementResults"))
    for requirement_value in requirements:
        requirement = as_mapping(requirement_value)
        requirement_id = str(requirement.get("requirementId", requirement.get("id", "unknown")))
        connection.execute(
            """
            INSERT INTO requirement_results(run_id, requirement_id, status, test_ids_json, evidence)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(run_id, requirement_id) DO UPDATE SET
                status = excluded.status,
                test_ids_json = excluded.test_ids_json,
                evidence = excluded.evidence
            """,
            (
                run_id,
                requirement_id,
                normalize_status(requirement.get("status")),
                canonical_json(requirement.get("testIds", [])),
                str(requirement.get("evidence", "")),
            ),
        )
    connection.commit()
    return run_id


def import_benchmarks(connection: sqlite3.Connection, document: Mapping[str, Any]) -> int:
    environment = as_mapping(document.get("environment"))
    recorded_at = str(document.get("recordedAt", utc_now()))
    inserted = 0
    for result_value in as_sequence(document.get("results")):
        result = as_mapping(result_value)
        benchmark_id = str(result.get("benchmarkId") or stable_id("benchmark", [recorded_at, result]))
        connection.execute(
            """
            INSERT OR REPLACE INTO benchmarks(
                benchmark_id, run_id, recorded_at, benchmark_name, sample_count,
                duration_ms, throughput_per_second, peak_heap_bytes, environment_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                benchmark_id,
                result.get("runId"),
                recorded_at,
                str(result.get("name", "telemetry-pipeline")),
                integer(result.get("sampleCount"), 1),
                number(result.get("durationMs")),
                number(result.get("throughputPerSecond")),
                integer(result.get("peakHeapBytes")) if result.get("peakHeapBytes") is not None else None,
                canonical_json(environment),
            ),
        )
        inserted += 1
    connection.commit()
    return inserted


def import_model_evaluation(connection: sqlite3.Connection, document: Mapping[str, Any]) -> str:
    evaluation = as_mapping(document.get("evaluation"))
    metrics = as_mapping(evaluation.get("metrics"))
    quality_gate = as_mapping(document.get("qualityGate"))
    model_version = str(document.get("modelVersion", "unknown"))
    evaluated_at = str(document.get("generatedAt", utc_now()))
    evaluation_id = stable_id("model", [model_version, evaluated_at, evaluation])
    connection.execute(
        """
        INSERT OR REPLACE INTO model_evaluations(
            evaluation_id, run_id, model_version, evaluated_at, dataset_seeds_json,
            precision, recall, f1, false_positive_rate, quality_gate_passed, details_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            evaluation_id,
            document.get("runId"),
            model_version,
            evaluated_at,
            canonical_json(evaluation.get("seeds", [])),
            number(metrics.get("precision")),
            number(metrics.get("recall")),
            number(metrics.get("f1")),
            number(metrics.get("falsePositiveRate")),
            int(bool(quality_gate.get("passed", False))),
            canonical_json(document),
        ),
    )
    connection.commit()
    return evaluation_id


def load_named_queries(path: Path = DEFAULT_QUERIES) -> dict[str, str]:
    queries: dict[str, str] = {}
    current_name: str | None = None
    current_lines: list[str] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("-- name:"):
            if current_name:
                queries[current_name] = "\n".join(current_lines).strip()
            current_name = line.split(":", 1)[1].strip()
            current_lines = []
        elif current_name:
            current_lines.append(line)
    if current_name:
        queries[current_name] = "\n".join(current_lines).strip()
    if len(queries) < 10:
        raise RuntimeError("At least ten named analytical queries are required.")
    return queries


def run_analytical_queries(
    connection: sqlite3.Connection, queries_path: Path = DEFAULT_QUERIES
) -> dict[str, list[dict[str, Any]]]:
    return {
        name: [dict(row) for row in connection.execute(sql)]
        for name, sql in load_named_queries(queries_path).items()
    }


def markdown_report(results: Mapping[str, Sequence[Mapping[str, Any]]]) -> str:
    lines = ["# Verification History Analytics", ""]
    for name, rows in results.items():
        lines.extend([f"## {name.replace('_', ' ').title()}", ""])
        if not rows:
            lines.extend(["No matching records.", ""])
            continue
        columns = list(rows[0].keys())
        lines.append("| " + " | ".join(columns) + " |")
        lines.append("| " + " | ".join("---" for _ in columns) + " |")
        for row in rows:
            values = [str(row.get(column, "")).replace("|", "\\|").replace("\n", " ") for column in columns]
            lines.append("| " + " | ".join(values) + " |")
        lines.append("")
    return "\n".join(lines)


def load_document(path: Path) -> Mapping[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, Mapping):
        raise ValueError(f"{path} must contain a JSON object.")
    return value


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=Path, default=DEFAULT_DATABASE)
    parser.add_argument("--migrations", type=Path, default=DEFAULT_MIGRATIONS)
    parser.add_argument("--queries", type=Path, default=DEFAULT_QUERIES)
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("migrate", help="Apply pending versioned migrations.")
    subparsers.add_parser("integrity", help="Run SQLite and foreign-key integrity checks.")
    ingest_parser = subparsers.add_parser("ingest", help="Ingest a verification report JSON file.")
    ingest_parser.add_argument("report", type=Path)
    benchmark_parser = subparsers.add_parser("import-benchmarks", help="Import benchmark JSON.")
    benchmark_parser.add_argument("benchmark", type=Path)
    model_parser = subparsers.add_parser("import-model", help="Import learned-model evaluation JSON.")
    model_parser.add_argument("evaluation", type=Path)
    report_parser = subparsers.add_parser("report", help="Generate all analytical trend reports.")
    report_parser.add_argument("--format", choices=("markdown", "json"), default="markdown")
    report_parser.add_argument("--output", type=Path)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    with connect_database(args.database) as connection:
        applied = migrate(connection, args.migrations)
        if args.command == "migrate":
            payload: Any = {"applied": applied, "database": str(args.database)}
        elif args.command == "integrity":
            payload = integrity_check(connection)
            if not payload["ok"]:
                print(json.dumps(payload, indent=2))
                return 1
        elif args.command == "ingest":
            payload = {"runId": ingest_verification_report(connection, load_document(args.report))}
        elif args.command == "import-benchmarks":
            payload = {"imported": import_benchmarks(connection, load_document(args.benchmark))}
        elif args.command == "import-model":
            payload = {"evaluationId": import_model_evaluation(connection, load_document(args.evaluation))}
        else:
            results = run_analytical_queries(connection, args.queries)
            payload = json.dumps(results, indent=2) if args.format == "json" else markdown_report(results)
            if args.output:
                args.output.parent.mkdir(parents=True, exist_ok=True)
                args.output.write_text(str(payload) + "\n", encoding="utf-8", newline="\n")
                print(json.dumps({"output": str(args.output), "queries": len(results)}, indent=2))
                return 0
            print(payload)
            return 0
    print(json.dumps(payload, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, RuntimeError, sqlite3.Error) as error:
        print(f"analytics error: {error}", file=sys.stderr)
        raise SystemExit(1) from error
