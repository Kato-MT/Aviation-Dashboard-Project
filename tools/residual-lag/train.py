"""Paired feature ablation on fresh full-mission training data; no evaluation reads."""
from __future__ import annotations
import argparse
import importlib.util
import json
import platform
from pathlib import Path
import numpy as np
import scipy
import sklearn
from sklearn.ensemble import RandomForestClassifier

spec = importlib.util.spec_from_file_location('frozen_training', Path(__file__).parents[1] / 'full-mission-model/train.py')
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)

def thresholds(scores, cases):
    if len(scores) != len(cases) * 141 or not np.isfinite(scores).all() or np.any((scores < 0) | (scores > 1)):
        raise ValueError('Invalid calibration scores.')
    maxima = sorted(float(scores[i*141:(i+1)*141].max()) for i,c in enumerate(cases) if c['spec']['family'] == 'nominal')
    if not maxima:
        raise ValueError('Nominal calibration required.')
    return sorted(set([.5,.6,.7,.8,.9,.95] + [maxima[max(0,int(np.ceil(q*len(maxima)))-1)] for q in [.5,.75,.9,.95,1]]))

def active_features(names, model_id):
    suffix = [f'{pair}-disagreement.{summary}' for pair in ['altitude','speed','rate'] for summary in ['mean15','rms15','missing15']] + ['speed-lag.signed-smoothed-evidence','speed-lag.valid-support-fraction']
    if len(names) != 83 or len(set(names)) != 83 or names[70:72] != ['speed-lag.best-offset20', 'speed-lag.rms-improvement20'] or names[72:] != suffix:
        raise ValueError('Unexpected feature contract.')
    if model_id == 'control':
        return list(range(72))
    if model_id == 'targeted':
        return [i for i in range(83) if i not in (70,71)]
    raise ValueError('Unknown feature ablation.')

def export_forest(model, columns):
    trees = base.export_forest(model)
    for tree in trees:
        tree['feature'] = [columns[i] if i >= 0 else i for i in tree['feature']]
    return trees

def train(output):
    fit, x, y, weights, _ = base.read_corpus(output/'corpus/fit')
    calibration, cx, _, _, cases = base.read_corpus(output/'corpus/calibration')
    if fit['sourceSha256'] != calibration['sourceSha256'] or fit['featureNames'] != calibration['featureNames']:
        raise ValueError('Mismatched corpus provenance.')
    incumbent = json.loads((output/'incumbent.json').read_text())
    if fit['featureNames'][:72] != incumbent['featureNames']:
        raise ValueError('Original feature contract differs from incumbent.')
    scaler = base.fit_scaler(x, np.asarray(fit['resolutions']))
    z, cz = base.transform(x,scaler), base.transform(cx,scaler)
    models, predictions = {}, {}
    for model_id in ['control','targeted']:
        columns = active_features(fit['featureNames'], model_id)
        forest = RandomForestClassifier(**fit['protocol']['models']['forest']).fit(z[:,columns], y, sample_weight=weights)
        # Fixed-order probability reduction prevents parallel parity-value roundoff drift.
        forest.n_jobs = 1
        scores = forest.predict_proba(cz[:,columns])[:,1]
        trees = export_forest(forest, columns)
        models[model_id] = {'trees':trees,'activeFeatures':columns,'thresholds':thresholds(scores,cases),'featureImportances':forest.feature_importances_.tolist()}
        predictions[model_id] = scores
        print(f'{model_id} fit completed ({len(columns)} active features).',flush=True)
    indices = np.unique(np.concatenate([np.linspace(0,len(cx)-1,41,dtype=int)] + [np.argsort(v)[-10:] for v in predictions.values()]))
    result = {'schemaVersion':'residual-lag-model.v1','sourceSha256':fit['sourceSha256'],'fitManifestSha256':fit['contentSha256'],'calibrationManifestSha256':calibration['contentSha256'],'protocol':fit['protocol'],'featureNames':fit['featureNames'],'scaler':scaler,'models':models,'parity':[{'features':cx[i].tolist(),'scores':{k:float(v[i]) for k,v in predictions.items()}} for i in indices],'fitSummary':{'missions':len(y)//141,'windows':len(y),'positiveWindows':int(y.sum()),'constantFeatures':int(sum(scaler['constantMask']))},'environment':{'python':platform.python_version(),'numpy':np.__version__,'scipy':scipy.__version__,'sklearn':sklearn.__version__}}
    path = output/'model.json'
    if path.exists():
        if json.loads(path.read_text()) != result:
            raise ValueError('Existing model differs; never overwrite frozen evidence.')
    else:
        temp = path.with_suffix('.tmp')
        temp.write_text(json.dumps(result,sort_keys=True,separators=(',',':'))+'\n')
        temp.replace(path)
    print(json.dumps({'modelSha256':base.file_hash(path),'thresholds':{k:v['thresholds'] for k,v in models.items()}}),flush=True)
    return result

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output',type=Path,required=True)
    args = parser.parse_args()
    if (args.output/'selection.json').exists() or (args.output/'final/manifest.json').exists():
        raise SystemExit('Training frozen after selection.')
    train(args.output)
