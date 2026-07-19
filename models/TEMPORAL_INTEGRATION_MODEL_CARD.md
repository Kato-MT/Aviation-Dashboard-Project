# Temporal Integration Model Card

## Summary

This experimental browser model is fitted in Python on causal rolling-window
features exported from the actual TypeScript synthetic mission generator,
fusion estimator, Investigation projection, and browser feature encoder.
Deterministic rules remain authoritative. The model is synthetic-only and is
not flight-safety, operational, diagnostic-certification, or airworthiness evidence.

The classifier compares each standardized feature vector with deterministic
training prototypes partitioned by training lifecycle and end phase. Inference
does not receive lifecycle, phase truth, fault labels, onset, or recovery metadata.
Its normalized distance similarities are relative ranking scores, not calibrated
probabilities.

## Identity

- Artifact schema: `temporal-fault-model.v1`
- Model version: `2.0.0`
- Model type: `causal-multiscale-feature-nearest-prototype`
- Configuration SHA-256: `30300e753e278f3ea8633fe71fb6ecdcdecf5a52146c85d2c22c6e2facbe956c`
- Artifact SHA-256: `4cdea6792b8d302a8cc0197caccbb4498b18d136b1c2ed93fe798d66a82633af`
- Window: 40 samples at 1000 ms cadence

## Held-out selected-window integration gate

The split seed sets are disjoint. Hyperparameter selection and threshold fitting
use only training and calibration seeds. The final fixed evaluation uses seeds
9101 through 9140 exactly once. Metrics use balanced selected causal windows from
held-out TypeScript missions. They are neither full-stream episode metrics nor
estimates of real-world prevalence.

| Metric | Observed | Gate |
| --- | ---: | ---: |
| Selected-window binary F1 | 0.9861 | >= 0.85 |
| Selected-window false-positive rate | 0.0500 | <= 0.05 |
| Classification macro F1 | 0.9855 | >= 0.65 |
| Minimum per-fault classification recall | 0.8250 | >= 0.65 |
| Abstention rate | 0.0091 | <= 0.80 |
| Answered observations | 436 | >= 1 |

Point-estimate gate result: **PASS**.

The deterministic seed-cluster bootstrap uses seed `22073` for
`1000` iterations. Its 95 percent intervals are:

| Metric | Lower | Upper |
| --- | ---: | ---: |
| Precision | 0.9874 | 1.0000 |
| Recall | 0.9650 | 0.9900 |
| F1 | 0.9785 | 0.9925 |
| Classification macro F1 | 0.9767 | 0.9924 |
| Minimum per-fault recall | 0.7000 | 0.9250 |

The selected-window confusion counts are 391 TP,
2 FP, 38 TN,
and 9 FN. The exact one-sided 95 percent
Clopper-Pearson upper bound for the false-positive rate is
`0.1492`. Therefore this 40-window
nominal sample does **not** establish a population false-positive rate at or below
five percent. That statistical limitation is separate from the declared
selected-window point-estimate gate.

## Per-fault held-out behavior

Zero-answer or zero-classification rows are explicit limitations, not hidden
successes. Every declared fault must meet the minimum recall gate.

| Declared synthetic label | Answered | Detection recall | Classification recall |
| --- | ---: | ---: | ---: |
| gradual-drift | 40 / 40 | 1.000 | 1.000 |
| noise-growth | 40 / 40 | 1.000 | 1.000 |
| oscillation | 40 / 40 | 1.000 | 1.000 |
| sensor-lag | 40 / 40 | 1.000 | 1.000 |
| intermittent-dropout | 40 / 40 | 1.000 | 1.000 |
| stuck-value | 39 / 40 | 0.975 | 0.975 |
| gain-error | 40 / 40 | 1.000 | 1.000 |
| fuel-leak | 40 / 40 | 1.000 | 1.000 |
| cross-sensor-decoupling | 40 / 40 | 0.825 | 0.825 |
| simultaneous-faults | 39 / 40 | 0.975 | 0.975 |


## Limitations

- Trained and evaluated only on generated synthetic telemetry projected by the browser Investigation path.
- Selected rolling windows are balanced research observations, not independent real-world flights.
- Ranks declared synthetic fault hypotheses and does not establish root cause.
- Normalized distance similarities are relative scores, not calibrated probabilities.
- The held-out false-positive point estimate passes, but 40 nominal windows cannot establish a population false-positive rate at or below five percent at 95 percent confidence.
- Unknown or unsupported inputs may produce an abstention.
- Deterministic rules remain authoritative for verification status.
