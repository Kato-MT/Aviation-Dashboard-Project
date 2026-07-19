# Temporal intelligence test plan

## Objective

Verify that the v2.2 temporal candidate produces reproducible synthetic evidence across generation, phase estimation, fusion, deterministic investigation, advisory inference, campaign aggregation, JSON replay, chart preparation, and SQLite persistence.

The presence of a test file is not a release result. The July 19 working tree completed the local TypeScript, Python, coverage, browser, accessibility, normal-build, and network-disabled offline checks recorded in the v2.2 release notes. Those local results are not protected CI, Pages, provenance, or tagged release evidence for a single commit.

Status terms in this plan are strict:

- **Present** means the source file exists.
- **Linked** means a stable test ID points to that source in the traceability matrix.
- **Locally compiled** means typechecking and bundling completed for the working tree at the time of the check.
- **Passed** is reserved for an executed test result tied to an exact commit and environment.

## Evidence rules

- Use only `SYNTHETIC_UNCLASSIFIED` scenarios and generated model windows.
- Record the exact commit and artifact SHA-256 values before a release-candidate run.
- Keep training, calibration, and held-out seeds disjoint.
- Never use ground-truth fault labels as detector inputs.
- Treat deterministic indications as authoritative and model results as advisory.
- Report `null` when precision, recall, F1, false alarms per hour, calibration, or timing is not identifiable. Do not replace an undefined denominator with an artificial zero or one.
- Publish measured results only from generated artifacts or a captured test report for the exact commit.

## Current test inventory

These tests are present in the workspace and define candidate behavior. Their presence alone does not establish a complete passing suite.

| Area                              | Current test files                                                                                                                                   | Behavior represented                                                                                                                                                                                              |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Synthetic scenarios               | `tests/temporal/generator.test.ts`                                                                                                                   | Ten declared scenarios, nominal mission, seed repeatability, onset, active and recovery labels, explicit missingness, input validation, finite output                                                             |
| Mission phase                     | `tests/temporal/phase.test.ts`                                                                                                                       | Entry versus maintain hysteresis, complete phase sequence, transition evidence, invalid configuration and nonfinite rejection                                                                                     |
| Sensor fusion                     | `tests/temporal/estimator.test.ts`                                                                                                                   | Convergence, uncertainty reduction and growth, missing sensors, innovation evidence, invalid values, strictly increasing time                                                                                     |
| Investigation                     | `tests/investigation/analyze.test.ts`                                                                                                                | All ten mission scenarios, aligned evidence, markers, model warmup, agreement states, deterministic behavior, no ground-truth leakage                                                                             |
| V1 research model in TypeScript   | `tests/ml/temporalModel.test.ts`                                                                                                                     | Research artifact contract, gate recomputation, feature encoding, missing-value behavior, exact window size, Python parity, unknown, user-disabled state, and determinism                                         |
| V1 research training in Python    | `tests/ml/test_temporal_training.py`                                                                                                                 | Disjoint seeds, deterministic research generation, reproducible artifact generation, parity, same-population detector projection, post-hoc challenge, and no ground-truth detector input                          |
| V2 integrated model in TypeScript | `tests/ml/temporalIntegrationModel.test.ts`                                                                                                          | Production-integrated advisory artifact contract, checked selected-window observations, raw mission-window Python parity, and actual Investigation-window inference                                               |
| V2 integrated training in Python  | `tests/ml/test_temporal_integration_training.py`, `tools/ml/export_temporal_integration_corpus.ts`                                                   | Actual TypeScript mission and Investigation projection, balanced deterministic selected windows, disjoint seeds, reproducible artifacts, identities, parity, and generated model card                             |
| Model registry                    | `tests/model-registry/modelRegistry.test.ts`, `tests/model-registry/identities.test.ts`                                                              | Exact compatibility, readiness, mismatch reasons, immutable registry, configuration and artifact hash recomputation, deterministic authority                                                                      |
| Campaign engine and worker        | `tests/campaign/runner.test.ts`, `tests/campaign/contracts.test.ts`, `tests/campaign/browserClient.test.ts`, `tests/campaign/temporalWorker.test.ts` | Matrix determinism, progress, cancellation, failure containment, matching, grouped metrics, timing, calibration, bootstrap, JSON round trip, browser-client request association, worker handler, scenario mapping |
| Campaign SQLite                   | `tests/analytics/test_temporal_campaign.py`                                                                                                          | Migration, indexes, foreign keys, idempotent ingestion, detection evidence, integrity, report, malformed contract                                                                                                 |
| Investigation chart renderer      | `tests/ui/investigationCharts.test.ts`                                                                                                               | Series validation, critical-evidence-preserving downsampling, marker and phase helpers, overlay rendering, cursor and keyboard behavior                                                                           |
| Integrated browser source         | `tests/browser/workbench.spec.ts`, `tests/browser/offline.spec.ts`                                                                                   | Investigation run, minimized and explicit source export, learned controls, four-way evidence, exact waveform compatibility, worker campaign, responsive layout, network-disabled offline behavior, build parity   |
| Accessibility source              | `tests/accessibility/workbench.spec.ts`                                                                                                              | Investigation overlays and status, campaign-running state, keyboard and automated accessibility checks                                                                                                            |

The browser and accessibility files are linked by stable test IDs. They are not listed here as passed execution.

## Required test matrix

### 1. Synthetic scenario generation

For `nominal` and each declared mission scenario, exercise multiple fixed seeds and assert:

- repeated seed, scenario, cadence, count, and start time yield byte-equivalent JSON;
- a changed seed changes generated measurements;
- schema, profile, classification, source, time, and quality fields remain explicit;
- numeric output is finite, except declared missing values represented by `null`;
- active and recovery counts match the resolved timeline;
- only declared target sensors receive injected or recovering quality;
- no detector consumes `faultLabels` or `phaseTruth` as observed evidence.

The ten mission scenarios are `gradual-drift`, `noise-growth`, `oscillation`, `lag`, `intermittent-dropout`, `stuck-value`, `gain-error`, `fuel-leak`, `cross-sensor-decoupling`, and `simultaneous-faults`.

### 2. Phase hysteresis

For every transition, test values:

- just below entry;
- exactly at entry;
- between entry and maintain after a candidate begins;
- outside maintain, which must reset the candidate;
- at the configured confirmation count;
- with nonfinite input and invalid confirmation count.

Confirm that transition evidence contains the prior and next phase, entry condition, maintain condition, observed values, condition evidence, sample, timestamp, and synthetic label. Add sequence-level tests that distinguish stable hysteresis from one-sample boundary noise.

### 3. Sensor fusion

Test all available, one missing, multiple missing, and no available measurement paths. Verify predicted, observed, estimated, innovation, normalized innovation, Kalman gain, uncertainty, and missing-sensor output. Exercise:

- a stable sequence that reduces uncertainty;
- prediction-only intervals that increase uncertainty;
- an outlier above the three-sigma innovation boundary;
- zero, negative, duplicate, out-of-order, very large, and nonfinite timestamp deltas;
- property-based randomized valid seeds, fault types, severities, durations, and onset phases with deterministic replay, fixed cadence, bounded lifecycle indices, and finite output;
- nonfinite measurements and invalid covariance or noise configuration;
- ft/min to ft/s conversion and display conversion in the investigation path.

The 60-second prediction cap must not replace a separate test for timing-gap evidence.

### 4. Deterministic investigation

For every stable investigation rule, construct boundary, nominal, and violation cases. Confirm the exact rule ID, indication ID, severity, sensor IDs, observed value, expected condition, hypothesis list, and evidence. Verify detection delay is never negative and remains `null` when no post-onset indication exists.

Repeat each analysis with all ground-truth labels removed. Deterministic indications must remain identical. This is the primary leakage test.

### 5. Temporal model

#### Contract and compatibility

Reject mismatched artifact version, model type, schema, profile, profile version, required channel, unit, cadence outside 1,000 ms plus or minus 100 ms, window length other than 40, artifact SHA-256, or configuration SHA-256. Test every reason code independently and in combinations.

The Configuration view's compatibility result, enable control, and the analyzer's scoring activation must be tested together before release. Direct artifact loading inside the analyzer is not sufficient file-identity evidence by itself.

#### V1 research training, calibration, and evaluation separation

Assert these exact, disjoint seed sets:

- training: 1101 through 1140;
- calibration: 2101 through 2120;
- held-out evaluation: 3101 through 3140.

Training has 440 examples, calibration has 220, and held-out evaluation has 440 because each seed is paired with nominal plus ten fault labels. Held-out magnitudes are generated in the declared 0.72 through 1.32 range.

#### V2 integrated training, calibration, and selected-window evaluation

Assert these exact, disjoint seed sets for the production-integrated advisory artifact:

- training: 1101 through 1140;
- calibration: 2101 through 2120;
- held-out evaluation: 9101 through 9140.

The corpus exporter must call the actual TypeScript synthetic mission generator, fusion estimator, Investigation projection, and browser feature encoder. Each seed produces one nominal mission plus ten declared fault missions. Each 180-sample mission contributes exactly one selected 40-sample causal window, yielding 440 training, 220 calibration, and 440 held-out observations. Test reports and public documentation must call these selected-window observations, not episodes, complete streams, prevalence-weighted samples, independent flights, or real-world results.

Regenerate `models/temporal_fault_model_v2.json`, `models/temporal_evaluation_v2.json`, `models/temporal_inference_parity_v2.json`, and `models/TEMPORAL_INTEGRATION_MODEL_CARD.md`. Assert byte-stable regeneration, exact artifact and canonical-configuration identities, Python-to-TypeScript parity on raw mission windows, and explicit selected-window confusion counts. Runtime rolling-window performance requires a separately identified full-stream campaign and must not be inferred from this balanced selected-window partition.

#### Gate acceptance

Recompute each candidate artifact against the unchanged `FDW-TML-004` requirements rather than trusting a stored `passed` flag or an artifact-specific weaker threshold:

| Metric                                  | Required gate |
| --------------------------------------- | ------------: |
| Episode F1                              | At least 0.80 |
| Episode false-positive rate             |  At most 0.05 |
| Classification macro F1                 | At least 0.65 |
| Minimum per-fault classification recall | At least 0.65 |

Test one failure at a time. The integrated v2 minimum per-fault classification recall must be calculated across all ten declared classes and compared with 0.65. A failed gate must produce ineligible, inactive, advisory-only output. A passed gate must still remain inactive while the user selection is disabled.

#### Inference and abstention

- Match the checked Python parity cases within the declared absolute tolerance of `1e-9`.
- Require exactly 40 samples and finite output.
- Exercise forward fill, leading missing values, an entirely missing channel, low confidence, excessive class distance, insufficient anomaly margin, nominal, detected fault, and `unknown`.
- Verify top hypotheses have stable normalized-similarity ordering and deterministic tie behavior. Do not label the softmax-over-negative-distance score as a calibrated probability.
- Repeat identical inference and compare the entire result.
- Keep the minimum per-fault detection and classification counts visible in reports and do not replace them with aggregate F1.

#### V2 selected-window observations and statistical boundary

Read expected metrics and counts from the checked-in v2 evaluation artifact and assert them during exact regeneration. At minimum, verify total, nominal, and fault windows; TP, FP, TN, and FN; precision, recall, F1, macro F1, answered and abstained counts; and per-fault detected and correctly classified numerators and denominators.

For the nominal false-positive count, calculate and publish an exact one-sided 95 percent binomial upper bound. Store the observed numerator and denominator beside the point estimate. A point estimate at or below 0.05 does not establish an underlying rate at or below 0.05 when the upper bound exceeds 0.05.

Recompute the minimum per-fault classification recall from the per-fault count table and compare it with `FDW-TML-004`. A stored `passed` field must not override a failing required metric. This test must fail closed if a checked artifact weakens or omits the 0.65 requirement.

#### V1 research same-population detector projection

Regenerate `models/temporal_evaluation_v1.json` and assert one population of 440 held-out episodes, seeds 3101 through 3140, 40 samples per episode, 1,000 ms cadence, and fault magnitudes `0.72` through `1.32`. Assert these exact binary episode outcomes:

| System                            |  TP |  FP |  TN |  FN |             F1 | False-positive rate |
| --------------------------------- | --: | --: | --: | --: | -------------: | ------------------: |
| Temporal model                    | 371 |   1 |  39 |  29 | 0.961139896373 |               0.025 |
| One-sample persistence predictor  | 240 |   0 |  40 | 160 |           0.75 |                 0.0 |
| Two-sample linear predictor       | 179 |   0 |  40 | 221 | 0.618307426598 |                 0.0 |
| Robust covariance detector        | 400 |  40 |   0 |   0 | 0.952380952381 |                 1.0 |
| Deterministic investigation rules |  80 |   0 |  40 | 320 | 0.333333333333 |                 0.0 |

Confirm the robust covariance artifact SHA-256 is `6b8f286e2b2d7db49a8953cae5e301c40bc3f6154cd0b3197afad5647310ce66` and that it is not recalibrated on the temporal population. Confirm the deterministic projection evaluates only `investigation.sensor.missing` and `investigation.vibration.rolling-noise`, records the other six rules and their exclusion reasons, and never presents the partial row as complete rule-engine performance.

Run a leakage test that strips fault labels from detector inputs while retaining labels and onset only in the scoring harness. Detector outcomes must remain identical. Classification metrics, original covariance point metrics, and excluded rule behavior must not be merged into the binary comparison.

#### V1 research post-hoc generalization evidence

Keep the challenge separate from the primary release gate. Assert seeds 4101 through 4110 are disjoint from all primary partitions, the registered artifact and configuration hashes remain frozen, and no fitting or calibration uses challenge examples. Reproduce:

- magnitude `0.45` and `1.60` challenges over 210 episodes;
- onset and active-duration pairs `3/7`, `17/6`, `28/7`, and `30/10` over 410 episodes and all five generated phase labels;
- five declared two-fault combinations over 60 episodes.

Validate stored confusion, classification, abstention, per-configuration, per-fault, and per-phase evidence without imposing a post-hoc performance threshold. Exact novel-combination classification must remain undefined because no combination class exists. Ground-truth configuration is construction and scoring metadata only and must not enter the five observed inference channels.

### 6. Campaign evaluation

Build controlled generic-runner matrices over multiple profiles, phases, scenarios, and seeds. For the fixed-wing-only temporal executor, verify that unsupported profile IDs and versions fail closed instead of receiving fixed-wing data. Exercise all three bounded severity, duration, and onset-phase parameter sets. Verify ordered profile to scenario to seed expansion, stable case IDs, stable spec SHA-256, replay manifest variation equality, progress, queued browser cancellation between cases, partial cancelled-result evidence, evaluator failure containment, and JSON round trip.

Use controlled episodes to verify:

- expected, missing, and unexpected detection classification;
- duplicate and late detections;
- true negatives from declared negative rule opportunities;
- confusion overall and by profile, phase, and fault;
- scenario coverage;
- episode precision, recall, and F1;
- false alarms per run and synthetic hour;
- minimum, maximum, mean, median, and p95 time to detection;
- observations, answered, abstained, confidence summaries, Brier score, and expected calibration error;
- deterministic bootstrap estimates and interval bounds for a fixed bootstrap seed.

Test the wired input boundaries at zero, 1, 12, and 13 seeds; duplicates; nonintegers; negative values; and values above the positive 32-bit range. The default UI fixes one supported profile, one nominal scenario plus 30 parameterized fault cases, and 180 samples, so its declared range is 31 through 372 cases. Exercise lower-level boundaries at 4 profiles, 64 scenarios, 12 seeds, 372 cases, 256 KiB per specification, 10 MiB per serialized result, 128 detections per case, and 2,048 calibration observations per case. Inputs beyond those limits must fail explicitly.

### 7. SQLite evidence

Run migration twice, verify all four campaign tables and declared indexes, and reject orphan cases and detections. Upgrade a v1 database through migrations v2 and v3. Ingest the same run twice and confirm one run, one copy of each case, and one copy of each metric. Then ingest a second run containing the same deterministic case IDs and confirm both histories remain queryable without collisions. Corrupt a disposable database to prove integrity and foreign-key reports are not silently treated as success.

Exercise importer rejection above 10 MiB per result file, 64 MiB of retained result payloads, and 128 MiB of campaign-history database size. Confirm every limit fails explicitly without deleting prior evidence. Parameterized SQL mitigates SQL injection but does not make imported evidence trustworthy.

### 8. Chart and accessibility behavior

Verify aligned and misaligned arrays, null display gaps, inverted uncertainty, increasing sample indices, phase and marker ranges, empty state, and downsampling that never drops critical markers. Exercise overlays, cursor redraw, click seeking, Arrow keys, Page Up and Page Down, Home and End, focus visibility, accessible canvas names or equivalent text, zoom, narrow viewport, and non-color status descriptions.

Capture and replace a waveform baseline. Permit overlay only when profile, cadence, sample count, and every sample index match. Confirm a mismatch disables the control, states every mismatch reason, retains the captured baseline, and performs no interpolation. Verify the four detector rows preserve their roles, render unsupported or unavailable states, identify top Kalman residual sensors, and keep deterministic rules authoritative in mixed and unanimous summaries.

Export once with source inclusion disabled and assert that generated samples, investigation points, and complete series are absent. Export again after explicit selection and assert that all three are present and `exportPolicy.sourceDataIncluded` records the choice. Confirm campaign JSON omits source telemetry rows.

The display renderer is wired into the application Investigation view and passed the local browser and accessibility checks. Exact-commit exit criteria remain tied to protected CI and the tagged workflow.

## Security and resource tests

- Reject nonfinite and dimensionally invalid artifacts before inference.
- Recompute checked artifact and configuration hashes.
- Treat hostile labels and detection details as text in the current UI and JSON exports.
- Reject excessive campaign profiles, scenarios, seeds, total cases, bootstrap iterations, per-case evidence, serialized specification or result bytes, retained SQLite payloads, and database growth at the declared limits.
- Confirm cancellation remains responsive for a maximum allowed campaign.
- Confirm an inactive or abstained model cannot create an authoritative indication.
- Confirm source samples are absent from normal campaign evidence and from default Investigation JSON. Confirm only the explicit Investigation source-export choice adds generated source windows.

## Execution commands

Run the repository commands without converting them into a status claim until their outputs are captured for one exact commit:

```text
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:python
pnpm test:e2e
pnpm test:a11y
pnpm build
pnpm build:offline
```

`pnpm validate` combines most repository gates, but a v2.2 record must additionally identify the temporal artifact hashes, the held-out evaluation file, browser versions, and any tests that remain excluded from coverage.

For the current working tree, `pnpm build` and `pnpm build:offline` have completed locally. Record them as local compilation only. Do not mark the browser, offline-runtime, CI, or release rows passed until the built applications are executed through their declared gates on one exact commit.

## Candidate exit criteria

Promotion from candidate to release requires all of the following on the same commit:

- complete TypeScript and Python suites pass;
- temporal artifact regeneration is deterministic and hashes match the registry;
- the integrated investigation path invokes registry compatibility before activation;
- all ten mission scenarios and all ten model classes have recorded coverage;
- v1 research evidence remains separate from v2 production-integrated advisory evidence;
- v2 selected-window counts, exact one-sided false-positive bound, and weakest per-fault results remain documented without an episode, full-stream, prevalence, independent-flight, calibrated-probability, or real-world claim;
- every integrated v2 gate metric satisfies the unchanged `FDW-TML-004` requirement before the artifact is called eligible;
- UI campaign bounds are tested, and generic worker, result, and SQLite resource caps exist and are tested;
- the actual inline Web Worker build, progress, result, error, and responsive cancellation paths are verified end to end;
- the temporal workflow is present and verified in normal and offline builds;
- browser, responsive, keyboard, and automated accessibility checks pass;
- no benchmark, security, coverage, or release claim exceeds the captured evidence.
