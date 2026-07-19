# Test case catalog

Each cataloged behavior has a stable `TC-*` identifier. Automated release evidence shall preserve that identifier through the test name, report, or checked registry. "Expected" describes behavior, not a recorded pass. Release evidence supplies actual results.

## v2.0 adapters and validation

| ID          | Behavior and expected result                                                             |
| ----------- | ---------------------------------------------------------------------------------------- |
| TC-CSV-001  | Included CSV parses with 85 accepted records.                                            |
| TC-CSV-002  | Included CSV byte hash matches the controlled SHA-256 value.                             |
| TC-CSV-003  | Empty file is a fatal validation failure.                                                |
| TC-CSV-004  | Header-only CSV is a valid empty or explicitly empty state, as specified by the adapter. |
| TC-CSV-005  | Missing required header blocks analysis.                                                 |
| TC-CSV-006  | Duplicate required header blocks analysis.                                               |
| TC-CSV-007  | Empty required numeric cell quarantines the row.                                         |
| TC-CSV-008  | Whitespace-only numeric cell quarantines the row.                                        |
| TC-CSV-009  | Literal numeric zero remains accepted.                                                   |
| TC-CSV-010  | Alphabetic numeric text quarantines the row.                                             |
| TC-CSV-011  | `NaN` text quarantines the row.                                                          |
| TC-CSV-012  | Positive infinity text quarantines the row.                                              |
| TC-CSV-013  | Negative infinity text quarantines the row.                                              |
| TC-CSV-014  | Invalid timestamp quarantines the row with original row location.                        |
| TC-CSV-015  | Accepted plus quarantined rows reconcile with parsed rows.                               |
| TC-CSV-016  | Quoted delimiter and line break remain one escaped text field.                           |
| TC-CSV-017  | Duplicate source declaration blocks analysis.                                            |
| TC-CSV-018  | File above 10 MiB is rejected before parsing.                                            |
| TC-CSV-019  | Input above 250,000 samples is rejected explicitly.                                      |
| TC-CSV-020  | Exactly 250,000 samples is handled according to the declared inclusive limit.            |
| TC-JSON-001 | Supported versioned JSON normalizes successfully.                                        |
| TC-JSON-002 | Unsupported major version blocks analysis.                                               |
| TC-JSON-003 | Missing schema version blocks analysis.                                                  |
| TC-JSON-004 | Missing explicit unit blocks analysis.                                                   |
| TC-JSON-005 | Unknown unit is rejected rather than guessed.                                            |
| TC-JSON-006 | Missing measurements object quarantines the sample.                                      |
| TC-JSON-007 | Hostile strings remain text in issue evidence.                                           |
| TC-JSON-008 | Equivalent JSON and CSV produce equal canonical samples.                                 |
| TC-JSON-009 | Equivalent JSON and CSV produce equal ordered findings.                                  |
| TC-PRO-001  | Included baseline profile accepts the included fixture.                                  |
| TC-PRO-002  | Generic fixed-wing synthetic profile loads with declared version and channels.           |
| TC-PRO-003  | Generic rotary-wing synthetic profile loads with declared version and channels.          |
| TC-PRO-004  | Profile/schema mismatch blocks analysis with explicit evidence.                          |
| TC-PRO-005  | Missing required channel mapping blocks analysis.                                        |
| TC-PRO-006  | Profile and adapter versions appear in provenance.                                       |

## v2.0 deterministic rules

| ID          | Behavior and expected result                                                                    |
| ----------- | ----------------------------------------------------------------------------------------------- |
| TC-RULE-001 | Included fixture produces exactly five overspeed findings.                                      |
| TC-RULE-002 | Included fixture produces exactly three rapid-descent findings.                                 |
| TC-RULE-003 | Included fixture produces exactly one fuel-change finding.                                      |
| TC-RULE-004 | Included fixture produces exactly nine compatibility findings total.                            |
| TC-RULE-005 | Value exactly on an inclusive range boundary is handled as declared.                            |
| TC-RULE-006 | Value just outside a range boundary produces one evidence-backed finding.                       |
| TC-RULE-007 | Range finding contains observed value, expected condition, source, time, severity, and rule ID. |
| TC-RULE-008 | Rate calculation uses actual elapsed timestamp duration.                                        |
| TC-RULE-009 | Changed regular cadence preserves the same physical rate result.                                |
| TC-RULE-010 | Irregular cadence uses each pair's actual elapsed time.                                         |
| TC-RULE-011 | Duplicate timestamp produces timing evidence and no division-by-zero result.                    |
| TC-RULE-012 | Out-of-order timestamp produces timing evidence and no invalid rate result.                     |
| TC-RULE-013 | Gap above profile tolerance produces a gap finding.                                             |
| TC-RULE-014 | Gap at the declared boundary is handled as declared.                                            |
| TC-RULE-015 | Missing required sequence produces source-specific evidence.                                    |
| TC-RULE-016 | Duplicate sequence produces source-specific evidence.                                           |
| TC-RULE-017 | Same sequence on different sources is not a cross-source duplicate.                             |
| TC-RULE-018 | Frozen channel for the declared duration produces a frozen-sensor finding.                      |
| TC-RULE-019 | Near-frozen values outside tolerance do not produce an unexpected frozen finding.               |
| TC-RULE-020 | Stale feed age above tolerance produces a stale finding.                                        |
| TC-RULE-021 | Feed age at tolerance is handled as declared.                                                   |
| TC-RULE-022 | Repeated identical analysis produces equivalent ordered findings.                               |
| TC-RULE-023 | Validation and diagnostic findings remain distinguishable.                                      |

## v2.0 seeded faults and verification

| ID         | Behavior and expected result                                                              |
| ---------- | ----------------------------------------------------------------------------------------- |
| TC-FLT-001 | Declared scenario catalog contains at least eight stable IDs.                             |
| TC-FLT-002 | Range-spike scenario produces exactly its expected findings.                              |
| TC-FLT-003 | Rate-change scenario produces exactly its expected findings.                              |
| TC-FLT-004 | Duplicate-timestamp scenario produces exactly its expected findings.                      |
| TC-FLT-005 | Timestamp-gap scenario produces exactly its expected findings.                            |
| TC-FLT-006 | Missing-sequence scenario produces exactly its expected findings.                         |
| TC-FLT-007 | Duplicate-sequence scenario produces exactly its expected findings.                       |
| TC-FLT-008 | Frozen-sensor scenario produces exactly its expected findings.                            |
| TC-FLT-009 | Stale-feed scenario produces exactly its expected findings.                               |
| TC-FLT-010 | Same scenario and seed produce equivalent output and manifest.                            |
| TC-FLT-011 | Different supported seeds produce recorded, deterministic manifests.                      |
| TC-FLT-012 | Detector result is unchanged if only the external manifest representation changes.        |
| TC-VER-001 | Baseline-only finding is classified resolved.                                             |
| TC-VER-002 | Equivalent baseline and candidate finding is classified persisting.                       |
| TC-VER-003 | Candidate-only finding is classified newly introduced.                                    |
| TC-VER-004 | Mixed comparison returns correct disjoint classification counts.                          |
| TC-VER-005 | Candidate fatal validation issue fails verification.                                      |
| TC-VER-006 | Candidate quarantine increase appears in comparison evidence.                             |
| TC-VER-007 | Nominal candidate displays and exports nominal status.                                    |
| TC-VER-008 | Verification includes application, schema, adapter, profile, hashes, counts, and outcome. |
| TC-VER-009 | Stable comparison identity does not depend on localized display text.                     |

## v2.0 exports, UI, accessibility, and build

| ID           | Behavior and expected result                                                                |
| ------------ | ------------------------------------------------------------------------------------------- |
| TC-EXP-001   | JSON report includes a supported report schema version.                                     |
| TC-EXP-002   | JSON report excludes source samples by default.                                             |
| TC-EXP-003   | Explicit source-data selection includes samples with a warning.                             |
| TC-EXP-004   | CSV finding export contains stable evidence columns.                                        |
| TC-EXP-005   | CSV cells beginning `=`, `+`, `-`, or `@` are neutralized.                                  |
| TC-EXP-006   | Export filename removes untrusted path separators and control characters.                   |
| TC-SEC-001   | Uploaded HTML-like timestamp renders as literal text.                                       |
| TC-SEC-002   | Uploaded event-handler text does not create an event handler.                               |
| TC-SEC-003   | Uploaded script-like text does not create a script element.                                 |
| TC-SEC-004   | Runtime CSP blocks unapproved script origins and inline handlers.                           |
| TC-UI-001    | Monitor renders charts, gauges, alerts, and replay for a valid run.                         |
| TC-UI-002    | Diagnostics filters by severity, source, and rule without mutating findings.                |
| TC-UI-003    | Verification renders resolved, persisting, and new groups.                                  |
| TC-UI-004    | Configuration renders active versions, mappings, rules, and provenance.                     |
| TC-UI-005    | Loading state is named and replaces incompatible controls.                                  |
| TC-UI-006    | Empty state provides a next action.                                                         |
| TC-UI-007    | Nominal state states that analysis completed with no findings.                              |
| TC-UI-008    | Warning state identifies recoverable validation issues.                                     |
| TC-UI-009    | Failure state identifies the attempted input and reason.                                    |
| TC-UI-010    | Play, pause, scrub, and 1x, 2x, and 4x preserve replay behavior.                            |
| TC-UI-011    | Activating an alert moves replay to its sample.                                             |
| TC-UI-012    | Long source and evidence text does not cover required controls.                             |
| TC-UI-013    | A second successful load replaces first-run charts and findings.                            |
| TC-UI-014    | Failed parse after a valid run marks prior results inactive.                                |
| TC-UI-015    | Oversize failure after a valid run does not retain active prior counters.                   |
| TC-UI-016    | Unsupported schema after a valid run does not retain active prior findings.                 |
| TC-UI-017    | Rapid successive loads cannot commit an older request over a newer request.                 |
| TC-A11Y-001  | All four views are reachable and operable by keyboard.                                      |
| TC-A11Y-002  | Alert controls activate with Enter and Space.                                               |
| TC-A11Y-003  | Every replay icon control has a stable accessible name.                                     |
| TC-A11Y-004  | Replay slider exposes name, current value, minimum, and maximum.                            |
| TC-A11Y-005  | Keyboard focus is visibly indicated.                                                        |
| TC-A11Y-006  | View navigation has current-state semantics.                                                |
| TC-A11Y-007  | Status changes are announced without stealing focus.                                        |
| TC-A11Y-008  | Severity and comparison status are not communicated by color alone.                         |
| TC-A11Y-009  | Reduced-motion preference disables nonessential animation.                                  |
| TC-A11Y-010  | 200 percent zoom preserves content and operation.                                           |
| TC-A11Y-011  | Mobile viewport reflows without horizontal control loss.                                    |
| TC-A11Y-012  | Automated scans report zero serious or critical findings.                                   |
| TC-BUILD-001 | Production build succeeds from frozen lockfile.                                             |
| TC-BUILD-002 | Offline build creates one self-contained HTML artifact.                                     |
| TC-BUILD-003 | Production application makes no runtime CDN request.                                        |
| TC-BUILD-004 | Offline application loads without a network connection.                                     |
| TC-BUILD-005 | Production and offline builds report the same application version and deterministic result. |
| TC-CM-001    | Core branch coverage meets the configured 90 percent gate.                                  |
| TC-CM-002    | Traceability checker rejects an unmapped requirement.                                       |
| TC-CM-003    | Traceability checker rejects an unknown test ID.                                            |

## v2.1 streaming, model, analytics, and assurance

| ID          | Behavior and expected result                                                                                   |
| ----------- | -------------------------------------------------------------------------------------------------------------- |
| TC-STR-001  | Node simulator and browser demo messages pass the same protocol validator.                                     |
| TC-STR-002  | Valid hello, telemetry, heartbeat, and end messages are accepted.                                              |
| TC-STR-003  | Unsupported protocol or schema version is rejected explicitly.                                                 |
| TC-STR-004  | Two sources maintain independent sequence and heartbeat state.                                                 |
| TC-STR-005  | Disconnect fault produces explicit disconnected health.                                                        |
| TC-STR-006  | Latency and jitter are reflected in health metrics.                                                            |
| TC-STR-007  | Dropped packet injection produces sequence evidence.                                                           |
| TC-STR-008  | Duplicate and reordered messages produce source-specific evidence.                                             |
| TC-STR-009  | Stale heartbeat produces stale health without UI-timer inference.                                              |
| TC-STR-010  | Queue pressure keeps queue bounded and increments visible drop count.                                          |
| TC-STR-011  | Reconnect backoff is bounded and reaches terminal state.                                                       |
| TC-ML-001   | Same generated-data config and seed reproduce the training dataset hash.                                       |
| TC-ML-002   | Evaluation excludes training seeds and records held-out seeds.                                                 |
| TC-ML-003   | Exported artifact has version, config hash, feature order, parameters, and hash.                               |
| TC-ML-004   | TypeScript scores match Python reference within declared tolerance.                                            |
| TC-ML-005   | Score and per-channel contributions are displayed beside deterministic results.                                |
| TC-ML-006   | Metrics include precision, recall, F1, false-positive rate, seeds, and limitations.                            |
| TC-ML-007   | Model stays disabled when either release gate fails.                                                           |
| TC-ML-008   | Model output cannot remove or downgrade a deterministic finding.                                               |
| TC-DB-001   | Fresh database applies all migrations and passes integrity check.                                              |
| TC-DB-002   | Foreign-key violation is rejected.                                                                             |
| TC-DB-003   | Duplicate migration application is safe and version-aware.                                                     |
| TC-DB-004   | All required tables and indexes exist.                                                                         |
| TC-DB-005   | Ten documented parameterized queries execute on fixture history.                                               |
| TC-DB-006   | Trend report covers recurring faults, regressions, profiles, performance, and model quality.                   |
| TC-ADV-001  | Parser property tests preserve row-accounting and finite-number invariants.                                    |
| TC-ADV-002  | Fuzz failure records a reproducible seed and minimal input.                                                    |
| TC-ADV-003  | Mutation run records score and surviving mutants.                                                              |
| TC-PERF-001 | 1,000-sample benchmark records environment, hash, counts, timings, and correctness.                            |
| TC-PERF-002 | 10,000-sample benchmark records environment, hash, counts, timings, and correctness.                           |
| TC-PERF-003 | 100,000-sample benchmark records environment, hash, counts, timings, and correctness.                          |
| TC-DEV-001  | Container history records that configuration remained deferred until native and CI stability evidence existed. |
| TC-DEV-002  | CI builds the digest-pinned non-root container and runs the lockfile-backed validation and build commands.     |

## v2.2 temporal fault intelligence

The source column records the intended evidence location, not a pass result. `Linked` means the behavior is represented in an existing test source. `Pending` identifies a release-required case that still needs an automated browser, accessibility, offline, or artifact-evidence test before release.

### Model registry, phase, fusion, and scenarios

| ID         | Behavior and expected result                                                                                                                                                                          | Source linkage                                                                                  |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| TC-REG-001 | Registry entries are immutable and expose exact model, profile, compatibility, artifact, configuration, training, calibration, held-out evaluation, model-card, and quality-gate evidence identities. | Linked: `tests/model-registry/modelRegistry.test.ts`, `tests/model-registry/identities.test.ts` |
| TC-REG-002 | Duplicate registry identities are rejected and lookup never silently selects a different version.                                                                                                     | Linked: `tests/model-registry/modelRegistry.test.ts`                                            |
| TC-REG-003 | An exact compatibility contract reports supported, enabled, eligible, and active states.                                                                                                              | Linked: `tests/model-registry/modelRegistry.test.ts`                                            |
| TC-REG-004 | Schema, profile, channel, unit, cadence, window, artifact, and configuration mismatches each produce the expected stable reason code and inactive state.                                              | Linked: `tests/model-registry/modelRegistry.test.ts`                                            |
| TC-REG-005 | User-disabled and failed-quality-gate models remain inactive while preserving separate user and eligibility states.                                                                                   | Linked: `tests/model-registry/modelRegistry.test.ts`                                            |
| TC-REG-006 | Unsupported profiles and cross-model contract mismatches are explicit instead of guessed.                                                                                                             | Linked: `tests/model-registry/modelRegistry.test.ts`                                            |
| TC-REG-007 | Checked-in artifact and canonical configuration bytes recompute to every registered SHA-256 identity.                                                                                                 | Linked: `tests/model-registry/identities.test.ts`                                               |
| TC-REG-008 | All four agreement states are stable, an inactive model is non-indicating, and deterministic authority never changes.                                                                                 | Linked: `tests/model-registry/modelRegistry.test.ts`                                            |
| TC-PHA-001 | Separate entry and maintain thresholds plus confirmation samples prevent a boundary-noise transition.                                                                                                 | Linked: `tests/temporal/phase.test.ts`                                                          |
| TC-PHA-002 | A complete mission traverses ground, takeoff, climb, cruise, descent, landing, and ground with full synthetic transition evidence.                                                                    | Linked: `tests/temporal/phase.test.ts`                                                          |
| TC-PHA-003 | Invalid phase configuration and nonfinite observations are rejected explicitly.                                                                                                                       | Linked: `tests/temporal/phase.test.ts`                                                          |
| TC-FUS-001 | Redundant altitude and vertical-rate observations converge on a finite state and reduce uncertainty.                                                                                                  | Linked: `tests/temporal/estimator.test.ts`                                                      |
| TC-FUS-002 | Missing observations stay explicit, use prediction-only processing, and increase uncertainty.                                                                                                         | Linked: `tests/temporal/estimator.test.ts`                                                      |
| TC-FUS-003 | An outlier retains predicted, observed, innovation, normalized residual, gain, and 95 percent uncertainty evidence.                                                                                   | Linked: `tests/temporal/estimator.test.ts`                                                      |
| TC-FUS-004 | Nonfinite observations and non-increasing timestamps are rejected explicitly.                                                                                                                         | Linked: `tests/temporal/estimator.test.ts`                                                      |
| TC-TMP-001 | The catalog contains exactly the ten declared temporal fault IDs and each definition has onset, duration, recovery, and target metadata.                                                              | Linked: `tests/temporal/generator.test.ts`                                                      |
| TC-TMP-002 | Identical scenario configuration and seed reproduce equivalent output, while a different seed changes measurements.                                                                                   | Linked: `tests/temporal/generator.test.ts`                                                      |
| TC-TMP-003 | Nominal generation contains all declared phases and no injected-fault labels.                                                                                                                         | Linked: `tests/temporal/generator.test.ts`                                                      |
| TC-TMP-004 | Every declared scenario labels only its fault lifecycle and changes at least one declared target channel without fault-labeling unaffected sensors.                                                   | Linked: `tests/temporal/generator.test.ts`                                                      |
| TC-TMP-005 | Nominal and every declared scenario contain no nonfinite numeric output.                                                                                                                              | Linked: `tests/temporal/generator.test.ts`                                                      |
| TC-TMP-006 | Intermittent dropout represents missing values as `null` with an explicit missing-quality flag.                                                                                                       | Linked: `tests/temporal/generator.test.ts`                                                      |
| TC-TMP-007 | Invalid seed, sample count, cadence, start time, and scenario ID are rejected explicitly.                                                                                                             | Linked: `tests/temporal/generator.test.ts`                                                      |
| TC-TMP-008 | Randomized valid seeds, fault types, severities, durations, and onset phases preserve deterministic replay, fixed cadence, lifecycle bounds, and finite output.                                       | Linked: `tests/temporal/generator.test.ts`                                                      |

### Investigation and temporal model

| ID         | Behavior and expected result                                                                                                                                                                                                       | Source linkage                                                                                                                               |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-INV-001 | Nominal analysis produces aligned finite state, phase, fusion, residual, model-warmup, and hypothesis DTOs.                                                                                                                        | Linked: `tests/investigation/analyze.test.ts`                                                                                                |
| TC-INV-002 | Every declared scenario produces lifecycle markers, phase and fusion evidence, hypotheses, and nonnegative available detection delay.                                                                                              | Linked: `tests/investigation/analyze.test.ts`                                                                                                |
| TC-INV-003 | Analysis retains phase transitions and predicted, observed, estimated, residual, and 95 percent uncertainty evidence at aligned samples.                                                                                           | Linked: `tests/investigation/analyze.test.ts`                                                                                                |
| TC-INV-004 | Model warmup, explicit user-disabled state, and active advisory inference are represented without changing deterministic authority.                                                                                                | Linked: `tests/investigation/analyze.test.ts`                                                                                                |
| TC-INV-005 | Every Investigation point derives the correct one of four rule-model agreement states.                                                                                                                                             | Linked: `tests/investigation/analyze.test.ts`                                                                                                |
| TC-INV-006 | Removing every injected ground-truth label leaves deterministic indications byte-for-byte equivalent.                                                                                                                              | Linked: `tests/investigation/analyze.test.ts`                                                                                                |
| TC-INV-007 | Indications use unique stable IDs, observed-data evidence, and declared campaign hypotheses.                                                                                                                                       | Linked: `tests/investigation/analyze.test.ts`                                                                                                |
| TC-INV-008 | Repeated analysis is deterministic and never reports a negative detection delay.                                                                                                                                                   | Linked: `tests/investigation/analyze.test.ts`                                                                                                |
| TC-INV-009 | Chart helpers create stable phase bands and lifecycle and detection markers.                                                                                                                                                       | Linked: `tests/ui/investigationCharts.test.ts`                                                                                               |
| TC-INV-010 | Downsampling preserves aligned series, phase boundaries, and critical lifecycle and detection evidence even above the requested display budget.                                                                                    | Linked: `tests/ui/investigationCharts.test.ts`                                                                                               |
| TC-INV-011 | Chart preparation permits explicit missing observations and rejects misaligned, nonfinite, inverted-bound, invalid-time, and unsafe-range inputs.                                                                                  | Linked: `tests/ui/investigationCharts.test.ts`                                                                                               |
| TC-INV-012 | The browser renders the fifth Investigation view and keeps charts, replay, selected-sample evidence, overlays, timeline, hypotheses, indications, and phase log synchronized.                                                      | Linked: `tests/browser/workbench.spec.ts`                                                                                                    |
| TC-INV-013 | Investigation replay, seek, and overlay controls operate by keyboard with stable accessible names and visible selected state.                                                                                                      | Linked: `tests/accessibility/workbench.spec.ts`, `tests/ui/investigationCharts.test.ts`                                                      |
| TC-INV-014 | Investigation and campaign exports exclude source sample windows by default and include them only after a separate explicit user choice.                                                                                           | Linked: `tests/browser/workbench.spec.ts`                                                                                                    |
| TC-TML-001 | Training, calibration, and held-out seed sets are recorded and pairwise disjoint.                                                                                                                                                  | Linked: `tests/ml/test_temporal_training.py`                                                                                                 |
| TC-TML-002 | Every declared nominal and fault label generates deterministic fixed-length held-out windows.                                                                                                                                      | Linked: `tests/ml/test_temporal_training.py`                                                                                                 |
| TC-TML-003 | Every held-out fault has onset and non-training magnitude evidence and differs from its same-seed nominal window.                                                                                                                  | Linked: `tests/ml/test_temporal_training.py`                                                                                                 |
| TC-TML-004 | Dropout feature extraction stays finite, records missingness, and rejects a non-40-sample window.                                                                                                                                  | Linked: `tests/ml/test_temporal_training.py`                                                                                                 |
| TC-TML-005 | Repeated v1 research training is reproducible and satisfies every declared held-out quality gate before recording research eligibility.                                                                                            | Linked: `tests/ml/test_temporal_training.py`                                                                                                 |
| TC-TML-006 | The TypeScript parser validates the fixed artifact, channel, feature, dimension, scale, and training-identity contract and recomputes gate status from metrics.                                                                    | Linked: `tests/ml/temporalModel.test.ts`                                                                                                     |
| TC-TML-007 | The causal encoder produces declared dilation, curvature, lag, cross-channel, and missingness features with finite deterministic fallbacks.                                                                                        | Linked: `tests/ml/temporalModel.test.ts`                                                                                                     |
| TC-TML-008 | Python and TypeScript predictions match checked-in label, confidence, and distance parity evidence within declared tolerance.                                                                                                      | Linked: `tests/ml/test_temporal_training.py`, `tests/ml/temporalModel.test.ts`                                                               |
| TC-TML-009 | Inference returns explicit nominal, unknown-abstain, and detected outcomes plus at most three ranked non-nominal hypotheses.                                                                                                       | Linked: `tests/ml/temporalModel.test.ts`                                                                                                     |
| TC-TML-010 | User-disabled and failed-gate inference are inactive, non-anomalous, and deterministic-rule authoritative.                                                                                                                         | Linked: `tests/ml/temporalModel.test.ts`                                                                                                     |
| TC-TML-011 | Repeated TypeScript inference over the same window is byte-for-byte deterministic.                                                                                                                                                 | Linked: `tests/ml/temporalModel.test.ts`                                                                                                     |
| TC-TML-012 | The checked-in v1 research evaluation evidence validates all required split seeds, episode and classification metrics, per-fault results, abstention, bootstrap bounds, limitations, and gate fields.                              | Linked: `tests/ml/temporalModel.test.ts`                                                                                                     |
| TC-TML-013 | On first browser load, eligible learned models remain user-disabled until the user explicitly enables each model.                                                                                                                  | Linked: `tests/browser/workbench.spec.ts`                                                                                                    |
| TC-TML-014 | The same 440 held-out episodes compare temporal, persistence, linear, unchanged covariance, and partial compatible-rule paths with exact population, detector-definition, identity, confusion, and limitation evidence.            | Linked: `tests/ml/test_temporal_training.py`, `tests/ml/temporalModel.test.ts`                                                               |
| TC-TML-015 | The frozen artifact runs a disjoint, post-hoc, non-gating challenge over unseen magnitudes, four onset-duration configurations and phase labels, and five novel combinations without fitting, recalibration, or inference leakage. | Linked: `tests/ml/test_temporal_training.py`, `tests/ml/temporalModel.test.ts`                                                               |
| TC-TML-016 | The v2 corpus is produced by the actual TypeScript mission generator and Investigation projection, is deterministic and balanced by declared label, and records pairwise-disjoint training, calibration, and held-out seeds.       | Linked: `tests/ml/test_temporal_integration_training.py`, `tools/ml/export_temporal_integration_corpus.ts`                                   |
| TC-TML-017 | Repeated v2 training exactly regenerates the checked artifact, selected-window evaluation, Python parity cases, model card, artifact SHA-256, and canonical-configuration SHA-256.                                                 | Linked: `tests/ml/test_temporal_integration_training.py`, `tests/ml/temporalIntegrationModel.test.ts`                                        |
| TC-TML-018 | V2 evaluation explicitly records one selected causal 40-sample window per mission plus total, nominal, fault, TP, FP, TN, FN, answered, abstained, and per-fault detected and correctly classified counts.                         | Linked: `tests/ml/test_temporal_integration_training.py`, `models/temporal_evaluation_v2.json`                                               |
| TC-TML-019 | V2 nominal false-positive evidence records the observed numerator and denominator and an exact one-sided 95 percent binomial upper bound, without treating the point estimate as proof of a population rate at or below 0.05.      | Linked: `tests/ml/test_temporal_integration_training.py`, `models/temporal_evaluation_v2.json`                                               |
| TC-TML-020 | V2 eligibility recomputes every `FDW-TML-004` selected-window threshold, including 0.85 F1 and 0.65 minimum per-fault classification recall, and a stored pass flag cannot override a failed required metric.                      | Linked: `tests/ml/test_temporal_integration_training.py`, `tests/ml/temporalIntegrationModel.test.ts`                                        |
| TC-TML-021 | V2 Python and TypeScript inference match on raw held-out mission windows, and the actual Investigation path emits causal rolling-window advisory results after warmup without changing deterministic authority.                    | Linked: `tests/ml/test_temporal_integration_training.py`, `tests/ml/temporalIntegrationModel.test.ts`, `tests/investigation/analyze.test.ts` |

### Campaign worker and SQLite history

| ID         | Behavior and expected result                                                                                                                                                                                                                                          | Source linkage                                                                                                                |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| TC-CAM-001 | The complete profile, parameterized scenario, and seed matrix executes in stable order with unique cases, real severity, duration, and onset-phase variation, identical repeated results, and replay identities.                                                      | Linked: `tests/campaign/runner.test.ts`, `tests/campaign/defaultTemporalCampaign.test.ts`, `tests/temporal/generator.test.ts` |
| TC-CAM-002 | Campaign metrics distinguish expected, missing, duplicate, negative-rule, and unknown detections and calculate confusion, coverage, episode, false-alarm, timing, and calibration results.                                                                            | Linked: `tests/campaign/runner.test.ts`                                                                                       |
| TC-CAM-003 | Cancellation between cases returns a deterministic partial result with completed and remaining counts.                                                                                                                                                                | Linked: `tests/campaign/runner.test.ts`                                                                                       |
| TC-CAM-004 | An abort during evaluation does not commit the in-flight case.                                                                                                                                                                                                        | Linked: `tests/campaign/runner.test.ts`                                                                                       |
| TC-CAM-005 | An evaluator exception is contained to its failed case and later matrix cases continue.                                                                                                                                                                               | Linked: `tests/campaign/runner.test.ts`                                                                                       |
| TC-CAM-006 | JSON serialization round-trips a campaign without changing replay, case, or metric evidence; deep validation rejects forged digests, run identities, replay entries, partitions, summaries, metrics, and unsupported contracts.                                       | Linked: `tests/campaign/contracts.test.ts`                                                                                    |
| TC-CAM-007 | Empty episode, duration, and calibration evidence returns explicit unavailable metrics rather than fabricated zeros.                                                                                                                                                  | Linked: `tests/campaign/contracts.test.ts`                                                                                    |
| TC-CAM-008 | Campaign validation enforces matrix uniqueness, versioned worker messages, and explicit synthetic and unclassified metadata.                                                                                                                                          | Linked: `tests/campaign/contracts.test.ts`                                                                                    |
| TC-CAM-009 | The temporal worker analyzes observed telemetry, emits progress, retains advisory calibration, and marks deterministic detections authoritative.                                                                                                                      | Linked: `tests/campaign/temporalWorker.test.ts`                                                                               |
| TC-CAM-010 | Repeated temporal worker campaigns replay identically.                                                                                                                                                                                                                | Linked: `tests/campaign/temporalWorker.test.ts`                                                                               |
| TC-CAM-011 | The worker yields between cases, returns a validated partial cancelled result, fails unsupported profiles and scenarios closed, rejects malformed or duplicate requests, and cancels only the matching request.                                                       | Linked: `tests/campaign/temporalWorker.test.ts`                                                                               |
| TC-CAM-012 | The browser worker client validates request identity, progress, deep result integrity, cancellation, evaluator error, worker error, message-deserialization error, watchdog timeout, timer cleanup, worker replacement, and one-active-request behavior.              | Linked: `tests/campaign/browserClient.test.ts`                                                                                |
| TC-CAM-013 | The Investigation UI reports campaign progress without blocking replay, supports cancellation, renders partial or completed metrics and failures, and exports versioned evidence.                                                                                     | Linked: `tests/browser/workbench.spec.ts`, `tests/accessibility/workbench.spec.ts`                                            |
| TC-CAM-014 | Direct campaign callers reject excessive seeds, matrices, specifications, results, detections, and calibration payloads before execution or deserialization.                                                                                                          | Linked: `tests/campaign/contracts.test.ts`                                                                                    |
| TC-TDB-001 | Ordered campaign migrations upgrade a v1 database, remain idempotent, create every required table, index, and queryable variation field, atomically roll back failed DDL, restore foreign keys, and permit the same deterministic case ID in different campaign runs. | Linked: `tests/analytics/test_temporal_campaign.py`                                                                           |
| TC-TDB-002 | Foreign keys reject orphan campaign children and database integrity checks report both SQLite and foreign-key status.                                                                                                                                                 | Linked: `tests/analytics/test_temporal_campaign.py`                                                                           |
| TC-TDB-003 | Repeated campaign ingestion preserves one run plus its case, variation, matched, missing, unexpected, and metric evidence without duplication.                                                                                                                        | Linked: `tests/analytics/test_temporal_campaign.py`                                                                           |
| TC-TDB-004 | Malformed, unsupported, nonfinite, digest-forged, summary-forged, or partition-inconsistent campaign evidence is rejected without a partial run write.                                                                                                                | Linked: `tests/analytics/test_temporal_campaign.py`                                                                           |
| TC-TDB-005 | Campaign reporting summarizes selected or latest run status, outcomes, core metrics, replay identity, and variations without duplicating stored result JSON, and rejects an unknown run.                                                                              | Linked: `tests/analytics/test_temporal_campaign.py`                                                                           |
| TC-TDB-006 | Campaign-history validation rejects results over the case or byte limits and enforces explicit retained-payload and database quotas without partial writes or silent pruning.                                                                                         | Linked: `tests/analytics/test_temporal_campaign.py`                                                                           |

### Data boundary, accessibility, and offline browser release cases

| ID          | Behavior and expected result                                                                                                                                          | Source linkage                                                                     |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| TC-BND-001  | Scenario, phase, fusion, model, and campaign contracts retain explicit synthetic and unclassified metadata.                                                           | Linked: `tests/temporal`, `tests/model-registry`, `tests/campaign`                 |
| TC-BND-002  | Removing ground-truth fault labels cannot change production indications or authoritative agreement.                                                                   | Linked: `tests/investigation/analyze.test.ts`                                      |
| TC-BND-003  | Worker detections declare observed-telemetry-only evidence and deterministic authority, with model details advisory only.                                             | Linked: `tests/campaign/temporalWorker.test.ts`                                    |
| TC-BND-004  | Browser copy and exported v2.2 evidence identify synthetic and unclassified data and contain no operational-affiliation claim.                                        | Linked: `tests/browser/workbench.spec.ts`                                          |
| TC-TACC-001 | Investigation and campaign controls are keyboard operable, visibly focused, correctly named, and expose announced progress and state text without color-only meaning. | Linked: `tests/accessibility/workbench.spec.ts`                                    |
| TC-TACC-002 | Automated scans report zero serious or critical findings in Investigation before and during a campaign.                                                               | Linked: `tests/accessibility/workbench.spec.ts`                                    |
| TC-TACC-003 | Investigation and campaign evidence and controls remain usable at mobile, desktop, and 200 percent zoom layouts.                                                      | Linked: `tests/browser/workbench.spec.ts`, `tests/accessibility/workbench.spec.ts` |
| TC-TOFF-001 | Production and self-contained offline builds both include temporal inference, Investigation, and worker-backed campaign capabilities from the same version.           | Linked: `tests/browser/offline.spec.ts`                                            |
| TC-TOFF-002 | The offline application runs a temporal investigation and campaign with network disabled and makes no CDN or telemetry-upload request.                                | Linked: `tests/browser/offline.spec.ts`                                            |
| TC-TOFF-003 | Normal and offline applications produce equivalent deterministic Investigation and campaign evidence for the same scenario and seed.                                  | Linked: `tests/browser/offline.spec.ts`                                            |
