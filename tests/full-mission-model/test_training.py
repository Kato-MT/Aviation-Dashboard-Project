"""Numerical regression checks run in the experiment's pinned Python environment."""
from __future__ import annotations
import importlib.util
import unittest
from pathlib import Path
import numpy as np
from sklearn.ensemble import RandomForestClassifier

PATH = Path(__file__).resolve().parents[2] / 'tools/full-mission-model/train.py'
SPEC = importlib.util.spec_from_file_location('full_mission_train', PATH)
TRAIN = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(TRAIN)


class TrainingTests(unittest.TestCase):
    def test_TC_SMP_001_robust_scaling_floors_and_constant_mask(self):
        x = np.array([[0., 7., 0.], [2., 7., 0.], [4., 7., 0.], [6., 7., .01]])
        saved = x.copy()
        scaler = TRAIN.fit_scaler(x, np.array([.001,.001,.025]))
        self.assertEqual(scaler['center'], [3.,7.,0.])
        self.assertAlmostEqual(scaler['scale'][0],3/1.349)
        self.assertEqual(scaler['scale'][1:], [.001,.025])
        self.assertEqual(scaler['constantMask'], [False,True,False])
        np.testing.assert_array_equal(x,saved)
        transformed = TRAIN.transform(np.array([[1e6,999.,-.05]]),scaler)
        np.testing.assert_array_equal(transformed, [[50.,0.,-2.]])
        self.assertEqual(scaler['center'], [3.,7.,0.])

    def test_TC_SMP_002_invalid_training_values_fail(self):
        for x, floors in [(np.array([[np.nan]]),np.array([1.])),(np.empty((0,1)),np.array([1.])),(np.zeros((2,1)),np.array([0.])),(np.zeros((2,1)),np.array([np.nan]))]:
            with self.assertRaises(ValueError): TRAIN.fit_scaler(x,floors)
        with self.assertRaises(ValueError): TRAIN.transform(np.array([[np.inf]]),{'center':[0.],'scale':[1.],'constantMask':[False],'clip':50})

    def test_TC_SMP_003_endpoint_labels_include_recovery_but_not_later_samples(self):
        target=TRAIN.mission_target({'onsetIndex':40,'activeEndIndex':43,'recoveryEndIndex':46})
        np.testing.assert_array_equal(target[:9], [0,1,1,1,1,1,1,1,0])
        self.assertEqual(int(target.sum()),7)
        self.assertEqual(int(TRAIN.mission_target(None).sum()),0)
        with self.assertRaises(ValueError): TRAIN.mission_target({'onsetIndex':45,'activeEndIndex':43,'recoveryEndIndex':46})

    def test_TC_SMP_004_thresholds_use_nominal_mission_maxima_only(self):
        cases=[{'spec':{'family':f}} for f in ['nominal','fault','nominal','nominal','nominal']]
        scores=np.concatenate([np.full(141,v) for v in [.1,.99,.2,.3,.4]])
        self.assertEqual(TRAIN.thresholds(scores,cases),[.2,.4,.5])
        scores[141:282]=0
        self.assertEqual(TRAIN.thresholds(scores,cases),[.2,.4,.5])
        with self.assertRaises(ValueError): TRAIN.thresholds(scores[:-1],cases)
        with self.assertRaises(ValueError): TRAIN.thresholds(np.zeros(141),[{'spec':{'family':'fault'}}])

    def test_TC_SMP_005_exported_tree_leaves_reproduce_sklearn(self):
        x=np.array([[i,j] for i in range(10) for j in range(4)],dtype=float)
        y=np.array([int(i+j>6) for i,j in x])
        model=RandomForestClassifier(n_estimators=5,max_depth=3,random_state=13).fit(x,y)
        trees=TRAIN.export_forest(model)
        actual=[]
        for row in x.astype(np.float32):
            values=[]
            for tree in trees:
                index=0
                while tree['left'][index] != -1:
                    index=tree['left'][index] if row[tree['feature'][index]] <= tree['threshold'][index] else tree['right'][index]
                values.append(tree['positive'][index])
            actual.append(sum(values)/len(values))
        np.testing.assert_allclose(actual,model.predict_proba(x)[:,1],rtol=0,atol=1e-15)


if __name__ == '__main__': unittest.main()
