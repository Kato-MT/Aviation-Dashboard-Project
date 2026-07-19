#!/usr/bin/env python3
"""Train and evaluate the compact temporal fault classifier.

The model uses deterministic causal convolution features at multiple dilations,
then learns standardized class prototypes from generated synthetic telemetry.
It is intentionally small enough for transparent TypeScript inference in the
offline browser build. Deterministic rules remain authoritative.
"""

from __future__ import annotations

import hashlib
import json
import math
import random
import statistics
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Sequence


ARTIFACT_VERSION = "temporal-fault-model.v1"
MODEL_VERSION = "1.0.0"
GENERATED_AT = "2026-07-17T00:00:00.000Z"
PROFILE_ID = "generic-fixed-wing"
PROFILE_VERSION = "1.0.0"
SCHEMA_VERSION = "telemetry.v1"
WINDOW_LENGTH = 40
CADENCE_MS = 1_000
CHANNELS = ("airspeed", "altitude", "verticalRate", "fuel", "vibration")
UNITS = {
    "airspeed": "kts",
    "altitude": "ft",
    "verticalRate": "ft/min",
    "fuel": "%",
    "vibration": "g",
}
FAULT_LABELS = (
    "gradual-drift",
    "noise-growth",
    "oscillation",
    "sensor-lag",
    "intermittent-dropout",
    "stuck-value",
    "gain-error",
    "fuel-leak",
    "cross-sensor-decoupling",
    "simultaneous-faults",
)
LABELS = ("nominal",) + FAULT_LABELS
TRAINING_SEEDS = tuple(range(1_101, 1_141))
CALIBRATION_SEEDS = tuple(range(2_101, 2_121))
HELD_OUT_SEEDS = tuple(range(3_101, 3_141))
MINIMUM_EPISODE_F1 = 0.80
MAXIMUM_FALSE_POSITIVE_RATE = 0.05
MINIMUM_CLASSIFICATION_MACRO_F1 = 0.65
MINIMUM_PER_FAULT_CLASSIFICATION_RECALL = 0.65
BASELINE_COMPARISON_VERSION = "temporal-baseline-comparison.v1"
GENERALIZATION_CHALLENGE_VERSION = "temporal-generalization-challenge.v1"
POST_HOC_CHALLENGE_SEEDS = tuple(range(4_101, 4_111))
CHALLENGE_MAGNITUDES = (
    ("low-outside-evaluation-range", 0.45),
    ("high-outside-evaluation-range", 1.60),
)
CHALLENGE_TEMPORAL_CONFIGURATIONS = (
    ("early-transient", 3, 7, "early-window"),
    ("middle-transient", 17, 6, "middle-window"),
    ("late-transient", 28, 7, "late-window"),
    ("late-persistent", 30, 10, "late-window"),
)
NOVEL_FAULT_COMBINATIONS = (
    ("drift-plus-noise", ("gradual-drift", "noise-growth")),
    ("oscillation-plus-fuel-leak", ("oscillation", "fuel-leak")),
    ("lag-plus-gain", ("sensor-lag", "gain-error")),
    (
        "dropout-plus-decoupling",
        ("intermittent-dropout", "cross-sensor-decoupling"),
    ),
    ("stuck-plus-fuel-leak", ("stuck-value", "fuel-leak")),
)
INVESTIGATION_COMPATIBLE_RULES = (
    "investigation.sensor.missing",
    "investigation.vibration.rolling-noise",
)
INVESTIGATION_EXCLUDED_RULES = {
    "investigation.fusion.innovation": (
        "requires the production fusion estimator and normalized innovations from redundant "
        "altitude and vertical-rate sensors"
    ),
    "investigation.redundancy.altitude-disagreement": (
        "requires separate barometricAltitude and gpsAltitude observations"
    ),
    "investigation.redundancy.speed-disagreement": (
        "requires separate indicatedAirspeed and gpsGroundSpeed observations"
    ),
    "investigation.redundancy.vertical-rate-disagreement": (
        "requires separate inertialVerticalRate and barometricVerticalRate observations"
    ),
    "investigation.sensor.stuck-barometric-altitude": (
        "requires separate barometricAltitude and gpsAltitude histories"
    ),
    "investigation.fuel.quantity-flow-relationship": (
        "requires fuelQuantity and fuelFlow while the compact model window contains fuel only"
    ),
}


@dataclass(frozen=True)
class WindowExample:
    seed: int
    label: str
    phase: str
    onset: int | None
    magnitude: float
    window: tuple[dict[str, float | None], ...]


@dataclass(frozen=True)
class ChallengeExample:
    seed: int
    challenge_id: str
    expected_labels: tuple[str, ...]
    phase: str
    onset: int | None
    active_duration: int
    magnitude: float
    window: tuple[dict[str, float | None], ...]


def _phase(seed: int) -> str:
    return ("takeoff", "climb", "cruise", "descent", "landing")[seed % 5]


def _nominal_window(seed: int) -> list[dict[str, float | None]]:
    rng = random.Random(seed)
    phase_offset = (seed % 17) * 23
    result: list[dict[str, float | None]] = []
    for index in range(WINDOW_LENGTH):
        time = phase_offset + index
        common = rng.gauss(0.0, 1.0)
        airspeed = 128 + 16 * math.sin(time / 61) + 1.6 * common + rng.gauss(0, 0.8)
        vertical_rate = 520 * math.cos(time / 54) + 22 * common + rng.gauss(0, 28)
        altitude = 5_800 + 1_520 * math.sin(time / 54) + 13 * common + rng.gauss(0, 18)
        fuel = 94 - 0.016 * time - 0.05 * common + rng.gauss(0, 0.035)
        vibration = 0.22 + 0.012 * math.sin(time / 5.5) + 0.004 * common + rng.gauss(0, 0.003)
        result.append(
            {
                "airspeed": airspeed,
                "altitude": altitude,
                "verticalRate": vertical_rate,
                "fuel": fuel,
                "vibration": vibration,
            }
        )
    return result


def generate_window(seed: int, label: str, split: str) -> WindowExample:
    if label not in LABELS:
        raise ValueError(f"Unsupported temporal label: {label}")
    if split not in {"training", "calibration", "held-out"}:
        raise ValueError(f"Unsupported split: {split}")
    window = _nominal_window(seed)
    onset = 10 + seed % 6
    held_out_scale = 0.72 + (seed % 9) * 0.075 if split == "held-out" else 1.0
    magnitude = held_out_scale
    if label == "nominal":
        return WindowExample(seed, label, _phase(seed), None, 0.0, tuple(window))

    rng = random.Random(seed ^ 0x7220)
    original = [dict(sample) for sample in window]
    for index in range(onset, WINDOW_LENGTH):
        progress = (index - onset + 1) / (WINDOW_LENGTH - onset)
        if label in {"gradual-drift", "simultaneous-faults"}:
            window[index]["airspeed"] = float(window[index]["airspeed"]) + 34 * magnitude * progress
        if label == "noise-growth":
            window[index]["vibration"] = float(window[index]["vibration"]) + rng.gauss(
                0, 0.07 * magnitude * progress
            )
        if label == "oscillation":
            window[index]["verticalRate"] = float(window[index]["verticalRate"]) + (
                1_250 * magnitude * math.sin((index - onset) * math.pi / 2)
            )
        if label == "sensor-lag":
            lag = max(6, round((12 + seed % 5) * magnitude))
            source = max(0, index - lag)
            window[index]["altitude"] = original[source]["altitude"]
        if label == "intermittent-dropout" and (index - onset) % (2 + seed % 2) == 0:
            window[index]["vibration"] = None
        if label == "stuck-value":
            window[index]["airspeed"] = window[onset - 1]["airspeed"]
        if label == "gain-error":
            window[index]["altitude"] = float(window[index]["altitude"]) * (1 + 0.10 * magnitude)
        if label in {"fuel-leak", "simultaneous-faults"}:
            window[index]["fuel"] = float(window[index]["fuel"]) - 0.21 * magnitude * (index - onset + 1)
        if label == "cross-sensor-decoupling":
            window[index]["verticalRate"] = -float(original[index]["verticalRate"]) + 130 * magnitude

    return WindowExample(seed, label, _phase(seed), onset, magnitude, tuple(window))


def _impute(values: Sequence[float | None]) -> tuple[list[float], float]:
    missing = sum(value is None or not math.isfinite(value) for value in values)
    first = next((float(value) for value in values if value is not None and math.isfinite(value)), 0.0)
    prior = first
    output: list[float] = []
    for value in values:
        if value is not None and math.isfinite(value):
            prior = float(value)
        output.append(prior)
    return output, missing / len(values)


def _rms(values: Iterable[float]) -> float:
    data = list(values)
    return math.sqrt(sum(value * value for value in data) / len(data)) if data else 0.0


def _correlation(left: Sequence[float], right: Sequence[float]) -> float:
    if len(left) != len(right) or len(left) < 2:
        return 0.0
    left_mean = statistics.fmean(left)
    right_mean = statistics.fmean(right)
    numerator = sum((a - left_mean) * (b - right_mean) for a, b in zip(left, right, strict=True))
    left_energy = sum((a - left_mean) ** 2 for a in left)
    right_energy = sum((b - right_mean) ** 2 for b in right)
    denominator = math.sqrt(left_energy * right_energy)
    return numerator / denominator if denominator > 1e-12 else 0.0


def feature_names() -> list[str]:
    names: list[str] = []
    for channel in CHANNELS:
        names.extend(
            f"{channel}.{suffix}"
            for suffix in (
                "mean",
                "std",
                "half-shift",
                "d1-rms",
                "d2-rms",
                "d4-rms",
                "curvature-rms",
                "freeze-ratio",
                "missing-fraction",
            )
        )
    names.extend(
        (
            "cross.altitude-vertical-rate-correlation",
            "cross.altitude-vertical-rate-best-lag",
            "cross.altitude-vertical-rate-lag-improvement",
            "cross.airspeed-altitude-correlation",
            "cross.fuel-slope",
            "cross.vibration-growth-ratio",
        )
    )
    return names


def extract_features(window: Sequence[dict[str, float | None]]) -> list[float]:
    if len(window) != WINDOW_LENGTH:
        raise ValueError(f"Expected exactly {WINDOW_LENGTH} temporal samples.")
    channel_values: dict[str, list[float]] = {}
    features: list[float] = []
    half = WINDOW_LENGTH // 2
    for channel in CHANNELS:
        values, missing_fraction = _impute([sample.get(channel) for sample in window])
        channel_values[channel] = values
        mean = statistics.fmean(values)
        std = statistics.pstdev(values)
        half_shift = statistics.fmean(values[half:]) - statistics.fmean(values[:half])
        d1 = [values[index] - values[index - 1] for index in range(1, len(values))]
        d2 = [values[index] - values[index - 2] for index in range(2, len(values))]
        d4 = [values[index] - values[index - 4] for index in range(4, len(values))]
        curvature = [
            values[index] - 2 * values[index - 1] + values[index - 2]
            for index in range(2, len(values))
        ]
        tolerance = max(abs(mean) * 1e-6, 1e-8)
        freeze_ratio = sum(abs(value) <= tolerance for value in d1) / len(d1)
        features.extend(
            (
                mean,
                std,
                half_shift,
                _rms(d1),
                _rms(d2),
                _rms(d4),
                _rms(curvature),
                freeze_ratio,
                missing_fraction,
            )
        )
    altitude = channel_values["altitude"]
    vertical_rate = channel_values["verticalRate"]
    airspeed = channel_values["airspeed"]
    fuel = channel_values["fuel"]
    vibration = channel_values["vibration"]
    first_vibration_std = statistics.pstdev(vibration[:half])
    second_vibration_std = statistics.pstdev(vibration[half:])
    altitude_changes = [altitude[index] - altitude[index - 1] for index in range(1, WINDOW_LENGTH)]
    vertical_rate_aligned = vertical_rate[1:]
    zero_lag_correlation = _correlation(altitude_changes, vertical_rate_aligned)
    lag_correlations: list[tuple[int, float]] = []
    for lag in range(-8, 9):
        if lag < 0:
            left = altitude_changes[-lag:]
            right = vertical_rate_aligned[: len(left)]
        elif lag > 0:
            left = altitude_changes[:-lag]
            right = vertical_rate_aligned[lag:]
        else:
            left = altitude_changes
            right = vertical_rate_aligned
        lag_correlations.append((lag, _correlation(left, right)))
    best_lag, best_lag_correlation = max(
        lag_correlations, key=lambda entry: (abs(entry[1]), -abs(entry[0]))
    )
    features.extend(
        (
            zero_lag_correlation,
            float(best_lag),
            abs(best_lag_correlation) - abs(zero_lag_correlation),
            _correlation(airspeed, altitude),
            (fuel[-1] - fuel[0]) / (WINDOW_LENGTH - 1),
            second_vibration_std / max(first_vibration_std, 1e-9),
        )
    )
    if not all(math.isfinite(value) for value in features):
        raise ValueError("Temporal feature extraction produced a nonfinite value.")
    return features


def _percentile(values: Sequence[float], probability: float) -> float:
    ordered = sorted(values)
    if not ordered:
        raise ValueError("Cannot calculate a percentile of an empty sequence.")
    position = (len(ordered) - 1) * probability
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    fraction = position - lower
    return ordered[lower] * (1 - fraction) + ordered[upper] * fraction


def _fit_standardizer(rows: Sequence[Sequence[float]]) -> tuple[list[float], list[float]]:
    columns = list(zip(*rows, strict=True))
    center = [statistics.fmean(column) for column in columns]
    scale = [max(statistics.pstdev(column), 1e-9) for column in columns]
    return center, scale


def _standardize(row: Sequence[float], center: Sequence[float], scale: Sequence[float]) -> list[float]:
    return [(value - origin) / width for value, origin, width in zip(row, center, scale, strict=True)]


def _centroid(rows: Sequence[Sequence[float]]) -> list[float]:
    return [statistics.fmean(column) for column in zip(*rows, strict=True)]


def _distance(left: Sequence[float], right: Sequence[float]) -> float:
    return sum((a - b) ** 2 for a, b in zip(left, right, strict=True)) / len(left)


def _softmax(values: Sequence[float]) -> list[float]:
    maximum = max(values)
    exponents = [math.exp(value - maximum) for value in values]
    total = sum(exponents)
    return [value / total for value in exponents]


def _predict(
    features: Sequence[float],
    center: Sequence[float],
    scale: Sequence[float],
    centroids: dict[str, Sequence[float]],
    radii: dict[str, float],
    confidence_threshold: float,
    temperature: float,
    anomaly_margin_threshold: float,
) -> dict[str, object]:
    standardized = _standardize(features, center, scale)
    distances = {label: _distance(standardized, centroids[label]) for label in LABELS}
    probabilities_list = _softmax([-distances[label] / temperature for label in LABELS])
    probabilities = dict(zip(LABELS, probabilities_list, strict=True))
    nearest = min(LABELS, key=lambda label: distances[label])
    confidence = probabilities[nearest]
    nearest_fault_distance = min(distances[label] for label in FAULT_LABELS)
    anomaly_margin = distances["nominal"] - nearest_fault_distance
    insufficient_fault_margin = nearest != "nominal" and anomaly_margin <= anomaly_margin_threshold
    abstained = (
        distances[nearest] > radii[nearest]
        or confidence < confidence_threshold
        or insufficient_fault_margin
    )
    predicted = "unknown" if abstained else nearest
    hypotheses = sorted(
        (
            {"faultType": label, "probability": probabilities[label], "distance": distances[label]}
            for label in FAULT_LABELS
        ),
        key=lambda entry: (-float(entry["probability"]), str(entry["faultType"])),
    )[:3]
    return {
        "predictedLabel": predicted,
        "nearestLabel": nearest,
        "confidence": confidence,
        "distance": distances[nearest],
        "anomalyMargin": anomaly_margin,
        "abstained": abstained,
        "anomalous": not abstained and nearest != "nominal",
        "probabilities": probabilities,
        "hypotheses": hypotheses,
    }


def _confusion(labels: Sequence[bool], predictions: Sequence[bool]) -> dict[str, float | int]:
    tp = sum(label and prediction for label, prediction in zip(labels, predictions, strict=True))
    fp = sum((not label) and prediction for label, prediction in zip(labels, predictions, strict=True))
    tn = sum((not label) and (not prediction) for label, prediction in zip(labels, predictions, strict=True))
    fn = sum(label and (not prediction) for label, prediction in zip(labels, predictions, strict=True))
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    fpr = fp / (fp + tn) if fp + tn else 0.0
    return {
        "truePositives": tp,
        "falsePositives": fp,
        "trueNegatives": tn,
        "falseNegatives": fn,
        "precision": precision,
        "recall": recall,
        "f1": f1,
        "falsePositiveRate": fpr,
    }


def _macro_f1(expected: Sequence[str], predicted: Sequence[str]) -> float:
    scores: list[float] = []
    for label in FAULT_LABELS:
        truth = [value == label for value in expected]
        guess = [value == label for value in predicted]
        scores.append(float(_confusion(truth, guess)["f1"]))
    return statistics.fmean(scores)


def _bootstrap_interval(
    labels: Sequence[bool], predictions: Sequence[bool], seed: int = 22_072, iterations: int = 300
) -> dict[str, float | int]:
    rng = random.Random(seed)
    values: list[float] = []
    for _ in range(iterations):
        indices = [rng.randrange(len(labels)) for _ in labels]
        metrics = _confusion([labels[index] for index in indices], [predictions[index] for index in indices])
        values.append(float(metrics["f1"]))
    return {
        "method": "deterministic-bootstrap",
        "seed": seed,
        "iterations": iterations,
        "lower95": _percentile(values, 0.025),
        "upper95": _percentile(values, 0.975),
    }


def _examples(seeds: Sequence[int], split: str) -> list[WindowExample]:
    return [generate_window(seed, label, split) for seed in seeds for label in LABELS]


def _fault_recall(
    examples: Sequence[WindowExample], predictions: Sequence[bool | None]
) -> dict[str, dict[str, float | int]]:
    by_fault: dict[str, dict[str, float | int]] = {}
    for label in FAULT_LABELS:
        selected = [
            prediction
            for example, prediction in zip(examples, predictions, strict=True)
            if example.label == label
        ]
        eligible = [prediction for prediction in selected if prediction is not None]
        detected = sum(prediction is True for prediction in eligible)
        by_fault[label] = {
            "episodes": len(selected),
            "eligibleEpisodes": len(eligible),
            "detected": detected,
            "detectionRecall": detected / len(eligible) if eligible else 0.0,
        }
    return by_fault


def _episode_metrics(
    examples: Sequence[WindowExample], predictions: Sequence[bool | None]
) -> tuple[dict[str, float | int], int]:
    eligible = [
        (example.label != "nominal", prediction)
        for example, prediction in zip(examples, predictions, strict=True)
        if prediction is not None
    ]
    labels = [label for label, _ in eligible]
    detected = [bool(prediction) for _, prediction in eligible]
    return _confusion(labels, detected), len(eligible)


def _linear_prediction_errors(window: Sequence[dict[str, float | None]]) -> list[list[float | None]]:
    errors: list[list[float | None]] = []
    for index in range(2, len(window)):
        row: list[float | None] = []
        for channel in CHANNELS:
            current = window[index].get(channel)
            previous = window[index - 1].get(channel)
            prior = window[index - 2].get(channel)
            if not all(
                value is not None and math.isfinite(value)
                for value in (current, previous, prior)
            ):
                row.append(None)
                continue
            predicted = 2 * float(previous) - float(prior)
            row.append(float(current) - predicted)
        errors.append(row)
    return errors


def _fit_linear_prediction_baseline(
    training_examples: Sequence[WindowExample], calibration_examples: Sequence[WindowExample]
) -> dict[str, object]:
    by_channel = [[] for _ in CHANNELS]
    for example in training_examples:
        for row in _linear_prediction_errors(example.window):
            for index, value in enumerate(row):
                if value is not None:
                    by_channel[index].append(value)
    centers = [statistics.median(values) for values in by_channel]
    scales: list[float] = []
    for values, center in zip(by_channel, centers, strict=True):
        mad = statistics.median(abs(value - center) for value in values)
        scales.append(max(mad * 1.4826, 1e-9))

    def episode_score(example: WindowExample, fault_only: bool) -> tuple[float | None, int]:
        start_index = example.onset if fault_only and example.onset is not None else 2
        scores: list[float] = []
        excluded = 0
        for sample_index, row in enumerate(_linear_prediction_errors(example.window), start=2):
            if sample_index < start_index:
                continue
            available = [
                abs(value - centers[index]) / scales[index]
                for index, value in enumerate(row)
                if value is not None
            ]
            if len(available) != len(CHANNELS):
                excluded += len(CHANNELS) - len(available)
            if available:
                scores.append(max(available))
        return (max(scores) if scores else None), excluded

    calibration_scores = [
        score
        for example in calibration_examples
        if (score := episode_score(example, False)[0]) is not None
    ]
    threshold = _percentile(calibration_scores, 0.99)
    return {
        "centers": centers,
        "scales": scales,
        "threshold": threshold,
        "score": episode_score,
        "calibrationEpisodeScores": len(calibration_scores),
    }


def _persistence_prediction_errors(
    window: Sequence[dict[str, float | None]],
) -> list[list[float | None]]:
    errors: list[list[float | None]] = []
    for index in range(1, len(window)):
        row: list[float | None] = []
        for channel in CHANNELS:
            current = window[index].get(channel)
            previous = window[index - 1].get(channel)
            if not all(
                value is not None and math.isfinite(value) for value in (current, previous)
            ):
                row.append(None)
                continue
            row.append(float(current) - float(previous))
        errors.append(row)
    return errors


def _fit_persistence_prediction_baseline(
    training_examples: Sequence[WindowExample], calibration_examples: Sequence[WindowExample]
) -> dict[str, object]:
    by_channel = [[] for _ in CHANNELS]
    for example in training_examples:
        for row in _persistence_prediction_errors(example.window):
            for index, value in enumerate(row):
                if value is not None:
                    by_channel[index].append(value)
    centers = [statistics.median(values) for values in by_channel]
    scales: list[float] = []
    for values, center in zip(by_channel, centers, strict=True):
        mad = statistics.median(abs(value - center) for value in values)
        scales.append(max(mad * 1.4826, 1e-9))

    def episode_score(example: WindowExample, fault_only: bool) -> tuple[float | None, int]:
        start_index = example.onset if fault_only and example.onset is not None else 1
        scores: list[float] = []
        excluded = 0
        for sample_index, row in enumerate(_persistence_prediction_errors(example.window), start=1):
            if sample_index < start_index:
                continue
            available = [
                abs(value - centers[index]) / scales[index]
                for index, value in enumerate(row)
                if value is not None
            ]
            if len(available) != len(CHANNELS):
                excluded += len(CHANNELS) - len(available)
            if available:
                scores.append(max(available))
        return (max(scores) if scores else None), excluded

    calibration_scores = [
        score
        for example in calibration_examples
        if (score := episode_score(example, False)[0]) is not None
    ]
    threshold = _percentile(calibration_scores, 0.99)
    return {
        "centers": centers,
        "scales": scales,
        "threshold": threshold,
        "score": episode_score,
        "calibrationEpisodeScores": len(calibration_scores),
    }


def _load_robust_covariance_artifact() -> tuple[dict[str, object], str]:
    path = Path(__file__).resolve().parents[2] / "models" / "robust_covariance_v1.json"
    raw = path.read_bytes()
    artifact = json.loads(raw)
    if artifact.get("artifactVersion") != "learned-baseline.v1":
        raise ValueError("Unsupported robust covariance artifact version for comparison.")
    if tuple(artifact.get("channels", ())) != CHANNELS:
        raise ValueError("Robust covariance channels do not match the temporal evaluation projection.")
    return artifact, hashlib.sha256(raw).hexdigest()


def _investigation_source_sha256() -> str:
    path = Path(__file__).resolve().parents[2] / "src" / "investigation" / "analyze.ts"
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _robust_covariance_score(
    sample: dict[str, float | None], artifact: dict[str, object]
) -> float | None:
    values = [sample.get(channel) for channel in CHANNELS]
    if not all(value is not None and math.isfinite(value) for value in values):
        return None
    center = artifact["center"]
    scale = artifact["scale"]
    inverse = artifact["inverseCovariance"]
    assert isinstance(center, list) and isinstance(scale, list) and isinstance(inverse, list)
    residual = [
        (float(value) - float(origin)) / float(width)
        for value, origin, width in zip(values, center, scale, strict=True)
    ]
    projected = [
        sum(float(weight) * value for weight, value in zip(row, residual, strict=True))
        for row in inverse
    ]
    return max(0.0, sum(value * projection for value, projection in zip(residual, projected, strict=True)))


def _evaluate_robust_covariance(
    examples: Sequence[WindowExample], artifact: dict[str, object]
) -> tuple[list[bool | None], int, int]:
    threshold = float(artifact["scoreThreshold"])
    predictions: list[bool | None] = []
    eligible_points = 0
    excluded_points = 0
    for example in examples:
        start = example.onset if example.onset is not None else 0
        scores: list[float] = []
        for sample in example.window[start:]:
            score = _robust_covariance_score(sample, artifact)
            if score is None:
                excluded_points += 1
            else:
                eligible_points += 1
                scores.append(score)
        predictions.append(None if not scores else any(score >= threshold for score in scores))
    return predictions, eligible_points, excluded_points


def _population_standard_deviation(values: Sequence[float]) -> float:
    return statistics.pstdev(values) if values else 0.0


def _evaluate_compatible_investigation_rules(
    examples: Sequence[WindowExample],
) -> tuple[list[bool | None], dict[str, int]]:
    predictions: list[bool | None] = []
    rule_counts = {rule_id: 0 for rule_id in INVESTIGATION_COMPATIBLE_RULES}
    for example in examples:
        onset = example.onset if example.onset is not None else 0
        detected = False
        for index, sample in enumerate(example.window):
            if index < onset:
                continue
            if any(sample.get(channel) is None for channel in CHANNELS):
                rule_counts["investigation.sensor.missing"] += 1
                detected = True
            if index >= 7:
                vibration = [
                    candidate.get("vibration") for candidate in example.window[index - 7 : index + 1]
                ]
                if all(value is not None and math.isfinite(value) for value in vibration):
                    noise = _population_standard_deviation([float(value) for value in vibration])
                    if noise > 0.025:
                        rule_counts["investigation.vibration.rolling-noise"] += 1
                        detected = True
        predictions.append(detected)
    return predictions, rule_counts


def _baseline_comparison(
    held_out_examples: Sequence[WindowExample],
    temporal_predictions: Sequence[dict[str, object]],
    temporal_metrics: dict[str, float | int],
) -> dict[str, object]:
    training_nominal = [generate_window(seed, "nominal", "training") for seed in TRAINING_SEEDS]
    calibration_nominal = [
        generate_window(seed, "nominal", "calibration") for seed in CALIBRATION_SEEDS
    ]

    persistence = _fit_persistence_prediction_baseline(training_nominal, calibration_nominal)
    persistence_predictions: list[bool | None] = []
    persistence_excluded_observations = 0
    persistence_score = persistence["score"]
    assert callable(persistence_score)
    for example in held_out_examples:
        score, excluded = persistence_score(example, example.onset is not None)
        persistence_excluded_observations += excluded
        persistence_predictions.append(
            None if score is None else float(score) >= float(persistence["threshold"])
        )
    persistence_metrics, persistence_eligible = _episode_metrics(
        held_out_examples, persistence_predictions
    )

    linear = _fit_linear_prediction_baseline(training_nominal, calibration_nominal)
    linear_predictions: list[bool | None] = []
    linear_excluded_observations = 0
    linear_score = linear["score"]
    assert callable(linear_score)
    for example in held_out_examples:
        score, excluded = linear_score(example, example.onset is not None)
        linear_excluded_observations += excluded
        linear_predictions.append(
            None if score is None else float(score) >= float(linear["threshold"])
        )
    linear_metrics, linear_eligible = _episode_metrics(held_out_examples, linear_predictions)

    robust_artifact, robust_hash = _load_robust_covariance_artifact()
    robust_predictions, robust_eligible_points, robust_excluded_points = (
        _evaluate_robust_covariance(held_out_examples, robust_artifact)
    )
    robust_metrics, robust_eligible = _episode_metrics(held_out_examples, robust_predictions)

    deterministic_predictions, rule_counts = _evaluate_compatible_investigation_rules(
        held_out_examples
    )
    deterministic_metrics, deterministic_eligible = _episode_metrics(
        held_out_examples, deterministic_predictions
    )

    temporal_binary = [bool(prediction["anomalous"]) for prediction in temporal_predictions]
    return {
        "schemaVersion": BASELINE_COMPARISON_VERSION,
        "evaluationPopulation": {
            "split": "held-out",
            "seeds": list(HELD_OUT_SEEDS),
            "labels": list(LABELS),
            "episodes": len(held_out_examples),
            "samplesPerEpisode": WINDOW_LENGTH,
            "cadenceMs": CADENCE_MS,
            "unseenMagnitudeRange": [0.72, 1.32],
            "episodeUnit": "one generated 40-sample window for one seed and one label",
        },
        "episodeDetectionDefinition": (
            "A fault episode is positive when the detector emits at least one eligible anomaly "
            "at or after the declared onset; a nominal episode is positive when it emits at "
            "least one anomaly anywhere in the window."
        ),
        "systems": {
            "temporalModel": {
                "status": "evaluated",
                "role": "candidate",
                "mapping": (
                    "The model emits one window-level anomaly decision. Unknown and abstained "
                    "outputs map to no detection."
                ),
                "eligibleEpisodes": len(held_out_examples),
                "excludedEpisodes": 0,
                "metrics": temporal_metrics,
                "byFault": _fault_recall(held_out_examples, temporal_binary),
            },
            "persistencePredictionBaseline": {
                "status": "evaluated",
                "method": "one-sample-persistence-max-standardized-residual",
                "mapping": (
                    "Each channel prediction is its prior observed value. The episode score is "
                    "the maximum absolute robust-standardized one-step residual in the eligible "
                    "evaluation interval."
                ),
                "trainingSeeds": list(TRAINING_SEEDS),
                "calibrationSeeds": list(CALIBRATION_SEEDS),
                "calibrationMethod": "99th percentile of nominal episode maximum scores",
                "parameters": {
                    "channels": list(CHANNELS),
                    "prediction": "value[t] = value[t-1]",
                    "residualCenter": dict(
                        zip(CHANNELS, persistence["centers"], strict=True)
                    ),
                    "residualScale": dict(
                        zip(CHANNELS, persistence["scales"], strict=True)
                    ),
                    "episodeAggregation": "maximum channel score across eligible samples",
                },
                "threshold": persistence["threshold"],
                "eligibleEpisodes": persistence_eligible,
                "excludedEpisodes": len(held_out_examples) - persistence_eligible,
                "excludedChannelObservations": persistence_excluded_observations,
                "metrics": persistence_metrics,
                "byFault": _fault_recall(held_out_examples, persistence_predictions),
                "limitations": [
                    "Persistence cannot model expected trend or periodic motion.",
                    "Missing channel values are excluded rather than treated as anomalies.",
                ],
            },
            "linearPredictionBaseline": {
                "status": "evaluated",
                "method": "two-sample-linear-extrapolation-max-standardized-residual",
                "mapping": (
                    "Each channel is predicted from its two prior samples. The episode score is "
                    "the maximum absolute robust-standardized one-step residual in the eligible "
                    "evaluation interval."
                ),
                "trainingSeeds": list(TRAINING_SEEDS),
                "calibrationSeeds": list(CALIBRATION_SEEDS),
                "calibrationMethod": "99th percentile of nominal episode maximum scores",
                "parameters": {
                    "channels": list(CHANNELS),
                    "prediction": "value[t] = 2 * value[t-1] - value[t-2]",
                    "residualCenter": dict(zip(CHANNELS, linear["centers"], strict=True)),
                    "residualScale": dict(zip(CHANNELS, linear["scales"], strict=True)),
                    "episodeAggregation": "maximum channel score across eligible samples",
                },
                "threshold": linear["threshold"],
                "eligibleEpisodes": linear_eligible,
                "excludedEpisodes": len(held_out_examples) - linear_eligible,
                "excludedChannelObservations": linear_excluded_observations,
                "metrics": linear_metrics,
                "byFault": _fault_recall(held_out_examples, linear_predictions),
                "limitations": [
                    "This simple predictor is not the production sensor-fusion estimator.",
                    "Missing channel values are excluded rather than treated as anomalies.",
                ],
            },
            "robustCovarianceDetector": {
                "status": "evaluated-with-transfer-limitations",
                "artifactVersion": robust_artifact["artifactVersion"],
                "modelVersion": robust_artifact["modelVersion"],
                "artifactSha256": robust_hash,
                "mapping": (
                    "The fixed pointwise artifact scores every complete sample at or after onset; "
                    "an episode is positive when any eligible score meets its checked-in threshold."
                ),
                "threshold": robust_artifact["scoreThreshold"],
                "recalibratedOnTemporalPopulation": False,
                "eligibleEpisodes": robust_eligible,
                "excludedEpisodes": len(held_out_examples) - robust_eligible,
                "eligiblePointObservations": robust_eligible_points,
                "excludedPointObservations": robust_excluded_points,
                "metrics": robust_metrics,
                "byFault": _fault_recall(held_out_examples, robust_predictions),
                "limitations": [
                    "The artifact was trained and calibrated on a different synthetic point distribution.",
                    "Episode-level any-point aggregation differs from its original point-level evaluation.",
                    "Incomplete samples cannot be scored and are excluded without imputation.",
                ],
            },
            "deterministicInvestigationRules": {
                "status": "partially-evaluated",
                "authority": "deterministic-rules",
                "implementationSource": "src/investigation/analyze.ts",
                "implementationSourceSha256": _investigation_source_sha256(),
                "mapping": (
                    "An episode is positive when either compatible observed-only rule emits at "
                    "or after onset. This is a partial rule-suite result, not a score for the full "
                    "production investigation engine."
                ),
                "compatibleRules": list(INVESTIGATION_COMPATIBLE_RULES),
                "compatibleRuleDefinitions": {
                    "investigation.sensor.missing": {
                        "condition": "any available projected channel is null",
                    },
                    "investigation.vibration.rolling-noise": {
                        "windowSamples": 8,
                        "statistic": "population-standard-deviation",
                        "threshold": 0.025,
                        "comparison": "greater-than",
                        "unit": "g",
                    },
                },
                "compatibleRuleIndications": rule_counts,
                "excludedRules": [
                    {"ruleId": rule_id, "reason": reason}
                    for rule_id, reason in INVESTIGATION_EXCLUDED_RULES.items()
                ],
                "eligibleEpisodes": deterministic_eligible,
                "excludedEpisodes": len(held_out_examples) - deterministic_eligible,
                "metrics": deterministic_metrics,
                "byFault": _fault_recall(held_out_examples, deterministic_predictions),
                "limitations": [
                    "Only two of eight current investigation rules are compatible with the compact five-channel windows.",
                    "The result cannot be used to rank the complete deterministic rule engine against either learned model.",
                ],
            },
        },
        "comparability": {
            "groundTruthUse": (
                "Fault labels and onset indices are used only to select the evaluation interval "
                "and score episode outcomes; detector inputs contain observations only."
            ),
            "directlyComparable": [
                "held-out seeds and magnitude distribution",
                "binary episode precision, recall, F1, and false-positive rate",
            ],
            "notDirectlyComparable": [
                "temporal fault classification, which only the temporal model provides",
                "original robust covariance point-level metrics from its separate evaluation distribution",
                "the six investigation rules excluded because required production signals are absent",
            ],
            "interpretation": (
                "Comparison metrics describe behavior on this declared synthetic projection only. "
                "They do not establish operational, aircraft, or safety performance."
            ),
        },
    }


def _generate_challenge_example(
    seed: int,
    challenge_id: str,
    fault_labels: Sequence[str],
    onset: int,
    active_duration: int,
    magnitude: float,
) -> ChallengeExample:
    if not fault_labels or any(label not in FAULT_LABELS for label in fault_labels):
        raise ValueError("Challenge faults must be declared temporal fault labels.")
    if onset < 1 or onset >= WINDOW_LENGTH:
        raise ValueError("Challenge onset must leave at least one prior sample in the window.")
    if active_duration < 1 or onset + active_duration > WINDOW_LENGTH:
        raise ValueError("Challenge active duration must fit inside the model window.")
    if magnitude <= 0 or not math.isfinite(magnitude):
        raise ValueError("Challenge magnitude must be finite and positive.")

    original = _nominal_window(seed)
    window = [dict(sample) for sample in original]
    effects = tuple(
        effect
        for label in fault_labels
        for effect in (
            ("gradual-drift", "fuel-leak") if label == "simultaneous-faults" else (label,)
        )
    )
    rng = random.Random(seed ^ 0x7220)
    active_end = onset + active_duration
    for index in range(onset, active_end):
        progress = (index - onset + 1) / active_duration
        for effect in effects:
            if effect == "gradual-drift":
                window[index]["airspeed"] = (
                    float(window[index]["airspeed"]) + 34 * magnitude * progress
                )
            elif effect == "noise-growth":
                window[index]["vibration"] = float(window[index]["vibration"]) + rng.gauss(
                    0, 0.07 * magnitude * progress
                )
            elif effect == "oscillation":
                window[index]["verticalRate"] = float(window[index]["verticalRate"]) + (
                    1_250 * magnitude * math.sin((index - onset) * math.pi / 2)
                )
            elif effect == "sensor-lag":
                lag = max(6, round((12 + seed % 5) * magnitude))
                window[index]["altitude"] = original[max(0, index - lag)]["altitude"]
            elif effect == "intermittent-dropout" and (index - onset) % (2 + seed % 2) == 0:
                window[index]["vibration"] = None
            elif effect == "stuck-value":
                window[index]["airspeed"] = window[onset - 1]["airspeed"]
            elif effect == "gain-error":
                window[index]["altitude"] = float(window[index]["altitude"]) * (
                    1 + 0.10 * magnitude
                )
            elif effect == "fuel-leak":
                window[index]["fuel"] = (
                    float(window[index]["fuel"])
                    - 0.21 * magnitude * (index - onset + 1)
                )
            elif effect == "cross-sensor-decoupling":
                window[index]["verticalRate"] = (
                    -float(original[index]["verticalRate"]) + 130 * magnitude
                )
    return ChallengeExample(
        seed=seed,
        challenge_id=challenge_id,
        expected_labels=tuple(fault_labels),
        phase=_phase(seed),
        onset=onset,
        active_duration=active_duration,
        magnitude=magnitude,
        window=tuple(window),
    )


def _generate_challenge_nominal(seed: int) -> ChallengeExample:
    return ChallengeExample(
        seed=seed,
        challenge_id="nominal-control",
        expected_labels=(),
        phase=_phase(seed),
        onset=None,
        active_duration=0,
        magnitude=0.0,
        window=tuple(_nominal_window(seed)),
    )


def _challenge_known_summary(
    nominal_examples: Sequence[ChallengeExample],
    fault_examples: Sequence[ChallengeExample],
    predict_window: object,
) -> dict[str, object]:
    assert callable(predict_window)
    examples = [*nominal_examples, *fault_examples]
    predictions = [predict_window(example.window) for example in examples]
    expected_fault = [bool(example.expected_labels) for example in examples]
    predicted_fault = [bool(prediction["anomalous"]) for prediction in predictions]
    fault_predictions = predictions[len(nominal_examples) :]
    expected_classes = [example.expected_labels[0] for example in fault_examples]
    predicted_classes = [str(prediction["predictedLabel"]) for prediction in fault_predictions]

    def grouped_summary(selected_indices: Sequence[int]) -> dict[str, float | int]:
        selected = [(fault_examples[index], fault_predictions[index]) for index in selected_indices]
        detected = sum(bool(prediction["anomalous"]) for _, prediction in selected)
        classified = sum(
            prediction["predictedLabel"] == example.expected_labels[0]
            for example, prediction in selected
        )
        abstained = sum(bool(prediction["abstained"]) for _, prediction in selected)
        count = len(selected)
        return {
            "episodes": count,
            "detected": detected,
            "detectionRecall": detected / count if count else 0.0,
            "correctlyClassified": classified,
            "classificationRecall": classified / count if count else 0.0,
            "abstained": abstained,
            "abstentionRate": abstained / count if count else 0.0,
        }

    configuration_ids = sorted({example.challenge_id for example in fault_examples})
    phase_ids = sorted({example.phase for example in fault_examples})
    return {
        "population": {
            "nominalEpisodes": len(nominal_examples),
            "faultEpisodes": len(fault_examples),
            "totalEpisodes": len(examples),
        },
        "episodeMetrics": _confusion(expected_fault, predicted_fault),
        "classificationMacroF1": _macro_f1(expected_classes, predicted_classes),
        "abstentionRate": sum(bool(prediction["abstained"]) for prediction in predictions)
        / len(predictions),
        "faultEpisodeAbstentionRate": sum(
            bool(prediction["abstained"]) for prediction in fault_predictions
        )
        / len(fault_predictions),
        "byConfiguration": {
            configuration_id: grouped_summary(
                [
                    index
                    for index, example in enumerate(fault_examples)
                    if example.challenge_id == configuration_id
                ]
            )
            for configuration_id in configuration_ids
        },
        "byFault": {
            label: grouped_summary(
                [
                    index
                    for index, example in enumerate(fault_examples)
                    if example.expected_labels == (label,)
                ]
            )
            for label in FAULT_LABELS
        },
        "bySyntheticPhase": {
            phase: grouped_summary(
                [
                    index
                    for index, example in enumerate(fault_examples)
                    if example.phase == phase
                ]
            )
            for phase in phase_ids
        },
    }


def _challenge_combination_summary(
    nominal_examples: Sequence[ChallengeExample],
    fault_examples: Sequence[ChallengeExample],
    predict_window: object,
) -> dict[str, object]:
    assert callable(predict_window)
    examples = [*nominal_examples, *fault_examples]
    predictions = [predict_window(example.window) for example in examples]
    expected_fault = [bool(example.expected_labels) for example in examples]
    predicted_fault = [bool(prediction["anomalous"]) for prediction in predictions]
    fault_predictions = predictions[len(nominal_examples) :]

    def grouped_summary(selected_indices: Sequence[int]) -> dict[str, float | int]:
        selected = [(fault_examples[index], fault_predictions[index]) for index in selected_indices]
        count = len(selected)
        detected = sum(bool(prediction["anomalous"]) for _, prediction in selected)
        abstained = sum(bool(prediction["abstained"]) for _, prediction in selected)
        top_one_component = sum(
            str(prediction["predictedLabel"]) in example.expected_labels
            for example, prediction in selected
        )
        top_three_component = sum(
            any(
                str(hypothesis["faultType"]) in example.expected_labels
                for hypothesis in prediction["hypotheses"]
            )
            for example, prediction in selected
        )
        return {
            "episodes": count,
            "detected": detected,
            "detectionRecall": detected / count if count else 0.0,
            "abstained": abstained,
            "abstentionRate": abstained / count if count else 0.0,
            "topOneComponentHypothesis": top_one_component,
            "topOneComponentRate": top_one_component / count if count else 0.0,
            "topThreeContainsComponent": top_three_component,
            "topThreeComponentCoverage": top_three_component / count if count else 0.0,
        }

    combination_ids = sorted({example.challenge_id for example in fault_examples})
    predicted_distribution: dict[str, int] = {}
    for prediction in fault_predictions:
        label = str(prediction["predictedLabel"])
        predicted_distribution[label] = predicted_distribution.get(label, 0) + 1
    all_fault_indices = list(range(len(fault_examples)))
    return {
        "population": {
            "nominalEpisodes": len(nominal_examples),
            "faultEpisodes": len(fault_examples),
            "totalEpisodes": len(examples),
        },
        "episodeMetrics": _confusion(expected_fault, predicted_fault),
        "classificationMetric": "not-scored-no-declared-combination-class",
        "componentHypothesisSummary": grouped_summary(all_fault_indices),
        "predictedLabelDistribution": predicted_distribution,
        "byCombination": {
            combination_id: grouped_summary(
                [
                    index
                    for index, example in enumerate(fault_examples)
                    if example.challenge_id == combination_id
                ]
            )
            for combination_id in combination_ids
        },
    }


def _post_hoc_generalization_challenge(
    center: Sequence[float],
    scale: Sequence[float],
    centroids: dict[str, Sequence[float]],
    radii: dict[str, float],
    confidence_threshold: float,
    temperature: float,
    anomaly_margin_threshold: float,
    configuration_sha256: str,
    artifact_sha256: str,
) -> dict[str, object]:
    def predict_window(window: Sequence[dict[str, float | None]]) -> dict[str, object]:
        return _predict(
            extract_features(window),
            center,
            scale,
            centroids,
            radii,
            confidence_threshold,
            temperature,
            anomaly_margin_threshold,
        )

    nominal_examples = [_generate_challenge_nominal(seed) for seed in POST_HOC_CHALLENGE_SEEDS]
    magnitude_examples = [
        _generate_challenge_example(
            seed,
            challenge_id,
            (label,),
            10 + seed % 6,
            WINDOW_LENGTH - (10 + seed % 6),
            magnitude,
        )
        for challenge_id, magnitude in CHALLENGE_MAGNITUDES
        for seed in POST_HOC_CHALLENGE_SEEDS
        for label in FAULT_LABELS
    ]
    temporal_examples = [
        _generate_challenge_example(
            seed,
            challenge_id,
            (label,),
            onset,
            active_duration,
            1.0,
        )
        for challenge_id, onset, active_duration, _ in CHALLENGE_TEMPORAL_CONFIGURATIONS
        for seed in POST_HOC_CHALLENGE_SEEDS
        for label in FAULT_LABELS
    ]
    combination_examples = [
        _generate_challenge_example(
            seed,
            challenge_id,
            labels,
            10 + seed % 6,
            WINDOW_LENGTH - (10 + seed % 6),
            1.0,
        )
        for challenge_id, labels in NOVEL_FAULT_COMBINATIONS
        for seed in POST_HOC_CHALLENGE_SEEDS
    ]

    return {
        "schemaVersion": GENERALIZATION_CHALLENGE_VERSION,
        "status": "post-hoc-non-gating",
        "releaseGate": {
            "included": False,
            "reason": (
                "The challenge was designed after the primary held-out gate and has no "
                "pre-registered acceptance threshold. Results are evidence and limitations only."
            ),
        },
        "heldOutSeeds": list(POST_HOC_CHALLENGE_SEEDS),
        "seedPartition": {
            "disjointFromTraining": not bool(set(POST_HOC_CHALLENGE_SEEDS) & set(TRAINING_SEEDS)),
            "disjointFromCalibration": not bool(
                set(POST_HOC_CHALLENGE_SEEDS) & set(CALIBRATION_SEEDS)
            ),
            "disjointFromPrimaryHeldOut": not bool(
                set(POST_HOC_CHALLENGE_SEEDS) & set(HELD_OUT_SEEDS)
            ),
        },
        "frozenInference": {
            "artifactVersion": ARTIFACT_VERSION,
            "modelVersion": MODEL_VERSION,
            "artifactSha256": artifact_sha256,
            "configurationSha256": configuration_sha256,
            "confidenceThreshold": confidence_threshold,
            "temperature": temperature,
            "anomalyMarginThreshold": anomaly_margin_threshold,
            "fitOrCalibrationOnChallenge": False,
            "inferenceInputs": list(CHANNELS),
        },
        "groundTruthUse": (
            "Fault labels, magnitude, onset, duration, and combination membership are retained "
            "outside inference and used only to construct synthetic observations and score results. "
            "The frozen predictor receives the five observed channels only."
        ),
        "dimensions": {
            "unseenMagnitude": {
                "primaryHeldOutMagnitudeRange": [0.72, 1.32],
                "configurations": [
                    {"challengeId": challenge_id, "magnitude": magnitude}
                    for challenge_id, magnitude in CHALLENGE_MAGNITUDES
                ],
                "results": _challenge_known_summary(
                    nominal_examples, magnitude_examples, predict_window
                ),
            },
            "activeDurationAndOnsetPhase": {
                "trainingOnsetRange": [10, 15],
                "trainingActiveDurationRange": [25, 30],
                "configurations": [
                    {
                        "challengeId": challenge_id,
                        "onsetSample": onset,
                        "activeDurationSamples": active_duration,
                        "activeEndSample": onset + active_duration - 1,
                        "recoverySamples": WINDOW_LENGTH - onset - active_duration,
                        "onsetPhase": onset_phase,
                        "magnitude": 1.0,
                    }
                    for challenge_id, onset, active_duration, onset_phase in CHALLENGE_TEMPORAL_CONFIGURATIONS
                ],
                "syntheticPhaseLabels": sorted({_phase(seed) for seed in POST_HOC_CHALLENGE_SEEDS}),
                "results": _challenge_known_summary(
                    nominal_examples, temporal_examples, predict_window
                ),
            },
            "novelFaultCombinations": {
                "knownTrainingCombination": {
                    "label": "simultaneous-faults",
                    "components": ["gradual-drift", "fuel-leak"],
                },
                "configurations": [
                    {"challengeId": challenge_id, "components": list(labels)}
                    for challenge_id, labels in NOVEL_FAULT_COMBINATIONS
                ],
                "onsetRule": "10 + seed modulo 6",
                "activeDurationRule": "40 - onset",
                "magnitude": 1.0,
                "results": _challenge_combination_summary(
                    nominal_examples, combination_examples, predict_window
                ),
            },
        },
        "limitations": [
            "All challenge telemetry is generated, synthetic, and unclassified.",
            "Challenge configurations were selected post hoc and are not an independent release gate.",
            "Each dimension uses ten seeds, with two seeds for each synthetic phase label.",
            "Onset phase describes location within the 40-sample window; phase labels are generator metadata, not a flight-dynamics simulation.",
            "Novel combinations compose known synthetic effects and do not represent previously unseen physical fault mechanisms.",
            "Exact classification is undefined for novel combinations because the model has no matching combination classes.",
        ],
    }


def train_temporal_model() -> tuple[dict[str, object], dict[str, object], dict[str, object]]:
    training_examples = _examples(TRAINING_SEEDS, "training")
    training_features = [extract_features(example.window) for example in training_examples]
    center, scale = _fit_standardizer(training_features)
    standardized_training = [_standardize(row, center, scale) for row in training_features]
    centroids = {
        label: _centroid(
            [
                row
                for row, example in zip(standardized_training, training_examples, strict=True)
                if example.label == label
            ]
        )
        for label in LABELS
    }

    calibration_examples = _examples(CALIBRATION_SEEDS, "calibration")
    calibration_features = [extract_features(example.window) for example in calibration_examples]
    class_distances: dict[str, list[float]] = {label: [] for label in LABELS}
    calibration_confidences: list[float] = []
    nominal_margins: list[float] = []
    temperature = 0.35
    provisional_radii = {label: float("inf") for label in LABELS}
    for example, features in zip(calibration_examples, calibration_features, strict=True):
        standardized = _standardize(features, center, scale)
        class_distances[example.label].append(_distance(standardized, centroids[example.label]))
        prediction = _predict(
            features, center, scale, centroids, provisional_radii, 0.0, temperature, float("-inf")
        )
        if example.label == "nominal":
            nominal_margins.append(float(prediction["anomalyMargin"]))
        if prediction["nearestLabel"] == example.label:
            calibration_confidences.append(float(prediction["confidence"]))
    radii = {
        label: max(_percentile(values, 0.99) * 1.8, 0.05)
        for label, values in class_distances.items()
    }
    confidence_threshold = max(0.12, _percentile(calibration_confidences, 0.02) * 0.75)
    anomaly_margin_threshold = max(0.0, _percentile(nominal_margins, 0.99))

    held_out_examples = _examples(HELD_OUT_SEEDS, "held-out")
    predictions = [
        _predict(
            extract_features(example.window),
            center,
            scale,
            centroids,
            radii,
            confidence_threshold,
            temperature,
            anomaly_margin_threshold,
        )
        for example in held_out_examples
    ]
    expected_fault = [example.label != "nominal" for example in held_out_examples]
    predicted_fault = [bool(prediction["anomalous"]) for prediction in predictions]
    episode_metrics = _confusion(expected_fault, predicted_fault)
    expected_classes = [example.label for example in held_out_examples if example.label != "nominal"]
    predicted_classes = [
        str(prediction["predictedLabel"])
        for example, prediction in zip(held_out_examples, predictions, strict=True)
        if example.label != "nominal"
    ]
    macro_f1 = _macro_f1(expected_classes, predicted_classes)
    by_fault: dict[str, dict[str, float | int]] = {}
    for label in FAULT_LABELS:
        selected = [
            prediction
            for example, prediction in zip(held_out_examples, predictions, strict=True)
            if example.label == label
        ]
        detected = sum(bool(prediction["anomalous"]) for prediction in selected)
        classified = sum(prediction["predictedLabel"] == label for prediction in selected)
        abstained = sum(bool(prediction["abstained"]) for prediction in selected)
        by_fault[label] = {
            "episodes": len(selected),
            "detected": detected,
            "detectionRecall": detected / len(selected),
            "correctlyClassified": classified,
            "classificationRecall": classified / len(selected),
            "abstained": abstained,
        }
    abstention_rate = sum(bool(prediction["abstained"]) for prediction in predictions) / len(predictions)
    minimum_per_fault_recall = min(float(result["classificationRecall"]) for result in by_fault.values())
    quality_passed = (
        float(episode_metrics["f1"]) >= MINIMUM_EPISODE_F1
        and float(episode_metrics["falsePositiveRate"]) <= MAXIMUM_FALSE_POSITIVE_RATE
        and macro_f1 >= MINIMUM_CLASSIFICATION_MACRO_F1
        and minimum_per_fault_recall >= MINIMUM_PER_FAULT_CLASSIFICATION_RECALL
    )
    config = {
        "profileId": PROFILE_ID,
        "profileVersion": PROFILE_VERSION,
        "schemaVersion": SCHEMA_VERSION,
        "windowLength": WINDOW_LENGTH,
        "cadenceMs": CADENCE_MS,
        "channels": CHANNELS,
        "units": UNITS,
        "featureEncoder": "causal-convolution-dilations-1-2-4",
        "classifier": "standardized-nearest-centroid",
    }
    config_hash = hashlib.sha256(
        json.dumps(config, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    artifact: dict[str, object] = {
        "artifactVersion": ARTIFACT_VERSION,
        "modelVersion": MODEL_VERSION,
        "modelType": "causal-dilated-convolution-nearest-centroid",
        "generatedAt": GENERATED_AT,
        "syntheticDataOnly": True,
        "enabledByDefault": quality_passed,
        "schemaVersion": SCHEMA_VERSION,
        "profile": {"id": PROFILE_ID, "version": PROFILE_VERSION},
        "windowLength": WINDOW_LENGTH,
        "cadenceMs": CADENCE_MS,
        "channels": list(CHANNELS),
        "units": UNITS,
        "featureNames": feature_names(),
        "featureCenter": center,
        "featureScale": scale,
        "classCentroids": centroids,
        "classRadii": radii,
        "temperature": temperature,
        "confidenceThreshold": confidence_threshold,
        "anomalyMarginThreshold": anomaly_margin_threshold,
        "training": {
            "seeds": list(TRAINING_SEEDS),
            "examples": len(training_examples),
            "configurationSha256": config_hash,
        },
        "calibration": {
            "seeds": list(CALIBRATION_SEEDS),
            "examples": len(calibration_examples),
            "method": "class-distance-99th-percentile-and-confidence-floor",
        },
        "evaluation": {
            "seeds": list(HELD_OUT_SEEDS),
            "examples": len(held_out_examples),
            "unseenMagnitudeRange": [0.72, 1.32],
            "episodeMetrics": episode_metrics,
            "classificationMacroF1": macro_f1,
            "abstentionRate": abstention_rate,
            "byFault": by_fault,
            "f1ConfidenceInterval": _bootstrap_interval(expected_fault, predicted_fault),
        },
        "qualityGate": {
            "minimumEpisodeF1": MINIMUM_EPISODE_F1,
            "maximumFalsePositiveRate": MAXIMUM_FALSE_POSITIVE_RATE,
            "minimumClassificationMacroF1": MINIMUM_CLASSIFICATION_MACRO_F1,
            "minimumPerFaultClassificationRecall": MINIMUM_PER_FAULT_CLASSIFICATION_RECALL,
            "observedMinimumPerFaultClassificationRecall": minimum_per_fault_recall,
            "passed": quality_passed,
        },
        "limitations": [
            "Trained and evaluated only on generated synthetic telemetry.",
            "Ranks declared synthetic fault hypotheses and does not establish cause.",
            "Unknown or unsupported inputs must produce an abstention.",
            "Deterministic rules remain authoritative for verification status.",
            "The compact convolution encoder is not intended for real-world flight or safety use.",
        ],
    }
    baseline_comparison = _baseline_comparison(
        held_out_examples,
        predictions,
        episode_metrics,
    )
    artifact_sha256 = hashlib.sha256(
        (json.dumps(_rounded(artifact), indent=2, sort_keys=True) + "\n").encode("utf-8")
    ).hexdigest()
    generalization_challenge = _post_hoc_generalization_challenge(
        center,
        scale,
        centroids,
        radii,
        confidence_threshold,
        temperature,
        anomaly_margin_threshold,
        config_hash,
        artifact_sha256,
    )
    evaluation = {
        "artifactVersion": ARTIFACT_VERSION,
        "modelVersion": MODEL_VERSION,
        "generatedAt": GENERATED_AT,
        "evaluation": artifact["evaluation"],
        "baselineComparison": baseline_comparison,
        "postHocGeneralizationChallenge": generalization_challenge,
        "qualityGate": artifact["qualityGate"],
        "enabledByDefault": quality_passed,
    }
    def parity_case(case_id: str, example: WindowExample) -> dict[str, object]:
        prediction = _predict(
            extract_features(example.window),
            center,
            scale,
            centroids,
            radii,
            confidence_threshold,
            temperature,
            anomaly_margin_threshold,
        )
        return {
            "caseId": case_id,
            "window": example.window,
            "expected": {
                "predictedLabel": prediction["predictedLabel"],
                "nearestLabel": prediction["nearestLabel"],
                "confidence": prediction["confidence"],
                "distance": prediction["distance"],
            },
        }

    unknown_case = parity_case(
        "unknown-oscillation", generate_window(4_221, "oscillation", "held-out")
    )
    nominal_case = next(
        parity_case(f"nominal-{seed}", generate_window(seed, "nominal", "held-out"))
        for seed in HELD_OUT_SEEDS
        if parity_case("candidate", generate_window(seed, "nominal", "held-out"))["expected"][
            "predictedLabel"
        ]
        == "nominal"
    )
    detected_case = next(
        parity_case(f"oscillation-{seed}", generate_window(seed, "oscillation", "held-out"))
        for seed in HELD_OUT_SEEDS
        if parity_case("candidate", generate_window(seed, "oscillation", "held-out"))["expected"][
            "predictedLabel"
        ]
        == "oscillation"
    )
    parity = {
        "artifactVersion": ARTIFACT_VERSION,
        "absoluteTolerance": 1e-9,
        "window": unknown_case["window"],
        "expected": unknown_case["expected"],
        "cases": [unknown_case, nominal_case, detected_case],
    }
    return artifact, evaluation, parity


def _rounded(value: object) -> object:
    if isinstance(value, float):
        return round(value, 12)
    if isinstance(value, list):
        return [_rounded(item) for item in value]
    if isinstance(value, tuple):
        return [_rounded(item) for item in value]
    if isinstance(value, dict):
        return {key: _rounded(item) for key, item in value.items()}
    return value


def write_temporal_artifacts(output: Path) -> tuple[dict[str, object], dict[str, object], dict[str, object]]:
    artifact, evaluation, parity = train_temporal_model()
    output.mkdir(parents=True, exist_ok=True)
    documents = {
        "temporal_fault_model_v1.json": _rounded(artifact),
        "temporal_evaluation_v1.json": _rounded(evaluation),
        "temporal_inference_parity_v1.json": _rounded(parity),
    }
    for name, document in documents.items():
        (output / name).write_text(
            json.dumps(document, indent=2, sort_keys=True) + "\n", encoding="utf-8", newline="\n"
        )
    metrics = artifact["evaluation"]["episodeMetrics"]
    quality = artifact["qualityGate"]
    by_fault = artifact["evaluation"]["byFault"]
    rows = "\n".join(
        f"| {label} | {values['detectionRecall']:.3f} | {values['classificationRecall']:.3f} | {values['abstained']} |"
        for label, values in by_fault.items()
    )
    comparison = evaluation["baselineComparison"]
    assert isinstance(comparison, dict)
    comparison_systems = comparison["systems"]
    assert isinstance(comparison_systems, dict)
    comparison_labels = {
        "temporalModel": "Temporal model",
        "persistencePredictionBaseline": "Persistence prediction baseline",
        "linearPredictionBaseline": "Linear prediction baseline",
        "robustCovarianceDetector": "Robust covariance detector",
        "deterministicInvestigationRules": "Deterministic investigation rules",
    }
    comparison_rows = "\n".join(
        (
            f"| {comparison_labels[key]} | {system['status']} | "
            f"{system['metrics']['precision']:.4f} | {system['metrics']['recall']:.4f} | "
            f"{system['metrics']['f1']:.4f} | {system['metrics']['falsePositiveRate']:.4f} | "
            f"{system['eligibleEpisodes']} |"
        )
        for key, system in comparison_systems.items()
    )
    deterministic_comparison = comparison_systems["deterministicInvestigationRules"]
    robust_comparison = comparison_systems["robustCovarianceDetector"]
    challenge = evaluation["postHocGeneralizationChallenge"]
    assert isinstance(challenge, dict)
    challenge_dimensions = challenge["dimensions"]
    assert isinstance(challenge_dimensions, dict)
    magnitude_dimension = challenge_dimensions["unseenMagnitude"]
    temporal_dimension = challenge_dimensions["activeDurationAndOnsetPhase"]
    combination_dimension = challenge_dimensions["novelFaultCombinations"]
    magnitude_results = magnitude_dimension["results"]
    temporal_results = temporal_dimension["results"]
    combination_results = combination_dimension["results"]
    combination_components = combination_results["componentHypothesisSummary"]
    challenge_rows = "\n".join(
        (
            f"| {label} | {results['population']['totalEpisodes']} | "
            f"{results['episodeMetrics']['precision']:.4f} | "
            f"{results['episodeMetrics']['recall']:.4f} | "
            f"{results['episodeMetrics']['f1']:.4f} | "
            f"{results['episodeMetrics']['falsePositiveRate']:.4f} | "
            f"{classification} | {abstention:.4f} |"
        )
        for label, results, classification, abstention in (
            (
                "Magnitude outside primary range",
                magnitude_results,
                f"{magnitude_results['classificationMacroF1']:.4f}",
                magnitude_results["faultEpisodeAbstentionRate"],
            ),
            (
                "Onset placement and active duration",
                temporal_results,
                f"{temporal_results['classificationMacroF1']:.4f}",
                temporal_results["faultEpisodeAbstentionRate"],
            ),
            (
                "Novel fault combinations",
                combination_results,
                "not defined",
                combination_components["abstentionRate"],
            ),
        )
    )
    magnitude_configuration_text = ", ".join(
        f"{entry['challengeId']}={entry['magnitude']:.2f}"
        for entry in magnitude_dimension["configurations"]
    )
    temporal_configuration_text = "; ".join(
        (
            f"{entry['challengeId']}: onset {entry['onsetSample']}, duration "
            f"{entry['activeDurationSamples']}, recovery {entry['recoverySamples']}"
        )
        for entry in temporal_dimension["configurations"]
    )
    combination_configuration_text = "; ".join(
        f"{entry['challengeId']}: {' + '.join(entry['components'])}"
        for entry in combination_dimension["configurations"]
    )
    card = f"""# Temporal Fault Model Card

## Summary

This experimental model combines a compact causal convolution feature encoder
at dilations 1, 2, and 4 with a learned standardized nearest-centroid
classifier. It evaluates 40-sample windows from the generic fixed-wing
synthetic profile, ranks declared synthetic fault hypotheses, and abstains when
confidence or class distance is unsupported. Deterministic rules remain
authoritative.

## Identity and compatibility

- Artifact: `{ARTIFACT_VERSION}`
- Model version: `{MODEL_VERSION}`
- Model type: `causal-dilated-convolution-nearest-centroid`
- Profile: `{PROFILE_ID}` version `{PROFILE_VERSION}`
- Schema: `{SCHEMA_VERSION}`
- Window: `{WINDOW_LENGTH}` samples at `{CADENCE_MS}` ms cadence
- Channels: `{', '.join(CHANNELS)}`
- Training seeds: `{TRAINING_SEEDS[0]}` through `{TRAINING_SEEDS[-1]}`
- Calibration seeds: `{CALIBRATION_SEEDS[0]}` through `{CALIBRATION_SEEDS[-1]}`
- Held-out seeds: `{HELD_OUT_SEEDS[0]}` through `{HELD_OUT_SEEDS[-1]}`
- Default eligible: **{'yes' if artifact['enabledByDefault'] else 'no'}**

## Held-out synthetic evaluation

| Metric | Measured | Gate |
| --- | ---: | ---: |
| Episode precision | {metrics['precision']:.4f} | Report only |
| Episode recall | {metrics['recall']:.4f} | Report only |
| Episode F1 | {metrics['f1']:.4f} | At least {MINIMUM_EPISODE_F1:.2f} |
| False-positive rate | {metrics['falsePositiveRate']:.4f} | At most {MAXIMUM_FALSE_POSITIVE_RATE:.2f} |
| Classification macro F1 | {artifact['evaluation']['classificationMacroF1']:.4f} | At least {MINIMUM_CLASSIFICATION_MACRO_F1:.2f} |
| Minimum per-fault classification recall | {quality['observedMinimumPerFaultClassificationRecall']:.4f} | At least {MINIMUM_PER_FAULT_CLASSIFICATION_RECALL:.2f} |
| Abstention rate | {artifact['evaluation']['abstentionRate']:.4f} | Report only |

The deterministic bootstrap 95 percent interval for episode F1 is
`{artifact['evaluation']['f1ConfidenceInterval']['lower95']:.4f}` to
`{artifact['evaluation']['f1ConfidenceInterval']['upper95']:.4f}`.

| Synthetic fault | Detection recall | Classification recall | Abstained episodes |
| --- | ---: | ---: | ---: |
{rows}

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
{comparison_rows}

This is not a fully symmetric benchmark. The persistence predictor uses the
prior observation, while the linear predictor uses two-sample extrapolation.
Both thresholds are calibrated on nominal calibration episodes. The robust
covariance artifact is used unchanged, without recalibration, even though it
was trained on a different synthetic point distribution. Its
`{robust_comparison['excludedPointObservations']}` incomplete point observations
are excluded because its production interface requires all five channels to be
finite.

Only `{len(deterministic_comparison['compatibleRules'])}` of the current eight
investigation rules are valid on these compact windows:
`{', '.join(deterministic_comparison['compatibleRules'])}`. The other six need
redundant sensor channels, fuel flow, or production fusion state that this model
evaluation dataset does not contain. The deterministic row is therefore a
partial rule-suite result and must not be interpreted as the performance of the
complete authoritative investigation engine.

## Post-hoc generalization challenge

This challenge is intentionally separate from the primary held-out evaluation
and is **not a release gate**. It uses frozen artifact
`{challenge['frozenInference']['artifactSha256']}` with no fitting,
recalibration, or threshold selection on challenge results. Seeds
`{POST_HOC_CHALLENGE_SEEDS[0]}` through `{POST_HOC_CHALLENGE_SEEDS[-1]}` are
disjoint from training, calibration, and primary held-out seeds. Labels and
onset metadata are used only to construct synthetic observations and score
episodes; inference receives the five observed channels only.

Exact challenge configurations:

- Magnitudes: `{magnitude_configuration_text}`. Both are outside the primary
  held-out range 0.72 through 1.32.
- Onset and duration: `{temporal_configuration_text}`.
- Novel combinations: `{combination_configuration_text}`.

| Challenge dimension | Episodes | Precision | Recall | F1 | False-positive rate | Classification macro F1 | Fault abstention rate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
{challenge_rows}

Exact classification is not defined for novel combinations because the model
has no corresponding combination classes. A declared component appears as the
top-one hypothesis for `{combination_components['topOneComponentRate']:.4f}` of
combination episodes and somewhere in the top three for
`{combination_components['topThreeComponentCoverage']:.4f}`. These hypothesis
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

{chr(10).join(f'- {item}' for item in artifact['limitations'])}
"""
    (output / "TEMPORAL_MODEL_CARD.md").write_text(card, encoding="utf-8", newline="\n")
    return artifact, evaluation, parity


def main() -> int:
    output = Path(__file__).resolve().parents[2] / "models"
    artifact, evaluation, _ = write_temporal_artifacts(output)
    print(
        json.dumps(
            {
                "artifact": str(output / "temporal_fault_model_v1.json"),
                "evaluation": evaluation["evaluation"],
                "qualityGate": artifact["qualityGate"],
                "enabledByDefault": artifact["enabledByDefault"],
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
