# 90-second demonstration script

Use the included synthetic dataset and a prepared synthetic candidate. The spoken narration is approximately 200 words. Rehearse the clicks before recording, and do not improvise organization, operational, or real-platform claims.

## 0:00 to 0:12, establish scope

**On screen:** Open Configuration and show the version and profile provenance.

"Flight Diagnostics Workbench turns synthetic telemetry into reproducible validation, diagnostics, and verification evidence. Every dataset, profile, threshold, and injected fault shown here is synthetic and unclassified."

## 0:12 to 0:28, load and validate

**On screen:** Load the included CSV and point to its hash, accepted count, and quarantine count.

"Configuration records application, schema, adapter, and profile versions. The CSV adapter uses explicit field and unit mappings. Fatal schema errors block analysis; recoverable row errors are quarantined and remain visible. Nothing is silently converted or dropped."

## 0:28 to 0:46, monitor

**On screen:** Open Monitor, start replay, pause with the keyboard, and focus one alert.

"Monitor keeps the original replay workflow while presenting it in a calmer, minimalist interface. The dataset hash and accepted count prove which synthetic fixture is being analyzed. Rate checks use actual timestamps. Keyboard controls and non-color status labels keep replay understandable without relying on a mouse or color alone."

## 0:46 to 1:02, inspect evidence

**On screen:** Open Diagnostics and filter to one stable rule ID.

"Diagnostics makes every finding inspectable through a stable rule ID, severity, source, time, observed value, expected condition, and supporting evidence. Filters isolate one rule without hiding validation context. This makes troubleshooting decisions interview-defensible instead of opaque."

## 1:02 to 1:18, verify a change

**On screen:** Compare the prepared candidate with the baseline in Verification.

"Verification separates resolved, persisting, and newly introduced findings. It also fails closed when candidate validation has fatal errors."

## 1:18 to 1:30, export and close

**On screen:** Show the report export controls and source-data choice.

"Exports record versions, hashes, counts, findings, and comparison outcomes while excluding source records by default. The result is transparent test evidence built around authoritative deterministic checks."

If v2.1 evidence is released, the closing screen may show streaming health or the learned-baseline comparison. Do not demonstrate an unreleased or failing gate as complete.
