import integrationArtifact from '../../models/temporal_fault_model_v2.json';
import integrationParity from '../../models/temporal_inference_parity_v2.json';
import { describe, expect, it } from 'vitest';
import { analyzeTemporalScenario } from '../../src/investigation/analyze';
import {
  parseTemporalFaultModelArtifact,
  scoreTemporalFaultModel,
} from '../../src/ml/temporalModel';
import type { TemporalSample } from '../../src/ml/temporalTypes';
import { generateTemporalScenario } from '../../src/temporal/generator';

describe('actual-mission temporal integration model', () => {
  it('loads the honest versioned browser artifact and its passed integration gate', () => {
    const artifact = parseTemporalFaultModelArtifact(integrationArtifact);
    expect(artifact.modelVersion).toBe('2.0.0');
    expect(artifact.modelType).toBe('causal-multiscale-feature-nearest-prototype');
    expect(artifact.qualityGate.passed).toBe(true);
    expect(artifact.evaluation.selectedWindowMetrics?.f1).toBeCloseTo(0.986128625473, 12);
    expect(artifact.evaluation.selectedWindowMetrics?.falsePositiveRate).toBe(0.05);
    expect(artifact.evaluation.classificationMacroF1).toBeCloseTo(0.98546835443, 12);
    expect(artifact.qualityGate.minimumPerFaultClassificationRecall).toBe(0.65);
    expect(artifact.qualityGate.observedMinimumPerFaultClassificationRecall).toBe(0.825);
    expect(artifact.evaluation.abstentionRate).toBeCloseTo(0.009090909091, 12);
    expect(artifact.evaluation.answeredObservations).toBe(436);
    expect(artifact.classPrototypes?.['cross-sensor-decoupling'].length).toBeGreaterThan(1);
    expect(artifact.classPrototypeIds?.['cross-sensor-decoupling']).toHaveLength(
      artifact.classPrototypes?.['cross-sensor-decoupling'].length ?? 0,
    );
    expect(
      (artifact.evaluation.falsePositiveRateEvidence as { exactOneSidedUpper95: number })
        .exactOneSidedUpper95,
    ).toBeGreaterThan(0.05);
  });

  it('matches Python for each raw held-out TypeScript mission parity window', () => {
    for (const parityCase of integrationParity.cases) {
      const score = scoreTemporalFaultModel(
        integrationArtifact,
        parityCase.window as readonly TemporalSample[],
        true,
      );
      expect(score.predictedLabel).toBe(parityCase.expected.predictedLabel);
      expect(score.nearestLabel).toBe(parityCase.expected.nearestLabel);
      expect(score.abstained).toBe(parityCase.expected.abstained);
      expect(score.anomalous).toBe(parityCase.expected.anomalous);
      expect(Math.abs(score.relativeScore - parityCase.expected.relativeScore)).toBeLessThanOrEqual(
        integrationParity.absoluteTolerance,
      );
      expect(Math.abs(score.distance - parityCase.expected.distance)).toBeLessThanOrEqual(
        integrationParity.absoluteTolerance,
      );
    }
  });

  it('answers real Investigation windows and detects the default oscillation mission', () => {
    const investigation = analyzeTemporalScenario(
      generateTemporalScenario({ seed: 3101, scenarioId: 'oscillation', sampleCount: 180 }),
      { modelEnabled: true },
    );
    const scores = investigation.points.flatMap((point) =>
      point.model.score === null ? [] : [point.model.score],
    );
    const answered = scores.filter((score) => !score.abstained);
    expect(scores).toHaveLength(141);
    expect(answered.length).toBeGreaterThan(0);
    expect(answered.length).toBeLessThanOrEqual(scores.length);
    expect(answered.some((score) => score.anomalous)).toBe(true);
    expect(answered.every((score) => score.modelVersion === '2.0.0')).toBe(true);
  });
});
