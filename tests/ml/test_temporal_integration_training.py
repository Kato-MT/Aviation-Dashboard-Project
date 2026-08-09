from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

import tools.ml.train_temporal_integration_model as integration


class TemporalIntegrationTrainingTests(unittest.TestCase):
    def test_distance_uses_cross_runtime_stable_summation(self) -> None:
        # Built-in sum loses a low-order bit for this squared-distance vector.
        left = [8.826206015115842, 2.1906508158960874e-36, 10.0414161998145]
        right = [0.0, 0.0, 0.0]

        self.assertEqual(integration._distance(left, right), 59.57731730638806)

    def test_actual_typescript_corpus_is_balanced_deterministic_and_disjoint(self) -> None:
        first = integration.load_integration_corpus()
        second = integration.load_integration_corpus()
        self.assertEqual(first, second)
        self.assertEqual(first["schemaVersion"], "temporal-integration-corpus.v1")
        self.assertEqual(first["projection"]["id"], "investigation-model-projection")
        self.assertEqual(first["projection"]["windowLength"], 40)
        split_seeds = [set(first["splits"][name]["seeds"]) for name in ("training", "calibration", "heldOut")]
        self.assertFalse(split_seeds[0] & split_seeds[1])
        self.assertFalse(split_seeds[0] & split_seeds[2])
        self.assertFalse(split_seeds[1] & split_seeds[2])
        for split, expected_per_label in (("training", 40), ("calibration", 20), ("heldOut", 40)):
            examples = first["splits"][split]["examples"]
            counts = {
                label: sum(example["label"] == label for example in examples)
                for label in integration.LABELS
            }
            self.assertEqual(set(counts.values()), {expected_per_label})

    def test_training_is_reproducible_and_passes_the_integration_gate(self) -> None:
        first = integration.train_temporal_integration_model()
        second = integration.train_temporal_integration_model()
        self.assertEqual(first, second)
        artifact = first[0]
        self.assertEqual(artifact["modelVersion"], "2.0.0")
        self.assertEqual(
            artifact["modelType"], "causal-multiscale-feature-nearest-prototype"
        )
        self.assertTrue(artifact["qualityGate"]["passed"])
        self.assertTrue(artifact["enabledByDefault"])
        self.assertGreater(artifact["evaluation"]["answeredObservations"], 0)
        self.assertLess(artifact["evaluation"]["abstentionRate"], 1.0)
        self.assertGreaterEqual(
            artifact["evaluation"]["selectedWindowMetrics"]["f1"],
            integration.MINIMUM_OBSERVATION_F1,
        )
        self.assertLessEqual(
            artifact["evaluation"]["selectedWindowMetrics"]["falsePositiveRate"],
            integration.MAXIMUM_FALSE_POSITIVE_RATE,
        )
        self.assertGreaterEqual(
            artifact["evaluation"]["classificationMacroF1"],
            integration.MINIMUM_CLASSIFICATION_MACRO_F1,
        )
        self.assertEqual(
            artifact["qualityGate"]["minimumPerFaultClassificationRecall"], 0.65
        )
        for result in artifact["evaluation"]["byFault"].values():
            self.assertGreaterEqual(result["classificationRecall"], 0.65)
        false_positive_evidence = artifact["evaluation"]["falsePositiveRateEvidence"]
        self.assertEqual(false_positive_evidence["falsePositiveWindows"], 2)
        self.assertEqual(false_positive_evidence["nominalWindows"], 40)
        self.assertGreater(false_positive_evidence["exactOneSidedUpper95"], 0.05)
        self.assertFalse(
            false_positive_evidence["populationRateAtMostFivePercentEstablished"]
        )

    def test_configuration_hash_covers_selection_corpus_and_threshold_contract(self) -> None:
        artifact, _, _, canonical_configuration = (
            integration.train_temporal_integration_model()
        )
        configuration = json.loads(canonical_configuration)
        self.assertEqual(
            configuration["corpus"]["splitSeeds"]["heldOut"],
            list(range(9101, 9141)),
        )
        self.assertEqual(
            configuration["prototypePartitionKeys"], ["lifecycle", "endPhase"]
        )
        self.assertEqual(
            configuration["featureScaleMultipliers"],
            {"mean": 0.5, "halfShift": 0.5},
        )
        self.assertIn("classRadiusPercentile", configuration["distanceCalibration"])
        self.assertIn("classRadiusSafetyFactor", configuration["distanceCalibration"])
        self.assertIn("anomalyDistanceThreshold", configuration["distanceCalibration"])
        self.assertEqual(
            configuration["relativeSimilarity"]["method"],
            "softmax-normalized-negative-distance-not-calibrated-probability",
        )
        self.assertEqual(
            configuration["relativeSimilarity"]["temperature"],
            integration.RELATIVE_SCORE_TEMPERATURE,
        )
        self.assertEqual(
            artifact["training"]["configurationSha256"],
            hashlib.sha256(canonical_configuration.encode("utf-8")).hexdigest(),
        )
        self.assertTrue(
            all("lifecycle" not in name and "truth" not in name for name in artifact["featureNames"])
        )

    def test_checked_in_v2_artifacts_are_exact_regeneration(self) -> None:
        root = Path(__file__).resolve().parents[2]
        artifact, evaluation, parity, canonical_configuration = (
            integration.train_temporal_integration_model()
        )
        expected = {
            "temporal_fault_model_v2.json": integration._rounded(artifact),
            "temporal_evaluation_v2.json": integration._rounded(evaluation),
            "temporal_inference_parity_v2.json": integration._rounded(parity),
        }
        for name, document in expected.items():
            actual = json.loads((root / "models" / name).read_text(encoding="utf-8"))
            self.assertEqual(actual, document, name)
        artifact_bytes = (root / "models" / "temporal_fault_model_v2.json").read_bytes()
        self.assertEqual(
            hashlib.sha256(artifact_bytes).hexdigest(),
            "4cdea6792b8d302a8cc0197caccbb4498b18d136b1c2ed93fe798d66a82633af",
        )
        self.assertEqual(
            hashlib.sha256(canonical_configuration.encode("utf-8")).hexdigest(),
            "30300e753e278f3ea8633fe71fb6ecdcdecf5a52146c85d2c22c6e2facbe956c",
        )

    def test_artifact_write_round_trip_includes_generated_model_card(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            artifact, evaluation, parity = integration.write_temporal_integration_artifacts(output)
            self.assertEqual(
                json.loads((output / "temporal_fault_model_v2.json").read_text(encoding="utf-8")),
                integration._rounded(artifact),
            )
            self.assertEqual(
                json.loads((output / "temporal_evaluation_v2.json").read_text(encoding="utf-8")),
                integration._rounded(evaluation),
            )
            self.assertEqual(
                json.loads((output / "temporal_inference_parity_v2.json").read_text(encoding="utf-8")),
                integration._rounded(parity),
            )
            self.assertEqual(
                (output / "TEMPORAL_INTEGRATION_MODEL_CARD.md").read_text(encoding="utf-8"),
                (Path(__file__).resolve().parents[2] / "models" / "TEMPORAL_INTEGRATION_MODEL_CARD.md").read_text(encoding="utf-8"),
            )
            model_card = (output / "TEMPORAL_INTEGRATION_MODEL_CARD.md").read_text(
                encoding="utf-8"
            )
            self.assertIn("relative ranking scores", model_card)
            self.assertIn("not calibrated", model_card)


if __name__ == "__main__":
    unittest.main()
