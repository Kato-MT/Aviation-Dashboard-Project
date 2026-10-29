"""Fixture-only checks for the residual/lag feature ablation and portable export."""
from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
from sklearn.ensemble import RandomForestClassifier

PATH = Path(__file__).resolve().parents[2] / 'tools/residual-lag/train.py'
SPEC = importlib.util.spec_from_file_location('residual_lag_train', PATH)
TRAIN = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(TRAIN)


def feature_names():
    suffixes = ['mean', 'std', 'half-shift', 'd1-rms', 'd2-rms', 'd4-rms',
                'curvature-rms', 'freeze-ratio', 'missing-fraction']
    names = [f'{channel}.{suffix}' for channel in ['airspeed', 'altitude', 'verticalRate', 'fuel', 'vibration'] for suffix in suffixes]
    names += ['cross.altitude-vertical-rate-correlation', 'cross.altitude-vertical-rate-best-lag',
              'cross.altitude-vertical-rate-lag-improvement', 'cross.airspeed-altitude-correlation',
              'cross.fuel-slope', 'cross.vibration-growth-ratio']
    names += [f'{pair}-disagreement.{suffix}' for pair in ['altitude', 'speed', 'rate'] for suffix in ['current-absolute', 'mean5', 'rms5', 'missing5']]
    names += ['fuel-flow.mean5', 'fuel-flow.missing5', 'fuel.decline5', 'barometric-altitude.range5',
              'gps-altitude.range5', 'vibration.std5', 'speed-disagreement.mean20',
              'speed-lag.best-offset20', 'speed-lag.rms-improvement20']
    names += [f'{pair}-disagreement.{suffix}' for pair in ['altitude', 'speed', 'rate'] for suffix in ['mean15', 'rms15', 'missing15']]
    return names + ['speed-lag.signed-smoothed-evidence', 'speed-lag.valid-support-fraction']


def portable_scores(trees, global_rows):
    scores = []
    for row in np.asarray(global_rows, dtype=np.float32):
        positive = []
        for tree in trees:
            node = 0
            while tree['left'][node] != -1:
                branch = 'left' if row[tree['feature'][node]] <= tree['threshold'][node] else 'right'
                node = tree[branch][node]
            positive.append(tree['positive'][node])
        scores.append(sum(positive) / len(positive))
    return np.asarray(scores)


class ResidualLagTrainingTests(unittest.TestCase):
    def test_TC_RLP_001_feature_masks_keep_original_control_and_remove_only_two_old_lags(self):
        names = feature_names()
        original = names.copy()
        self.assertEqual(len(names), 83)
        self.assertEqual(TRAIN.active_features(names, 'control'), list(range(72)))
        self.assertEqual(TRAIN.active_features(names, 'targeted'), list(range(70)) + list(range(72, 83)))
        self.assertEqual(names, original)

    def test_TC_RLP_002_malformed_feature_contracts_fail_before_fitting(self):
        names = feature_names()
        reordered = names.copy()
        reordered[0], reordered[1] = reordered[1], reordered[0]
        duplicate = names.copy()
        duplicate[-1] = duplicate[-2]
        wrong_added = names.copy()
        wrong_added[72] = 'altitude-disagreement.mean16'
        wrong_old_lag = names.copy()
        wrong_old_lag[70] = 'speed-lag.best-offset30'
        for bad in [names[:-1], duplicate, wrong_added, wrong_old_lag]:
            with self.subTest(names=bad):
                for model_id in ['control', 'targeted']:
                    with self.assertRaises(ValueError):
                        TRAIN.active_features(bad, model_id)
        with self.assertRaises(ValueError):
            TRAIN.active_features(names, 'unknown')
        # Prefix ordering is bound to the pinned incumbent during train(), before fitting.
        manifest = {'sourceSha256': 'fixture', 'featureNames': reordered,
                    'resolutions': [.001] * 83, 'protocol': {'models': {'forest': {}}}}
        corpus = (manifest, np.zeros((2, 83)), np.array([0, 1]), np.ones(2), [])
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            (output / 'incumbent.json').write_text(json.dumps({'featureNames': names[:72]}))
            with patch.object(TRAIN.base, 'read_corpus', side_effect=[corpus, corpus]), \
                 patch.object(TRAIN, 'RandomForestClassifier', side_effect=AssertionError('Fitting must not start')) as constructor:
                with self.assertRaises(ValueError):
                    TRAIN.train(output)
                constructor.assert_not_called()

    def test_TC_RLP_003_thresholds_use_mission_maxima_and_preserve_strict_boundary(self):
        cases = [{'spec': {'family': family}} for family in ['nominal', 'fault', 'nominal', 'nominal', 'nominal']]
        scores = np.zeros(141 * len(cases))
        for mission, value in enumerate([.11, .99, .22, .33, .44]):
            scores[mission * 141 + 17] = value
        self.assertEqual(TRAIN.thresholds(scores, cases), [.22, .33, .44, .5, .6, .7, .8, .9, .95])
        scores[141:282] = 0
        self.assertEqual(TRAIN.thresholds(scores, cases), [.22, .33, .44, .5, .6, .7, .8, .9, .95])
        # A calibration maximum must survive without rounding below its exact value.
        maximum = float(np.nextafter(.9, 1.))
        nominal = np.full(141, .1)
        nominal[-1] = maximum
        choices = TRAIN.thresholds(nominal, [{'spec': {'family': 'nominal'}}])
        self.assertIn(maximum, choices)
        self.assertFalse(np.any(nominal > maximum))
        self.assertTrue(np.any(nominal > np.nextafter(maximum, 0.)))

    def test_TC_RLP_004_invalid_calibration_scores_or_missing_controls_fail(self):
        cases = [{'spec': {'family': 'nominal'}}]
        for scores in [np.zeros(140), np.full(141, np.nan), np.full(141, np.inf),
                       np.full(141, -.01), np.full(141, 1.01)]:
            with self.subTest(first=scores[0], length=len(scores)):
                with self.assertRaises(ValueError):
                    TRAIN.thresholds(scores, cases)
        with self.assertRaises(ValueError):
            TRAIN.thresholds(np.zeros(141), [{'spec': {'family': 'fault'}}])
        with self.assertRaises(ValueError):
            TRAIN.thresholds(np.array([]), [])

    def test_TC_RLP_005_exported_noncontiguous_feature_indices_preserve_forest_predictions(self):
        # Arbitrary fixture coordinates, independent of every mission seed partition.
        columns = [2, 13, 72, 80, 82]
        local = np.array([[a, b, c, a-b, c-a] for a in range(-3, 4) for b in range(-2, 3) for c in range(-2, 3)], dtype=float)
        labels = ((local[:, 2] + 2 * local[:, 4] - local[:, 1]) > 0).astype(int)
        weights = 1 + (np.arange(len(local)) % 4) / 4
        forest = RandomForestClassifier(n_estimators=7, max_depth=4, max_features=None, random_state=17, n_jobs=1).fit(local, labels, sample_weight=weights)
        trees = TRAIN.export_forest(forest, columns)
        local_trees = TRAIN.base.export_forest(forest)
        used = set()
        for tree, original in zip(trees, local_trees, strict=True):
            for feature, before in zip(tree['feature'], original['feature'], strict=True):
                self.assertEqual(feature, columns[before] if before >= 0 else before)
                if feature >= 0:
                    used.add(feature)
            for key in ['left', 'right', 'threshold', 'positive']:
                self.assertEqual(tree[key], original[key])
        self.assertTrue(used.intersection({72, 80, 82}))
        self.assertTrue(used.issubset(columns))
        queries = np.concatenate([local, local[:25] + .12345])
        global_rows = np.full((len(queries), 83), 10000.)
        global_rows[:, columns] = queries
        expected = forest.predict_proba(queries)[:, 1]
        np.testing.assert_allclose(portable_scores(trees, global_rows), expected, rtol=0, atol=1e-15)
        # Unselected global columns must not affect the exported model.
        unselected = [i for i in range(83) if i not in columns]
        global_rows[:, unselected] = -10000.
        np.testing.assert_allclose(portable_scores(trees, global_rows), expected, rtol=0, atol=1e-15)


if __name__ == '__main__':
    unittest.main()
