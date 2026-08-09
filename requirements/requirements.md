# Software requirements

## Conventions

`FDW-<area>-<number>` is a stable requirement identifier. "Shall" indicates release-required behavior. A requirement may be changed only through review with updated tests and traceability. All datasets, profiles, thresholds, streams, and injected scenarios described here are synthetic and unclassified.

## Input, schema, and normalization

| ID          | Release | Requirement                                                                                                                                                                                                                                                                           |
| ----------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FDW-ING-001 | v2.0    | The system shall represent every accepted input as a versioned canonical `TelemetryRun`.                                                                                                                                                                                              |
| FDW-ING-002 | v2.0    | A canonical sample shall include source ID, optional sequence, normalized timestamp, measurements, units, and quality flags.                                                                                                                                                          |
| FDW-ING-003 | v2.0    | The legacy CSV adapter shall preserve the included fixture's 85 accepted records.                                                                                                                                                                                                     |
| FDW-ING-004 | v2.0    | The JSON adapter shall require and validate a supported external schema version.                                                                                                                                                                                                      |
| FDW-ING-005 | v2.0    | Every adapter shall use explicit field and unit mappings and shall not guess missing units.                                                                                                                                                                                           |
| FDW-ING-006 | v2.0    | Blank, missing, whitespace-only, nonnumeric, `NaN`, and nonfinite required values shall be reported and shall not become accepted numeric zero.                                                                                                                                       |
| FDW-ING-007 | v2.0    | Recoverable row errors shall quarantine the complete row with issue evidence.                                                                                                                                                                                                         |
| FDW-ING-008 | v2.0    | Fatal schema, version, header, and profile errors shall block analysis.                                                                                                                                                                                                               |
| FDW-ING-009 | v2.0    | Accepted plus quarantined data-row counts shall reconcile with the parsed input count.                                                                                                                                                                                                |
| FDW-ING-010 | v2.0    | Equivalent CSV and JSON fixtures shall normalize to equivalent canonical samples and findings.                                                                                                                                                                                        |
| FDW-ING-011 | v2.0    | The system shall detect duplicate, out-of-order, and profile-defined gapped timestamps.                                                                                                                                                                                               |
| FDW-ING-012 | v2.0    | The system shall detect required missing and duplicate sequence numbers.                                                                                                                                                                                                              |
| FDW-ING-013 | v2.0    | Uploads above 10 MiB shall be rejected before analysis with an explicit error.                                                                                                                                                                                                        |
| FDW-ING-014 | v2.0    | Inputs above 250,000 samples shall be rejected with an explicit error.                                                                                                                                                                                                                |
| FDW-ING-015 | v2.0    | Every run shall include an SHA-256 hash of the exact input bytes.                                                                                                                                                                                                                     |
| FDW-ING-016 | v2.0    | Duplicate source declarations and incompatible profile/schema combinations shall block analysis.                                                                                                                                                                                      |
| FDW-ING-017 | v2.2.1  | Versioned JSON timestamps shall use the supported RFC 3339-compatible subset: a real Gregorian date, seconds `00` through `59`, an explicit UTC designator or numeric offset, and a normalized UTC year from `0000` through `9999`; invalid or ambiguous values shall be quarantined. |

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

## v2.2 model registry and deterministic authority

| ID          | Release | Requirement                                                                                                                                                                                                                                                                                                                                                                 |
| ----------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FDW-REG-001 | v2.2    | Each learned model shall have an immutable, versioned, profile-specific registry descriptor containing its model family, artifact version, profile identity, required channels and units, cadence, window length, artifact and configuration SHA-256 identities, and explicit training, calibration, held-out evaluation, model-card, and quality-gate evidence references. |
| FDW-REG-002 | v2.2    | Compatibility evaluation shall compare schema, profile ID and version, required channels and units, cadence, window length, artifact identity, and configuration identity and shall report stable reason codes for every mismatch.                                                                                                                                          |
| FDW-REG-003 | v2.2    | Model readiness shall expose user enablement, quality-gate eligibility, and active state independently, and learned models shall start user-disabled even when eligible.                                                                                                                                                                                                    |
| FDW-REG-004 | v2.2    | An incompatible model, unsupported profile, failed quality gate, or user-disabled model shall remain inactive without silently selecting another model or compatibility contract.                                                                                                                                                                                           |
| FDW-REG-005 | v2.2    | Rules and advisory model output shall be classified as `both-indicate`, `rules-only`, `model-only`, or `both-nominal`, while deterministic rules remain authoritative in every state.                                                                                                                                                                                       |

## v2.2 mission phase and redundant-sensor fusion

| ID          | Release | Requirement                                                                                                                                                                                                                |
| ----------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FDW-PHA-001 | v2.2    | The deterministic phase state machine shall declare ground, takeoff, climb, cruise, descent, and landing and shall support an ordered complete synthetic mission through those phases.                                     |
| FDW-PHA-002 | v2.2    | Phase changes shall use separate entry and maintain thresholds plus a declared number of confirmation samples so boundary noise cannot cause a single-sample transition.                                                   |
| FDW-PHA-003 | v2.2    | Every phase transition shall record stable rule identity, source sample and time, prior and next phase, expected and hysteresis conditions, evaluated observations, confirmation count, and synthetic-data classification. |
| FDW-FUS-001 | v2.2    | The fusion estimator shall causally combine redundant barometric and GPS altitude with inertial and barometric vertical-rate observations using strictly increasing normalized timestamps.                                 |
| FDW-FUS-002 | v2.2    | Every fusion update shall retain predicted, observed, and estimated state, innovations, normalized residuals, Kalman gains, missing-sensor evidence, and 95 percent altitude and vertical-rate uncertainty bounds.         |
| FDW-FUS-003 | v2.2    | Missing redundant observations shall remain explicit `null` measurements, cause prediction-only processing for the unavailable sensors, and increase uncertainty rather than being replaced with fabricated measurements.  |
| FDW-FUS-004 | v2.2    | Nonfinite observations and non-increasing timestamps shall be rejected explicitly, and valid fusion outputs and uncertainty evidence shall remain finite.                                                                  |

## v2.2 seeded temporal scenarios

| ID          | Release | Requirement                                                                                                                                                                                                                      |
| ----------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FDW-TMP-001 | v2.2    | The fixed-wing temporal catalog shall declare exactly gradual drift, noise growth, oscillation, lag, intermittent dropout, stuck value, gain error, fuel leak, cross-sensor decoupling, and simultaneous faults with stable IDs. |
| FDW-TMP-002 | v2.2    | Scenario generation shall record an integer seed and shall reproduce equivalent output for the same configuration and seed while allowing different supported seeds to produce different measurements.                           |
| FDW-TMP-003 | v2.2    | Every injected temporal scenario shall declare target sensors and label onset index, active duration, recovery duration, and per-sample active or recovering lifecycle without labeling unaffected sensors as faulty.            |
| FDW-TMP-004 | v2.2    | A nominal scenario shall contain every declared mission phase and no injected-fault labels, while intermittent missing observations shall use `null` plus an explicit missing-quality flag.                                      |
| FDW-TMP-005 | v2.2    | Scenario configuration shall reject unsupported IDs and invalid seed, sample-count, cadence, or start-time values, and accepted generated output shall contain no nonfinite numeric values.                                      |
| FDW-TMP-006 | v2.2    | Property-based generation across randomized valid seeds, fault types, severities, durations, and onset phases shall preserve deterministic replay, fixed cadence, lifecycle bounds, and finite numeric output.                   |

## v2.2 Investigation workspace

| ID          | Release | Requirement                                                                                                                                                                                                       |
| ----------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FDW-INV-001 | v2.2    | The application shall add an Investigation view without removing the existing Monitor, Diagnostics, Verification, or Configuration views.                                                                         |
| FDW-INV-002 | v2.2    | Investigation shall present synchronized expected, predicted, observed, and estimated state, uncertainty bands, residuals, phase bands, fault lifecycle markers, detection markers, and a shared replay position. |
| FDW-INV-003 | v2.2    | Deterministic Investigation indications shall use stable IDs and observed-telemetry evidence only, including source, sample, time, observed values, expected condition, residuals, and applicable hypotheses.     |
| FDW-INV-004 | v2.2    | Injected ground-truth labels shall be display-only verification evidence and shall not change deterministic indications, learned-model features, agreement state, or authoritative decisions.                     |
| FDW-INV-005 | v2.2    | Investigation shall expose model warmup, user-disabled, ineligible, active advisory, abstention, and all four rule-model agreement states without presenting model output as authoritative.                       |
| FDW-INV-006 | v2.2    | Chart downsampling shall preserve phase boundaries and fault onset, active-end, recovery-end, and detection evidence, including when those critical points exceed the requested display budget.                   |
| FDW-INV-007 | v2.2    | Investigation replay, chart seeking, and overlay controls shall support keyboard operation and shall keep synchronized timeline, hypothesis, indication, and phase-transition evidence at the selected sample.    |

## v2.2 temporal learned model

| ID          | Release | Requirement                                                                                                                                                                                                                                                                                                                               |
| ----------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FDW-TML-001 | v2.2    | Temporal-model training, calibration, and held-out evaluation shall use disjoint recorded seeds over labeled synthetic nominal and declared-fault windows, including held-out fault magnitudes not used for fitting.                                                                                                                      |
| FDW-TML-002 | v2.2    | The exported temporal artifact shall be versioned and hashed and shall declare a fixed 40-sample causal window, channel and feature order, preprocessing, centroids, radii, thresholds, and training-configuration identity.                                                                                                              |
| FDW-TML-003 | v2.2    | The causal feature encoder shall derive declared multi-dilation, curvature, lag, correlation, cross-channel, and missingness features without reading future samples or injected ground-truth labels.                                                                                                                                     |
| FDW-TML-004 | v2.2    | Evidence eligibility for the integrated advisory shall require held-out selected-window F1 of at least 0.85, selected-window false-positive rate of at most 0.05, classification macro F1 of at least 0.65, and minimum per-fault classification recall of at least 0.65; eligible models shall still remain user-disabled on first load. |
| FDW-TML-005 | v2.2    | Runtime eligibility shall recompute the declared quality gates from artifact evidence rather than trusting a stored pass flag, and a failed gate shall force an inactive advisory result.                                                                                                                                                 |
| FDW-TML-006 | v2.2    | Inference shall provide explicit `unknown` and abstention outcomes plus at most three ranked non-nominal advisory hypotheses, and a user-disabled model shall return an explicit inactive result.                                                                                                                                         |
| FDW-TML-007 | v2.2    | TypeScript inference shall match checked-in Python parity cases for label, confidence, and distance within the declared absolute tolerance and shall be deterministic for repeated identical windows.                                                                                                                                     |
| FDW-TML-008 | v2.2    | Integrated evaluation evidence shall record split seeds, selected-window precision, recall, F1 and false-positive rate, classification macro F1, per-fault results, abstention, deterministic seed-cluster bootstrap confidence bounds, exact nominal false-positive count and upper bound, limitations, and point-estimate gate status.  |
| FDW-TML-009 | v2.2    | Temporal-model output shall remain advisory and shall not suppress, downgrade, replace, or relabel an authoritative deterministic indication or nominal decision.                                                                                                                                                                         |
| FDW-TML-010 | v2.2    | The primary held-out population shall compare the temporal model with one-sample persistence, two-sample linear prediction, the unchanged robust-covariance artifact, and only the deterministic rules compatible with the compact channels, with every partial or transfer limitation explicit.                                          |
| FDW-TML-011 | v2.2    | A separate post-hoc, non-gating challenge shall use disjoint seeds and frozen inference to record unseen magnitude, onset, active-duration, phase-label, and novel-combination behavior without using challenge labels or lifecycle metadata as model inputs.                                                                             |

Full-stream learned-model false alarms, first post-onset indication, detection delay, phase, duration, and recovery evaluation are deferred to v2.3. No v2.2 selected-window value may be presented as that future mission-level evidence.

## v2.2 temporal campaign execution and metrics

| ID          | Release | Requirement                                                                                                                                                                                                                                                                                          |
| ----------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FDW-CAM-001 | v2.2    | A versioned campaign specification shall define a deterministic profile, parameterized scenario, and seed matrix with unique case identities, declared severity, duration, and onset-phase variations, expected detections, negative rules, bootstrap configuration, and synthetic-data metadata.    |
| FDW-CAM-002 | v2.2    | Browser campaign execution shall use a versioned worker protocol with at most one active client request, validated request and response identities, bounded run and cancellation watchdogs, and explicit termination and malformed-message behavior.                                                 |
| FDW-CAM-003 | v2.2    | Campaign execution shall report case-level progress and shall support cancellation that returns visible completed-case and remaining-case evidence without committing an aborted in-flight case.                                                                                                     |
| FDW-CAM-004 | v2.2    | A scenario evaluator failure shall be contained to its case, recorded with explicit error evidence, and shall not prevent remaining matrix cases from running.                                                                                                                                       |
| FDW-CAM-005 | v2.2    | Every campaign result shall include a reproducible specification SHA-256 identity, digest-derived run identity, ordered case replay manifest, deterministic bounded result serialization, and internally consistent case, summary, metric, and replay evidence sufficient to replay the same matrix. |
| FDW-CAM-006 | v2.2    | Campaign results shall distinguish matched, missing, and unexpected detections and calculate confusion, scenario coverage, episode precision, recall and F1, false alarms per run and synthetic hour, and time-to-detection.                                                                         |
| FDW-CAM-007 | v2.2    | Campaign results shall report calibration sample count, expected calibration error, Brier score, abstention rate, and deterministic bootstrap confidence intervals, including explicit unavailable values for empty evidence.                                                                        |
| FDW-CAM-008 | v2.2    | The Investigation UI shall expose campaign progress, cancellation, completion or partial status, case counts, core metrics, contained failures, and a versioned evidence export without blocking other browser controls.                                                                             |
| FDW-CAM-009 | v2.2    | Campaign specifications and results shall enforce low-level limits of 12 seeds, 372 matrix cases, 256 KiB per specification, 10 MiB per result, 128 detections per case, and 2,048 calibration observations per case, including worker and parser callers that bypass the UI.                        |

## v2.2 campaign history

| ID          | Release | Requirement                                                                                                                                                                                                                                                                                                                                                                            |
| ----------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FDW-TDB-001 | v2.2    | Ordered atomic SQLite migrations shall create campaign runs, cases, detections, metrics, migration history, queryable severity, duration, and onset-phase variation fields, and documented indexes while remaining idempotent, upgrading a v1 campaign database, rolling back failed DDL, restoring foreign-key enforcement, and scoping deterministic case IDs to their campaign run. |
| FDW-TDB-002 | v2.2    | Campaign-history connections shall enable foreign keys and expose both database integrity results and foreign-key violation results.                                                                                                                                                                                                                                                   |
| FDW-TDB-003 | v2.2    | Campaign ingestion shall preserve matched, missing, unexpected, case, replay, and metric evidence and shall be idempotent for the same campaign run identity.                                                                                                                                                                                                                          |
| FDW-TDB-004 | v2.2    | Unsupported, nonfinite, cryptographically inconsistent, or internally contradictory campaign contracts shall be rejected before any partial database write.                                                                                                                                                                                                                            |
| FDW-TDB-005 | v2.2    | Campaign analytics shall generate a concise selected-run or latest-run report containing status counts, detection outcomes, core metrics, replay identity, and variation summaries without duplicating the stored full result payload, and shall fail explicitly for an unknown requested run.                                                                                         |
| FDW-TDB-006 | v2.2    | Campaign-history ingestion shall reject results over 10 MiB or 372 cases, cap retained result payloads at 64 MiB and the database at 128 MiB, and fail explicitly without silently pruning evidence.                                                                                                                                                                                   |

## v2.2 data boundary, accessibility, and offline assurance

| ID          | Release | Requirement                                                                                                                                                                                                                      |
| ----------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FDW-BND-001 | v2.2    | Temporal scenarios, phase and fusion evidence, campaigns, model artifacts, UI states, and exports shall identify their inputs and thresholds as synthetic and unclassified and shall not claim operational affiliation.          |
| FDW-BND-002 | v2.2    | Ground-truth fault labels shall remain outside production indication, model-inference, and authoritative-decision inputs and shall be available only as explicitly labeled verification evidence.                                |
| FDW-BND-003 | v2.2    | Normal Investigation and campaign exports shall minimize data by excluding generated or uploaded source sample windows unless a separate explicit user choice requests their inclusion.                                          |
| FDW-SEC-010 | v2.2    | Investigation and campaign controls, overlay toggles, replay position, progress, status, and evidence shall have accessible names, keyboard operation, visible focus, and announced text states that do not rely on color alone. |
| FDW-SEC-011 | v2.2    | The Investigation workspace shall preserve required controls and evidence at mobile, desktop, and 200 percent zoom layouts and shall have zero serious or critical automated accessibility findings at release.                  |
| FDW-CM-011  | v2.2    | Normal and self-contained offline builds from the same commit shall include temporal inference and the worker-backed campaign path without runtime CDN or telemetry-upload requests.                                             |
| FDW-CM-012  | v2.2    | Browser release tests shall exercise Investigation and campaign behavior in normal and offline builds at desktop and mobile viewports and shall confirm equivalent deterministic evidence for the same seed.                     |
