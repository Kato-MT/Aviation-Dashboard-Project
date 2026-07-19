from __future__ import annotations

import hashlib
import json
import math
import unittest
from pathlib import Path

import tools.ml.train_temporal_model as temporal


class TemporalTrainingPipelineTests(unittest.TestCase):
    def test_split_seeds_are_disjoint(self) -> None:
        training = set(temporal.TRAINING_SEEDS)
        calibration = set(temporal.CALIBRATION_SEEDS)
        held_out = set(temporal.HELD_OUT_SEEDS)
        self.assertFalse(training & calibration)
        self.assertFalse(training & held_out)
        self.assertFalse(calibration & held_out)

    def test_every_declared_label_is_seed_deterministic(self) -> None:
        for label in temporal.LABELS:
            first = temporal.generate_window(3101, label, "held-out")
            second = temporal.generate_window(3101, label, "held-out")
            self.assertEqual(first, second)
            self.assertEqual(len(first.window), temporal.WINDOW_LENGTH)

    def test_declared_faults_have_onset_and_held_out_magnitude(self) -> None:
        for label in temporal.FAULT_LABELS:
            example = temporal.generate_window(3108, label, "held-out")
            self.assertIsNotNone(example.onset)
            self.assertGreater(example.magnitude, 0)
            self.assertNotEqual(example.window, temporal.generate_window(3108, "nominal", "held-out").window)

    def test_dropout_features_remain_finite_and_record_missingness(self) -> None:
        example = temporal.generate_window(3121, "intermittent-dropout", "held-out")
        features = temporal.extract_features(example.window)
        self.assertEqual(len(features), len(temporal.feature_names()))
        self.assertTrue(all(math.isfinite(value) for value in features))
        missing_index = temporal.feature_names().index("vibration.missing-fraction")
        self.assertGreater(features[missing_index], 0)

    def test_feature_extraction_rejects_wrong_window_length(self) -> None:
        example = temporal.generate_window(3101, "nominal", "held-out")
        with self.assertRaisesRegex(ValueError, "exactly 40"):
            temporal.extract_features(example.window[:-1])

    def test_training_is_reproducible_and_quality_gated(self) -> None:
        first = temporal.train_temporal_model()
        second = temporal.train_temporal_model()
        self.assertEqual(first, second)
        artifact = first[0]
        metrics = artifact["evaluation"]["episodeMetrics"]
        self.assertGreaterEqual(metrics["f1"], temporal.MINIMUM_EPISODE_F1)
        self.assertLessEqual(metrics["falsePositiveRate"], temporal.MAXIMUM_FALSE_POSITIVE_RATE)
        self.assertGreaterEqual(
            artifact["evaluation"]["classificationMacroF1"],
            temporal.MINIMUM_CLASSIFICATION_MACRO_F1,
        )
        self.assertTrue(artifact["qualityGate"]["passed"])
        self.assertTrue(artifact["enabledByDefault"])

    def test_baseline_comparison_uses_declared_held_out_population(self) -> None:
        _, evaluation, _ = temporal.train_temporal_model()
        comparison = evaluation["baselineComparison"]
        self.assertEqual(
            comparison["schemaVersion"],
            temporal.BASELINE_COMPARISON_VERSION,
        )
        population = comparison["evaluationPopulation"]
        self.assertEqual(population["seeds"], list(temporal.HELD_OUT_SEEDS))
        self.assertEqual(population["labels"], list(temporal.LABELS))
        self.assertEqual(population["episodes"], 440)
        self.assertEqual(population["unseenMagnitudeRange"], [0.72, 1.32])

        systems = comparison["systems"]
        self.assertEqual(
            set(systems),
            {
                "temporalModel",
                "persistencePredictionBaseline",
                "linearPredictionBaseline",
                "robustCovarianceDetector",
                "deterministicInvestigationRules",
            },
        )
        for system in systems.values():
            self.assertEqual(system["eligibleEpisodes"], 440)
            self.assertEqual(
                set(system["metrics"]),
                {
                    "truePositives",
                    "falsePositives",
                    "trueNegatives",
                    "falseNegatives",
                    "precision",
                    "recall",
                    "f1",
                    "falsePositiveRate",
                },
            )

        deterministic = systems["deterministicInvestigationRules"]
        self.assertEqual(deterministic["status"], "partially-evaluated")
        self.assertEqual(
            deterministic["compatibleRules"],
            list(temporal.INVESTIGATION_COMPATIBLE_RULES),
        )
        self.assertEqual(len(deterministic["excludedRules"]), 6)
        self.assertTrue(all(entry["reason"] for entry in deterministic["excludedRules"]))
        investigation_source = (
            Path(__file__).resolve().parents[2] / deterministic["implementationSource"]
        )
        self.assertEqual(
            deterministic["implementationSourceSha256"],
            hashlib.sha256(investigation_source.read_bytes()).hexdigest(),
        )
        self.assertEqual(
            deterministic["compatibleRuleDefinitions"][
                "investigation.vibration.rolling-noise"
            ]["threshold"],
            0.025,
        )
        linear = systems["linearPredictionBaseline"]
        self.assertEqual(linear["parameters"]["channels"], list(temporal.CHANNELS))
        self.assertEqual(set(linear["parameters"]["residualCenter"]), set(temporal.CHANNELS))
        persistence = systems["persistencePredictionBaseline"]
        self.assertEqual(persistence["parameters"]["prediction"], "value[t] = value[t-1]")
        self.assertAlmostEqual(persistence["metrics"]["f1"], 0.75, places=12)
        self.assertEqual(persistence["metrics"]["falsePositiveRate"], 0.0)
        self.assertIn("observations only", comparison["comparability"]["groundTruthUse"])

    def test_post_hoc_generalization_challenge_is_disjoint_frozen_and_non_gating(self) -> None:
        _, evaluation, _ = temporal.train_temporal_model()
        challenge = evaluation["postHocGeneralizationChallenge"]
        self.assertEqual(
            challenge["schemaVersion"],
            temporal.GENERALIZATION_CHALLENGE_VERSION,
        )
        self.assertEqual(challenge["status"], "post-hoc-non-gating")
        self.assertFalse(challenge["releaseGate"]["included"])
        self.assertTrue(all(challenge["seedPartition"].values()))
        self.assertEqual(challenge["heldOutSeeds"], list(temporal.POST_HOC_CHALLENGE_SEEDS))
        self.assertFalse(challenge["frozenInference"]["fitOrCalibrationOnChallenge"])
        self.assertEqual(
            challenge["frozenInference"]["artifactSha256"],
            "8d238523f942ccc2b4f60a0048ff413018059dd1e583a1be216653bc3ef60cf4",
        )
        self.assertEqual(challenge["frozenInference"]["inferenceInputs"], list(temporal.CHANNELS))
        self.assertIn("outside inference", challenge["groundTruthUse"])

        dimensions = challenge["dimensions"]
        self.assertEqual(
            set(dimensions),
            {
                "unseenMagnitude",
                "activeDurationAndOnsetPhase",
                "novelFaultCombinations",
            },
        )
        magnitude = dimensions["unseenMagnitude"]
        self.assertEqual(
            [entry["magnitude"] for entry in magnitude["configurations"]],
            [0.45, 1.60],
        )
        self.assertEqual(magnitude["results"]["population"]["totalEpisodes"], 210)
        magnitude_metrics = magnitude["results"]["episodeMetrics"]
        self.assertEqual(
            (
                magnitude_metrics["truePositives"],
                magnitude_metrics["falsePositives"],
                magnitude_metrics["trueNegatives"],
                magnitude_metrics["falseNegatives"],
            ),
            (114, 0, 10, 86),
        )
        self.assertAlmostEqual(magnitude_metrics["f1"], 0.726114649682, places=12)

        placement = dimensions["activeDurationAndOnsetPhase"]
        self.assertEqual(placement["results"]["population"]["totalEpisodes"], 410)
        self.assertEqual(
            [entry["onsetSample"] for entry in placement["configurations"]],
            [3, 17, 28, 30],
        )
        self.assertEqual(placement["results"]["episodeMetrics"]["truePositives"], 150)
        self.assertEqual(placement["results"]["episodeMetrics"]["falseNegatives"], 250)

        combinations = dimensions["novelFaultCombinations"]
        self.assertEqual(combinations["results"]["population"]["totalEpisodes"], 60)
        self.assertEqual(
            combinations["results"]["classificationMetric"],
            "not-scored-no-declared-combination-class",
        )
        self.assertEqual(
            combinations["results"]["componentHypothesisSummary"][
                "topThreeComponentCoverage"
            ],
            1.0,
        )

    def test_transient_challenge_fault_recovers_and_metadata_is_separate(self) -> None:
        example = temporal._generate_challenge_example(
            4101,
            "test-transient",
            ("gradual-drift",),
            onset=3,
            active_duration=7,
            magnitude=0.45,
        )
        repeated = temporal._generate_challenge_example(
            4101,
            "renamed-metadata",
            ("gradual-drift",),
            onset=3,
            active_duration=7,
            magnitude=0.45,
        )
        nominal = temporal._generate_challenge_nominal(4101)
        self.assertEqual(example.window, repeated.window)
        self.assertNotEqual(example.challenge_id, repeated.challenge_id)
        self.assertNotEqual(example.window[9], nominal.window[9])
        self.assertEqual(example.window[10:], nominal.window[10:])
        self.assertEqual(
            temporal.extract_features(example.window),
            temporal.extract_features(repeated.window),
        )

    def test_robust_covariance_comparison_uses_checked_in_artifact_identity(self) -> None:
        root = Path(__file__).resolve().parents[2]
        robust_path = root / "models" / "robust_covariance_v1.json"
        expected_hash = hashlib.sha256(robust_path.read_bytes()).hexdigest()
        _, evaluation, _ = temporal.train_temporal_model()
        robust = evaluation["baselineComparison"]["systems"]["robustCovarianceDetector"]
        self.assertEqual(robust["artifactSha256"], expected_hash)
        self.assertFalse(robust["recalibratedOnTemporalPopulation"])
        self.assertGreater(robust["excludedPointObservations"], 0)

    def test_checked_in_temporal_documents_are_exact_regeneration(self) -> None:
        root = Path(__file__).resolve().parents[2]
        artifact, evaluation, parity = temporal.train_temporal_model()
        expected_documents = {
            "temporal_fault_model_v1.json": temporal._rounded(artifact),
            "temporal_evaluation_v1.json": temporal._rounded(evaluation),
            "temporal_inference_parity_v1.json": temporal._rounded(parity),
        }
        for name, expected in expected_documents.items():
            actual = json.loads((root / "models" / name).read_text(encoding="utf-8"))
            self.assertEqual(actual, expected, name)
        self.assertEqual(
            hashlib.sha256((root / "models" / "temporal_fault_model_v1.json").read_bytes()).hexdigest(),
            "8d238523f942ccc2b4f60a0048ff413018059dd1e583a1be216653bc3ef60cf4",
        )

    def test_parity_vector_matches_python_prediction(self) -> None:
        root = Path(__file__).resolve().parents[2]
        artifact = json.loads(
            (root / "models" / "temporal_fault_model_v1.json").read_text(encoding="utf-8")
        )
        parity = json.loads(
            (root / "models" / "temporal_inference_parity_v1.json").read_text(encoding="utf-8")
        )
        prediction = temporal._predict(
            temporal.extract_features(parity["window"]),
            artifact["featureCenter"],
            artifact["featureScale"],
            artifact["classCentroids"],
            artifact["classRadii"],
            artifact["confidenceThreshold"],
            artifact["temperature"],
            artifact["anomalyMarginThreshold"],
        )
        expected = parity["expected"]
        self.assertEqual(prediction["predictedLabel"], expected["predictedLabel"])
        self.assertEqual(prediction["nearestLabel"], expected["nearestLabel"])
        self.assertLessEqual(abs(prediction["confidence"] - expected["confidence"]), parity["absoluteTolerance"])
        self.assertLessEqual(abs(prediction["distance"] - expected["distance"]), parity["absoluteTolerance"])

    def test_artifact_write_round_trip(self) -> None:
        output = Path(__file__).resolve().parents[2] / "release" / ".test-temporal-artifacts"
        artifact, evaluation, parity = temporal.write_temporal_artifacts(output)
        self.assertEqual(
            json.loads((output / "temporal_fault_model_v1.json").read_text(encoding="utf-8"))["artifactVersion"],
            artifact["artifactVersion"],
        )
        self.assertEqual(
            json.loads((output / "temporal_evaluation_v1.json").read_text(encoding="utf-8"))["qualityGate"],
            temporal._rounded(evaluation)["qualityGate"],
        )
        self.assertEqual(
            json.loads((output / "temporal_inference_parity_v1.json").read_text(encoding="utf-8"))["expected"],
            temporal._rounded(parity)["expected"],
        )
        self.assertEqual(
            (output / "TEMPORAL_MODEL_CARD.md").read_text(encoding="utf-8"),
            (Path(__file__).resolve().parents[2] / "models" / "TEMPORAL_MODEL_CARD.md").read_text(
                encoding="utf-8"
            ),
        )


if __name__ == "__main__":
    unittest.main()
