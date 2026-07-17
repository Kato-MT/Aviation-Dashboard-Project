# Experimental Learned-Baseline Model Card

## Summary

This optional detector uses a robust center and scale with a regularized
covariance matrix and Mahalanobis scoring. It is trained and evaluated only on
generated synthetic, unclassified telemetry. Deterministic rules remain the
authoritative source for verification status.

## Version and reproducibility

- Artifact: `learned-baseline.v1`
- Model version: `1.0.0`
- Training seeds: `101, 211, 307, 401`
- Calibration seeds: `509, 601`
- Held-out evaluation seeds: `701, 809, 907`
- Default enabled: **yes**

## Held-out results

| Metric              | Result |  Quality gate |
| ------------------- | -----: | ------------: |
| Precision           | 0.8451 |   Report only |
| Recall              | 1.0000 |   Report only |
| F1                  | 0.9160 | At least 0.85 |
| False-positive rate | 0.0117 |  At most 0.05 |

These values are reproducible outputs of `tools/ml/train_model.py`; they are not
claims about real aircraft, operational data, or flight safety.

## Intended use

- Demonstrate a learned baseline beside deterministic diagnostics.
- Rank unusual synthetic samples and explain channel residual contributions.
- Compare experimental anomaly indications with authoritative rule findings.

## Limitations

- Experimental detector trained only on generated synthetic telemetry.
- Pointwise model does not detect all temporal, communications, or schema faults.
- Deterministic profile rules remain authoritative for verification results.
- Model scores are demonstrations and are not flight-safety or certification evidence.
