import temporalArtifactJson from '../../models/temporal_fault_model_v2.json';
import { scoreTemporalFaultModel } from '../ml/temporalModel';
import {
  TEMPORAL_FAULT_LABELS,
  type TemporalFaultLabel as ModelHypothesisType,
  type TemporalSample as ModelSample,
} from '../ml/temporalTypes';
import { getTemporalFaultDefinition } from '../temporal/generator';
import { MissionPhaseDetector } from '../temporal/phase';
import type { TemporalScenario, TemporalSensorId } from '../temporal/types';
import type {
  InvestigationAgreement,
  InvestigationDetectionSummary,
  InvestigationFusionPoint,
  InvestigationHypothesisScore,
  InvestigationIndication,
  InvestigationMarker,
  InvestigationPoint,
  InvestigationProductionAgreement,
  InvestigationSeries,
  NumericSeriesPoint,
  TemporalScenarioInvestigation,
} from './types';
import { covarianceScenarioContext, investigationPointEvidence } from './detectorEvidence';
import {
  createInvestigationModelProjector,
  INVESTIGATION_MODEL_WINDOW_LENGTH,
} from './modelProjection';

export interface AnalyzeTemporalScenarioOptions {
  readonly modelEnabled: boolean;
  readonly covarianceModelEnabled?: boolean | undefined;
}

const SENSOR_IDS = [
  'indicatedAirspeed',
  'gpsGroundSpeed',
  'barometricAltitude',
  'gpsAltitude',
  'inertialVerticalRate',
  'barometricVerticalRate',
  'fuelQuantity',
  'fuelFlow',
  'vibration',
] as const satisfies readonly TemporalSensorId[];

function finite(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function finiteMean(values: readonly (number | null | undefined)[]): number | null {
  const available = values.filter(finite);
  return available.length === 0
    ? null
    : available.reduce((sum, value) => sum + value, 0) / available.length;
}

function standardDeviation(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const origin = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - origin) ** 2, 0) / values.length);
}

function finiteRange(values: readonly (number | null | undefined)[]): number | null {
  const available = values.filter(finite);
  return available.length === values.length
    ? Math.max(...available) - Math.min(...available)
    : null;
}

function indication(
  ruleId: string,
  label: string,
  severity: InvestigationIndication['severity'],
  sampleIndex: number,
  timestampMs: number,
  sensorIds: readonly string[],
  observedValue: InvestigationIndication['observedValue'],
  expectedCondition: string,
  hypothesisTypes: readonly ModelHypothesisType[],
  evidence: InvestigationIndication['evidence'],
): InvestigationIndication {
  return {
    indicationId: `${ruleId}:${sensorIds.join('+') || 'fused'}:${sampleIndex}`,
    ruleId,
    label,
    severity,
    sampleIndex,
    timestampMs,
    sensorIds,
    observedValue,
    expectedCondition,
    hypothesisTypes,
    evidence,
  };
}

function observedIndications(
  scenario: TemporalScenario,
  sampleIndex: number,
  fusion: InvestigationFusionPoint,
): InvestigationIndication[] {
  const sample = scenario.samples[sampleIndex]!;
  const measurements = sample.measurements;
  const results: InvestigationIndication[] = [];
  for (const sensorId of SENSOR_IDS) {
    if (measurements[sensorId] === null) {
      results.push(
        indication(
          'investigation.sensor.missing',
          'Sensor observation missing',
          'error',
          sampleIndex,
          sample.timestampMs,
          [sensorId],
          null,
          'required sensor observation is finite and present',
          ['intermittent-dropout'],
          { sensorId, missing: true },
        ),
      );
    }
  }

  if (sampleIndex >= 5 && fusion.evidence.maximumAbsoluteNormalizedInnovation > 3) {
    results.push(
      indication(
        'investigation.fusion.innovation',
        'Fusion innovation exceeded three sigma',
        'warning',
        sampleIndex,
        sample.timestampMs,
        fusion.evidence.innovations.map(({ sensorId }) => sensorId),
        fusion.evidence.maximumAbsoluteNormalizedInnovation,
        'maximum absolute normalized fusion innovation <= 3',
        ['gradual-drift', 'oscillation', 'gain-error', 'cross-sensor-decoupling'],
        {
          maximumAbsoluteNormalizedInnovation: fusion.evidence.maximumAbsoluteNormalizedInnovation,
        },
      ),
    );
  }

  const altitudeDisagreement =
    finite(measurements.barometricAltitude) && finite(measurements.gpsAltitude)
      ? Math.abs(measurements.barometricAltitude - measurements.gpsAltitude)
      : null;
  if (altitudeDisagreement !== null && altitudeDisagreement > 80) {
    results.push(
      indication(
        'investigation.redundancy.altitude-disagreement',
        'Redundant altitude sensors disagree',
        'error',
        sampleIndex,
        sample.timestampMs,
        ['barometricAltitude', 'gpsAltitude'],
        altitudeDisagreement,
        'absolute redundant altitude disagreement <= 80 ft',
        ['gradual-drift', 'stuck-value', 'gain-error', 'cross-sensor-decoupling'],
        { absoluteDifference: altitudeDisagreement, threshold: 80 },
      ),
    );
  }
  const speedDisagreement =
    finite(measurements.indicatedAirspeed) && finite(measurements.gpsGroundSpeed)
      ? Math.abs(measurements.indicatedAirspeed - measurements.gpsGroundSpeed)
      : null;
  if (speedDisagreement !== null && speedDisagreement > 10) {
    results.push(
      indication(
        'investigation.redundancy.speed-disagreement',
        'Redundant speed sensors disagree',
        'warning',
        sampleIndex,
        sample.timestampMs,
        ['indicatedAirspeed', 'gpsGroundSpeed'],
        speedDisagreement,
        'absolute redundant speed disagreement <= 10 kts',
        ['sensor-lag', 'gain-error'],
        { absoluteDifference: speedDisagreement, threshold: 10 },
      ),
    );
  }
  const rateDisagreement =
    finite(measurements.inertialVerticalRate) && finite(measurements.barometricVerticalRate)
      ? Math.abs(measurements.inertialVerticalRate - measurements.barometricVerticalRate)
      : null;
  if (rateDisagreement !== null && rateDisagreement > 90) {
    results.push(
      indication(
        'investigation.redundancy.vertical-rate-disagreement',
        'Redundant vertical-rate sensors disagree',
        'warning',
        sampleIndex,
        sample.timestampMs,
        ['inertialVerticalRate', 'barometricVerticalRate'],
        rateDisagreement,
        'absolute redundant vertical-rate disagreement <= 90 ft/min',
        ['oscillation', 'cross-sensor-decoupling', 'simultaneous-faults'],
        { absoluteDifference: rateDisagreement, threshold: 90 },
      ),
    );
  }

  const vibrationWindow = scenario.samples
    .slice(Math.max(0, sampleIndex - 7), sampleIndex + 1)
    .map(({ measurements: values }) => values.vibration)
    .filter(finite);
  if (vibrationWindow.length === 8) {
    const rollingNoise = standardDeviation(vibrationWindow);
    if (rollingNoise > 0.025) {
      results.push(
        indication(
          'investigation.vibration.rolling-noise',
          'Vibration rolling noise is high',
          'warning',
          sampleIndex,
          sample.timestampMs,
          ['vibration'],
          rollingNoise,
          'eight-sample vibration population standard deviation <= 0.025 g',
          ['noise-growth'],
          { rollingStandardDeviation: rollingNoise, windowLength: 8, threshold: 0.025 },
        ),
      );
    }
  }

  if (sampleIndex >= 5) {
    const stuckWindow = scenario.samples.slice(sampleIndex - 5, sampleIndex + 1);
    const barometricRange = finiteRange(
      stuckWindow.map(({ measurements: values }) => values.barometricAltitude),
    );
    const gpsRange = finiteRange(stuckWindow.map(({ measurements: values }) => values.gpsAltitude));
    if (barometricRange !== null && gpsRange !== null && barometricRange <= 0.5 && gpsRange >= 8) {
      results.push(
        indication(
          'investigation.sensor.stuck-barometric-altitude',
          'Barometric altitude appears stuck',
          'error',
          sampleIndex,
          sample.timestampMs,
          ['barometricAltitude', 'gpsAltitude'],
          barometricRange,
          'six-sample barometric range > 0.5 ft when redundant GPS altitude changes',
          ['stuck-value'],
          { barometricRange, gpsRange, windowLength: 6 },
        ),
      );
    }
  }

  if (sampleIndex >= 4) {
    const fuelWindow = scenario.samples.slice(sampleIndex - 4, sampleIndex + 1);
    const quantities = fuelWindow.map(({ measurements: values }) => values.fuelQuantity);
    const flows = fuelWindow.map(({ measurements: values }) => values.fuelFlow).filter(finite);
    if (quantities.every(finite) && flows.length === 5) {
      const quantityDropPerSample = (quantities[0]! - quantities.at(-1)!) / 4;
      const averageFlow = flows.reduce((sum, value) => sum + value, 0) / flows.length;
      if (quantityDropPerSample > 0.27 && averageFlow > 0.9) {
        results.push(
          indication(
            'investigation.fuel.quantity-flow-relationship',
            'Fuel quantity loss is abnormal for observed flow',
            'error',
            sampleIndex,
            sample.timestampMs,
            ['fuelQuantity', 'fuelFlow'],
            quantityDropPerSample,
            'five-sample fuel quantity loss rate <= 0.27 percentage points per sample',
            ['fuel-leak', 'simultaneous-faults'],
            { quantityDropPerSample, averageFlow, windowLength: 5 },
          ),
        );
      }
    }
  }
  return results;
}

function productionAgreement(
  rulesIndicate: boolean,
  modelIndicates: boolean,
): InvestigationProductionAgreement {
  const state: InvestigationAgreement = rulesIndicate
    ? modelIndicates
      ? 'both-indicate'
      : 'rules-only'
    : modelIndicates
      ? 'model-only'
      : 'both-nominal';
  return {
    authority: 'deterministic-rules',
    state,
    authoritativeIndication: rulesIndicate,
    advisoryModelIndication: modelIndicates,
  };
}

function seriesPoint(point: InvestigationPoint, value: number | null): NumericSeriesPoint {
  return { sampleIndex: point.sampleIndex, timestampMs: point.timestampMs, value };
}

function buildSeries(
  scenario: TemporalScenario,
  points: readonly InvestigationPoint[],
): InvestigationSeries {
  return {
    expectedAltitude: points.map((point) =>
      seriesPoint(point, scenario.samples[point.sampleIndex]!.truth.altitude),
    ),
    observedAltitude: points.map((point) => seriesPoint(point, point.fusion.observed.altitude)),
    predictedAltitude: points.map((point) => seriesPoint(point, point.fusion.predicted.altitude)),
    estimatedAltitude: points.map((point) => seriesPoint(point, point.fusion.estimated.altitude)),
    altitude95Lower: points.map((point) => seriesPoint(point, point.fusion.altitude95[0])),
    altitude95Upper: points.map((point) => seriesPoint(point, point.fusion.altitude95[1])),
    expectedVerticalRate: points.map((point) =>
      seriesPoint(point, scenario.samples[point.sampleIndex]!.truth.verticalRate),
    ),
    observedVerticalRate: points.map((point) =>
      seriesPoint(point, point.fusion.observed.verticalRate),
    ),
    predictedVerticalRate: points.map((point) =>
      seriesPoint(point, point.fusion.predicted.verticalRate),
    ),
    estimatedVerticalRate: points.map((point) =>
      seriesPoint(point, point.fusion.estimated.verticalRate),
    ),
    verticalRate95Lower: points.map((point) => seriesPoint(point, point.fusion.verticalRate95[0])),
    verticalRate95Upper: points.map((point) => seriesPoint(point, point.fusion.verticalRate95[1])),
  };
}

function markers(scenario: TemporalScenario): InvestigationMarker[] {
  const timeline = scenario.faultTimeline;
  if (timeline === null) return [];
  const label = getTemporalFaultDefinition(timeline.faultId)?.label ?? timeline.faultId;
  const entries = [
    { kind: 'onset', sampleIndex: timeline.onsetIndex },
    { kind: 'active-end', sampleIndex: timeline.activeEndIndex },
    { kind: 'recovery-end', sampleIndex: timeline.recoveryEndIndex },
  ] as const;
  return entries.map(({ kind, sampleIndex }) => ({
    kind,
    sampleIndex,
    timestampMs: scenario.samples[sampleIndex]!.timestampMs,
    label,
  }));
}

function hypothesisScores(
  indications: readonly InvestigationIndication[],
  sampleCount: number,
): InvestigationHypothesisScore[] {
  return TEMPORAL_FAULT_LABELS.map((hypothesisType) => {
    const supporting = indications.filter((entry) =>
      entry.hypothesisTypes.includes(hypothesisType),
    );
    return {
      hypothesisType,
      indicationCount: supporting.length,
      firstIndicationIndex: supporting[0]?.sampleIndex ?? null,
      score: supporting.length / Math.max(1, sampleCount),
    };
  });
}

function detectionSummary(
  scenario: TemporalScenario,
  points: readonly InvestigationPoint[],
): InvestigationDetectionSummary {
  const onset = scenario.faultTimeline?.onsetIndex ?? 0;
  const deterministic = points.find(
    (point) => point.sampleIndex >= onset && point.indications.length > 0,
  );
  const model = points.find(
    (point) => point.sampleIndex >= onset && point.model.score?.anomalous === true,
  );
  const delay = (index: number | undefined): { samples: number | null; ms: number | null } =>
    index === undefined || scenario.faultTimeline === null
      ? { samples: null, ms: null }
      : { samples: index - onset, ms: (index - onset) * scenario.cadenceMs };
  const deterministicDelay = delay(deterministic?.sampleIndex);
  const modelDelay = delay(model?.sampleIndex);
  return {
    deterministicIndex: deterministic?.sampleIndex ?? null,
    deterministicDelaySamples: deterministicDelay.samples,
    deterministicDelayMs: deterministicDelay.ms,
    modelIndex: model?.sampleIndex ?? null,
    modelDelaySamples: modelDelay.samples,
    modelDelayMs: modelDelay.ms,
  };
}

export function analyzeTemporalScenario(
  scenario: TemporalScenario,
  options: AnalyzeTemporalScenarioOptions,
): TemporalScenarioInvestigation {
  if (scenario.samples.length === 0) throw new Error('Investigation requires temporal samples.');
  const projectModel = createInvestigationModelProjector(scenario);
  const phaseDetector = new MissionPhaseDetector();
  const modelWindow: ModelSample[] = [];
  const points: InvestigationPoint[] = [];
  const covarianceContext = covarianceScenarioContext(
    scenario,
    options.covarianceModelEnabled ?? false,
  );

  for (const sample of scenario.samples) {
    const { rawFusion, fusion, modelSample } = projectModel(sample);
    const speed =
      finiteMean([sample.measurements.indicatedAirspeed, sample.measurements.gpsGroundSpeed]) ?? 0;
    const phaseEvaluation = phaseDetector.update({
      sampleIndex: sample.sampleIndex,
      timestampMs: sample.timestampMs,
      speed,
      altitude: fusion.estimated.altitude,
      verticalRate: fusion.estimated.verticalRate,
    });
    modelWindow.push(modelSample);
    if (modelWindow.length > INVESTIGATION_MODEL_WINDOW_LENGTH) modelWindow.shift();
    const modelScore =
      modelWindow.length === INVESTIGATION_MODEL_WINDOW_LENGTH
        ? scoreTemporalFaultModel(temporalArtifactJson, modelWindow, options.modelEnabled)
        : null;
    const pointIndications = observedIndications(scenario, sample.sampleIndex, fusion);
    const agreement = productionAgreement(
      pointIndications.length > 0,
      modelScore?.anomalous === true,
    );
    const warmupRemaining = Math.max(0, INVESTIGATION_MODEL_WINDOW_LENGTH - modelWindow.length);
    const detectorEvidence = investigationPointEvidence(
      sample.measurements,
      fusion,
      pointIndications,
      warmupRemaining,
      modelScore,
      covarianceContext,
    );
    points.push({
      sampleIndex: sample.sampleIndex,
      timestampMs: sample.timestampMs,
      timestamp: sample.timestamp,
      phase: phaseEvaluation.phase,
      phaseEvaluation,
      fusion,
      maximumAbsoluteNormalizedResidual: rawFusion.evidence.maximumAbsoluteNormalizedInnovation,
      activeGroundTruthLabels: sample.faultLabels.map((label) => ({ ...label })),
      indications: pointIndications,
      model: {
        warmupRemaining,
        score: modelScore,
      },
      agreement,
      detectorEvidence,
    });
  }

  const allIndications = points.flatMap((point) => point.indications);
  const detection = detectionSummary(scenario, points);
  return {
    scenario: {
      scenarioId: scenario.scenarioId,
      seed: scenario.seed,
      cadenceMs: scenario.cadenceMs,
      startedAt: scenario.startedAt,
      synthetic: scenario.synthetic,
      dataClassification: scenario.dataClassification,
    },
    points,
    phaseTransitions: phaseDetector.transitions,
    indications: allIndications,
    markers: markers(scenario),
    series: buildSeries(scenario, points),
    hypothesisScores: hypothesisScores(allIndications, scenario.samples.length),
    detection,
    detectionIndex: detection.deterministicIndex,
    detectionDelaySamples: detection.deterministicDelaySamples,
    modelDetectionIndex: detection.modelIndex,
  };
}
