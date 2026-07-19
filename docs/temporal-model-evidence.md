# Temporal model evidence

## Evidence status

This inventory separates two checked-in model roles that must not be conflated:

- **v1 research-evidence-only:** a separate five-channel generator supports controlled same-population comparisons and a non-gating generalization challenge. It is not the browser production path.
- **v2 production-integrated advisory:** the actual TypeScript mission generator, Investigation projection, and browser feature encoder produce its training and evaluation corpus. It remains advisory, and deterministic rules remain authoritative.

This inventory is not, by itself, a release verification record. Exact-commit CI, browser, offline, accessibility, security, and release outcomes are recorded separately in the generated verification report and GitHub workflows.

## V2 production-integrated advisory evidence

### Identity and evaluation unit

| File or canonical configuration                                   | SHA-256                                                            |
| ----------------------------------------------------------------- | ------------------------------------------------------------------ |
| `models/temporal_fault_model_v2.json`                             | `4cdea6792b8d302a8cc0197caccbb4498b18d136b1c2ed93fe798d66a82633af` |
| `models/temporal_evaluation_v2.json`                              | `ce1597d1b5df276c082b2a41dc6f1eaa4070cb31b6c1bb77b25e275957a4145c` |
| `models/temporal_inference_parity_v2.json`                        | `e0fd67f2ffa287895ae4e711a29e5dc08cf88efa0ef37c8f8557873f0836d0fe` |
| Canonical `generic-fixed-wing.temporal-fault@2.0.0` configuration | `30300e753e278f3ea8633fe71fb6ecdcdecf5a52146c85d2c22c6e2facbe956c` |

The v2 corpus has 40 held-out seeds. Each seed produces one nominal mission and ten fault missions. The exporter deliberately selects exactly one 40-sample causal window from each 180-sample mission, for 440 balanced selected-window observations: 40 nominal and 400 fault. It does not evaluate every rolling window in a mission.

These values are therefore **selected-window observations**. They are not episode-level, full-stream, prevalence-weighted, independent-flight, or real-world performance estimates. Runtime inference scores every rolling window after warmup, so full-stream false alarms, first post-onset indication, detection delay, phase, duration, and recovery require separate evidence.

### V2 checked selected-window observations

| Measure                                      |  Checked value | Count evidence            |
| -------------------------------------------- | -------------: | ------------------------- |
| Balanced selected windows                    |            440 | 40 nominal, 400 fault     |
| True positives                               |            391 | of 400 fault windows      |
| False negatives                              |              9 | of 400 fault windows      |
| False positives                              |              2 | of 40 nominal windows     |
| True negatives                               |             38 | of 40 nominal windows     |
| Binary selected-window precision             | 0.994910941476 | point estimate            |
| Binary selected-window recall                |         0.9775 | point estimate            |
| Binary selected-window F1                    | 0.986128625473 | point estimate            |
| Observed selected-window false-positive rate |           0.05 | 2 of 40 nominal windows   |
| Classification macro F1                      |  0.98546835443 | balanced synthetic labels |
| Abstention rate                              | 0.009090909091 | 4 of 440 windows          |

The deterministic seed-cluster bootstrap uses held-out mission seed as its resampling unit, seed `22073`, and 1,000 iterations. The selected-window F1 interval is `0.97845373891` through `0.992481203008`; classification macro F1 is `0.976720288326` through `0.992436708861`; minimum per-fault recall is `0.7` through `0.925`.

Two observed false positives do not prove that the underlying false-positive rate is at most 5 percent. For 2 events in 40 nominal observations, the exact one-sided 95 percent upper bound is approximately `0.1492`, or `14.92%`. The defensible statement is:

> Observed selected-window FPR: 2/40, or 5.0%. The exact one-sided 95% upper bound is 14.92%, so this sample does not establish an underlying FPR at or below 5%.

### V2 per-fault selected-window behavior

| Declared synthetic class  | Detected | Correctly classified | Detection recall | Classification recall |
| ------------------------- | -------: | -------------------: | ---------------: | --------------------: |
| `gradual-drift`           |  40 / 40 |              40 / 40 |            1.000 |                 1.000 |
| `noise-growth`            |  40 / 40 |              40 / 40 |            1.000 |                 1.000 |
| `oscillation`             |  40 / 40 |              40 / 40 |            1.000 |                 1.000 |
| `sensor-lag`              |  40 / 40 |              40 / 40 |            1.000 |                 1.000 |
| `intermittent-dropout`    |  40 / 40 |              40 / 40 |            1.000 |                 1.000 |
| `stuck-value`             |  39 / 40 |              39 / 40 |            0.975 |                 0.975 |
| `gain-error`              |  40 / 40 |              40 / 40 |            1.000 |                 1.000 |
| `fuel-leak`               |  40 / 40 |              40 / 40 |            1.000 |                 1.000 |
| `cross-sensor-decoupling` |  33 / 40 |              33 / 40 |            0.825 |                 0.825 |
| `simultaneous-faults`     |  39 / 40 |              39 / 40 |            0.975 |                 0.975 |

Every declared fault class satisfies the selected-window minimum classification recall of `0.65`. Cross-sensor decoupling is the weakest at 33 of 40 correct selected windows, or `0.825` recall. The checked point-estimate gate passes, but named hypotheses remain exploratory and full-stream learned-model evaluation is deferred to v2.3.

### V2 score semantics

Inference applies softmax to negative centroid distances with a fixed temperature. The resulting values are normalized distance similarities used to rank classes. No probability-calibration map is fitted, so the values must not be described as calibrated probabilities. Campaign Brier and expected-calibration-error fields are score-reliability diagnostics over this synthetic campaign, not proof of probabilistic calibration.

### Evidence refresh rule

The exact hashes and values above describe the checked files at the time of this documentation update. Before tagging a release, regenerate the model artifacts, recompute these hashes and counts, and fail the documentation check if any value changes without a matching evidence refresh.

## V1 research-evidence-only inventory

### V1 research artifact identity

| File or canonical configuration                                   | SHA-256                                                            |
| ----------------------------------------------------------------- | ------------------------------------------------------------------ |
| `models/temporal_fault_model_v1.json`                             | `8d238523f942ccc2b4f60a0048ff413018059dd1e583a1be216653bc3ef60cf4` |
| `models/temporal_evaluation_v1.json`                              | `c9b9e139ee1fba643357079b2a28b9688cddceb0e8bd160b6e1369b2a11c5d08` |
| `models/temporal_inference_parity_v1.json`                        | `b412a6a0a06de1e3bc5892baa46308c5e0ec3b304de9b618911e71fb8efd732b` |
| `models/model_configuration_manifest_v1.json`                     | `8b1a3f66577e6f6ac64fb33b5e8964f9d9758d0cf3a989a2a88a830b90016257` |
| Canonical `generic-fixed-wing.temporal-fault` configuration bytes | `9c7639745597b7b5a1b1ea7d498dfb83ae9da045316445b4d77ffbb7696fa230` |

The v1 research registry entry uses the first hash as `artifactSha256` and the canonical configuration hash as `configurationSha256`. The evaluation, parity, and manifest file hashes above identify workspace evidence, but they are not production-path activation identities.

### V1 research registry contract

The immutable registry entry is `generic-fixed-wing.temporal-fault` model version `1.0.0`.

| Field                 | Required value                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------ |
| Registry schema       | `model-registry.v1`                                                                                    |
| Artifact version      | `temporal-fault-model.v1`                                                                              |
| Model type            | `causal-dilated-convolution-nearest-centroid`                                                          |
| Telemetry schema      | `telemetry.v1`                                                                                         |
| Profile               | `generic-fixed-wing` version `1.0.0`                                                                   |
| Cadence               | 1,000 ms, tolerance 100 ms                                                                             |
| Window                | Exactly 40 samples                                                                                     |
| Channels and units    | `airspeed` in `kts`, `altitude` in `ft`, `verticalRate` in `ft/min`, `fuel` in `%`, `vibration` in `g` |
| Artifact SHA-256      | `8d238523f942ccc2b4f60a0048ff413018059dd1e583a1be216653bc3ef60cf4`                                     |
| Configuration SHA-256 | `9c7639745597b7b5a1b1ea7d498dfb83ae9da045316445b4d77ffbb7696fa230`                                     |
| Training reference    | `models/temporal_fault_model_v1.json#/training`, seeds 1101 through 1140                               |
| Calibration reference | `models/temporal_fault_model_v1.json#/calibration`, seeds 2101 through 2120                            |
| Evaluation reference  | `models/temporal_evaluation_v1.json#/evaluation`, seeds 3101 through 3140                              |
| Model card            | `models/TEMPORAL_MODEL_CARD.md`                                                                        |
| Quality-gate pointer  | `/qualityGate` in the evaluation document                                                              |
| Availability          | `registered`                                                                                           |
| User default          | `disabled`                                                                                             |
| Authority             | `deterministic-rules`                                                                                  |

Compatibility reports explicit reasons for unsupported profile, schema, profile version, missing channel, unit, cadence, window, artifact identity, configuration identity, registration, or availability. A compatible artifact must also pass its recomputed quality gate and be explicitly enabled by the user before it is active.

The artifact contains `enabledByDefault: true` because its stored synthetic gate passed. That field indicates gate eligibility in the artifact-generation workflow. It does not override the registry's disabled user default or the scoring function's default `userEnabled = false`. Eligibility is not activation.

The application Configuration view selects the v2 production-integrated registry entry. V1 remains registered so its research evidence can be reproduced and audited, but it is not the artifact used by the Investigation analyzer.

### V1 research architecture evidence

The artifact contains no Transformer and no trained convolution kernel. The implemented encoder computes 51 fixed causal summary features from a 40-sample window:

- nine features for each of five channels: mean, standard deviation, half-window shift, difference RMS at offsets 1, 2, and 4, curvature RMS, freeze ratio, and missing fraction;
- six cross-channel features: altitude to vertical-rate correlation, best lag, lag improvement, airspeed to altitude correlation, fuel slope, and vibration growth ratio.

Training learns the feature center, scale, eleven class centroids, and calibration radii and thresholds. Inference standardizes the 51 values, computes mean squared distance to nominal plus ten fault centroids, converts those distances to normalized similarity scores with temperature `0.35`, and applies class-radius, similarity-floor, and anomaly-margin abstention. The normalized similarities rank classes; they are not calibrated probabilities.

This compact approach was selected for transparent Python and TypeScript parity, deterministic execution, small browser scope, and inspectable distance evidence. No Transformer comparison was generated, so there is no accuracy, latency, or size claim against a Transformer.

### V1 research reproducibility partitions

The Python generator pairs each seed with eleven labels: nominal plus ten synthetic faults.

| Partition           | Seeds             | Examples | Purpose                                           |
| ------------------- | ----------------- | -------: | ------------------------------------------------- |
| Training            | 1101 through 1140 |      440 | Standardizer and class centroids                  |
| Calibration         | 2101 through 2120 |      220 | Class radii, confidence floor, and anomaly margin |
| Held-out evaluation | 3101 through 3140 |      440 | Gate metrics and per-fault evidence               |

The ranges are disjoint. Held-out fault magnitudes use the stored range `0.72` through `1.32`. All examples are generated synthetic data from the same training-code family, so disjoint seeds do not establish performance on a different real-world or operational distribution.

Calibration uses `class-distance-99th-percentile-and-confidence-floor`. Per-class radii are the calibrated class-distance 99th percentile multiplied by `1.8`, with a minimum of `0.05`. The confidence floor is 75 percent of the calibrated second percentile for correctly classified confidence, with a minimum of `0.12`. The anomaly-margin floor is the calibrated nominal 99th percentile, with a minimum of zero. The resulting artifact thresholds are confidence `0.201783008564` and anomaly margin `0.019807710791`.

The model-training generator is also distinct from the nine-sensor mission scenario generator. Its five-channel transformations are not identical, and its `sensor-lag` label is not the same identifier as the mission generator's `lag`. The metrics below are model-distribution metrics, not end-to-end investigation metrics.

### V1 research held-out episode and classification results

Exact values from `models/temporal_evaluation_v1.json`:

| Metric                                  | Exact measured value |
| --------------------------------------- | -------------------: |
| Examples                                |                  440 |
| True positives                          |                  371 |
| False positives                         |                    1 |
| True negatives                          |                   39 |
| False negatives                         |                   29 |
| Episode precision                       |       0.997311827957 |
| Episode recall                          |               0.9275 |
| Episode F1                              |       0.961139896373 |
| Episode false-positive rate             |                0.025 |
| Classification macro F1                 |        0.94734856407 |
| Minimum per-fault classification recall |                0.675 |
| Overall abstention rate                 |       0.043181818182 |

### V1 research quality gate

| Gate                                    |   Requirement |       Observed | Stored result |
| --------------------------------------- | ------------: | -------------: | ------------- |
| Episode F1                              | At least 0.80 | 0.961139896373 | Pass          |
| False-positive rate                     |  At most 0.05 |          0.025 | Pass          |
| Classification macro F1                 | At least 0.65 |  0.94734856407 | Pass          |
| Minimum per-fault classification recall | At least 0.65 |          0.675 | Pass          |

The stored v1 quality gate is `passed: true`. TypeScript recomputes all four comparisons rather than trusting that flag alone. These results establish only research-artifact eligibility on the declared v1 distribution; they do not establish v2 production-integrated performance.

### V1 research deterministic bootstrap interval

The held-out episode F1 interval was generated with deterministic bootstrap seed `22072` and `300` iterations:

|       Estimate | Lower 95 percent | Upper 95 percent | Method                    |
| -------------: | ---------------: | ---------------: | ------------------------- |
| 0.961139896373 |    0.94405347036 |   0.973354940533 | `deterministic-bootstrap` |

This interval quantifies resampling variation inside the generated held-out set. It does not cover dataset shift, generator mismatch, model-selection bias, or real-world uncertainty.

### V1 research per-fault evidence

Each fault has 40 held-out episodes.

| Fault class               | Detected | Detection recall | Correctly classified | Classification recall | Abstained |
| ------------------------- | -------: | ---------------: | -------------------: | --------------------: | --------: |
| `cross-sensor-decoupling` |       37 |            0.925 |                   36 |                   0.9 |         1 |
| `fuel-leak`               |       40 |              1.0 |                   40 |                   1.0 |         0 |
| `gain-error`              |       38 |             0.95 |                   37 |                 0.925 |         2 |
| `gradual-drift`           |       36 |              0.9 |                   36 |                   0.9 |         2 |
| `intermittent-dropout`    |       38 |             0.95 |                   38 |                  0.95 |         2 |
| `noise-growth`            |       38 |             0.95 |                   38 |                  0.95 |         2 |
| `oscillation`             |       38 |             0.95 |                   38 |                  0.95 |         2 |
| `sensor-lag`              |       28 |              0.7 |                   27 |                 0.675 |         4 |
| `simultaneous-faults`     |       40 |              1.0 |                   38 |                  0.95 |         0 |
| `stuck-value`             |       38 |             0.95 |                   38 |                  0.95 |         2 |

Sensor lag is the weakest recorded class by both detection and classification recall. Its classification recall of `0.675` is only `0.025` above the minimum gate. This weakness must be shown beside aggregate F1 in any review or demo.

### V1 research same-population detector comparison

The checked evaluation also projects five detector paths onto the same 440 held-out synthetic episodes, seeds 3101 through 3140, 40 samples per episode, 1,000 ms cadence, and fault-magnitude range `0.72` through `1.32`. A fault episode counts as positive when a detector emits at least one eligible indication at or after the declared onset. A nominal episode counts as positive when it emits at least one indication anywhere in the window.

| System                            | Evaluation status                   |  TP |  FP |  TN |  FN |      Precision | Recall |             F1 | False-positive rate |
| --------------------------------- | ----------------------------------- | --: | --: | --: | --: | -------------: | -----: | -------------: | ------------------: |
| Temporal model                    | evaluated                           | 371 |   1 |  39 |  29 | 0.997311827957 | 0.9275 | 0.961139896373 |               0.025 |
| One-sample persistence predictor  | evaluated                           | 240 |   0 |  40 | 160 |            1.0 |    0.6 |           0.75 |                 0.0 |
| Two-sample linear predictor       | evaluated                           | 179 |   0 |  40 | 221 |            1.0 | 0.4475 | 0.618307426598 |                 0.0 |
| Robust covariance detector        | evaluated with transfer limitations | 400 |  40 |   0 |   0 | 0.909090909091 |    1.0 | 0.952380952381 |                 1.0 |
| Deterministic investigation rules | partially evaluated                 |  80 |   0 |  40 | 320 |            1.0 |    0.2 | 0.333333333333 |                 0.0 |

These numbers are directly comparable only as binary episode precision, recall, F1, and false-positive rate on the declared projection. They are not a symmetric ranking of the complete systems:

- The temporal model makes one window-level decision. `unknown` and abstained outputs count as no detection.
- The persistence baseline predicts each channel from its immediately preceding observation and uses a robust-standardized maximum residual threshold of `3.858281254216`, calibrated from nominal calibration episodes. It excludes 929 missing residual observations and is not the production fusion estimator.
- The linear baseline predicts each channel from its two preceding samples, scores the maximum robust-standardized residual, and uses a threshold calibrated from nominal calibration episodes. It is not the production fusion estimator.
- The robust covariance artifact, SHA-256 `6b8f286e2b2d7db49a8953cae5e301c40bc3f6154cd0b3197afad5647310ce66`, is used unchanged and is not recalibrated on this temporal population. It was trained on a different synthetic point distribution. Its episode aggregation reports an indication when any eligible post-onset point reaches the checked threshold. It excludes 468 incomplete point observations and marks every nominal episode positive, which produces the recorded false-positive rate of `1.0`.
- Only two of the current eight investigation rules can be evaluated from the compact five-channel windows: `investigation.sensor.missing` and `investigation.vibration.rolling-noise`. The other six require redundant sensor channels, fuel flow, or production fusion state that is absent from this dataset. The implementation source recorded by the evaluation is `src/investigation/analyze.ts`, SHA-256 `04b95dea79a2399f7fdfab80db6997f83671c3101076226077d46027ad3f15e8`. The deterministic row is a partial projection, not a measurement of the complete authoritative rule engine.

Ground-truth fault labels and onset indices are used only to select the evaluation interval and score the episode outcome. Detector inputs contain observations only. The comparison does not use ground truth to set a detector input or alter a detector decision. The temporal classification metrics, the robust covariance artifact's original point-level metrics, and the six excluded investigation rules are not directly comparable in this table.

The comparison supports transparent review of declared synthetic behavior. It does not establish real-world performance, operational suitability, root cause, or superiority of one complete system over another. Deterministic rules remain authoritative regardless of the table values.

### V1 research post-hoc generalization challenge

The frozen artifact was also scored on a separate, explicitly **post-hoc and non-gating** challenge. Seeds 4101 through 4110 are disjoint from training, calibration, and the primary held-out partition. No challenge observation was used for fitting, threshold selection, or calibration. Fault labels, magnitude, onset, duration, and combination membership remain outside inference and are used only to construct synthetic observations and score results.

| Challenge dimension                                                        | Episodes |  TP |  FP |  TN |  FN | Precision | Recall |             F1 | FPR | Classification macro F1 | Fault abstention |
| -------------------------------------------------------------------------- | -------: | --: | --: | --: | --: | --------: | -----: | -------------: | --: | ----------------------: | ---------------: |
| Magnitudes `0.45` and `1.60` outside the primary `0.72` to `1.32` range    |      210 | 114 |   0 |  10 |  86 |       1.0 |   0.57 | 0.726114649682 | 0.0 |          0.615713713198 |            0.205 |
| Onset and active-duration pairs `3/7`, `17/6`, `28/7`, and `30/10` samples |      410 | 150 |   0 |  10 | 250 |       1.0 |  0.375 | 0.545454545455 | 0.0 |          0.302221904014 |             0.31 |
| Five novel two-fault combinations                                          |       60 |  29 |   0 |  10 |  21 |       1.0 |   0.58 |  0.73417721519 | 0.0 |             Not defined |             0.42 |

The onset and duration configurations cover early, middle, and late positions in the 40-sample window and retain five generated phase labels across the seed set. These phase labels are generator metadata, not a flight-dynamics simulation. The novel combinations are drift plus noise, oscillation plus fuel leak, lag plus gain, dropout plus decoupling, and stuck plus fuel leak. Exact combination classification is deliberately undefined because the model has no matching combination classes. For the 50 fault-combination episodes, the top hypothesis matched a component in 58 percent of episodes and the top three contained a component in all episodes. Those component figures are diagnostic coverage, not root-cause accuracy.

The challenge uses only ten nominal controls per dimension and was designed after the primary gate. Its values are limitations evidence, not an independent release gate or a basis for enabling the model. In particular, the `0.375` onset-and-duration recall shows material sensitivity to where and how long a fault appears inside the fixed window.

### V1 research unknown and abstention evidence

Inference returns `unknown` when any of these conditions apply:

- the user did not enable the model;
- the artifact is ineligible or fails the recomputed quality gate;
- the nearest-class distance exceeds its calibrated radius;
- confidence is below `0.201783008564`;
- a fault label lacks the required anomaly margin above `0.019807710791`.

The checked parity artifact includes an explicit unknown case:

| Field                                   | Exact value           |
| --------------------------------------- | --------------------- |
| Case                                    | `unknown-oscillation` |
| Nearest label                           | `oscillation`         |
| Final predicted label                   | `unknown`             |
| Confidence                              | 0.457314375352        |
| Distance                                | 1.476342725576        |
| Python to TypeScript absolute tolerance | `1e-9`                |

`unknown` is a useful safety property, but its synthetic rate is not a guarantee that all unfamiliar inputs will abstain.

Malformed artifacts, nonfinite artifact fields, and windows that are not exactly 40 samples throw explicit errors. They are validation failures, not classifier abstentions.

## Combined limitations

- Both models were trained, calibrated, and evaluated only on generated synthetic telemetry.
- It ranks declared hypotheses and does not establish root cause.
- It evaluates a fixed 40-second window at the nominal 1,000 ms cadence.
- Missing values are forward-filled, with zero fallback for an entirely missing channel; deterministic missing-data findings must remain authoritative.
- V1 records sensor lag as its weakest class. V2 records more severe named-class limitations, including zero correct gain-error classifications in 40 selected windows.
- V1's model generator and the mission generator are separate distributions. V2 uses the mission generator and Investigation projection but still evaluates only balanced selected windows.
- Registry compatibility is displayed in the application, but low-level scoring can still be called without it.
- No Transformer comparison, real-world dataset, browser timing result, CI result, offline runtime result, or release result is part of this evidence.
- The artifact is not intended for real flight, maintenance, certification, operational, or safety use.
