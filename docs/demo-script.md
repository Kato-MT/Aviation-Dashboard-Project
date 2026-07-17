# 90-second demonstration script

Use the included synthetic dataset and a prepared synthetic candidate. Do not improvise organization, operational, or real-platform claims.

## 0:00 to 0:12, establish scope

"Flight Diagnostics Workbench is a telemetry integration and verification project. Everything shown here, including the data, profiles, thresholds, and injected faults, is synthetic and unclassified."

Show **Configuration**. Point to the application, schema, adapter, and profile versions.

## 0:12 to 0:28, load and validate

Load the included CSV.

"The adapter uses an explicit field and unit mapping. Validation accounts for every row. Fatal schema problems block analysis, while recoverable row errors are quarantined and remain visible."

Point to the dataset SHA-256, accepted count, and quarantine count.

## 0:28 to 0:43, monitor

Open **Monitor** and start replay.

"The monitor preserves the original project's charts, gauges, alerts, scrubber, and replay speeds. Rate checks use actual timestamps instead of assuming a fixed sample cadence."

Use the keyboard to pause and activate one alert.

## 0:43 to 0:58, explain evidence

Open **Diagnostics** and filter to one rule.

"Each finding records a stable rule ID, severity, source, time, observed value, expected condition, and supporting evidence. The profile supplies synthetic parameters, while the rule engine supplies deterministic semantics."

## 0:58 to 1:15, verify a change

Open **Verification** and compare the prepared candidate.

"The comparison classifies findings as resolved, persisting, or newly introduced. It also compares validation results, so an invalid candidate cannot pass simply because it produced fewer findings."

Point to one item in each classification if the prepared fixture contains them.

## 1:15 to 1:27, reproduce and export

"The report records versions, adapter, profile, input hashes, counts, validation, findings, and comparison outcome. The normal export excludes source records by default."

Export the versioned JSON report or CSV findings.

## 1:27 to 1:30, close

"The result is a reproducible software sustainment, diagnostics, and test-evidence workflow, built around transparent deterministic checks."

If v2.1 evidence is released, optionally replace the closing line with a brief streaming health or model-comparison view. Do not demonstrate an unreleased or failing gate as complete.
