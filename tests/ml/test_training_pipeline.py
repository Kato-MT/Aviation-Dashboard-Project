from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from tools.ml.train_model import (
    MAXIMUM_FALSE_POSITIVE_RATE,
    MINIMUM_F1,
    confusion_metrics,
    generate_nominal,
    inject_labeled_faults,
    invert_matrix,
    mahalanobis_score,
    standardized,
    train_model,
    write_artifacts,
)


class LearnedBaselinePipelineTests(unittest.TestCase):
    def test_typescript_parity_vector_matches_python_reference(self) -> None:
        root = Path(__file__).resolve().parents[2]
        artifact = json.loads(
            (root / "models" / "robust_covariance_v1.json").read_text(encoding="utf-8")
        )
        vector = json.loads(
            (root / "models" / "inference_parity_v1.json").read_text(encoding="utf-8")
        )
        measurements = [vector["measurements"][channel] for channel in artifact["channels"]]
        actual = mahalanobis_score(
            standardized(measurements, artifact["center"], artifact["scale"]),
            artifact["inverseCovariance"],
        )
        self.assertLessEqual(
            abs(actual - vector["pythonScore"]), vector["absoluteTolerance"]
        )

    def test_nominal_generator_is_seeded_and_reproducible(self) -> None:
        self.assertEqual(generate_nominal(42, 10), generate_nominal(42, 10))
        self.assertNotEqual(generate_nominal(42, 10), generate_nominal(43, 10))

    def test_fault_generation_has_exact_labels(self) -> None:
        points = inject_labeled_faults(701, 100, fault_fraction=0.1)
        self.assertEqual(sum(point.is_fault for point in points), 10)
        self.assertTrue(all(point.fault_type for point in points if point.is_fault))
        self.assertTrue(all(point.fault_type is None for point in points if not point.is_fault))

    def test_matrix_inverse_uses_pivoting(self) -> None:
        inverse = invert_matrix([[0.0, 2.0], [1.0, 0.0]])
        self.assertAlmostEqual(inverse[0][0], 0.0)
        self.assertAlmostEqual(inverse[0][1], 1.0)
        self.assertAlmostEqual(inverse[1][0], 0.5)
        self.assertAlmostEqual(inverse[1][1], 0.0)

    def test_confusion_metrics_include_required_measures(self) -> None:
        metrics = confusion_metrics([True, True, False, False], [True, False, True, False])
        self.assertEqual(metrics["precision"], 0.5)
        self.assertEqual(metrics["recall"], 0.5)
        self.assertEqual(metrics["f1"], 0.5)
        self.assertEqual(metrics["falsePositiveRate"], 0.5)

    def test_committed_model_evidence_passes_enablement_gate(self) -> None:
        root = Path(__file__).resolve().parents[2]
        artifact = json.loads((root / "models" / "robust_covariance_v1.json").read_text(encoding="utf-8"))
        metrics = artifact["evaluation"]["metrics"]
        self.assertGreaterEqual(metrics["f1"], MINIMUM_F1)
        self.assertLessEqual(metrics["falsePositiveRate"], MAXIMUM_FALSE_POSITIVE_RATE)
        self.assertTrue(artifact["qualityGate"]["passed"])
        self.assertTrue(artifact["enabledByDefault"])

    def test_training_and_artifact_writes_are_reproducible(self) -> None:
        first = train_model(150, 150)
        second = train_model(150, 150)
        self.assertEqual(first, second)
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            write_artifacts(first, output)
            self.assertTrue((output / "robust_covariance_v1.json").exists())
            self.assertTrue((output / "evaluation_v1.json").exists())
            self.assertIn("Deterministic rules remain", (output / "MODEL_CARD.md").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
