"""Fit portable experimental classifiers using every causal mission endpoint.

Inputs are created only by the existing TypeScript generator and observed encoder.
No final/development data is loaded by this module. No pickle loading is required.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import platform
import warnings
from pathlib import Path

import numpy as np
import scipy
import sklearn
from sklearn.ensemble import RandomForestClassifier
from sklearn.exceptions import ConvergenceWarning
from sklearn.linear_model import LogisticRegression


def file_hash(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read_corpus(directory: Path) -> tuple[dict, np.ndarray, np.ndarray, np.ndarray, list[dict]]:
    manifest = json.loads((directory / 'manifest.json').read_text())
    rows, labels, weights, cases = [], [], [], []
    expected_seeds = manifest['protocol']['fitSeeds' if manifest['stage'] == 'fit' else 'calibrationSeeds']
    if manifest['stage'] not in ('fit', 'calibration') or manifest['seeds'] != expected_seeds:
        raise ValueError('Training only accepts reserved fitting/calibration partitions.')
    for name, expected_hash, expected_file_hash in zip(manifest['batchFiles'], manifest['batchHashes'], manifest['batchFileHashes'], strict=True):
        if file_hash(directory / name) != expected_file_hash:
            raise ValueError('Corpus metadata checksum mismatch.')
        batch = json.loads((directory / name).read_text())
        path = directory / batch['featureFile']
        if batch['contentSha256'] != expected_hash or file_hash(path) != batch['featureSha256'] or batch['sourceSha256'] != manifest['sourceSha256']:
            raise ValueError('Corpus integrity mismatch.')
        data = np.fromfile(path, dtype='<f8').reshape(batch['rows'], batch['columns'])
        if not np.isfinite(data).all() or data.shape[1] != len(manifest['featureNames']) or len(batch['cases']) * 141 != len(data):
            raise ValueError('Invalid corpus dimensions or observations.')
        rows.append(data)
        for case in batch['cases']:
            timeline = case['faultTimeline']
            target = mission_target(timeline)
            weight = np.zeros(141)
            for label in (0, 1):
                count = np.count_nonzero(target == label)
                if count:
                    weight[target == label] = 1 / count
            labels.append(target); weights.append(weight); cases.append(case)
    if [case['spec']['options']['seed'] for case in cases[::41]] != expected_seeds or len(cases) != len(expected_seeds) * 41:
        raise ValueError('Incomplete or reordered seed/case matrix.')
    x, y, weight = np.concatenate(rows), np.concatenate(labels), np.concatenate(weights)
    if len(x) != manifest['rows']:
        raise ValueError('Corpus row count mismatch.')
    for label in (0, 1):
        total = weight[y == label].sum()
        if total <= 0:
            raise ValueError('Both supervised target classes are required.')
        weight[y == label] *= len(y) / (2 * total)
    return manifest, x, y, weight, cases


def mission_target(timeline: dict | None) -> np.ndarray:
    if timeline is not None and not (0 <= timeline['onsetIndex'] <= timeline['activeEndIndex'] <= timeline['recoveryEndIndex'] < 180):
        raise ValueError('Invalid supervised timeline.')
    return np.array([int(timeline is not None and timeline['onsetIndex'] <= end <= timeline['recoveryEndIndex']) for end in range(39, 180)], dtype=np.int8)


def fit_scaler(x: np.ndarray, resolutions: np.ndarray) -> dict:
    if x.ndim != 2 or not len(x) or resolutions.shape != (x.shape[1],) or not np.isfinite(x).all() or not np.isfinite(resolutions).all() or np.any(resolutions <= 0):
        raise ValueError('Finite observations and positive scale floors required.')
    low, center, high = np.quantile(x, [.25, .5, .75], axis=0)
    scale = np.maximum.reduce([(high-low)/1.349, .1*x.std(axis=0), resolutions])
    constant = np.ptp(x, axis=0) <= 1e-12
    return {'center':center.tolist(), 'scale':scale.tolist(), 'constantMask':constant.tolist(), 'clip':50}


def transform(x: np.ndarray, scaler: dict) -> np.ndarray:
    if not np.isfinite(x).all():
        raise ValueError('Nonfinite feature input.')
    z = np.clip((x - np.asarray(scaler['center'])) / np.asarray(scaler['scale']), -scaler['clip'], scaler['clip'])
    z[:, np.asarray(scaler['constantMask'])] = 0
    return z


def thresholds(scores: np.ndarray, cases: list[dict]) -> list[float]:
    if len(scores) != len(cases)*141 or not np.isfinite(scores).all() or np.any((scores<0)|(scores>1)):
        raise ValueError('Invalid calibration scores.')
    maxima = np.array([scores[i*141:(i+1)*141].max() for i,c in enumerate(cases) if c['spec']['family'] == 'nominal'])
    ordered = np.sort(maxima)
    if not len(ordered):
        raise ValueError('Nominal calibration controls required.')
    # Strict score > threshold means an exact calibration maximum stays clear.
    values = [.5] + [float(ordered[max(0, int(np.ceil(q*len(ordered)))-1)]) for q in (.5,.9,.95,1)]
    return sorted(set(values))


def export_forest(model: RandomForestClassifier) -> list[dict]:
    result = []
    for estimator in model.estimators_:
        tree = estimator.tree_
        positive = tree.value[:,0,1] / tree.value[:,0,:].sum(axis=1)
        result.append({'left':tree.children_left.tolist(),'right':tree.children_right.tolist(),'feature':tree.feature.tolist(),'threshold':tree.threshold.tolist(),'positive':positive.tolist()})
    return result


def train(output: Path) -> dict:
    fit, x, y, weights, _ = read_corpus(output/'corpus/fit')
    calibration, cx, _, _, cases = read_corpus(output/'corpus/calibration')
    if fit['sourceSha256'] != calibration['sourceSha256'] or fit['featureNames'] != calibration['featureNames']:
        raise ValueError('Mismatched fitting and calibration provenance.')
    scaler = fit_scaler(x, np.asarray(fit['resolutions']))
    z, cz = transform(x, scaler), transform(cx, scaler)
    configuration = fit['protocol']['models']
    models = {}
    with warnings.catch_warnings():
        warnings.simplefilter('error', ConvergenceWarning)
        linear = LogisticRegression(**configuration['linear']).fit(z, y, sample_weight=weights)
    scores = linear.predict_proba(cz)[:,1]
    models['linear'] = {'type':'logistic','coefficients':linear.coef_[0].tolist(),'intercept':float(linear.intercept_[0]),'thresholds':thresholds(scores,cases)}
    print('Linear fit completed.', flush=True)
    forest = RandomForestClassifier(**configuration['forest']).fit(z, y, sample_weight=weights)
    forest_scores = forest.predict_proba(cz)[:,1]
    models['forest'] = {'type':'random-forest','trees':export_forest(forest),'thresholds':thresholds(forest_scores,cases),'featureImportances':forest.feature_importances_.tolist()}
    print('Forest fit completed.', flush=True)
    indices = np.linspace(0,len(cx)-1,41,dtype=int)
    # Include high-scoring and nominal-max windows in cross-runtime parity evidence.
    indices = np.unique(np.concatenate([indices, np.argsort(forest_scores)[-10:], np.argsort(scores)[-10:]]))
    result = {'schemaVersion':'full-mission-supervised-model.v1','sourceSha256':fit['sourceSha256'],'fitManifestSha256':fit['contentSha256'],'calibrationManifestSha256':calibration['contentSha256'],'protocol':fit['protocol'],'featureNames':fit['featureNames'],'scaler':scaler,'models':models,'parity':[{'features':cx[i].tolist(),'linear':float(scores[i]),'forest':float(forest_scores[i])} for i in indices],'fitSummary':{'missions':len(y)//141,'windows':len(y),'positiveWindows':int(y.sum()),'constantFeatureCount':int(sum(scaler['constantMask'])),'minimumScale':min(scaler['scale']),'clippedFraction':float(np.mean(np.abs(z)>=50))},'environment':{'python':platform.python_version(),'numpy':np.__version__,'scipy':scipy.__version__,'sklearn':sklearn.__version__},'scoreMeaning':'Experimental supervised fault-presence score; not a calibrated operational probability.'}
    path = output/'model.json'
    if path.exists():
        if json.loads(path.read_text()) != result:
            raise ValueError('Existing model differs; never overwrite a frozen candidate.')
    else:
        temporary = path.with_suffix('.tmp')
        temporary.write_text(json.dumps(result,sort_keys=True,separators=(',',':'))+'\n')
        temporary.replace(path)
    print(json.dumps({'modelSha256':file_hash(path),'fit':result['fitSummary'],'thresholds':{k:v['thresholds'] for k,v in models.items()}}),flush=True)
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output',type=Path,required=True)
    args = parser.parse_args()
    if (args.output/'selection.json').exists() or (args.output/'final/manifest.json').exists():
        raise SystemExit('Training is frozen after candidate selection.')
    train(args.output)
