# Test case catalog

Each automated test name includes its stable `TC-*` identifier. "Expected" describes behavior, not a recorded pass. Release evidence supplies actual results.

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

| ID          | Behavior and expected result                                                                 |
| ----------- | -------------------------------------------------------------------------------------------- |
| TC-STR-001  | Node simulator and browser demo messages pass the same protocol validator.                   |
| TC-STR-002  | Valid hello, telemetry, heartbeat, and end messages are accepted.                            |
| TC-STR-003  | Unsupported protocol or schema version is rejected explicitly.                               |
| TC-STR-004  | Two sources maintain independent sequence and heartbeat state.                               |
| TC-STR-005  | Disconnect fault produces explicit disconnected health.                                      |
| TC-STR-006  | Latency and jitter are reflected in health metrics.                                          |
| TC-STR-007  | Dropped packet injection produces sequence evidence.                                         |
| TC-STR-008  | Duplicate and reordered messages produce source-specific evidence.                           |
| TC-STR-009  | Stale heartbeat produces stale health without UI-timer inference.                            |
| TC-STR-010  | Queue pressure keeps queue bounded and increments visible drop count.                        |
| TC-STR-011  | Reconnect backoff is bounded and reaches terminal state.                                     |
| TC-ML-001   | Same generated-data config and seed reproduce the training dataset hash.                     |
| TC-ML-002   | Evaluation excludes training seeds and records held-out seeds.                               |
| TC-ML-003   | Exported artifact has version, config hash, feature order, parameters, and hash.             |
| TC-ML-004   | TypeScript scores match Python reference within declared tolerance.                          |
| TC-ML-005   | Score and per-channel contributions are displayed beside deterministic results.              |
| TC-ML-006   | Metrics include precision, recall, F1, false-positive rate, seeds, and limitations.          |
| TC-ML-007   | Model stays disabled when either release gate fails.                                         |
| TC-ML-008   | Model output cannot remove or downgrade a deterministic finding.                             |
| TC-DB-001   | Fresh database applies all migrations and passes integrity check.                            |
| TC-DB-002   | Foreign-key violation is rejected.                                                           |
| TC-DB-003   | Duplicate migration application is safe and version-aware.                                   |
| TC-DB-004   | All required tables and indexes exist.                                                       |
| TC-DB-005   | Ten documented parameterized queries execute on fixture history.                             |
| TC-DB-006   | Trend report covers recurring faults, regressions, profiles, performance, and model quality. |
| TC-ADV-001  | Parser property tests preserve row-accounting and finite-number invariants.                  |
| TC-ADV-002  | Fuzz failure records a reproducible seed and minimal input.                                  |
| TC-ADV-003  | Mutation run records score and surviving mutants.                                            |
| TC-PERF-001 | 1,000-sample benchmark records environment, hash, counts, timings, and correctness.          |
| TC-PERF-002 | 10,000-sample benchmark records environment, hash, counts, timings, and correctness.         |
| TC-PERF-003 | 100,000-sample benchmark records environment, hash, counts, timings, and correctness.        |
| TC-DEV-001  | Optional container is absent until native and CI stability evidence exists.                  |
| TC-DEV-002  | Added container uses the lockfile and same validation commands as native setup.              |
