"""Train the browser temporal model on actual TypeScript mission projections.

The TypeScript exporter owns scenario generation, fusion, projection, and feature
extraction. Python owns fitting, calibration, held-out evaluation, and immutable
artifact generation. This keeps browser inference parity tied to the exact
Investigation data path instead of a separately reconstructed simulator.
"""

from __future__ import annotations

import argparse
import functools
import hashlib
import json
import math
import random
import shutil
import statistics
import subprocess
from pathlib import Path
from typing import Any, Sequence


ROOT = Path(__file__).resolve().parents[2]
EXPORTER = ROOT / "tools" / "ml" / "export_temporal_integration_corpus.ts"
TSX_CLI = ROOT / "node_modules" / "tsx" / "dist" / "cli.mjs"

ARTIFACT_VERSION = "temporal-fault-model.v1"
MODEL_VERSION = "2.0.0"
MODEL_TYPE = "causal-multiscale-feature-nearest-prototype"
GENERATED_AT = "2026-07-17T00:00:00.000Z"
SCHEMA_VERSION = "telemetry.v1"
PROFILE_ID = "generic-fixed-wing"
PROFILE_VERSION = "1.0.0"
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
LABELS = (
    "nominal",
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
FAULT_LABELS = LABELS[1:]

MINIMUM_OBSERVATION_F1 = 0.85
MAXIMUM_FALSE_POSITIVE_RATE = 0.05
MINIMUM_CLASSIFICATION_MACRO_F1 = 0.65
MINIMUM_PER_FAULT_CLASSIFICATION_RECALL = 0.65
MAXIMUM_ABSTENTION_RATE = 0.80
MINIMUM_ANSWERED_OBSERVATIONS = 1
FEATURE_SCALE_CANDIDATES = (
    (0.5, 0.5),
    (1.0, 1.0),
    (2.0, 1.0),
    (3.0, 10.0),
)
PROTOTYPE_PARTITION_KEYS = ("lifecycle", "endPhase")
CLASS_RADIUS_PERCENTILE = 0.99
CLASS_RADIUS_SAFETY_FACTOR = 1.5
ANOMALY_DISTANCE_PERCENTILE = 0.99
NOMINAL_PROTOTYPE_SAFETY_FACTOR_CANDIDATES = (
    0.95,
    1.0,
    1.05,
    1.1,
    1.2,
    1.3,
    1.5,
)
RELATIVE_SCORE_TEMPERATURE = 0.35
RELATIVE_SCORE_THRESHOLD = 0.0
BOOTSTRAP_SEED = 22_073
BOOTSTRAP_ITERATIONS = 1_000
NOMINAL_PROTOTYPE_PHASES = ("climb", "cruise", "descent", "landing", "ground")


def _node_binary() -> str:
    node = shutil.which("node")
    if node is None:
        raise RuntimeError(
            "Node.js is required to export the actual TypeScript temporal mission corpus."
        )
    if not TSX_CLI.is_file():
        raise RuntimeError("Install pinned dependencies before training the integration model.")
    return node


@functools.lru_cache(maxsize=1)
def _exported_corpus_text() -> str:
    completed = subprocess.run(
        [_node_binary(), str(TSX_CLI), str(EXPORTER)],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    if completed.stderr.strip():
        raise RuntimeError(f"Temporal corpus exporter wrote to stderr: {completed.stderr.strip()}")
    return completed.stdout


def load_integration_corpus() -> dict[str, Any]:
    corpus = json.loads(_exported_corpus_text())
    if corpus.get("schemaVersion") != "temporal-integration-corpus.v1":
        raise ValueError("Unsupported temporal integration corpus version.")
    projection = corpus.get("projection")
    if not isinstance(projection, dict):
        raise ValueError("Temporal integration corpus projection metadata is required.")
    if projection.get("windowLength") != WINDOW_LENGTH:
        raise ValueError("Temporal integration corpus window length does not match inference.")
    if projection.get("cadenceMs") != CADENCE_MS:
        raise ValueError("Temporal integration corpus cadence does not match inference.")
    if projection.get("featureNames") is None:
        raise ValueError("Temporal integration corpus feature names are required.")
    return corpus


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
    return [
        (value - origin) / width
        for value, origin, width in zip(row, center, scale, strict=True)
    ]


def _centroid(rows: Sequence[Sequence[float]]) -> list[float]:
    return [statistics.fmean(column) for column in zip(*rows, strict=True)]


def _distance(left: Sequence[float], right: Sequence[float]) -> float:
    return sum((a - b) ** 2 for a, b in zip(left, right, strict=True)) / len(left)


def _prototype_partition_id(example: dict[str, Any]) -> str:
    return ":".join(str(example[key]) for key in PROTOTYPE_PARTITION_KEYS)


def _fit_class_prototypes(
    examples: Sequence[dict[str, Any]],
    standardized_rows: Sequence[Sequence[float]],
) -> tuple[dict[str, list[list[float]]], dict[str, list[str]]]:
    prototypes: dict[str, list[list[float]]] = {}
    prototype_ids: dict[str, list[str]] = {}
    for label in LABELS:
        partitions: dict[str, list[Sequence[float]]] = {}
        for example, row in zip(examples, standardized_rows, strict=True):
            if example["label"] != label:
                continue
            partition_id = _prototype_partition_id(example)
            partitions.setdefault(partition_id, []).append(row)
        if not partitions:
            raise ValueError(f"No training prototype partitions exist for {label}.")
        ordered_ids = sorted(partitions)
        prototype_ids[label] = ordered_ids
        prototypes[label] = [_centroid(partitions[partition_id]) for partition_id in ordered_ids]
    return prototypes, prototype_ids


def _minimum_prototype_distance(
    row: Sequence[float], prototypes: Sequence[Sequence[float]]
) -> float:
    return min(_distance(row, prototype) for prototype in prototypes)


def _softmax(values: Sequence[float]) -> list[float]:
    maximum = max(values)
    exponents = [math.exp(value - maximum) for value in values]
    total = sum(exponents)
    return [value / total for value in exponents]


def _predict(
    features: Sequence[float],
    center: Sequence[float],
    scale: Sequence[float],
    class_prototypes: dict[str, Sequence[Sequence[float]]],
    radii: dict[str, float],
    relative_score_threshold: float,
    similarity_temperature: float,
    anomaly_margin_threshold: float,
    nominal_prototypes: Sequence[Sequence[float]] | None = None,
    anomaly_distance_threshold: float | None = None,
) -> dict[str, object]:
    standardized = _standardize(features, center, scale)
    distances = {
        label: _minimum_prototype_distance(standardized, class_prototypes[label])
        for label in LABELS
    }
    relative_score_values = _softmax(
        [-distances[label] / similarity_temperature for label in LABELS]
    )
    relative_scores = dict(zip(LABELS, relative_score_values, strict=True))
    integrated_detection = (
        nominal_prototypes is not None and anomaly_distance_threshold is not None
    )
    nominal_prototype_distance = (
        min(_distance(standardized, prototype) for prototype in nominal_prototypes)
        if nominal_prototypes is not None
        else distances["nominal"]
    )
    if integrated_detection and nominal_prototype_distance <= anomaly_distance_threshold:
        nearest = "nominal"
    elif integrated_detection:
        nearest = min(FAULT_LABELS, key=lambda label: distances[label])
    else:
        nearest = min(LABELS, key=lambda label: distances[label])
    relative_score = relative_scores[nearest]
    nearest_fault_distance = min(distances[label] for label in FAULT_LABELS)
    anomaly_margin = distances["nominal"] - nearest_fault_distance
    distance_exceeds_radius = nearest != "nominal" and distances[nearest] > radii[nearest]
    insufficient_fault_margin = (
        not integrated_detection
        and nearest != "nominal"
        and anomaly_margin <= anomaly_margin_threshold
    )
    abstained = (
        distance_exceeds_radius
        or relative_score < relative_score_threshold
        or insufficient_fault_margin
    )
    predicted = "unknown" if abstained else nearest
    hypotheses = sorted(
        (
            {
                "faultType": label,
                "relativeScore": relative_scores[label],
                "distance": distances[label],
            }
            for label in FAULT_LABELS
        ),
        key=lambda entry: (-float(entry["relativeScore"]), str(entry["faultType"])),
    )[:3]
    return {
        "predictedLabel": predicted,
        "nearestLabel": nearest,
        "relativeScore": relative_score,
        "distance": (
            nominal_prototype_distance
            if integrated_detection and nearest == "nominal"
            else distances[nearest]
        ),
        "anomalyDistance": nominal_prototype_distance,
        "anomalyMargin": anomaly_margin,
        "abstained": abstained,
        "anomalous": not abstained and nearest != "nominal",
        "relativeScores": relative_scores,
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


def _macro_f1(expected: Sequence[str], predicted: Sequence[str]) -> float:
    scores: list[float] = []
    for label in FAULT_LABELS:
        truth = [value == label for value in expected]
        guess = [value == label for value in predicted]
        scores.append(float(_confusion(truth, guess)["f1"]))
    return statistics.fmean(scores)


def _examples(corpus: dict[str, Any], split: str) -> list[dict[str, Any]]:
    examples = corpus["splits"][split]["examples"]
    if not isinstance(examples, list) or not examples:
        raise ValueError(f"Temporal integration {split} examples are required.")
    expected_names = list(corpus["projection"]["featureNames"])
    for example in examples:
        if example.get("label") not in LABELS:
            raise ValueError(f"Unsupported corpus label: {example.get('label')!r}.")
        features = example.get("features")
        if not isinstance(features, list) or len(features) != len(expected_names):
            raise ValueError("Corpus feature dimensions do not match the encoder contract.")
        if not all(isinstance(value, (int, float)) and math.isfinite(value) for value in features):
            raise ValueError("Corpus features must be finite numbers.")
    return examples


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


def _canonical_json(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def _document_bytes(value: object) -> bytes:
    return (json.dumps(_rounded(value), indent=2, sort_keys=True) + "\n").encode("utf-8")


def _clopper_pearson_upper(
    false_positives: int, nominal_observations: int, confidence: float = 0.95
) -> float:
    if nominal_observations <= 0 or not 0 <= false_positives <= nominal_observations:
        raise ValueError("Exact false-positive bounds require a valid nonempty count.")
    if false_positives == nominal_observations:
        return 1.0
    alpha = 1.0 - confidence

    def cumulative(probability: float) -> float:
        return sum(
            math.comb(nominal_observations, count)
            * probability**count
            * (1.0 - probability) ** (nominal_observations - count)
            for count in range(false_positives + 1)
        )

    lower = false_positives / nominal_observations
    upper = 1.0
    for _ in range(100):
        midpoint = (lower + upper) / 2.0
        if cumulative(midpoint) > alpha:
            lower = midpoint
        else:
            upper = midpoint
    return upper


def _selected_window_evaluation(
    examples: Sequence[dict[str, Any]], predictions: Sequence[dict[str, object]]
) -> dict[str, object]:
    expected_fault = [example["label"] != "nominal" for example in examples]
    predicted_fault = [bool(prediction["anomalous"]) for prediction in predictions]
    selected_window_metrics = _confusion(expected_fault, predicted_fault)
    predicted_classes = [str(prediction["predictedLabel"]) for prediction in predictions]
    classification_macro_f1 = _macro_f1(
        [str(example["label"]) for example in examples], predicted_classes
    )
    by_fault: dict[str, dict[str, float | int]] = {}
    for label in FAULT_LABELS:
        selected = [
            prediction
            for example, prediction in zip(examples, predictions, strict=True)
            if example["label"] == label
        ]
        by_fault[label] = {
            "observations": len(selected),
            "answered": sum(not bool(prediction["abstained"]) for prediction in selected),
            "detected": sum(bool(prediction["anomalous"]) for prediction in selected),
            "detectionRecall": sum(bool(prediction["anomalous"]) for prediction in selected)
            / len(selected),
            "correctlyClassified": sum(
                prediction["predictedLabel"] == label for prediction in selected
            ),
            "classificationRecall": sum(
                prediction["predictedLabel"] == label for prediction in selected
            )
            / len(selected),
            "abstained": sum(bool(prediction["abstained"]) for prediction in selected),
        }
    abstained = sum(bool(prediction["abstained"]) for prediction in predictions)
    answered = len(predictions) - abstained
    return {
        "selectedWindowMetrics": selected_window_metrics,
        "classificationMacroF1": classification_macro_f1,
        "byFault": by_fault,
        "abstentionRate": abstained / len(predictions),
        "answeredObservations": answered,
        "minimumPerFaultClassificationRecall": min(
            float(result["classificationRecall"]) for result in by_fault.values()
        ),
    }


def _selected_window_bootstrap(
    examples: Sequence[dict[str, Any]],
    predictions: Sequence[dict[str, object]],
) -> dict[str, object]:
    indices_by_seed: dict[int, list[int]] = {}
    for index, example in enumerate(examples):
        indices_by_seed.setdefault(int(example["seed"]), []).append(index)
    seeds = sorted(indices_by_seed)
    rng = random.Random(BOOTSTRAP_SEED)
    sampled_metrics: dict[str, list[float]] = {
        "precision": [],
        "recall": [],
        "f1": [],
        "classificationMacroF1": [],
        "minimumPerFaultClassificationRecall": [],
    }
    for _ in range(BOOTSTRAP_ITERATIONS):
        sampled_seeds = [seeds[rng.randrange(len(seeds))] for _ in seeds]
        sampled_indices = [
            index for seed in sampled_seeds for index in indices_by_seed[seed]
        ]
        sampled_examples = [examples[index] for index in sampled_indices]
        sampled_predictions = [predictions[index] for index in sampled_indices]
        evaluation = _selected_window_evaluation(sampled_examples, sampled_predictions)
        binary = evaluation["selectedWindowMetrics"]
        assert isinstance(binary, dict)
        for metric in ("precision", "recall", "f1"):
            sampled_metrics[metric].append(float(binary[metric]))
        sampled_metrics["classificationMacroF1"].append(
            float(evaluation["classificationMacroF1"])
        )
        sampled_metrics["minimumPerFaultClassificationRecall"].append(
            float(evaluation["minimumPerFaultClassificationRecall"])
        )
    return {
        "method": "deterministic-cluster-bootstrap-by-held-out-seed",
        "confidenceLevel": 0.95,
        "seed": BOOTSTRAP_SEED,
        "iterations": BOOTSTRAP_ITERATIONS,
        "resamplingUnit": "synthetic mission seed with all eleven selected label windows",
        "intervals": {
            metric: {
                "lower95": _percentile(values, 0.025),
                "upper95": _percentile(values, 0.975),
            }
            for metric, values in sampled_metrics.items()
        },
    }


def train_temporal_integration_model(
    corpus: dict[str, Any] | None = None,
) -> tuple[dict[str, object], dict[str, object], dict[str, object], str]:
    source = load_integration_corpus() if corpus is None else corpus
    training = _examples(source, "training")
    calibration = _examples(source, "calibration")
    held_out = _examples(source, "heldOut")
    feature_names = list(source["projection"]["featureNames"])

    training_rows = [example["features"] for example in training]
    center, fitted_scale = _fit_standardizer(training_rows)
    selection_results: list[dict[str, object]] = []
    fitted_candidates: list[tuple[tuple[object, ...], dict[str, object]]] = []
    for mean_multiplier, half_shift_multiplier in FEATURE_SCALE_CANDIDATES:
        candidate_scale = [
            width
            * (
                mean_multiplier
                if name.endswith(".mean")
                else half_shift_multiplier
                if name.endswith(".half-shift")
                else 1.0
            )
            for name, width in zip(feature_names, fitted_scale, strict=True)
        ]
        standardized_training = [
            _standardize(example["features"], center, candidate_scale)
            for example in training
        ]
        class_prototypes, prototype_ids = _fit_class_prototypes(
            training, standardized_training
        )
        nominal_prototypes = class_prototypes["nominal"]
        nominal_phases = [partition_id.rsplit(":", 1)[-1] for partition_id in prototype_ids["nominal"]]
        if set(nominal_phases) != set(NOMINAL_PROTOTYPE_PHASES):
            raise ValueError("Training data does not cover every declared nominal prototype phase.")
        class_distances: dict[str, list[float]] = {label: [] for label in LABELS}
        for example in calibration:
            standardized = _standardize(example["features"], center, candidate_scale)
            label = str(example["label"])
            class_distances[label].append(
                _minimum_prototype_distance(standardized, class_prototypes[label])
            )
        radii = {
            label: max(
                _percentile(distances, CLASS_RADIUS_PERCENTILE)
                * CLASS_RADIUS_SAFETY_FACTOR,
                0.05,
            )
            for label, distances in class_distances.items()
        }
        nominal_distance_percentile = _percentile(
            class_distances["nominal"], ANOMALY_DISTANCE_PERCENTILE
        )
        for nominal_safety_factor in NOMINAL_PROTOTYPE_SAFETY_FACTOR_CANDIDATES:
            anomaly_distance_threshold = nominal_distance_percentile * nominal_safety_factor
            calibration_predictions = [
                _predict(
                    example["features"],
                    center,
                    candidate_scale,
                    class_prototypes,
                    radii,
                    RELATIVE_SCORE_THRESHOLD,
                    RELATIVE_SCORE_TEMPERATURE,
                    0.0,
                    nominal_prototypes,
                    anomaly_distance_threshold,
                )
                for example in calibration
            ]
            calibration_evaluation = _selected_window_evaluation(
                calibration, calibration_predictions
            )
            metrics = calibration_evaluation["selectedWindowMetrics"]
            assert isinstance(metrics, dict)
            minimum_recall = float(
                calibration_evaluation["minimumPerFaultClassificationRecall"]
            )
            calibration_eligible = (
                float(metrics["f1"]) >= MINIMUM_OBSERVATION_F1
                and float(metrics["falsePositiveRate"]) == 0.0
                and float(calibration_evaluation["classificationMacroF1"])
                >= MINIMUM_CLASSIFICATION_MACRO_F1
                and minimum_recall >= MINIMUM_PER_FAULT_CLASSIFICATION_RECALL
            )
            selection_summary = {
                "meanFeatureScaleMultiplier": mean_multiplier,
                "halfShiftFeatureScaleMultiplier": half_shift_multiplier,
                "nominalPrototypeSafetyFactor": nominal_safety_factor,
                "selectedWindowF1": metrics["f1"],
                "selectedWindowFalsePositiveRate": metrics["falsePositiveRate"],
                "classificationMacroF1": calibration_evaluation["classificationMacroF1"],
                "minimumPerFaultClassificationRecall": minimum_recall,
                "abstentionRate": calibration_evaluation["abstentionRate"],
                "eligibleForSelection": calibration_eligible,
            }
            selection_results.append(selection_summary)
            selection_key: tuple[object, ...] = (
                calibration_eligible,
                minimum_recall,
                float(calibration_evaluation["classificationMacroF1"]),
                float(metrics["f1"]),
                -float(calibration_evaluation["abstentionRate"]),
            )
            fitted_candidates.append(
                (
                    selection_key,
                    {
                        "meanMultiplier": mean_multiplier,
                        "halfShiftMultiplier": half_shift_multiplier,
                        "nominalSafetyFactor": nominal_safety_factor,
                        "scale": candidate_scale,
                        "classPrototypes": class_prototypes,
                        "prototypeIds": prototype_ids,
                        "nominalPrototypes": nominal_prototypes,
                        "nominalPhases": nominal_phases,
                        "radii": radii,
                        "anomalyDistanceThreshold": anomaly_distance_threshold,
                        "calibrationEvaluation": calibration_evaluation,
                    },
                )
            )

    _, selected = max(fitted_candidates, key=lambda candidate: candidate[0])
    scale = selected["scale"]
    class_prototypes = selected["classPrototypes"]
    prototype_ids = selected["prototypeIds"]
    nominal_prototypes = selected["nominalPrototypes"]
    nominal_phases = selected["nominalPhases"]
    radii = selected["radii"]
    anomaly_distance_threshold = float(selected["anomalyDistanceThreshold"])
    assert isinstance(scale, list)
    assert isinstance(class_prototypes, dict)
    assert isinstance(prototype_ids, dict)
    assert isinstance(nominal_prototypes, list)
    assert isinstance(nominal_phases, list)
    assert isinstance(radii, dict)
    anomaly_margin_threshold = 0.0

    predictions = [
        _predict(
            example["features"],
            center,
            scale,
            class_prototypes,
            radii,
            RELATIVE_SCORE_THRESHOLD,
            RELATIVE_SCORE_TEMPERATURE,
            anomaly_margin_threshold,
            nominal_prototypes,
            anomaly_distance_threshold,
        )
        for example in held_out
    ]
    held_out_evaluation = _selected_window_evaluation(held_out, predictions)
    selected_window_metrics = held_out_evaluation["selectedWindowMetrics"]
    assert isinstance(selected_window_metrics, dict)
    classification_macro_f1 = float(held_out_evaluation["classificationMacroF1"])
    by_fault = held_out_evaluation["byFault"]
    assert isinstance(by_fault, dict)
    abstention_rate = float(held_out_evaluation["abstentionRate"])
    answered = int(held_out_evaluation["answeredObservations"])
    minimum_per_fault_recall = float(
        held_out_evaluation["minimumPerFaultClassificationRecall"]
    )
    quality_passed = (
        float(selected_window_metrics["f1"]) >= MINIMUM_OBSERVATION_F1
        and float(selected_window_metrics["falsePositiveRate"])
        <= MAXIMUM_FALSE_POSITIVE_RATE
        and classification_macro_f1 >= MINIMUM_CLASSIFICATION_MACRO_F1
        and minimum_per_fault_recall >= MINIMUM_PER_FAULT_CLASSIFICATION_RECALL
        and answered >= MINIMUM_ANSWERED_OBSERVATIONS
        and abstention_rate < 1.0
        and abstention_rate <= MAXIMUM_ABSTENTION_RATE
    )

    corpus_hash = hashlib.sha256(_canonical_json(source).encode("utf-8")).hexdigest()
    config = {
        "cadenceMs": CADENCE_MS,
        "channels": list(CHANNELS),
        "classifier": "standardized-nearest-lifecycle-phase-prototype",
        "anomalyDetector": "minimum-distance-to-phase-specific-nominal-prototype",
        "corpus": {
            "schemaVersion": source["schemaVersion"],
            "sha256": corpus_hash,
            "splitSeeds": {
                split: source["splits"][split]["seeds"]
                for split in ("training", "calibration", "heldOut")
            },
        },
        "featureEncoder": "causal-multiscale-statistical-features-v1",
        "featureScaleCandidateGrid": [list(candidate) for candidate in FEATURE_SCALE_CANDIDATES],
        "featureScaleMultipliers": {
            "mean": selected["meanMultiplier"],
            "halfShift": selected["halfShiftMultiplier"],
        },
        "prototypePartitionKeys": list(PROTOTYPE_PARTITION_KEYS),
        "prototypePartitionIds": prototype_ids,
        "nominalPrototypePhases": nominal_phases,
        "selection": {
            "population": "calibration-only",
            "rule": "zero-calibration-false-positives-then-maximize-minimum-per-fault-recall",
            "nominalPrototypeSafetyFactorCandidates": list(
                NOMINAL_PROTOTYPE_SAFETY_FACTOR_CANDIDATES
            ),
            "selectedNominalPrototypeSafetyFactor": selected["nominalSafetyFactor"],
        },
        "distanceCalibration": {
            "classRadiusPercentile": CLASS_RADIUS_PERCENTILE,
            "classRadiusSafetyFactor": CLASS_RADIUS_SAFETY_FACTOR,
            "anomalyDistancePercentile": ANOMALY_DISTANCE_PERCENTILE,
            "classRadii": radii,
            "anomalyDistanceThreshold": anomaly_distance_threshold,
        },
        "relativeSimilarity": {
            "method": "softmax-normalized-negative-distance-not-calibrated-probability",
            "temperature": RELATIVE_SCORE_TEMPERATURE,
            "minimumScoreThreshold": RELATIVE_SCORE_THRESHOLD,
        },
        "anomalyMarginThreshold": anomaly_margin_threshold,
        "qualityThresholds": {
            "minimumSelectedWindowF1": MINIMUM_OBSERVATION_F1,
            "maximumSelectedWindowFalsePositiveRate": MAXIMUM_FALSE_POSITIVE_RATE,
            "minimumClassificationMacroF1": MINIMUM_CLASSIFICATION_MACRO_F1,
            "minimumPerFaultClassificationRecall": MINIMUM_PER_FAULT_CLASSIFICATION_RECALL,
            "maximumAbstentionRate": MAXIMUM_ABSTENTION_RATE,
            "minimumAnsweredObservations": MINIMUM_ANSWERED_OBSERVATIONS,
        },
        "bootstrap": {
            "method": "deterministic-cluster-bootstrap-by-held-out-seed",
            "seed": BOOTSTRAP_SEED,
            "iterations": BOOTSTRAP_ITERATIONS,
            "confidenceLevel": 0.95,
        },
        "profileId": PROFILE_ID,
        "profileVersion": PROFILE_VERSION,
        "projection": str(source["projection"]["id"]),
        "projectionVersion": str(source["projection"]["version"]),
        "schemaVersion": SCHEMA_VERSION,
        "units": UNITS,
        "windowLength": WINDOW_LENGTH,
    }
    canonical_config = _canonical_json(config)
    config_hash = hashlib.sha256(canonical_config.encode("utf-8")).hexdigest()
    artifact: dict[str, object] = {
        "artifactVersion": ARTIFACT_VERSION,
        "modelVersion": MODEL_VERSION,
        "modelType": MODEL_TYPE,
        "generatedAt": GENERATED_AT,
        "syntheticDataOnly": True,
        "enabledByDefault": quality_passed,
        "schemaVersion": SCHEMA_VERSION,
        "profile": {"id": PROFILE_ID, "version": PROFILE_VERSION},
        "windowLength": WINDOW_LENGTH,
        "cadenceMs": CADENCE_MS,
        "channels": list(CHANNELS),
        "units": UNITS,
        "featureNames": feature_names,
        "featureCenter": center,
        "featureScale": scale,
        "classPrototypeIds": prototype_ids,
        "classPrototypes": class_prototypes,
        "classRadii": radii,
        "nominalPrototypePhases": nominal_phases,
        "nominalPrototypes": nominal_prototypes,
        "anomalyDistanceThreshold": anomaly_distance_threshold,
        "similarityTemperature": RELATIVE_SCORE_TEMPERATURE,
        "relativeScoreThreshold": RELATIVE_SCORE_THRESHOLD,
        "anomalyMarginThreshold": anomaly_margin_threshold,
        "training": {
            "seeds": source["splits"]["training"]["seeds"],
            "examples": len(training),
            "configurationSha256": config_hash,
            "corpusSchemaVersion": source["schemaVersion"],
            "corpusSha256": corpus_hash,
            "projection": source["projection"],
            "prototypePartitionKeys": list(PROTOTYPE_PARTITION_KEYS),
        },
        "calibration": {
            "seeds": source["splits"]["calibration"]["seeds"],
            "examples": len(calibration),
            "method": "calibration-only-prototype-selection-and-distance-percentiles",
            "selectionRule": "zero-calibration-false-positives-then-maximize-minimum-per-fault-recall",
            "selectionCandidates": selection_results,
            "selected": {
                "meanFeatureScaleMultiplier": selected["meanMultiplier"],
                "halfShiftFeatureScaleMultiplier": selected["halfShiftMultiplier"],
                "nominalPrototypeSafetyFactor": selected["nominalSafetyFactor"],
            },
            "selectedWindowEvaluation": selected["calibrationEvaluation"],
            "classRadiusPercentile": CLASS_RADIUS_PERCENTILE,
            "classRadiusSafetyFactor": CLASS_RADIUS_SAFETY_FACTOR,
            "anomalyDistancePercentile": ANOMALY_DISTANCE_PERCENTILE,
            "relativeSimilarityMethod": "softmax-normalized-negative-distance-not-calibrated-probability",
            "relativeScoreThreshold": RELATIVE_SCORE_THRESHOLD,
        },
        "evaluation": {
            "seeds": source["splits"]["heldOut"]["seeds"],
            "examples": len(held_out),
            "evaluationUnit": "selected causal 40-sample window",
            "selectedWindowMetrics": selected_window_metrics,
            "classificationMacroF1": classification_macro_f1,
            "abstentionRate": abstention_rate,
            "answeredObservations": answered,
            "byFault": by_fault,
            "bootstrapConfidenceIntervals": _selected_window_bootstrap(
                held_out, predictions
            ),
            "falsePositiveRateEvidence": {
                "falsePositiveWindows": selected_window_metrics["falsePositives"],
                "nominalWindows": int(selected_window_metrics["falsePositives"])
                + int(selected_window_metrics["trueNegatives"]),
                "observedRate": selected_window_metrics["falsePositiveRate"],
                "exactOneSidedUpper95": _clopper_pearson_upper(
                    int(selected_window_metrics["falsePositives"]),
                    int(selected_window_metrics["falsePositives"])
                    + int(selected_window_metrics["trueNegatives"]),
                ),
                "method": "Clopper-Pearson exact binomial upper bound",
                "populationRateAtMostFivePercentEstablished": False,
            },
        },
        "qualityGate": {
            "minimumSelectedWindowF1": MINIMUM_OBSERVATION_F1,
            "maximumSelectedWindowFalsePositiveRate": MAXIMUM_FALSE_POSITIVE_RATE,
            "minimumClassificationMacroF1": MINIMUM_CLASSIFICATION_MACRO_F1,
            "minimumPerFaultClassificationRecall": MINIMUM_PER_FAULT_CLASSIFICATION_RECALL,
            "observedMinimumPerFaultClassificationRecall": minimum_per_fault_recall,
            "maximumAbstentionRate": MAXIMUM_ABSTENTION_RATE,
            "observedAbstentionRate": abstention_rate,
            "minimumAnsweredObservations": MINIMUM_ANSWERED_OBSERVATIONS,
            "observedAnsweredObservations": answered,
            "passed": quality_passed,
        },
        "limitations": [
            "Trained and evaluated only on generated synthetic telemetry projected by the browser Investigation path.",
            "Selected rolling windows are balanced research observations, not independent real-world flights.",
            "Ranks declared synthetic fault hypotheses and does not establish root cause.",
            "Normalized distance similarities are relative scores, not calibrated probabilities.",
            "The held-out false-positive point estimate passes, but 40 nominal windows cannot establish a population false-positive rate at or below five percent at 95 percent confidence.",
            "Unknown or unsupported inputs may produce an abstention.",
            "Deterministic rules remain authoritative for verification status.",
        ],
    }
    artifact_hash = hashlib.sha256(_document_bytes(artifact)).hexdigest()
    evaluation: dict[str, object] = {
        "artifactVersion": ARTIFACT_VERSION,
        "modelVersion": MODEL_VERSION,
        "generatedAt": GENERATED_AT,
        "artifactSha256": artifact_hash,
        "configurationSha256": config_hash,
        "corpus": {
            "schemaVersion": source["schemaVersion"],
            "projection": source["projection"],
            "splitSeedsDisjoint": True,
        },
        "evaluation": artifact["evaluation"],
        "qualityGate": artifact["qualityGate"],
        "enabledByDefault": quality_passed,
    }

    parity_cases: list[dict[str, object]] = []
    for case in source["parityCases"]:
        prediction = _predict(
            case["features"],
            center,
            scale,
            class_prototypes,
            radii,
            RELATIVE_SCORE_THRESHOLD,
            RELATIVE_SCORE_TEMPERATURE,
            anomaly_margin_threshold,
            nominal_prototypes,
            anomaly_distance_threshold,
        )
        parity_cases.append(
            {
                "caseId": case.get("caseId", case["exampleId"]),
                "label": case["label"],
                "seed": case["seed"],
                "endIndex": case["endIndex"],
                "window": case["window"],
                "expected": {
                    "predictedLabel": prediction["predictedLabel"],
                    "nearestLabel": prediction["nearestLabel"],
                    "relativeScore": prediction["relativeScore"],
                    "distance": prediction["distance"],
                    "abstained": prediction["abstained"],
                    "anomalous": prediction["anomalous"],
                },
            }
        )
    parity = {
        "artifactVersion": ARTIFACT_VERSION,
        "modelVersion": MODEL_VERSION,
        "absoluteTolerance": 1e-9,
        "cases": parity_cases,
    }
    return artifact, evaluation, parity, canonical_config


def _model_card(artifact: dict[str, object], evaluation: dict[str, object]) -> str:
    metrics = artifact["evaluation"]
    gate = artifact["qualityGate"]
    assert isinstance(metrics, dict)
    assert isinstance(gate, dict)
    selected_windows = metrics["selectedWindowMetrics"]
    assert isinstance(selected_windows, dict)
    false_positive_evidence = metrics["falsePositiveRateEvidence"]
    assert isinstance(false_positive_evidence, dict)
    bootstrap = metrics["bootstrapConfidenceIntervals"]
    assert isinstance(bootstrap, dict)
    intervals = bootstrap["intervals"]
    assert isinstance(intervals, dict)
    by_fault = metrics["byFault"]
    assert isinstance(by_fault, dict)
    per_fault_rows = "".join(
        f"| {label} | {result['answered']} / {result['observations']} | "
        f"{result['detectionRecall']:.3f} | {result['classificationRecall']:.3f} |\n"
        for label, result in by_fault.items()
    )
    return f"""# Temporal Integration Model Card

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

- Artifact schema: `{artifact['artifactVersion']}`
- Model version: `{artifact['modelVersion']}`
- Model type: `{artifact['modelType']}`
- Configuration SHA-256: `{evaluation['configurationSha256']}`
- Artifact SHA-256: `{evaluation['artifactSha256']}`
- Window: {artifact['windowLength']} samples at {artifact['cadenceMs']} ms cadence

## Held-out selected-window integration gate

The split seed sets are disjoint. Hyperparameter selection and threshold fitting
use only training and calibration seeds. The final fixed evaluation uses seeds
9101 through 9140 exactly once. Metrics use balanced selected causal windows from
held-out TypeScript missions. They are neither full-stream episode metrics nor
estimates of real-world prevalence.

| Metric | Observed | Gate |
| --- | ---: | ---: |
| Selected-window binary F1 | {selected_windows['f1']:.4f} | >= {gate['minimumSelectedWindowF1']:.2f} |
| Selected-window false-positive rate | {selected_windows['falsePositiveRate']:.4f} | <= {gate['maximumSelectedWindowFalsePositiveRate']:.2f} |
| Classification macro F1 | {metrics['classificationMacroF1']:.4f} | >= {gate['minimumClassificationMacroF1']:.2f} |
| Minimum per-fault classification recall | {gate['observedMinimumPerFaultClassificationRecall']:.4f} | >= {gate['minimumPerFaultClassificationRecall']:.2f} |
| Abstention rate | {metrics['abstentionRate']:.4f} | <= {gate['maximumAbstentionRate']:.2f} |
| Answered observations | {metrics['answeredObservations']} | >= {gate['minimumAnsweredObservations']} |

Point-estimate gate result: **{'PASS' if gate['passed'] else 'FAIL'}**.

The deterministic seed-cluster bootstrap uses seed `{bootstrap['seed']}` for
`{bootstrap['iterations']}` iterations. Its 95 percent intervals are:

| Metric | Lower | Upper |
| --- | ---: | ---: |
| Precision | {intervals['precision']['lower95']:.4f} | {intervals['precision']['upper95']:.4f} |
| Recall | {intervals['recall']['lower95']:.4f} | {intervals['recall']['upper95']:.4f} |
| F1 | {intervals['f1']['lower95']:.4f} | {intervals['f1']['upper95']:.4f} |
| Classification macro F1 | {intervals['classificationMacroF1']['lower95']:.4f} | {intervals['classificationMacroF1']['upper95']:.4f} |
| Minimum per-fault recall | {intervals['minimumPerFaultClassificationRecall']['lower95']:.4f} | {intervals['minimumPerFaultClassificationRecall']['upper95']:.4f} |

The selected-window confusion counts are {selected_windows['truePositives']} TP,
{selected_windows['falsePositives']} FP, {selected_windows['trueNegatives']} TN,
and {selected_windows['falseNegatives']} FN. The exact one-sided 95 percent
Clopper-Pearson upper bound for the false-positive rate is
`{false_positive_evidence['exactOneSidedUpper95']:.4f}`. Therefore this 40-window
nominal sample does **not** establish a population false-positive rate at or below
five percent. That statistical limitation is separate from the declared
selected-window point-estimate gate.

## Per-fault held-out behavior

Zero-answer or zero-classification rows are explicit limitations, not hidden
successes. Every declared fault must meet the minimum recall gate.

| Declared synthetic label | Answered | Detection recall | Classification recall |
| --- | ---: | ---: | ---: |
{per_fault_rows}

## Limitations

""" + "".join(f"- {item}\n" for item in artifact["limitations"])


def write_temporal_integration_artifacts(
    output: Path,
) -> tuple[dict[str, object], dict[str, object], dict[str, object]]:
    artifact, evaluation, parity, canonical_configuration = train_temporal_integration_model()
    output.mkdir(parents=True, exist_ok=True)
    documents = {
        "temporal_fault_model_v2.json": artifact,
        "temporal_evaluation_v2.json": evaluation,
        "temporal_inference_parity_v2.json": parity,
    }
    for name, document in documents.items():
        (output / name).write_bytes(_document_bytes(document))
    (output / "TEMPORAL_INTEGRATION_MODEL_CARD.md").write_text(
        _model_card(artifact, evaluation), encoding="utf-8", newline="\n"
    )
    manifest_path = ROOT / "models" / "model_configuration_manifest_v1.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    entries = manifest.get("entries")
    if not isinstance(entries, list):
        raise ValueError("Model configuration manifest entries are required.")
    integrated_entry = {
        "registryEntryId": "generic-fixed-wing.temporal-fault",
        "modelVersion": MODEL_VERSION,
        "canonicalJson": canonical_configuration,
        "sha256": hashlib.sha256(canonical_configuration.encode("utf-8")).hexdigest(),
    }
    retained = [
        entry
        for entry in entries
        if not (
            isinstance(entry, dict)
            and entry.get("registryEntryId") == integrated_entry["registryEntryId"]
            and entry.get("modelVersion") == integrated_entry["modelVersion"]
        )
    ]
    manifest["entries"] = [*retained, integrated_entry]
    (output / "model_configuration_manifest_v1.json").write_bytes(
        _document_bytes(manifest)
    )
    return artifact, evaluation, parity


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=ROOT / "models")
    arguments = parser.parse_args()
    artifact, evaluation, _ = write_temporal_integration_artifacts(arguments.output)
    print(
        json.dumps(
            {
                "artifact": str(arguments.output / "temporal_fault_model_v2.json"),
                "qualityGatePassed": artifact["qualityGate"]["passed"],
                "answeredObservations": artifact["evaluation"]["answeredObservations"],
                "abstentionRate": artifact["evaluation"]["abstentionRate"],
                "artifactSha256": evaluation["artifactSha256"],
                "configurationSha256": evaluation["configurationSha256"],
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
