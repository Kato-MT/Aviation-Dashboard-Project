import { projectInvestigationScenario } from '../../src/investigation/modelProjection';
import { extractTemporalFeatures } from '../../src/ml/temporalModel';
import type { TemporalFaultModelArtifact } from '../../src/ml/temporalTypes';
import type { TemporalScenario } from '../../src/temporal/types';
import { percentile } from '../../src/mission-evaluation/statistics';
import type { PredictionPoint } from '../../src/mission-evaluation';
import { hashObject } from '../mission-evaluation/protocol';
import { PROTOCOL } from './protocol';

export interface Envelope {
  schemaVersion: 'nominal-envelope.v1';
  baselineSha256: string;
  protocolSha256: string;
  fitSeeds: number[];
  calibrationSeeds: number[];
  scale: number[];
  prototypes: number[][];
  thresholds: Record<string, number>;
}

/** The existing stateful observed-only projection; labels never enter the feature encoder. */
export function missionFeatures(scenario: TemporalScenario): number[][] {
  const samples = projectInvestigationScenario(scenario).map((p) => p.modelSample);
  return samples
    .slice(39)
    .map((_, i) => [...extractTemporalFeatures(samples.slice(i, i + 40)).values]);
}

export function nominalDistance(
  features: readonly number[],
  envelope: Pick<Envelope, 'scale' | 'prototypes'>,
): number {
  if (features.length !== envelope.scale.length || features.some((v) => !Number.isFinite(v)))
    throw new Error('Invalid observed feature vector.');
  let best = Infinity;
  for (const prototype of envelope.prototypes) {
    let sum = 0;
    for (let i = 0; i < features.length; i++)
      sum += ((features[i]! - prototype[i]!) / envelope.scale[i]!) ** 2;
    best = Math.min(best, sum / features.length);
  }
  if (!Number.isFinite(best)) throw new Error('Invalid nominal envelope distance.');
  return best;
}

export function fitEnvelope(
  training: readonly number[][][],
  calibration: readonly number[][][],
  artifact: TemporalFaultModelArtifact,
  baselineSha256: string,
): Envelope {
  if (
    training.length !== PROTOCOL.fitSeeds.length ||
    calibration.length !== PROTOCOL.calibrationSeeds.length ||
    [...training, ...calibration].some(
      (m) =>
        m.length !== 141 ||
        m.some(
          (row) =>
            row.length !== artifact.featureNames.length || row.some((v) => !Number.isFinite(v)),
        ),
    )
  )
    throw new Error('Expected complete finite nominal fitting/calibration missions.');
  const rows = training.flat();
  const scale = artifact.featureNames.map((name, i) => {
    const mean = rows.reduce((s, r) => s + r[i]!, 0) / rows.length;
    const std = Math.sqrt(rows.reduce((s, r) => s + (r[i]! - mean) ** 2, 0) / rows.length);
    const resolution = name.endsWith('.freeze-ratio')
      ? 1 / 39
      : name.endsWith('.missing-fraction')
        ? 1 / 40
        : 0;
    return Math.max(artifact.featureScale[i]!, std, resolution);
  });
  const prototypes = Array.from({ length: 141 }, (_, end) =>
    artifact.featureNames.map(
      (_, i) => training.reduce((s, m) => s + m[end]![i]!, 0) / training.length,
    ),
  );
  const envelope: Envelope = {
    schemaVersion: 'nominal-envelope.v1',
    baselineSha256,
    protocolSha256: hashObject(PROTOCOL),
    fitSeeds: [...PROTOCOL.fitSeeds],
    calibrationSeeds: [...PROTOCOL.calibrationSeeds],
    scale,
    prototypes,
    thresholds: {},
  };
  const distances = calibration.map((m) => m.map((row) => nominalDistance(row, envelope)));
  envelope.thresholds = {
    'window-p95': percentile(distances.flat(), 0.95)!,
    'window-p99': percentile(distances.flat(), 0.99)!,
    'mission-max-p95': percentile(
      distances.map((m) => Math.max(...m)),
      0.95,
    )!,
  };
  return envelope;
}

export function validateEnvelope(envelope: Envelope, baselineSha256: string): void {
  if (
    envelope.schemaVersion !== 'nominal-envelope.v1' ||
    envelope.baselineSha256 !== baselineSha256 ||
    envelope.protocolSha256 !== hashObject(PROTOCOL) ||
    hashObject(envelope.fitSeeds) !== hashObject(PROTOCOL.fitSeeds) ||
    hashObject(envelope.calibrationSeeds) !== hashObject(PROTOCOL.calibrationSeeds) ||
    envelope.scale.length !== 51 ||
    envelope.scale.some((v) => !Number.isFinite(v) || v <= 0) ||
    envelope.prototypes.length !== 141 ||
    envelope.prototypes.some((r) => r.length !== 51 || r.some((v) => !Number.isFinite(v))) ||
    PROTOCOL.candidates.some(
      (id) => !Number.isFinite(envelope.thresholds[id]) || envelope.thresholds[id]! <= 0,
    )
  )
    throw new Error('Invalid or incompatible experimental envelope.');
}

/** No truth, seed, phase, scenario ID, or future observations are accepted here. */
export function correctPredictions(
  baseline: readonly PredictionPoint[],
  features: readonly number[][],
  envelope: Envelope,
  candidateId: string,
): PredictionPoint[] {
  const threshold = envelope.thresholds[candidateId];
  if (
    threshold === undefined ||
    !Number.isFinite(threshold) ||
    threshold <= 0 ||
    baseline.length !== features.length + 39
  )
    throw new Error('Invalid correction inputs.');
  return baseline.map((point, i) => {
    if (i < 39 || point.modelState === 'unavailable' || point.modelState === 'warmup')
      return { ...point };
    const knownNominal = nominalDistance(features[i - 39]!, envelope) <= threshold;
    return { ...point, modelState: knownNominal ? 'nominal' : point.modelState };
  });
}
