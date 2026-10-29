import type { Artifact as Previous, Tree } from '../full-mission-model/model';
import { scaleFeatures } from '../full-mission-model/model';
import { hashObject } from '../mission-evaluation/protocol';
import { PROTOCOL } from './protocol';

export type ModelId = 'control' | 'targeted';
export interface Artifact {
  schemaVersion: 'residual-lag-model.v1';
  sourceSha256: string;
  fitManifestSha256: string;
  calibrationManifestSha256: string;
  protocol: typeof PROTOCOL;
  featureNames: string[];
  scaler: Previous['scaler'];
  models: Record<
    ModelId,
    { trees: Tree[]; activeFeatures: number[]; thresholds: number[]; featureImportances: number[] }
  >;
  parity: { features: number[]; scores: Record<ModelId, number> }[];
  fitSummary: {
    missions: number;
    windows: number;
    positiveWindows: number;
    constantFeatures: number;
  };
  environment: Record<string, string>;
}
export function validateArtifact(a: Artifact, source: string) {
  const n = a.featureNames.length,
    s = a.scaler;
  if (
    a.schemaVersion !== 'residual-lag-model.v1' ||
    a.sourceSha256 !== source ||
    hashObject(a.protocol) !== hashObject(PROTOCOL) ||
    n !== 83 ||
    new Set(a.featureNames).size !== n ||
    s.center.length !== n ||
    s.scale.length !== n ||
    s.constantMask.length !== n ||
    !s.center.every(Number.isFinite) ||
    s.scale.some((x) => !Number.isFinite(x) || x <= 0) ||
    s.constantMask.some((x) => typeof x !== 'boolean') ||
    s.clip !== 50 ||
    Object.keys(a.models).sort().join(',') !== 'control,targeted'
  )
    throw new Error('Invalid model/preprocessing provenance.');
  for (const id of ['control', 'targeted'] as const) {
    const m = a.models[id],
      expected = Array.from({ length: n }, (_, i) => i).filter((i) =>
        id === 'control' ? i < 72 : i !== 70 && i !== 71,
      );
    if (
      hashObject(m.activeFeatures) !== hashObject(expected) ||
      m.trees.length !== 64 ||
      !m.thresholds.length ||
      m.thresholds.some((x) => !Number.isFinite(x) || x < 0 || x > 1) ||
      m.featureImportances.length !== expected.length ||
      m.featureImportances.some((x) => !Number.isFinite(x) || x < 0)
    )
      throw new Error('Invalid model feature contract.');
    for (const tree of m.trees) {
      const size = tree.left.length;
      if (
        !size ||
        [tree.right, tree.feature, tree.threshold, tree.positive].some((x) => x.length !== size) ||
        !tree.threshold.every(Number.isFinite) ||
        tree.positive.some((x) => !Number.isFinite(x) || x < 0 || x > 1)
      )
        throw new Error('Invalid forest arrays.');
      for (let i = 0; i < size; i++)
        if (
          !(tree.left[i] === -1 && tree.right[i] === -1) &&
          (![tree.left[i]!, tree.right[i]!].every(
            (child) => Number.isInteger(child) && child > i && child < size,
          ) ||
            !expected.includes(tree.feature[i]!))
        )
          throw new Error('Invalid or cyclic tree.');
    }
  }
}
export function score(features: readonly number[], artifact: Artifact, id: ModelId) {
  if (!artifact.models[id]) throw new Error('Unknown model.');
  const z = scaleFeatures(features, artifact.scaler).map(Math.fround);
  let sum = 0;
  for (const tree of artifact.models[id].trees) {
    let i = 0;
    while (tree.left[i] !== -1)
      i = z[tree.feature[i]!]! <= tree.threshold[i]! ? tree.left[i]! : tree.right[i]!;
    sum += tree.positive[i]!;
  }
  return sum / artifact.models[id].trees.length;
}
export function verifyParity(artifact: Artifact) {
  if (!artifact.parity.length) throw new Error('Missing parity cases.');
  let maximumError = 0;
  for (const row of artifact.parity)
    for (const id of ['control', 'targeted'] as const) {
      const error = Math.abs(score(row.features, artifact, id) - row.scores[id]);
      if (!Number.isFinite(error) || error > 1e-10)
        throw new Error('Cross-runtime score mismatch.');
      maximumError = Math.max(maximumError, error);
    }
  return { cases: artifact.parity.length, maximumError, tolerance: 1e-10 };
}
