# Temporal Fault Model Card

## Summary

This experimental model combines a compact causal convolution feature encoder
at dilations 1, 2, and 4 with a learned standardized nearest-centroid
classifier. It evaluates 40-sample windows from the generic fixed-wing
synthetic profile, ranks declared synthetic fault hypotheses, and abstains when
confidence or class distance is unsupported. Deterministic rules remain
authoritative.

## Identity and compatibility

- Artifact: `temporal-fault-model.v1`
- Model version: `1.0.0`
- Model type: `causal-dilated-convolution-nearest-centroid`
- Profile: `generic-fixed-wing` version `1.0.0`
- Schema: `telemetry.v1`
- Window: `40` samples at `1000` ms cadence
- Channels: `airspeed, altitude, verticalRate, fuel, vibration`
- Training seeds: `1101` through `1140`
- Calibration seeds: `2101` through `2120`
- Held-out seeds: `3101` through `3140`
- Default eligible: **yes**

## Held-out synthetic evaluation

| Metric | Measured | Gate |
| --- | ---: | ---: |
| Episode precision | 0.9973 | Report only |
| Episode recall | 0.9275 | Report only |
| Episode F1 | 0.9611 | At least 0.80 |
| False-positive rate | 0.0250 | At most 0.05 |
| Classification macro F1 | 0.9473 | At least 0.65 |
| Minimum per-fault classification recall | 0.6750 | At least 0.65 |
| Abstention rate | 0.0432 | Report only |

The deterministic bootstrap 95 percent interval for episode F1 is
`0.9441` to
`0.9734`.

| Synthetic fault | Detection recall | Classification recall | Abstained episodes |
| --- | ---: | ---: | ---: |
| gradual-drift | 0.900 | 0.900 | 2 |
| noise-growth | 0.950 | 0.950 | 2 |
| oscillation | 0.950 | 0.950 | 2 |
| sensor-lag | 0.700 | 0.675 | 4 |
| intermittent-dropout | 0.950 | 0.950 | 2 |
| stuck-value | 0.950 | 0.950 | 2 |
| gain-error | 0.950 | 0.925 | 2 |
| fuel-leak | 1.000 | 1.000 | 0 |
| cross-sensor-decoupling | 0.925 | 0.900 | 1 |
| simultaneous-faults | 1.000 | 0.950 | 0 |

Sensor lag is the weakest recorded class and must remain visible as a
limitation. These results cover only generated held-out seeds and unseen
magnitudes in the declared range. They do not establish performance on another
distribution.

## Same-population baseline comparison

All rows below use the same 440 held-out synthetic episodes, seeds 3101 through
3140, and unseen magnitude range 0.72 through 1.32. A fault episode is positive
when a detector emits at least one eligible indication at or after onset. A
nominal episode is positive when it emits at least one indication anywhere in
the window.

| System | Evaluation status | Precision | Recall | F1 | False-positive rate | Eligible episodes |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Temporal model | evaluated | 0.9973 | 0.9275 | 0.9611 | 0.0250 | 440 |
| Persistence prediction baseline | evaluated | 1.0000 | 0.6000 | 0.7500 | 0.0000 | 440 |
| Linear prediction baseline | evaluated | 1.0000 | 0.4475 | 0.6183 | 0.0000 | 440 |
| Robust covariance detector | evaluated-with-transfer-limitations | 0.9091 | 1.0000 | 0.9524 | 1.0000 | 440 |
| Deterministic investigation rules | partially-evaluated | 1.0000 | 0.2000 | 0.3333 | 0.0000 | 440 |

This is not a fully symmetric benchmark. The persistence predictor uses the
prior observation, while the linear predictor uses two-sample extrapolation.
Both thresholds are calibrated on nominal calibration episodes. The robust
covariance artifact is used unchanged, without recalibration, even though it
was trained on a different synthetic point distribution. Its
`468` incomplete point observations
are excluded because its production interface requires all five channels to be
finite.

Only `2` of the current eight
investigation rules are valid on these compact windows:
`investigation.sensor.missing, investigation.vibration.rolling-noise`. The other six need
redundant sensor channels, fuel flow, or production fusion state that this model
evaluation dataset does not contain. The deterministic row is therefore a
partial rule-suite result and must not be interpreted as the performance of the
complete authoritative investigation engine.

## Post-hoc generalization challenge

This challenge is intentionally separate from the primary held-out evaluation
and is **not a release gate**. It uses frozen artifact
`8d238523f942ccc2b4f60a0048ff413018059dd1e583a1be216653bc3ef60cf4` with no fitting,
recalibration, or threshold selection on challenge results. Seeds
`4101` through `4110` are
disjoint from training, calibration, and primary held-out seeds. Labels and
onset metadata are used only to construct synthetic observations and score
episodes; inference receives the five observed channels only.

Exact challenge configurations:

- Magnitudes: `low-outside-evaluation-range=0.45, high-outside-evaluation-range=1.60`. Both are outside the primary
  held-out range 0.72 through 1.32.
- Onset and duration: `early-transient: onset 3, duration 7, recovery 30; middle-transient: onset 17, duration 6, recovery 17; late-transient: onset 28, duration 7, recovery 5; late-persistent: onset 30, duration 10, recovery 0`.
- Novel combinations: `drift-plus-noise: gradual-drift + noise-growth; oscillation-plus-fuel-leak: oscillation + fuel-leak; lag-plus-gain: sensor-lag + gain-error; dropout-plus-decoupling: intermittent-dropout + cross-sensor-decoupling; stuck-plus-fuel-leak: stuck-value + fuel-leak`.

| Challenge dimension | Episodes | Precision | Recall | F1 | False-positive rate | Classification macro F1 | Fault abstention rate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Magnitude outside primary range | 210 | 1.0000 | 0.5700 | 0.7261 | 0.0000 | 0.6157 | 0.2050 |
| Onset placement and active duration | 410 | 1.0000 | 0.3750 | 0.5455 | 0.0000 | 0.3022 | 0.3100 |
| Novel fault combinations | 60 | 1.0000 | 0.5800 | 0.7342 | 0.0000 | not defined | 0.4200 |

Exact classification is not defined for novel combinations because the model
has no corresponding combination classes. A declared component appears as the
top-one hypothesis for `0.5800` of
combination episodes and somewhere in the top three for
`1.0000`. These hypothesis
coverage values do not establish correct root-cause identification.

The challenge shows material degradation outside the primary distribution,
especially for short or late fault episodes. It uses only ten nominal controls
per dimension, and its zero observed false positives must not be interpreted as
a precise false-positive-rate estimate. The combinations compose already known
synthetic effects; they are not new physical fault mechanisms.

## Intended use

- Compare temporal indications with deterministic rules and the pointwise covariance detector.
- Rank declared synthetic hypotheses for investigation.
- Demonstrate calibrated uncertainty and an explicit unknown state.

## Limitations

- Trained and evaluated only on generated synthetic telemetry.
- Ranks declared synthetic fault hypotheses and does not establish cause.
- Unknown or unsupported inputs must produce an abstention.
- Deterministic rules remain authoritative for verification status.
- The compact convolution encoder is not intended for real-world flight or safety use.
