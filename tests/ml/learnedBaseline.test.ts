import { describe, expect, it } from 'vitest';

import modelArtifact from '../../models/robust_covariance_v1.json';
import parityVector from '../../models/inference_parity_v1.json';
import {
  compareDetections,
  modelPassesQualityGate,
  parseLearnedBaselineArtifact,
  scoreLearnedBaseline,
} from '../../src/ml/learnedBaseline';

describe('experimental learned baseline', () => {
  it('TC-ML-004 matches the Python reference score within the declared tolerance', () => {
    const result = scoreLearnedBaseline(modelArtifact, parityVector.measurements, true);
    expect(Math.abs(result.score - parityVector.pythonScore)).toBeLessThanOrEqual(
      parityVector.absoluteTolerance,
    );
  });

  it('validates the generated versioned artifact', () => {
    const model = parseLearnedBaselineArtifact(modelArtifact);
    expect(model.artifactVersion).toBe('learned-baseline.v1');
    expect(model.channels).toHaveLength(5);
    expect(model.inverseCovariance).toHaveLength(model.channels.length);
  });

  it('passes the published quality gate from held-out seeds', () => {
    const model = parseLearnedBaselineArtifact(modelArtifact);
    expect(model.evaluation.metrics.f1).toBeGreaterThanOrEqual(0.85);
    expect(model.evaluation.metrics.falsePositiveRate).toBeLessThanOrEqual(0.05);
    expect(modelPassesQualityGate(model)).toBe(true);
  });

  it('scores a center point as nominal with zero residual shares', () => {
    const model = parseLearnedBaselineArtifact(modelArtifact);
    const measurements = Object.fromEntries(
      model.channels.map((channel, index) => [channel, model.center[index]]),
    );
    const score = scoreLearnedBaseline(model, measurements, true);
    expect(score.active).toBe(true);
    expect(score.score).toBeCloseTo(0);
    expect(score.anomalous).toBe(false);
    expect(score.contributions.every((entry) => entry.absoluteShare === 0)).toBe(true);
  });

  it('detects a large synthetic residual and ranks its channel contribution', () => {
    const model = parseLearnedBaselineArtifact(modelArtifact);
    const measurements = Object.fromEntries(
      model.channels.map((channel, index) => [channel, model.center[index]]),
    );
    measurements.airspeed = 1_000;
    const score = scoreLearnedBaseline(model, measurements, true);
    expect(score.anomalous).toBe(true);
    expect(score.contributions[0]?.channel).toBe('airspeed');
    expect(score.contributions.reduce((sum, entry) => sum + entry.absoluteShare, 0)).toBeCloseTo(1);
  });

  it('does not make an anomaly authoritative when the user has not enabled the model', () => {
    const model = parseLearnedBaselineArtifact(modelArtifact);
    const measurements = Object.fromEntries(
      model.channels.map((channel, index) => [
        channel,
        model.center[index]! + model.scale[index]! * 100,
      ]),
    );
    const score = scoreLearnedBaseline(model, measurements, false);
    expect(score.active).toBe(false);
    expect(score.anomalous).toBe(false);
  });

  it('requires all finite model channels', () => {
    expect(() => scoreLearnedBaseline(modelArtifact, { airspeed: 120 }, true)).toThrow(
      'finite measurement is required',
    );
    expect(() =>
      scoreLearnedBaseline(
        modelArtifact,
        {
          airspeed: Number.NaN,
          altitude: 1,
          verticalRate: 1,
          fuel: 1,
          vibration: 1,
        },
        true,
      ),
    ).toThrow('finite measurement is required');
  });

  it('rejects malformed covariance dimensions', () => {
    expect(() => parseLearnedBaselineArtifact({ ...modelArtifact, inverseCovariance: [] })).toThrow(
      'finite square channel matrix',
    );
  });

  it('keeps deterministic findings authoritative in comparisons', () => {
    const model = parseLearnedBaselineArtifact(modelArtifact);
    const measurements = Object.fromEntries(
      model.channels.map((channel, index) => [channel, model.center[index]]),
    );
    const comparison = compareDetections(
      [{ ruleId: 'fixed.range.airspeed', severity: 'error' }],
      scoreLearnedBaseline(model, measurements, true),
    );
    expect(comparison.authority).toBe('deterministic-rules');
    expect(comparison.agreement).toBe('rules-only');
  });
});
