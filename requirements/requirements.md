# Software requirements

## Conventions

`FDW-<area>-<number>` is a stable requirement identifier. "Shall" indicates release-required behavior. A requirement may be changed only through review with updated tests and traceability. All datasets, profiles, thresholds, streams, and injected scenarios described here are synthetic and unclassified.

## Input, schema, and normalization

| ID          | Release | Requirement                                                                                                                                     |
| ----------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| FDW-ING-001 | v2.0    | The system shall represent every accepted input as a versioned canonical `TelemetryRun`.                                                        |
| FDW-ING-002 | v2.0    | A canonical sample shall include source ID, optional sequence, normalized timestamp, measurements, units, and quality flags.                    |
| FDW-ING-003 | v2.0    | The legacy CSV adapter shall preserve the included fixture's 85 accepted records.                                                               |
| FDW-ING-004 | v2.0    | The JSON adapter shall require and validate a supported external schema version.                                                                |
| FDW-ING-005 | v2.0    | Every adapter shall use explicit field and unit mappings and shall not guess missing units.                                                     |
| FDW-ING-006 | v2.0    | Blank, missing, whitespace-only, nonnumeric, `NaN`, and nonfinite required values shall be reported and shall not become accepted numeric zero. |
| FDW-ING-007 | v2.0    | Recoverable row errors shall quarantine the complete row with issue evidence.                                                                   |
| FDW-ING-008 | v2.0    | Fatal schema, version, header, and profile errors shall block analysis.                                                                         |
| FDW-ING-009 | v2.0    | Accepted plus quarantined data-row counts shall reconcile with the parsed input count.                                                          |
| FDW-ING-010 | v2.0    | Equivalent CSV and JSON fixtures shall normalize to equivalent canonical samples and findings.                                                  |
| FDW-ING-011 | v2.0    | The system shall detect duplicate, out-of-order, and profile-defined gapped timestamps.                                                         |
| FDW-ING-012 | v2.0    | The system shall detect required missing and duplicate sequence numbers.                                                                        |
| FDW-ING-013 | v2.0    | Uploads above 10 MiB shall be rejected before analysis with an explicit error.                                                                  |
| FDW-ING-014 | v2.0    | Inputs above 250,000 samples shall be rejected with an explicit error.                                                                          |
| FDW-ING-015 | v2.0    | Every run shall include an SHA-256 hash of the exact input bytes.                                                                               |
| FDW-ING-016 | v2.0    | Duplicate source declarations and incompatible profile/schema combinations shall block analysis.                                                |

## Profiles and deterministic diagnostics

| ID          | Release | Requirement                                                                                                                        |
| ----------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| FDW-RUL-001 | v2.0    | Detection behavior shall be selected by a versioned synthetic profile, not hard-coded UI logic.                                    |
| FDW-RUL-002 | v2.0    | The repository shall include versioned baseline, generic fixed-wing demonstration, and generic rotary-wing demonstration profiles. |
| FDW-RUL-003 | v2.0    | Every rule shall have a stable rule ID and declared severity.                                                                      |
| FDW-RUL-004 | v2.0    | Absolute range rules shall report out-of-range channel evidence.                                                                   |
| FDW-RUL-005 | v2.0    | Rate-of-change rules shall use actual normalized elapsed time.                                                                     |
| FDW-RUL-006 | v2.0    | Frozen-sensor rules shall use a profile-declared duration or sample condition.                                                     |
| FDW-RUL-007 | v2.0    | Stale-feed rules shall use timestamp or heartbeat age rather than UI repaint timing.                                               |
| FDW-RUL-008 | v2.0    | Schema and profile mismatch shall produce explicit diagnostic or blocking evidence as declared by severity.                        |
| FDW-RUL-009 | v2.0    | The included fixture shall produce exactly 5 overspeed, 3 rapid-descent, and 1 fuel-change compatibility finding.                  |
| FDW-RUL-010 | v2.0    | Every finding shall record rule ID, severity, source, time, observed value, expected condition, and evidence.                      |
| FDW-RUL-011 | v2.0    | Repeated analysis of identical canonical input and configuration shall produce equivalent ordered findings.                        |
| FDW-RUL-012 | v2.0    | Validation findings and diagnostic findings shall remain distinguishable in reports and filters.                                   |

## Fault injection

| ID          | Release | Requirement                                                                                                       |
| ----------- | ------- | ----------------------------------------------------------------------------------------------------------------- |
| FDW-FLT-001 | v2.0    | The system shall declare at least eight named synthetic fault scenarios with stable scenario IDs.                 |
| FDW-FLT-002 | v2.0    | Fault injection shall accept and record a deterministic seed.                                                     |
| FDW-FLT-003 | v2.0    | Identical nominal input, scenario, configuration, and seed shall produce equivalent injected output and manifest. |
| FDW-FLT-004 | v2.0    | Every injected scenario test shall require all expected findings and zero unexpected findings.                    |
| FDW-FLT-005 | v2.0    | Detection shall not read or branch on the injected-fault manifest.                                                |

## Verification and evidence

| ID          | Release | Requirement                                                                                                            |
| ----------- | ------- | ---------------------------------------------------------------------------------------------------------------------- |
| FDW-VER-001 | v2.0    | The system shall compare a baseline run with a candidate run.                                                          |
| FDW-VER-002 | v2.0    | Comparison shall classify findings as resolved, persisting, or newly introduced.                                       |
| FDW-VER-003 | v2.0    | Verification shall compare validation outcomes and record accepted and quarantined counts.                             |
| FDW-VER-004 | v2.0    | A candidate with a fatal validation issue shall not pass verification.                                                 |
| FDW-VER-005 | v2.0    | Every verification shall record application, profile, schema, adapter, hash, counts, findings, and outcome provenance. |
| FDW-VER-006 | v2.0    | Finding comparison identity shall be stable and versioned when its semantics change.                                   |
| FDW-VER-007 | v2.0    | A verification report shall include evaluated requirement results and an overall status.                               |
| FDW-VER-008 | v2.0    | A run with no findings shall display and export a nominal result rather than an empty error state.                     |

## User interface and state

| ID         | Release | Requirement                                                                                                    |
| ---------- | ------- | -------------------------------------------------------------------------------------------------------------- |
| FDW-UI-001 | v2.0    | The application shall provide Monitor, Diagnostics, Verification, and Configuration views.                     |
| FDW-UI-002 | v2.0    | Monitor shall retain charts, gauges, alerts, scrubber, play/pause, and 1x, 2x, and 4x replay.                  |
| FDW-UI-003 | v2.0    | Diagnostics shall filter findings without modifying the underlying run.                                        |
| FDW-UI-004 | v2.0    | Configuration shall display active versions, mappings, rules, and provenance.                                  |
| FDW-UI-005 | v2.0    | Verification shall display each comparison class and overall pass or fail evidence.                            |
| FDW-UI-006 | v2.0    | The UI shall expose named loading, empty, nominal, warning, and failure states.                                |
| FDW-UI-007 | v2.0    | A failed load shall mark prior results inactive and shall not present them as results for the attempted input. |
| FDW-UI-008 | v2.0    | Alert activation shall move replay to the associated sample and announce the change.                           |
| FDW-UI-009 | v2.0    | UI rendering shall use immutable or request-scoped run state to prevent cross-load leakage.                    |
| FDW-UI-010 | v2.0    | Long source IDs, rule evidence, and validation text shall wrap or scroll without hiding required controls.     |

## Export and privacy

| ID          | Release | Requirement                                                                                          |
| ----------- | ------- | ---------------------------------------------------------------------------------------------------- |
| FDW-EXP-001 | v2.0    | JSON verification exports shall declare a supported report schema version.                           |
| FDW-EXP-002 | v2.0    | CSV finding exports shall preserve stable rule IDs and evidence fields.                              |
| FDW-EXP-003 | v2.0    | Normal exports shall exclude uploaded source samples.                                                |
| FDW-EXP-004 | v2.0    | Including source samples shall require a separate explicit user choice.                              |
| FDW-EXP-005 | v2.0    | CSV exports shall neutralize cells that a spreadsheet may interpret as formulas.                     |
| FDW-EXP-006 | v2.0    | Export filenames shall include safe version or run identity without using untrusted path characters. |

## Accessibility, compatibility, and security

| ID          | Release | Requirement                                                                                                        |
| ----------- | ------- | ------------------------------------------------------------------------------------------------------------------ |
| FDW-SEC-001 | v2.0    | Untrusted file and stream values shall render as text, not interpreted HTML.                                       |
| FDW-SEC-002 | v2.0    | Interactive controls shall be keyboard operable with visible focus.                                                |
| FDW-SEC-003 | v2.0    | Replay controls shall expose accessible names, value, range, state, and keyboard operation.                        |
| FDW-SEC-004 | v2.0    | Status shall use text or icons in addition to color.                                                               |
| FDW-SEC-005 | v2.0    | The UI shall respect reduced-motion preferences.                                                                   |
| FDW-SEC-006 | v2.0    | Required content and controls shall remain usable at narrow mobile, tablet, desktop, and 200 percent zoom layouts. |
| FDW-SEC-007 | v2.0    | Automated accessibility scans shall report zero serious or critical findings at release.                           |
| FDW-SEC-008 | v2.0    | The release dependency audit shall contain no known high or critical vulnerability.                                |
| FDW-SEC-009 | v2.0    | Runtime Content Security Policy shall prohibit unapproved script origins and inline event handlers.                |

## Build, testing, and configuration management

| ID         | Release | Requirement                                                                                                        |
| ---------- | ------- | ------------------------------------------------------------------------------------------------------------------ |
| FDW-CM-001 | v2.0    | Browser application code shall use strict TypeScript modules built by Vite without a framework rewrite.            |
| FDW-CM-002 | v2.0    | Runtime dependencies and fonts shall be local and pinned through `pnpm-lock.yaml`.                                 |
| FDW-CM-003 | v2.0    | Normal Pages and self-contained offline artifacts shall be built from the same commit and lockfile.                |
| FDW-CM-004 | v2.0    | Extracted core modules shall enforce at least 90 percent branch coverage.                                          |
| FDW-CM-005 | v2.0    | The v2.0 suite shall contain at least 50 meaningful behavior cases.                                                |
| FDW-CM-006 | v2.0    | CI shall run validation, coverage, build, offline, browser, accessibility, and responsive gates for pull requests. |
| FDW-CM-007 | v2.0    | CI shall check requirements-to-test traceability.                                                                  |
| FDW-CM-008 | v2.0    | Release automation shall generate an SBOM, SHA-256 checksums, and artifact provenance.                             |
| FDW-CM-009 | v2.0    | GitHub Actions dependencies shall be pinned to full commit SHAs.                                                   |
| FDW-CM-010 | v2.0    | Release documentation shall not claim unmeasured quality, performance, security, or model results.                 |

## v2.1 streaming and communications

| ID          | Release | Requirement                                                                                                                                         |
| ----------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| FDW-STR-001 | v2.1    | The local Node simulator and in-browser demo adapter shall use the same versioned protocol.                                                         |
| FDW-STR-002 | v2.1    | The protocol shall define `hello`, `telemetry`, `heartbeat`, and `end` messages with version, source, sequence, and timestamp.                      |
| FDW-STR-003 | v2.1    | Streaming shall track multiple synthetic sources independently.                                                                                     |
| FDW-STR-004 | v2.1    | Connection health shall expose transport state, heartbeat age, message rate, queue depth, and dropped count.                                        |
| FDW-STR-005 | v2.1    | Reconnect shall use bounded backoff and terminate in an explicit state.                                                                             |
| FDW-STR-006 | v2.1    | The receive queue shall be bounded and shall surface dropped-message counts.                                                                        |
| FDW-STR-007 | v2.1    | Communication injection shall cover disconnect, latency, jitter, drop, duplicate, reordering, stale heartbeat, schema mismatch, and queue pressure. |
| FDW-STR-008 | v2.1    | Duplicate, out-of-order, stale, and incompatible messages shall produce source-specific evidence.                                                   |

## v2.1 learned baseline

| ID         | Release | Requirement                                                                                                                  |
| ---------- | ------- | ---------------------------------------------------------------------------------------------------------------------------- |
| FDW-ML-001 | v2.1    | Training shall use generated nominal synthetic telemetry and a versioned reproducible configuration.                         |
| FDW-ML-002 | v2.1    | Evaluation shall use held-out seeds with labeled injected synthetic faults.                                                  |
| FDW-ML-003 | v2.1    | The exported model artifact shall be versioned, hashed, and consumable by TypeScript inference.                              |
| FDW-ML-004 | v2.1    | The UI shall display anomaly score and per-channel residual contributions beside deterministic findings.                     |
| FDW-ML-005 | v2.1    | Published evaluation shall include precision, recall, F1, false-positive rate, seeds, and limitations.                       |
| FDW-ML-006 | v2.1    | The model shall remain disabled by default unless held-out F1 is at least 0.85 and false-positive rate is at most 5 percent. |
| FDW-ML-007 | v2.1    | Model output shall not suppress, downgrade, or replace deterministic findings.                                               |

## v2.1 history and advanced assurance

| ID          | Release | Requirement                                                                                                                    |
| ----------- | ------- | ------------------------------------------------------------------------------------------------------------------------------ |
| FDW-DB-001  | v2.1    | SQLite history shall include runs, sources, findings, injected faults, requirement results, benchmarks, and model evaluations. |
| FDW-DB-002  | v2.1    | Every SQLite connection shall enable foreign keys and run integrity checks.                                                    |
| FDW-DB-003  | v2.1    | Schema changes shall use ordered transactional migrations and documented indexes.                                              |
| FDW-DB-004  | v2.1    | Analytics shall provide at least ten documented parameterized queries.                                                         |
| FDW-DB-005  | v2.1    | Trend reports shall cover recurring faults, regressions, profile comparisons, performance, and model quality.                  |
| FDW-ADV-001 | v2.1    | Parser fuzzing and property-based tests shall preserve invariants and report reproducible failing seeds.                       |
| FDW-ADV-002 | v2.1    | Mutation testing shall publish the measured score and surviving mutants without a preset success claim.                        |
| FDW-ADV-003 | v2.1    | Benchmarks shall record reproducible results for 1,000, 10,000, and 100,000 samples.                                           |
| FDW-ADV-004 | v2.1    | An optional development container shall be added only after native Windows and CI setup are stable.                            |
