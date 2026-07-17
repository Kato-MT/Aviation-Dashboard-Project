#!/usr/bin/env python3
"""Train and evaluate a reproducible robust covariance-style telemetry model.

This pipeline intentionally uses only the Python standard library. It fits a
robust center and scale, estimates a regularized covariance matrix over clipped
standardized nominal telemetry, and exports a Mahalanobis scoring artifact for
TypeScript inference. Deterministic rules remain authoritative in the product.
"""

from __future__ import annotations

import argparse
import json
import math
import random
import statistics
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Sequence


CHANNELS = ("airspeed", "altitude", "verticalRate", "fuel", "vibration")
TRAINING_SEEDS = (101, 211, 307, 401)
CALIBRATION_SEEDS = (509, 601)
EVALUATION_SEEDS = (701, 809, 907)
GENERATED_AT = "2026-07-17T00:00:00.000Z"
MODEL_VERSION = "1.0.0"
ARTIFACT_VERSION = "learned-baseline.v1"
MINIMUM_F1 = 0.85
MAXIMUM_FALSE_POSITIVE_RATE = 0.05


@dataclass(frozen=True)
class LabeledPoint:
    values: tuple[float, ...]
    is_fault: bool
    fault_type: str | None = None


def generate_nominal(seed: int, count: int) -> list[tuple[float, ...]]:
    """Generate deterministic, correlated, synthetic nominal telemetry."""
    rng = random.Random(seed)
    points: list[tuple[float, ...]] = []
    for index in range(count):
        phase = index / 37.0 + seed * 0.001
        common = rng.gauss(0.0, 1.0)
        airspeed = 124.0 + 5.5 * math.sin(phase) + 1.8 * common + rng.gauss(0, 1.1)
        vertical_rate = 45.0 * math.cos(phase / 2) + 18.0 * common + rng.gauss(0, 22)
        altitude = 5_300.0 + 180.0 * math.sin(phase / 2) + 15.0 * common + rng.gauss(0, 35)
        fuel = 72.0 + 1.1 * math.cos(phase / 5) - 0.08 * common + rng.gauss(0, 0.45)
        vibration = 0.24 + 0.008 * common + 0.012 * math.sin(phase * 1.7) + rng.gauss(0, 0.006)
        points.append((airspeed, altitude, vertical_rate, fuel, vibration))
    return points


def inject_labeled_faults(seed: int, count: int, fault_fraction: float = 0.06) -> list[LabeledPoint]:
    """Create held-out points with deterministic labels and strong declared faults."""
    nominal = generate_nominal(seed, count)
    rng = random.Random(seed ^ 0x5A17)
    fault_count = max(1, round(count * fault_fraction))
    fault_indices = set(rng.sample(range(count), fault_count))
    fault_types = (
        "airspeed-shift",
        "altitude-jump",
        "vertical-rate-spike",
        "fuel-loss",
        "vibration-spike",
    )
    labeled: list[LabeledPoint] = []
    for index, point in enumerate(nominal):
        if index not in fault_indices:
            labeled.append(LabeledPoint(point, False, None))
            continue
        values = list(point)
        fault_type = fault_types[(index + seed) % len(fault_types)]
        if fault_type == "airspeed-shift":
            values[0] += 72.0
        elif fault_type == "altitude-jump":
            values[1] += 2_600.0
        elif fault_type == "vertical-rate-spike":
            values[2] -= 2_400.0
        elif fault_type == "fuel-loss":
            values[3] -= 31.0
        elif fault_type == "vibration-spike":
            values[4] += 0.95
        labeled.append(LabeledPoint(tuple(values), True, fault_type))
    return labeled


def percentile(values: Sequence[float], probability: float) -> float:
    if not values:
        raise ValueError("Cannot calculate a percentile of an empty sequence.")
    ordered = sorted(values)
    position = (len(ordered) - 1) * probability
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    fraction = position - lower
    return ordered[lower] * (1 - fraction) + ordered[upper] * fraction


def robust_center_and_scale(points: Sequence[Sequence[float]]) -> tuple[list[float], list[float]]:
    columns = list(zip(*points, strict=True))
    centers = [statistics.median(column) for column in columns]
    scales: list[float] = []
    for column, center in zip(columns, centers, strict=True):
        mad = statistics.median(abs(value - center) for value in column)
        scales.append(max(mad * 1.4826, 1e-9))
    return centers, scales


def standardized(
    point: Sequence[float], center: Sequence[float], scale: Sequence[float], *, clip: float | None = None
) -> list[float]:
    values = [(value - origin) / width for value, origin, width in zip(point, center, scale, strict=True)]
    if clip is None:
        return values
    return [max(-clip, min(clip, value)) for value in values]


def covariance(points: Sequence[Sequence[float]], regularization: float = 0.05) -> list[list[float]]:
    if len(points) < 2:
        raise ValueError("At least two points are required for covariance estimation.")
    width = len(points[0])
    means = [sum(point[index] for point in points) / len(points) for index in range(width)]
    matrix = [[0.0] * width for _ in range(width)]
    for row in range(width):
        for column in range(width):
            matrix[row][column] = sum(
                (point[row] - means[row]) * (point[column] - means[column]) for point in points
            ) / (len(points) - 1)
        matrix[row][row] += regularization
    return matrix


def invert_matrix(matrix: Sequence[Sequence[float]]) -> list[list[float]]:
    size = len(matrix)
    if size == 0 or any(len(row) != size for row in matrix):
        raise ValueError("Matrix must be non-empty and square.")
    augmented = [
        list(row) + [1.0 if row_index == column else 0.0 for column in range(size)]
        for row_index, row in enumerate(matrix)
    ]
    for column in range(size):
        pivot_row = max(range(column, size), key=lambda row: abs(augmented[row][column]))
        if abs(augmented[pivot_row][column]) < 1e-12:
            raise ValueError("Covariance matrix is singular after regularization.")
        augmented[column], augmented[pivot_row] = augmented[pivot_row], augmented[column]
        pivot = augmented[column][column]
        augmented[column] = [value / pivot for value in augmented[column]]
        for row in range(size):
            if row == column:
                continue
            factor = augmented[row][column]
            augmented[row] = [
                value - factor * pivot_value
                for value, pivot_value in zip(augmented[row], augmented[column], strict=True)
            ]
    return [row[size:] for row in augmented]


def mahalanobis_score(point: Sequence[float], inverse_covariance: Sequence[Sequence[float]]) -> float:
    projected = [sum(weight * value for weight, value in zip(row, point, strict=True)) for row in inverse_covariance]
    return max(0.0, sum(value * projection for value, projection in zip(point, projected, strict=True)))


def confusion_metrics(labels: Sequence[bool], predictions: Sequence[bool]) -> dict[str, float | int]:
    tp = sum(label and prediction for label, prediction in zip(labels, predictions, strict=True))
    fp = sum((not label) and prediction for label, prediction in zip(labels, predictions, strict=True))
    tn = sum((not label) and (not prediction) for label, prediction in zip(labels, predictions, strict=True))
    fn = sum(label and (not prediction) for label, prediction in zip(labels, predictions, strict=True))
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    false_positive_rate = fp / (fp + tn) if fp + tn else 0.0
    return {
        "truePositives": tp,
        "falsePositives": fp,
        "trueNegatives": tn,
        "falseNegatives": fn,
        "precision": precision,
        "recall": recall,
        "f1": f1,
        "falsePositiveRate": false_positive_rate,
    }


def rounded_matrix(matrix: Iterable[Iterable[float]]) -> list[list[float]]:
    return [[round(value, 12) for value in row] for row in matrix]


def train_model(samples_per_training_seed: int, samples_per_evaluation_seed: int) -> dict[str, object]:
    training = [
        point
        for seed in TRAINING_SEEDS
        for point in generate_nominal(seed, samples_per_training_seed)
    ]
    center, scale = robust_center_and_scale(training)
    clipped = [standardized(point, center, scale, clip=4.0) for point in training]
    inverse_covariance = invert_matrix(covariance(clipped))

    calibration = [
        point
        for seed in CALIBRATION_SEEDS
        for point in generate_nominal(seed, samples_per_evaluation_seed)
    ]
    calibration_scores = [
        mahalanobis_score(standardized(point, center, scale), inverse_covariance)
        for point in calibration
    ]
    threshold = percentile(calibration_scores, 0.99)

    held_out = [
        point
        for seed in EVALUATION_SEEDS
        for point in inject_labeled_faults(seed, samples_per_evaluation_seed)
    ]
    scores = [
        mahalanobis_score(standardized(point.values, center, scale), inverse_covariance)
        for point in held_out
    ]
    metrics = confusion_metrics(
        [point.is_fault for point in held_out],
        [score >= threshold for score in scores],
    )
    passed = (
        float(metrics["f1"]) >= MINIMUM_F1
        and float(metrics["falsePositiveRate"]) <= MAXIMUM_FALSE_POSITIVE_RATE
    )

    by_fault: dict[str, dict[str, int | float]] = {}
    for fault_type in sorted({point.fault_type for point in held_out if point.fault_type}):
        selected = [
            (point, score)
            for point, score in zip(held_out, scores, strict=True)
            if point.fault_type == fault_type
        ]
        detected = sum(score >= threshold for _, score in selected)
        by_fault[str(fault_type)] = {
            "samples": len(selected),
            "detected": detected,
            "recall": detected / len(selected) if selected else 0.0,
        }

    return {
        "artifactVersion": ARTIFACT_VERSION,
        "modelVersion": MODEL_VERSION,
        "modelType": "robust-regularized-covariance-mahalanobis",
        "generatedAt": GENERATED_AT,
        "syntheticDataOnly": True,
        "enabledByDefault": passed,
        "channels": list(CHANNELS),
        "center": [round(value, 12) for value in center],
        "scale": [round(value, 12) for value in scale],
        "inverseCovariance": rounded_matrix(inverse_covariance),
        "scoreThreshold": round(threshold, 12),
        "training": {
            "seeds": list(TRAINING_SEEDS),
            "samplesPerSeed": samples_per_training_seed,
            "totalSamples": len(training),
            "winsorizationLimit": 4.0,
            "covarianceRegularization": 0.05,
        },
        "calibration": {
            "seeds": list(CALIBRATION_SEEDS),
            "samplesPerSeed": samples_per_evaluation_seed,
            "thresholdPercentile": 0.99,
        },
        "evaluation": {
            "seeds": list(EVALUATION_SEEDS),
            "samplesPerSeed": samples_per_evaluation_seed,
            "faultFraction": 0.06,
            "metrics": {key: round(value, 12) if isinstance(value, float) else value for key, value in metrics.items()},
            "byFault": by_fault,
        },
        "qualityGate": {
            "minimumF1": MINIMUM_F1,
            "maximumFalsePositiveRate": MAXIMUM_FALSE_POSITIVE_RATE,
            "passed": passed,
        },
        "limitations": [
            "Experimental detector trained only on generated synthetic telemetry.",
            "Pointwise model does not detect all temporal, communications, or schema faults.",
            "Deterministic profile rules remain authoritative for verification results.",
            "Model scores are demonstrations and are not flight-safety or certification evidence.",
        ],
    }


def write_artifacts(model: dict[str, object], output_directory: Path) -> None:
    output_directory.mkdir(parents=True, exist_ok=True)
    artifact_path = output_directory / "robust_covariance_v1.json"
    metrics_path = output_directory / "evaluation_v1.json"
    card_path = output_directory / "MODEL_CARD.md"
    artifact_path.write_text(
        json.dumps(model, indent=2, sort_keys=True) + "\n", encoding="utf-8", newline="\n"
    )

    evaluation = model["evaluation"]
    quality_gate = model["qualityGate"]
    metrics_document = {
        "artifactVersion": model["artifactVersion"],
        "modelVersion": model["modelVersion"],
        "generatedAt": model["generatedAt"],
        "evaluation": evaluation,
        "qualityGate": quality_gate,
        "enabledByDefault": model["enabledByDefault"],
    }
    metrics_path.write_text(
        json.dumps(metrics_document, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
        newline="\n",
    )

    metrics = evaluation["metrics"]  # type: ignore[index]
    enabled = "yes" if model["enabledByDefault"] else "no"
    card = f"""# Experimental Learned-Baseline Model Card

## Summary

This optional detector uses a robust center and scale with a regularized
covariance matrix and Mahalanobis scoring. It is trained and evaluated only on
generated synthetic, unclassified telemetry. Deterministic rules remain the
authoritative source for verification status.

## Version and reproducibility

- Artifact: `{model['artifactVersion']}`
- Model version: `{model['modelVersion']}`
- Training seeds: `{', '.join(map(str, TRAINING_SEEDS))}`
- Calibration seeds: `{', '.join(map(str, CALIBRATION_SEEDS))}`
- Held-out evaluation seeds: `{', '.join(map(str, EVALUATION_SEEDS))}`
- Default enabled: **{enabled}**

## Held-out results

| Metric              | Result |  Quality gate |
| ------------------- | -----: | ------------: |
| Precision           | {metrics['precision']:.4f} |   Report only |
| Recall              | {metrics['recall']:.4f} |   Report only |
| F1                  | {metrics['f1']:.4f} | At least {MINIMUM_F1:.2f} |
| False-positive rate | {metrics['falsePositiveRate']:.4f} |  At most {MAXIMUM_FALSE_POSITIVE_RATE:.2f} |

These values are reproducible outputs of `tools/ml/train_model.py`; they are not
claims about real aircraft, operational data, or flight safety.

## Intended use

- Demonstrate a learned baseline beside deterministic diagnostics.
- Rank unusual synthetic samples and explain channel residual contributions.
- Compare experimental anomaly indications with authoritative rule findings.

## Limitations

{chr(10).join(f'- {item}' for item in model['limitations'])}
"""
    card_path.write_text(card, encoding="utf-8", newline="\n")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(__file__).resolve().parents[2] / "models",
        help="Output directory for model, evaluation, and model card artifacts.",
    )
    parser.add_argument("--training-samples", type=int, default=1_500)
    parser.add_argument("--evaluation-samples", type=int, default=1_000)
    args = parser.parse_args()
    if args.training_samples < 100 or args.evaluation_samples < 100:
        parser.error("Sample counts must each be at least 100.")
    model = train_model(args.training_samples, args.evaluation_samples)
    write_artifacts(model, args.output)
    print(
        json.dumps(
            {
                "artifact": str(args.output / "robust_covariance_v1.json"),
                "metrics": model["evaluation"],
                "qualityGate": model["qualityGate"],
                "enabledByDefault": model["enabledByDefault"],
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
