import { describe, expect, it } from 'vitest';

import { analyzeTemporalScenario } from '../../src/investigation/analyze';
import {
  fourWayAgreement,
  INVESTIGATION_COVARIANCE_CHANNEL_MAPPING,
} from '../../src/investigation/detectorEvidence';
import { DECLARED_TEMPORAL_FAULTS, generateTemporalScenario } from '../../src/temporal/generator';
import type { TemporalScenario } from '../../src/temporal/types';

function expectFiniteNumbers(value: unknown): void {
  if (typeof value === 'number') {
    expect(Number.isFinite(value)).toBe(true);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(expectFiniteNumbers);
    return;
  }
  if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach(expectFiniteNumbers);
  }
}

function withoutGroundTruthLabels(scenario: TemporalScenario): TemporalScenario {
  return {
    ...scenario,
    samples: scenario.samples.map((sample) => ({ ...sample, faultLabels: [] })),
  };
}

describe('temporal Investigation workspace analysis', () => {
  it('prepares a nominal mission as finite DTO-ready points and aligned series', () => {
    const scenario = generateTemporalScenario({ seed: 41, scenarioId: 'nominal' });
    const result = analyzeTemporalScenario(scenario, { modelEnabled: false });
    expect(result.points).toHaveLength(scenario.samples.length);
    expect(result.markers).toEqual([]);
    expect(result.series.expectedAltitude).toHaveLength(scenario.samples.length);
    expect(result.series.predictedAltitude).toHaveLength(scenario.samples.length);
    expect(result.series.estimatedVerticalRate).toHaveLength(scenario.samples.length);
    expect(result.hypothesisScores).toHaveLength(10);
    expect(result.points.every((point) => point.activeGroundTruthLabels.length === 0)).toBe(true);
    expectFiniteNumbers(result);
  });

  it.each(DECLARED_TEMPORAL_FAULTS)(
    'analyzes every $id scenario with finite phase, fusion, marker, and scoring output',
    (fault) => {
      const scenario = generateTemporalScenario({ seed: 72, scenarioId: fault.id });
      const result = analyzeTemporalScenario(scenario, { modelEnabled: true });
      expect(result.points).toHaveLength(scenario.samples.length);
      expect(result.markers.map(({ kind }) => kind)).toEqual([
        'onset',
        'active-end',
        'recovery-end',
      ]);
      expect(result.points.some((point) => point.activeGroundTruthLabels.length > 0)).toBe(true);
      expect(result.hypothesisScores.map(({ hypothesisType }) => hypothesisType)).toEqual([
        'gradual-drift',
        'noise-growth',
        'oscillation',
        'sensor-lag',
        'intermittent-dropout',
        'stuck-value',
        'gain-error',
        'fuel-leak',
        'cross-sensor-decoupling',
        'simultaneous-faults',
      ]);
      if (result.detection.deterministicDelaySamples !== null) {
        expect(result.detection.deterministicDelaySamples).toBeGreaterThanOrEqual(0);
        expect(result.detection.deterministicDelayMs).toBeGreaterThanOrEqual(0);
      }
      if (result.detection.modelDelaySamples !== null) {
        expect(result.detection.modelDelaySamples).toBeGreaterThanOrEqual(0);
        expect(result.detection.modelDelayMs).toBeGreaterThanOrEqual(0);
      }
      expectFiniteNumbers(result);
    },
  );

  it('retains phase transition and fused predicted, observed, estimated, residual, and band evidence', () => {
    const result = analyzeTemporalScenario(
      generateTemporalScenario({ seed: 9, scenarioId: 'gradual-drift' }),
      { modelEnabled: false },
    );
    expect(result.phaseTransitions.length).toBeGreaterThan(0);
    expect(result.phaseTransitions[0]).toMatchObject({
      ruleId: 'temporal.phase.transition',
      synthetic: true,
      dataClassification: 'SYNTHETIC_UNCLASSIFIED',
    });
    const point = result.points[80]!;
    expect(point.phaseEvaluation.phase).toBe(point.phase);
    expect(point.fusion.evidence).toMatchObject({
      ruleId: 'temporal.sensor-fusion.innovation',
      sampleIndex: 80,
    });
    expect(point.fusion.altitude95[0]).toBeLessThan(point.fusion.estimated.altitude);
    expect(point.fusion.altitude95[1]).toBeGreaterThan(point.fusion.estimated.altitude);
    expect(point.fusion.verticalRate95[0]).toBeLessThan(point.fusion.estimated.verticalRate);
    expect(point.fusion.verticalRate95[1]).toBeGreaterThan(point.fusion.estimated.verticalRate);
    expect(point.maximumAbsoluteNormalizedResidual).toBeGreaterThanOrEqual(0);
  });

  it('exposes model warmup, explicit user-disabled state, and active advisory inference', () => {
    const scenario = generateTemporalScenario({ seed: 61, scenarioId: 'oscillation' });
    const disabled = analyzeTemporalScenario(scenario, { modelEnabled: false });
    expect(disabled.points[0]?.model).toEqual({ warmupRemaining: 39, score: null });
    expect(disabled.points[38]?.model).toEqual({ warmupRemaining: 1, score: null });
    expect(disabled.points[39]?.model.warmupRemaining).toBe(0);
    expect(disabled.points[39]?.model.score?.activation).toMatchObject({
      userSelection: 'disabled',
      active: false,
      inactiveReason: 'user-disabled',
    });

    const enabled = analyzeTemporalScenario(scenario, { modelEnabled: true });
    expect(enabled.points[39]?.model.score?.activation).toMatchObject({
      userSelection: 'enabled',
      eligibility: 'eligible',
      active: true,
      inactiveReason: null,
    });
    expect(enabled.points[39]?.model.score?.authority).toBe('deterministic-rules');
    expect(enabled.points[39]?.model.score?.hypotheses).toHaveLength(3);
  });

  it('derives every production agreement state from observed rules and advisory model output', () => {
    const result = analyzeTemporalScenario(
      generateTemporalScenario({ seed: 83, scenarioId: 'simultaneous-faults' }),
      { modelEnabled: true },
    );
    expect(result.points.some(({ agreement }) => agreement.state === 'both-nominal')).toBe(true);
    for (const point of result.points) {
      const rulesIndicate = point.indications.length > 0;
      const modelIndicates = point.model.score?.anomalous === true;
      expect(point.agreement).toEqual({
        authority: 'deterministic-rules',
        state: rulesIndicate
          ? modelIndicates
            ? 'both-indicate'
            : 'rules-only'
          : modelIndicates
            ? 'model-only'
            : 'both-nominal',
        authoritativeIndication: rulesIndicate,
        advisoryModelIndication: modelIndicates,
      });
    }
  });

  it('does not leak ground-truth labels into deterministic indications', () => {
    const scenario = generateTemporalScenario({ seed: 27, scenarioId: 'fuel-leak' });
    const labeled = analyzeTemporalScenario(scenario, { modelEnabled: false });
    const unlabeled = analyzeTemporalScenario(withoutGroundTruthLabels(scenario), {
      modelEnabled: false,
    });
    expect(unlabeled.indications).toEqual(labeled.indications);
    expect(unlabeled.points.map(({ indications }) => indications)).toEqual(
      labeled.points.map(({ indications }) => indications),
    );
    expect(
      unlabeled.points.every(({ activeGroundTruthLabels }) => activeGroundTruthLabels.length === 0),
    ).toBe(true);
  });

  it('uses stable indication IDs, observed-data evidence, and declared campaign hypotheses', () => {
    const result = analyzeTemporalScenario(
      generateTemporalScenario({ seed: 18, scenarioId: 'intermittent-dropout' }),
      { modelEnabled: false },
    );
    const missing = result.indications.filter(
      ({ ruleId }) => ruleId === 'investigation.sensor.missing',
    );
    expect(missing.length).toBeGreaterThan(0);
    expect(
      missing.every(({ hypothesisTypes }) => hypothesisTypes.includes('intermittent-dropout')),
    ).toBe(true);
    expect(new Set(result.indications.map(({ indicationId }) => indicationId)).size).toBe(
      result.indications.length,
    );
  });

  it('is deterministic for repeated analysis and reports no negative delay', () => {
    const scenario = generateTemporalScenario({ seed: 99, scenarioId: 'gain-error' });
    const first = analyzeTemporalScenario(scenario, { modelEnabled: true });
    const second = analyzeTemporalScenario(scenario, { modelEnabled: true });
    expect(second).toEqual(first);
    expect(first.detectionIndex).toBe(first.detection.deterministicIndex);
    expect(first.modelDetectionIndex).toBe(first.detection.modelIndex);
    expect(first.detectionDelaySamples === null || first.detectionDelaySamples >= 0).toBe(true);
  });

  it('exposes authoritative rules plus covariance, Kalman, temporal, and four-way evidence', () => {
    const result = analyzeTemporalScenario(
      generateTemporalScenario({ seed: 143, scenarioId: 'simultaneous-faults' }),
      { modelEnabled: true, covarianceModelEnabled: true },
    );
    const faultPoint = result.points.find(
      ({ detectorEvidence }) => detectorEvidence.deterministicRules.state === 'indicate',
    );
    expect(faultPoint).toBeDefined();
    for (const point of result.points) {
      const evidence = point.detectorEvidence;
      expect(evidence.deterministicRules).toMatchObject({
        authority: 'deterministic-rules',
        role: 'authoritative',
        state: point.indications.length > 0 ? 'indicate' : 'nominal',
        indicationCount: point.indications.length,
      });
      expect(evidence.covarianceAdvisory).toMatchObject({
        authority: 'deterministic-rules',
        role: 'advisory',
        supported: true,
      });
      expect(evidence.kalmanInnovation).toMatchObject({
        authority: 'deterministic-rules',
        role: 'supporting-evidence',
        threshold: 3,
      });
      expect(evidence.temporalAdvisory).toMatchObject({
        authority: 'deterministic-rules',
        role: 'advisory',
      });
      expect(evidence.fourWayAgreement.authority).toBe('deterministic-rules');
      expect(evidence.fourWayAgreement.authoritativeDecision).toBe(
        evidence.deterministicRules.state,
      );
      expect(evidence.fourWayAgreement.decisions).toEqual({
        deterministicRules: evidence.deterministicRules.state,
        covarianceAdvisory: evidence.covarianceAdvisory.decision,
        kalmanInnovation: evidence.kalmanInnovation.decision,
        temporalAdvisory: evidence.temporalAdvisory.decision,
      });
    }
  });

  it('scores the supported fixed-wing covariance mapping and preserves disabled as unavailable', () => {
    expect(INVESTIGATION_COVARIANCE_CHANNEL_MAPPING).toMatchObject({
      airspeed: { unit: 'kts', sourceSensors: ['indicatedAirspeed', 'gpsGroundSpeed'] },
      altitude: { unit: 'ft', sourceSensors: ['barometricAltitude', 'gpsAltitude'] },
      verticalRate: {
        unit: 'ft/min',
        sourceSensors: ['inertialVerticalRate', 'barometricVerticalRate'],
      },
      fuel: { unit: '%', sourceSensors: ['fuelQuantity'] },
      vibration: { unit: 'g', sourceSensors: ['vibration'] },
    });
    const scenario = generateTemporalScenario({ seed: 211, scenarioId: 'nominal' });
    const enabled = analyzeTemporalScenario(scenario, {
      modelEnabled: false,
      covarianceModelEnabled: true,
    });
    const enabledCovariance = enabled.points[70]!.detectorEvidence.covarianceAdvisory;
    expect(enabledCovariance.state === 'indicate' || enabledCovariance.state === 'nominal').toBe(
      true,
    );
    expect(enabledCovariance.decision).not.toBe('not-available');
    expect(enabledCovariance.score).toMatchObject({
      active: true,
      qualityGatePassed: true,
    });
    expect(enabledCovariance.score?.score).toBeTypeOf('number');
    expect(enabledCovariance.threshold).toBeGreaterThan(0);

    const disabled = analyzeTemporalScenario(scenario, { modelEnabled: false });
    expect(disabled.points[70]!.detectorEvidence.covarianceAdvisory).toMatchObject({
      state: 'disabled',
      decision: 'not-available',
      supported: true,
      active: false,
      unsupportedReason: null,
      score: { active: false, qualityGatePassed: true },
    });
  });

  it('reports explicit covariance compatibility and missing-input reasons', () => {
    const base = generateTemporalScenario({ seed: 307, scenarioId: 'nominal' });
    const incompatible = {
      ...base,
      profileId: 'generic-rotary-wing',
      cadenceMs: 2_000,
    } as unknown as TemporalScenario;
    const incompatibleResult = analyzeTemporalScenario(incompatible, {
      modelEnabled: false,
      covarianceModelEnabled: true,
    });
    const incompatibleCovariance =
      incompatibleResult.points[50]!.detectorEvidence.covarianceAdvisory;
    expect(incompatibleCovariance).toMatchObject({
      state: 'unsupported',
      decision: 'not-available',
      supported: false,
      active: false,
      score: null,
    });
    expect(incompatibleCovariance.compatibilityReasons.map(({ code }) => code)).toEqual(
      expect.arrayContaining(['PROFILE_ID_MISMATCH', 'CADENCE_MISMATCH']),
    );
    expect(incompatibleCovariance.unsupportedReason).toContain('generic-fixed-wing only');

    const missingIndex = 70;
    const missing = {
      ...base,
      samples: base.samples.map((sample) =>
        sample.sampleIndex === missingIndex
          ? {
              ...sample,
              measurements: {
                ...sample.measurements,
                indicatedAirspeed: null,
                gpsGroundSpeed: null,
                barometricAltitude: null,
                gpsAltitude: null,
                inertialVerticalRate: null,
                barometricVerticalRate: null,
                fuelQuantity: null,
                vibration: null,
              },
            }
          : sample,
      ),
    };
    const missingResult = analyzeTemporalScenario(missing, {
      modelEnabled: true,
      covarianceModelEnabled: true,
    });
    const missingEvidence = missingResult.points[missingIndex]!.detectorEvidence;
    expect(missingEvidence.covarianceAdvisory).toMatchObject({
      state: 'unsupported',
      decision: 'not-available',
      score: null,
    });
    expect(missingEvidence.covarianceAdvisory.compatibilityReasons.at(-1)).toMatchObject({
      code: 'MISSING_MODEL_INPUT',
      channels: ['airspeed', 'altitude', 'verticalRate', 'fuel', 'vibration'],
    });
    expect(missingEvidence.kalmanInnovation).toMatchObject({
      state: 'unsupported',
      decision: 'not-available',
      maximumAbsoluteNormalizedInnovation: null,
      topResidualSensorChannels: [],
    });
    expect(missingEvidence.kalmanInnovation.unsupportedReason).toContain('No finite altitude');
  });

  it('orders the top Kalman residual sensor channels by absolute normalized innovation', () => {
    const result = analyzeTemporalScenario(
      generateTemporalScenario({ seed: 401, scenarioId: 'cross-sensor-decoupling' }),
      { modelEnabled: false, covarianceModelEnabled: true },
    );
    for (const point of result.points) {
      const kalman = point.detectorEvidence.kalmanInnovation;
      const magnitudes = kalman.topResidualSensorChannels.map(
        ({ absoluteNormalizedInnovation }) => absoluteNormalizedInnovation,
      );
      expect(magnitudes).toEqual([...magnitudes].sort((left, right) => right - left));
      expect(kalman.topResidualSensorChannels.length).toBeLessThanOrEqual(3);
      if (magnitudes.length > 0) {
        expect(kalman.maximumAbsoluteNormalizedInnovation).toBe(magnitudes[0]);
        expect(kalman.state).toBe(magnitudes[0]! > 3 ? 'indicate' : 'nominal');
      }
    }
    const onset = result.markers.find(({ kind }) => kind === 'onset')?.sampleIndex ?? 0;
    expect(
      result.points
        .slice(onset)
        .some(({ detectorEvidence }) =>
          detectorEvidence.kalmanInnovation.topResidualSensorChannels.some(
            ({ sensorId }) => sensorId === 'barometricAltitude' || sensorId === 'gpsAltitude',
          ),
        ),
    ).toBe(true);
  });

  it('classifies temporal warmup, disabled, active, and abstained states without authority drift', () => {
    const scenario = generateTemporalScenario({ seed: 509, scenarioId: 'oscillation' });
    const disabled = analyzeTemporalScenario(scenario, {
      modelEnabled: false,
      covarianceModelEnabled: true,
    });
    expect(disabled.points[0]!.detectorEvidence.temporalAdvisory).toMatchObject({
      state: 'warming-up',
      decision: 'not-available',
      warmupRemaining: 39,
    });
    expect(disabled.points[39]!.detectorEvidence.temporalAdvisory).toMatchObject({
      state: 'disabled',
      decision: 'not-available',
      warmupRemaining: 0,
      score: { authority: 'deterministic-rules' },
    });

    const enabled = analyzeTemporalScenario(scenario, {
      modelEnabled: true,
      covarianceModelEnabled: true,
    });
    expect(
      enabled.points.slice(39).every(({ detectorEvidence }) => {
        const temporal = detectorEvidence.temporalAdvisory;
        return (
          temporal.authority === 'deterministic-rules' &&
          ['indicate', 'nominal', 'abstained'].includes(temporal.state)
        );
      }),
    ).toBe(true);
  });

  it('summarizes complete and partial four-way agreement without advisory override', () => {
    const enabled = analyzeTemporalScenario(
      generateTemporalScenario({ seed: 601, scenarioId: 'gain-error' }),
      { modelEnabled: true, covarianceModelEnabled: true },
    );
    for (const point of enabled.points) {
      const agreement = point.detectorEvidence.fourWayAgreement;
      const available = Object.values(agreement.decisions).filter(
        (decision) => decision !== 'not-available',
      );
      expect(agreement.indicatingSignals + agreement.nominalSignals).toBe(available.length);
      expect(agreement.authoritativeDecision).toBe(point.detectorEvidence.deterministicRules.state);
    }
    const source = enabled.points[70]!.detectorEvidence;
    const completeNominal = fourWayAgreement(
      { ...source.deterministicRules, state: 'nominal' },
      {
        ...source.covarianceAdvisory,
        state: 'nominal',
        decision: 'nominal',
        supported: true,
        active: true,
      },
      { ...source.kalmanInnovation, state: 'nominal', decision: 'nominal' },
      { ...source.temporalAdvisory, state: 'nominal', decision: 'nominal' },
    );
    expect(completeNominal).toMatchObject({
      complete: true,
      state: 'unanimous-nominal',
      authoritativeDecision: 'nominal',
      indicatingSignals: 0,
      nominalSignals: 4,
      unavailableSignals: [],
    });

    const disabled = analyzeTemporalScenario(
      generateTemporalScenario({ seed: 601, scenarioId: 'nominal' }),
      { modelEnabled: false, covarianceModelEnabled: false },
    );
    expect(disabled.points[70]!.detectorEvidence.fourWayAgreement).toMatchObject({
      complete: false,
      authority: 'deterministic-rules',
      decisions: {
        covarianceAdvisory: 'not-available',
        temporalAdvisory: 'not-available',
      },
      unavailableSignals: ['covariance-advisory', 'temporal-advisory'],
    });
  });

  it('keeps all detector evidence independent of fault labels and truth metadata', () => {
    const scenario = generateTemporalScenario({ seed: 701, scenarioId: 'fuel-leak' });
    const withoutDetectorTruth = {
      ...scenario,
      samples: scenario.samples.map((sample) => ({
        ...sample,
        phaseTruth: 'ground' as const,
        truth: {
          speed: 999_001,
          altitude: 999_002,
          verticalRate: 999_003,
          fuel: 999_004,
          fuelFlow: 999_005,
          vibration: 999_006,
        },
        faultLabels: [],
      })),
    };
    const labeled = analyzeTemporalScenario(scenario, {
      modelEnabled: true,
      covarianceModelEnabled: true,
    });
    const scrubbed = analyzeTemporalScenario(withoutDetectorTruth, {
      modelEnabled: true,
      covarianceModelEnabled: true,
    });
    expect(scrubbed.points.map(({ detectorEvidence }) => detectorEvidence)).toEqual(
      labeled.points.map(({ detectorEvidence }) => detectorEvidence),
    );
    expect(scrubbed.indications).toEqual(labeled.indications);
    expect(scrubbed.points.map(({ phase }) => phase)).toEqual(
      labeled.points.map(({ phase }) => phase),
    );
  });
});
