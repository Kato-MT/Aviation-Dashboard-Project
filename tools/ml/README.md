# Learned-Baseline Training

`train_model.py` is a dependency-free, deterministic Python pipeline. It
generates nominal synthetic telemetry, fits a robust covariance-style model,
calibrates a Mahalanobis threshold, evaluates held-out labeled fault seeds, and
exports the artifact consumed by TypeScript.

```powershell
python tools/ml/train_model.py
```

The output is enabled by default only when held-out F1 is at least `0.85` and
false-positive rate is at most `0.05`. The learned detector is always
experimental. Deterministic rules remain authoritative.
