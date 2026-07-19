import { describe, expect, it } from 'vitest';

import temporalArtifact from '../../models/temporal_fault_model_v1.json';
import temporalEvaluation from '../../models/temporal_evaluation_v1.json';
import temporalParity from '../../models/temporal_inference_parity_v1.json';
import {
  extractTemporalFeatures,
  parseTemporalFaultModelArtifact,
  scoreTemporalFaultModel,
  temporalModelPassesQualityGate,
} from '../../src/ml/temporalModel';
import type { TemporalSample } from '../../src/ml/temporalTypes';

const parityWindow = temporalParity.window as readonly TemporalSample[];
const nominalCase = temporalParity.cases.find(({ caseId }) => caseId.startsWith('nominal-'))!;
const detectedCase = temporalParity.cases.find(({ caseId }) => caseId.startsWith('oscillation-'))!;

describe('temporal artifact parser and quality gate', () => {
  it('parses the generated artifact and preserves its fixed browser contract', () => {
    const artifact = parseTemporalFaultModelArtifact(temporalArtifact);
    expect(artifact.artifactVersion).toBe('temporal-fault-model.v1');
    expect(artifact.windowLength).toBe(40);
    expect(artifact.channels).toEqual([
      'airspeed',
      'altitude',
      'verticalRate',
      'fuel',
      'vibration',
    ]);
    expect(artifact.featureNames).toHaveLength(51);
    expect(Object.keys(artifact.classCentroids!)).toHaveLength(11);
  });

  it('validates the published held-out quality gate rather than trusting its flag alone', () => {
    const artifact = parseTemporalFaultModelArtifact(temporalArtifact);
    expect(temporalModelPassesQualityGate(artifact)).toBe(true);
    expect(
      temporalModelPassesQualityGate({
        ...artifact,
        evaluation: {
          ...artifact.evaluation,
          episodeMetrics: { ...artifact.evaluation.episodeMetrics!, f1: 0 },
        },
      }),
    ).toBe(false);
  });

  it('locks the complete disjoint held-out evidence, per-fault floor, abstention, and interval', () => {
    const trainingSeeds = temporalArtifact.training.seeds;
    const calibrationSeeds = temporalArtifact.calibration.seeds;
    const evaluationSeeds = temporalEvaluation.evaluation.seeds;
    expect(trainingSeeds).toEqual(Array.from({ length: 40 }, (_, index) => 1101 + index));
    expect(calibrationSeeds).toEqual(Array.from({ length: 20 }, (_, index) => 2101 + index));
    expect(evaluationSeeds).toEqual(Array.from({ length: 40 }, (_, index) => 3101 + index));
    expect(new Set([...trainingSeeds, ...calibrationSeeds, ...evaluationSeeds]).size).toBe(100);
    expect(temporalEvaluation.evaluation).toMatchObject({
      examples: 440,
      unseenMagnitudeRange: [0.72, 1.32],
      episodeMetrics: {
        truePositives: 371,
        falsePositives: 1,
        trueNegatives: 39,
        falseNegatives: 29,
        precision: 0.997311827957,
        recall: 0.9275,
        f1: 0.961139896373,
        falsePositiveRate: 0.025,
      },
      classificationMacroF1: 0.94734856407,
      abstentionRate: 0.043181818182,
      f1ConfidenceInterval: {
        method: 'deterministic-bootstrap',
        lower95: 0.94405347036,
        upper95: 0.973354940533,
        iterations: 300,
        seed: 22072,
      },
    });
    expect(Object.keys(temporalEvaluation.evaluation.byFault)).toHaveLength(10);
    expect(
      Math.min(
        ...Object.values(temporalEvaluation.evaluation.byFault).map(
          ({ classificationRecall }) => classificationRecall,
        ),
      ),
    ).toBe(0.675);
    expect(temporalEvaluation.qualityGate).toEqual({
      minimumEpisodeF1: 0.8,
      maximumFalsePositiveRate: 0.05,
      minimumClassificationMacroF1: 0.65,
      minimumPerFaultClassificationRecall: 0.65,
      observedMinimumPerFaultClassificationRecall: 0.675,
      passed: true,
    });
    expect(temporalArtifact.limitations).toContain(
      'Deterministic rules remain authoritative for verification status.',
    );
  });

  it.each([
    ['artifact object', null, 'must be an object'],
    [
      'artifact version',
      { ...temporalArtifact, artifactVersion: 'temporal-fault-model.v2' },
      'artifact version',
    ],
    ['model type', { ...temporalArtifact, modelType: 'transformer' }, 'fault-model type'],
    [
      'telemetry schema',
      { ...temporalArtifact, schemaVersion: 'telemetry.v2' },
      'telemetry schema',
    ],
    ['window contract', { ...temporalArtifact, windowLength: 39 }, 'windowLength must be 40'],
    ['channel array', { ...temporalArtifact, channels: null }, 'channels do not match'],
    [
      'channel order',
      { ...temporalArtifact, channels: [...temporalArtifact.channels].reverse() },
      'channels do not match',
    ],
    ['unit object', { ...temporalArtifact, units: null }, 'units are required'],
    [
      'channel unit',
      { ...temporalArtifact, units: { ...temporalArtifact.units, airspeed: '' } },
      'unit is required for airspeed',
    ],
    [
      'feature names',
      { ...temporalArtifact, featureNames: temporalArtifact.featureNames.slice(1) },
      'feature names',
    ],
    [
      'feature dimensions',
      { ...temporalArtifact, featureCenter: temporalArtifact.featureCenter.slice(1) },
      'center dimensions',
    ],
    [
      'positive feature scale',
      { ...temporalArtifact, featureScale: [0, ...temporalArtifact.featureScale.slice(1)] },
      'scales must be positive',
    ],
    [
      'class centroid dimensions',
      {
        ...temporalArtifact,
        classCentroids: { ...temporalArtifact.classCentroids, nominal: [] },
      },
      'centroid for nominal',
    ],
    ['class maps', { ...temporalArtifact, classCentroids: null }, 'class centroids are required'],
    [
      'class radius',
      { ...temporalArtifact, classRadii: { ...temporalArtifact.classRadii, nominal: 0 } },
      'radius for nominal',
    ],
    [
      'confidence finite',
      { ...temporalArtifact, confidenceThreshold: Number.NaN },
      'confidenceThreshold must be finite',
    ],
    ['confidence range', { ...temporalArtifact, confidenceThreshold: -1 }, 'between zero and one'],
    ['temperature', { ...temporalArtifact, temperature: 0 }, 'temperature must be positive'],
    ['cadence', { ...temporalArtifact, cadenceMs: 0 }, 'cadenceMs must be positive'],
    ['enablement flag', { ...temporalArtifact, enabledByDefault: 'yes' }, 'enabledByDefault flag'],
    [
      'synthetic boundary',
      { ...temporalArtifact, syntheticDataOnly: false },
      'declare syntheticDataOnly',
    ],
    ['profile identity', { ...temporalArtifact, profile: null }, 'profile identity'],
    ['evaluation evidence', { ...temporalArtifact, evaluation: null }, 'evaluation metrics'],
    ['quality gate', { ...temporalArtifact, qualityGate: null }, 'quality gate'],
    [
      'quality gate field',
      {
        ...temporalArtifact,
        qualityGate: { ...temporalArtifact.qualityGate, minimumEpisodeF1: Number.NaN },
      },
      'minimumEpisodeF1 must be finite',
    ],
    [
      'training identity',
      {
        ...temporalArtifact,
        training: { ...temporalArtifact.training, configurationSha256: 'bad' },
      },
      'configuration SHA-256',
    ],
    ['limitations', { ...temporalArtifact, limitations: [1] }, 'limitations must be strings'],
  ])('rejects malformed %s', (_name, artifact, message) => {
    expect(() => parseTemporalFaultModelArtifact(artifact)).toThrow(message);
  });
});

describe('causal temporal feature encoder', () => {
  it('produces the declared d1/d2/d4, curvature, lag, correlation, and cross features', () => {
    const result = extractTemporalFeatures(parityWindow);
    expect(result.names).toHaveLength(51);
    expect(result.values).toHaveLength(51);
    expect(result.names).toContain('airspeed.d1-rms');
    expect(result.names).toContain('altitude.d2-rms');
    expect(result.names).toContain('verticalRate.d4-rms');
    expect(result.names).toContain('fuel.curvature-rms');
    expect(result.names).toContain('cross.altitude-vertical-rate-best-lag');
    expect(result.names).toContain('cross.vibration-growth-ratio');
    expect(result.values.every(Number.isFinite)).toBe(true);
  });

  it('forward-fills missing-channel and null dropout values and records their fraction', () => {
    const withDropout = parityWindow.map((sample) => ({ ...sample }));
    delete withDropout[0]!.vibration;
    withDropout[5]!.vibration = null;
    const features = extractTemporalFeatures(withDropout);
    const missingIndex = features.names.indexOf('vibration.missing-fraction');
    expect(features.values[missingIndex]).toBeCloseTo(2 / 40, 12);
    expect(features.values.every(Number.isFinite)).toBe(true);
  });

  it('uses zero as the deterministic fallback for an entirely missing channel', () => {
    const withoutVibration = parityWindow.map((sample) => {
      const copy: Record<string, number | null | undefined> = { ...sample };
      delete copy.vibration;
      return copy;
    });
    const features = extractTemporalFeatures(withoutVibration);
    expect(features.values[features.names.indexOf('vibration.mean')]).toBe(0);
    expect(features.values[features.names.indexOf('vibration.missing-fraction')]).toBe(1);
  });

  it('rejects unsupported partial and oversized windows explicitly', () => {
    expect(() => extractTemporalFeatures(parityWindow.slice(1))).toThrow(
      'Expected exactly 40 temporal samples',
    );
    expect(() => extractTemporalFeatures([...parityWindow, parityWindow[0]!])).toThrow(
      'Expected exactly 40 temporal samples',
    );
  });
});

describe('temporal browser inference', () => {
  it('matches the Python parity confidence and distance within the declared tolerance', () => {
    const result = scoreTemporalFaultModel(temporalArtifact, parityWindow, true);
    expect(Math.abs(result.relativeScore - temporalParity.expected.confidence)).toBeLessThanOrEqual(
      temporalParity.absoluteTolerance,
    );
    expect(Math.abs(result.distance - temporalParity.expected.distance)).toBeLessThanOrEqual(
      temporalParity.absoluteTolerance,
    );
    expect(result.nearestLabel).toBe(temporalParity.expected.nearestLabel);
    expect(result.predictedLabel).toBe(temporalParity.expected.predictedLabel);
  });

  it('keeps the parity episode as an explicit unknown abstention', () => {
    const result = scoreTemporalFaultModel(temporalArtifact, parityWindow, true);
    expect(result.activation).toMatchObject({
      userSelection: 'enabled',
      eligibility: 'eligible',
      active: true,
      inactiveReason: null,
    });
    expect(result.abstained).toBe(true);
    expect(result.anomalous).toBe(false);
    expect(result.predictedLabel).toBe('unknown');
  });

  it('classifies the reconstructed nominal path as nominal', () => {
    const result = scoreTemporalFaultModel(
      temporalArtifact,
      nominalCase.window as readonly TemporalSample[],
      true,
    );
    expect(result.nearestLabel).toBe('nominal');
    expect(result.predictedLabel).toBe('nominal');
    expect(result.anomalous).toBe(false);
    expect(result.relativeScore).toBeCloseTo(nominalCase.expected.confidence, 9);
  });

  it('classifies a training-strength temporal anomaly and ranks three fault hypotheses', () => {
    const result = scoreTemporalFaultModel(
      temporalArtifact,
      detectedCase.window as readonly TemporalSample[],
      true,
    );
    expect(result.predictedLabel).toBe('oscillation');
    expect(result.anomalous).toBe(true);
    expect(result.hypotheses).toHaveLength(3);
    expect(result.hypotheses[0]?.faultType).toBe('oscillation');
    expect(result.hypotheses.map(({ faultType }) => faultType)).not.toContain('nominal');
  });

  it('returns an explicit inactive state when the user disables the model', () => {
    const result = scoreTemporalFaultModel(
      temporalArtifact,
      detectedCase.window as readonly TemporalSample[],
      false,
    );
    expect(result.authority).toBe('deterministic-rules');
    expect(result.activation).toEqual({
      userSelection: 'disabled',
      eligibility: 'eligible',
      active: false,
      inactiveReason: 'user-disabled',
    });
    expect(result.predictedLabel).toBe('unknown');
    expect(result.abstained).toBe(true);
    expect(result.anomalous).toBe(false);
  });

  it('makes a failed quality gate ineligible and never authoritative', () => {
    const failedArtifact = {
      ...temporalArtifact,
      qualityGate: { ...temporalArtifact.qualityGate, passed: false },
    };
    const result = scoreTemporalFaultModel(
      failedArtifact,
      detectedCase.window as readonly TemporalSample[],
      true,
    );
    expect(result.qualityGatePassed).toBe(false);
    expect(result.activation).toMatchObject({
      eligibility: 'ineligible',
      active: false,
      inactiveReason: 'quality-gate-failed',
    });
    expect(result.authority).toBe('deterministic-rules');
    expect(result.anomalous).toBe(false);
  });

  it('is byte-for-byte deterministic for repeated inference inputs', () => {
    const first = scoreTemporalFaultModel(temporalArtifact, parityWindow, true);
    const second = scoreTemporalFaultModel(temporalArtifact, parityWindow, true);
    expect(second).toEqual(first);
    expect(first.authority).toBe('deterministic-rules');
    expect(first.hypotheses).toHaveLength(3);
  });
});
