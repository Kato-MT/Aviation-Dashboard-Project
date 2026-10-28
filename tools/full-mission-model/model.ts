import { hashObject } from '../mission-evaluation/protocol';
import { PROTOCOL } from './protocol';

export interface Tree {
  left: number[];
  right: number[];
  feature: number[];
  threshold: number[];
  positive: number[];
}
export type FittedModel =
  | { type: 'logistic'; coefficients: number[]; intercept: number; thresholds: number[] }
  | { type: 'random-forest'; trees: Tree[]; thresholds: number[]; featureImportances: number[] };
export interface Artifact {
  schemaVersion: 'full-mission-supervised-model.v1';
  sourceSha256: string;
  fitManifestSha256: string;
  calibrationManifestSha256: string;
  protocol: typeof PROTOCOL;
  featureNames: string[];
  scaler: { center: number[]; scale: number[]; constantMask: boolean[]; clip: number };
  models: Record<string, FittedModel>;
  parity: { features: number[]; linear: number; forest: number }[];
  fitSummary: {
    missions: number;
    windows: number;
    positiveWindows: number;
    constantFeatureCount: number;
    minimumScale: number;
    clippedFraction: number;
  };
  environment: Record<string, string>;
  scoreMeaning: string;
}
const finite = (array: readonly number[]) => array.every(Number.isFinite);
export function validateArtifact(a: Artifact, sourceSha256: string) {
  const n = a.featureNames.length,
    s = a.scaler;
  if (
    a.schemaVersion !== 'full-mission-supervised-model.v1' ||
    a.sourceSha256 !== sourceSha256 ||
    hashObject(a.protocol) !== hashObject(PROTOCOL) ||
    n === 0 ||
    new Set(a.featureNames).size !== n ||
    s.center.length !== n ||
    s.scale.length !== n ||
    s.constantMask.length !== n ||
    !finite(s.center) ||
    !finite(s.scale) ||
    s.scale.some((v) => v <= 0) ||
    s.constantMask.some((v) => typeof v !== 'boolean') ||
    s.clip !== 50
  )
    throw new Error('Invalid model/preprocessing provenance.');
  if (Object.keys(a.models).sort().join(',') !== 'forest,linear')
    throw new Error('Expected both preregistered supervised models.');
  for (const model of Object.values(a.models)) {
    if (
      !model.thresholds.length ||
      model.thresholds.some((v) => !Number.isFinite(v) || v < 0 || v > 1)
    )
      throw new Error('Invalid model thresholds.');
    if (model.type === 'logistic') {
      if (
        model.coefficients.length !== n ||
        !finite(model.coefficients) ||
        !Number.isFinite(model.intercept)
      )
        throw new Error('Invalid linear model.');
    } else if (model.type === 'random-forest') {
      if (model.trees.length !== PROTOCOL.models.forest.n_estimators)
        throw new Error('Invalid forest size.');
      for (const tree of model.trees) {
        const size = tree.left.length;
        if (
          !size ||
          [tree.right, tree.feature, tree.threshold, tree.positive].some(
            (v) => v.length !== size,
          ) ||
          !finite(tree.threshold) ||
          tree.positive.some((v) => !Number.isFinite(v) || v < 0 || v > 1)
        )
          throw new Error('Invalid forest arrays.');
        for (let i = 0; i < size; i++) {
          const leaf = tree.left[i] === -1 && tree.right[i] === -1;
          if (
            !leaf &&
            (![tree.left[i]!, tree.right[i]!].every(
              (child) => Number.isInteger(child) && child > i && child < size,
            ) ||
              !Number.isInteger(tree.feature[i]) ||
              tree.feature[i]! < 0 ||
              tree.feature[i]! >= n)
          )
            throw new Error('Invalid or cyclic tree.');
        }
      }
    } else throw new Error('Unknown experimental model.');
  }
}
export function scaleFeatures(features: readonly number[], s: Artifact['scaler']) {
  if (features.length !== s.center.length || !finite(features))
    throw new Error('Invalid observed features.');
  return features.map((v, i) =>
    s.constantMask[i] ? 0 : Math.max(-s.clip, Math.min(s.clip, (v - s.center[i]!) / s.scale[i]!)),
  );
}
export function scoreFeatures(features: readonly number[], artifact: Artifact, id: string): number {
  const model = artifact.models[id];
  if (!model) throw new Error('Unknown model ID.');
  const z = scaleFeatures(features, artifact.scaler);
  if (model.type === 'logistic') {
    const logit = model.intercept + z.reduce((sum, v, i) => sum + v * model.coefficients[i]!, 0);
    return logit >= 0 ? 1 / (1 + Math.exp(-logit)) : Math.exp(logit) / (1 + Math.exp(logit));
  }
  const f32 = z.map(Math.fround);
  let sum = 0;
  for (const tree of model.trees) {
    let index = 0;
    while (tree.left[index] !== -1)
      index =
        f32[tree.feature[index]!]! <= tree.threshold[index]!
          ? tree.left[index]!
          : tree.right[index]!;
    sum += tree.positive[index]!;
  }
  return sum / model.trees.length;
}
export function verifyParity(artifact: Artifact) {
  if (!artifact.parity.length) throw new Error('Cross-runtime parity evidence missing.');
  let maximumError = 0;
  for (const row of artifact.parity)
    for (const id of ['linear', 'forest'] as const) {
      const error = Math.abs(scoreFeatures(row.features, artifact, id) - row[id]);
      if (!Number.isFinite(error) || error > 1e-10)
        throw new Error(`Python/TypeScript parity failed for${id}: ${error}`);
      maximumError = Math.max(maximumError, error);
    }
  return { cases: artifact.parity.length, maximumError, tolerance: 1e-10 };
}
