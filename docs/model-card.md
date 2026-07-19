# Learned-baseline evaluation evidence

The authoritative generated model card is [`models/MODEL_CARD.md`](../models/MODEL_CARD.md). This document records the supporting artifact identity, held-out evaluation, enablement decision, and release boundary.

## Status and identity

- Artifact ID: `learned-baseline.v1`
- Model version: `1.0.0`
- Model type: robust regularized covariance with Mahalanobis scoring
- Generated at: `2026-07-17T00:00:00.000Z`
- Artifact SHA-256: `6b8f286e2b2d7db49a8953cae5e301c40bc3f6154cd0b3197afad5647310ce66`
- Evaluation SHA-256: `253c5558a68b8b3cd433779b6212eac80f6d2767597b3ff143ec0cb493c1a9e7`
- Inference parity vector SHA-256: `e1ebf1406c10256bd6d2bb553c3faf96170c49ce0433aa465a954a6532c637f7`
- Local held-out gate: passed
- Artifact default enabled: yes

The generated artifact may be active only when the user enables the experimental comparison and runtime validation independently confirms both recorded gates. Deterministic findings remain authoritative.

## Intended use

The model compares synthetic telemetry samples with a generated nominal synthetic baseline and provides an anomaly score plus per-channel residual contributions. It is an educational comparison beside deterministic diagnostics.

It is not intended for real-world flight, safety, maintenance, certification, operational monitoring, or causal diagnosis. It cannot suppress, downgrade, or replace deterministic findings.

## Training and calibration

| Split               | Seeds              | Samples per seed | Purpose                                            |
| ------------------- | ------------------ | ---------------: | -------------------------------------------------- |
| Training            | 101, 211, 307, 401 |            1,500 | Fit center, scale, and regularized covariance      |
| Calibration         | 509, 601           |            1,000 | Select the 99th-percentile score threshold         |
| Held-out evaluation | 701, 809, 907      |            1,000 | Measure nominal and labeled injected-fault results |

Training uses five ordered channels: airspeed, altitude, vertical rate, fuel, and vibration. All generated data and injected faults are synthetic and unclassified. Training and held-out seeds do not overlap.

Python and TypeScript share a versioned parity vector whose Python reference score is `27.18691586461726`. Both implementations enforce an absolute score tolerance of `1e-10` for that vector.

## Held-out evaluation

| Metric              | Required gate | Measured value | Result   |
| ------------------- | ------------: | -------------: | -------- |
| Precision           |   Report only | 0.845070422535 | Reported |
| Recall              |   Report only | 1.000000000000 | Reported |
| F1                  | At least 0.85 | 0.916030534351 | Pass     |
| False-positive rate |  At most 0.05 | 0.011702127660 | Pass     |

Confusion counts: 180 true positives, 2,787 true negatives, 33 false positives, and 0 false negatives across the recorded held-out synthetic evaluation.

| Injected scenario   | Labeled samples | Detected | Recall |
| ------------------- | --------------: | -------: | -----: |
| Airspeed shift      |              36 |       36 | 1.0000 |
| Altitude jump       |              28 |       28 | 1.0000 |
| Fuel loss           |              46 |       46 | 1.0000 |
| Vertical-rate spike |              32 |       32 | 1.0000 |
| Vibration spike     |              38 |       38 | 1.0000 |

These metrics describe only the recorded generated held-out seeds. They do not establish performance on another distribution or any real-world system.

## Limitations and risks

- Generated relationships may not represent other data distributions.
- The pointwise model does not detect all temporal, communications, or schema faults.
- Robust covariance assumes a distribution shape and feature relationship that can fail under multimodal behavior.
- Aggregate metrics can hide weak performance for another scenario or channel.
- Residual contributions are local score components, not causal explanations.
- A high score may reflect a schema, mapping, or unit error.
- Python and TypeScript inference parity uses a declared numerical tolerance, but one vector does not cover every numerical edge case.

## Release evidence

The published [`v2.1.0` release](https://github.com/Kato-MT/Aviation-Dashboard-Project/releases/tag/v2.1.0) attaches the model artifact, evaluation JSON, model card, parity vector, SBOM, checksums, and provenance from commit `4439cbe06f5c7e85fba523e25cc04b3eba2c7f98`. The recorded artifact hashes match the committed files. See the [completed release verification](release-verification-v2.1.0.md). If a future release parity or held-out gate fails, the model must remain disabled regardless of an earlier passing evaluation.
