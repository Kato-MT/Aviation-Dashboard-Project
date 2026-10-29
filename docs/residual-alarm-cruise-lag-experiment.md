# Residual false alarms and cruise-lag experiment

This follow-up tests the remaining weaknesses of the full-mission forest at threshold 0.80. Production, the registered v2 model and prior reports remain unchanged. Checkpoints are committed and pushed to `feat/full-mission-evaluation`; they do not deploy the app.

## Diagnosis from already observed evidence

The prior final report has content hash `78495d5c9747f5107360bdd590bdcfcf595f593504fda83fe43cb6496e0d6d1e`. Its incumbent model file hash is `e1a0fa89202e33b3819ab134301b59f1dedbb4d4d0f5d209b3ead862e9d328e2`.

All 80 nominal missions replayed exactly. Nineteen missions produced 26 episodes covering 50 endpoints: 15 singletons, four two-sample runs, five three-sample runs, one four-sample run and one eight-sample run. Eleven episodes occurred in climb, eleven in descent and four in cruise. Only seven began within five samples of a phase transition, so suppressing transitions alone would not address the problem.

At 19 of the 26 episode peaks, tree-path contrasts against clear nominal missions at the same time were led by five-sample altitude, rate or speed disagreement summaries. The remaining seven were led by speed mean20 or lag-offset features. These associations identify a testable mechanism, not proof of causation. Peak scores were often confident: median 0.931, upper quartile 0.972 and maximum 1.0. Raising a threshold alone had already sacrificed lag recall.

Cruise lag is a weak signal. A three-sample delay shifts the nominal cruise speed by at most about 0.781 knots, compared with a nominal sensor-pair noise standard deviation of 1.221 knots. Climb lag produces about 2.374 knots. The old lag feature searches both leading and lagging offsets on unequal timestamp supports, and its best raw-error improvement can favor noise.

A diagnostic signed comparison of smoothed GPS against current IAS separates the already-observed nominal/cruise-lag values at sample100 better: AUC 0.8747 versus 0.6183 for the old raw RMS improvement. Replacing the generator's repeated historical IAS noise with current-time nominal noise retains diagnostic separation (AUC 0.8844). These reused-seed diagnostics are not new validation and did not set a final threshold.

## Fixed targeted experiment

Two forests will use identical fresh fitting missions, weighting, robust scaling and existing tree parameters: 64 trees, maximum depth18, minimum leaf5, maximum feature fraction0.75 and two training threads. This isolates the feature bundle rather than combining it with an untested regularization change.

- **Control:** the original 72 observed features, retrained on the new fitting partition.
- **Targeted candidate:** keep the original features except the raw best-offset/RMS-improvement lag pair; add 15-sample mean, RMS and missingness for each of the three redundant sensor pairs; add signed smoothed lag evidence and its valid-support fraction. Short summaries remain available for prompt detection.

The common exported matrix has 83 columns. Model-specific masks retain72 control inputs and81 targeted inputs. Missing evidence is explicit. No seed, truth, true phase, absolute endpoint, future observation or nominal-control trajectory enters inference.

The new lag evidence smooths GPS using seven-point centered means within the current40-sample window. It compares IAS at positions20–36 to GPS references at the same positions and three positions earlier, using exactly the same valid supports. Its numerator is the reduction in summed squared error under the delayed reference; its denominator is the square root of reference-change energy, floored at1e-9. The feature requires at least eight valid comparisons and records the valid fraction. All samples are at or before the current endpoint. The three-sample smoothing delay remains part of measured detection delay, without backdating.

| Partition   | Seeds       | Primary missions | Use                                        |
| ----------- | ----------- | ---------------: | ------------------------------------------ |
| Fit         | 22101–22160 |            2,460 | Train both models and preprocessing        |
| Calibration | 23101–23140 |            1,640 | Derive complete nominal-mission thresholds |
| Development | 24101–24140 |            1,640 | Select and freeze one setting per model    |
| Final       | 25101–25180 |            3,280 | Test frozen settings without retuning      |

All seeds must be disjoint from registered-model partitions and every prior experiment through21180. Primary missions retain the existing41-case matrix,180samples and one-second cadence. Development and final additionally include one cruise-lag challenge per seed that delays latent speed while retaining current-time IAS measurement noise. The challenge is evaluation-only and is reported separately from the primary41-case metrics. Generation may use truth to construct this synthetic challenge; inference never receives that truth as a feature.

Calibration considers fixed thresholds0.50,0.60,0.70,0.80,0.90,0.95 plus nearest-rank p50,p75,p90,p95 and maximum of nominal-mission score maxima, deduplicated. All policies use one window. Development selects the targeted model's passing setting with the lowest nominal mission alarm rate, then highest confirmed cruise-lag recall, highest overall confirmed recall and lower threshold. A control setting is frozen separately for a descriptive feature ablation; final control results cannot replace the primary candidate after evaluation.

## Acceptance before new final data

The comparator is the previous full-mission forest at0.80, not the weaker registered v2 model. Registered v2 and deterministic rules remain separate references.

- Preserve ordinary active recall within two percentage points overall and five points per family, with paired p95 added delay at most five seconds.
- Preserve confirmed fault-specific recall within two points overall and five points per family, with paired p95 added confirmed delay at most five seconds.
- Require a nominal-mission false-alarm reduction with a strictly negative upper95% paired confidence bound.
- Require at least a ten-point gain in confirmed `lag / standard-cruise` recall, with a strictly positive lower paired confidence bound, in both the primary matrix and the current-noise challenge.

Uncertainty uses1,000 paired bootstrap resamples grouped by seed. Related variants and the shared nominal control remain together. Undefined required evidence fails a gate. If no development setting passes, freeze the diagnostic candidate as rejected; final data cannot rescue a development failure. Final results may confirm or reject the frozen candidate, but cannot drive another tuning cycle on those seeds.

The ten-point lag gain is an improvement criterion, not a claim that the blind spot is eliminated. Absolute nominal and lag rates remain prominent, even if relative gates pass.

## Checkpoint status

Diagnosis and design are complete. No221xx–251xx mission has been generated at this checkpoint. Implementation, fresh evaluation and new verification are pending. The existing checkpoint history through `6843224` has been pushed and verified on GitHub.
