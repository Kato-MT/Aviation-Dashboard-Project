import { TEMPORAL_CHANNELS, type TemporalSample as ModelSample } from '../ml/temporalTypes';
import { KinematicFusionEstimator } from '../temporal/estimator';
import type {
  FusionEstimate,
  TemporalMeasurements,
  TemporalSample,
  TemporalScenario,
} from '../temporal/types';
import type { InvestigationFusionPoint } from './types';

export const INVESTIGATION_MODEL_WINDOW_LENGTH = 40;
export const INVESTIGATION_MODEL_PROJECTION_ID = 'investigation-model-projection';
export const INVESTIGATION_MODEL_PROJECTION_VERSION = '1.0.0';
export const INVESTIGATION_MODEL_CHANNELS = TEMPORAL_CHANNELS;

export interface InvestigationModelProjectionPoint {
  readonly rawFusion: FusionEstimate;
  readonly fusion: InvestigationFusionPoint;
  readonly modelSample: ModelSample;
}

export type InvestigationModelProjector = (
  sample: TemporalSample,
) => InvestigationModelProjectionPoint;

function finite(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function finiteMean(values: readonly (number | null | undefined)[]): number | null {
  const available = values.filter(finite);
  return available.length === 0
    ? null
    : available.reduce((sum, value) => sum + value, 0) / available.length;
}

function projectModelSample(
  measurements: TemporalMeasurements,
  fusion: InvestigationFusionPoint,
): ModelSample {
  const speed = finiteMean([measurements.indicatedAirspeed, measurements.gpsGroundSpeed]);
  const altitudeMissing =
    !finite(measurements.barometricAltitude) || !finite(measurements.gpsAltitude);
  const rateMissing =
    !finite(measurements.inertialVerticalRate) || !finite(measurements.barometricVerticalRate);
  return {
    airspeed: speed,
    altitude: altitudeMissing ? null : fusion.estimated.altitude,
    verticalRate: rateMissing ? null : fusion.estimated.verticalRate,
    fuel: measurements.fuelQuantity,
    vibration: measurements.vibration,
  };
}

function displayFusion(raw: FusionEstimate): InvestigationFusionPoint {
  const predictedVerticalRate = raw.predicted.verticalRate * 60;
  const estimatedVerticalRate = raw.estimated.verticalRate * 60;
  const observedVerticalRate =
    raw.evidence.observed.verticalRate === null ? null : raw.evidence.observed.verticalRate * 60;
  const verticalRate95 = [
    raw.uncertainty.verticalRate95[0] * 60,
    raw.uncertainty.verticalRate95[1] * 60,
  ] as const;
  const evidence = {
    ...raw.evidence,
    predicted: { altitude: raw.predicted.altitude, verticalRate: predictedVerticalRate },
    observed: { altitude: raw.evidence.observed.altitude, verticalRate: observedVerticalRate },
    estimated: { altitude: raw.estimated.altitude, verticalRate: estimatedVerticalRate },
    innovations: raw.evidence.innovations.map((entry) => {
      const rateSensor =
        entry.sensorId === 'inertialVerticalRate' || entry.sensorId === 'barometricVerticalRate';
      return rateSensor
        ? {
            ...entry,
            observedValue: entry.observedValue * 60,
            predictedValue: entry.predictedValue * 60,
            innovation: entry.innovation * 60,
            innovationVariance: entry.innovationVariance * 3_600,
            kalmanGain: [entry.kalmanGain[0] / 60, entry.kalmanGain[1]] as const,
            posteriorValue: entry.posteriorValue * 60,
          }
        : {
            ...entry,
            kalmanGain: [entry.kalmanGain[0], entry.kalmanGain[1] * 60] as const,
          };
    }),
    uncertainty: {
      ...raw.uncertainty,
      verticalRateStandardDeviation: raw.uncertainty.verticalRateStandardDeviation * 60,
      verticalRate95,
    },
  };
  return {
    predicted: { altitude: raw.predicted.altitude, verticalRate: predictedVerticalRate },
    observed: {
      altitude: raw.evidence.observed.altitude,
      verticalRate: observedVerticalRate,
    },
    estimated: { altitude: raw.estimated.altitude, verticalRate: estimatedVerticalRate },
    altitude95: raw.uncertainty.altitude95,
    verticalRate95,
    missingSensors: raw.missingSensors,
    evidence,
  };
}

/**
 * Creates the exact stateful projection used by Investigation inference.
 * Call the returned function once for each scenario sample in timestamp order.
 */
export function createInvestigationModelProjector(
  scenario: TemporalScenario,
): InvestigationModelProjector {
  if (scenario.samples.length === 0) {
    throw new Error('Investigation model projection requires temporal samples.');
  }
  const first = scenario.samples[0]!;
  const initialAltitude =
    finiteMean([first.measurements.barometricAltitude, first.measurements.gpsAltitude]) ?? 0;
  const initialVerticalRate =
    (finiteMean([
      first.measurements.inertialVerticalRate,
      first.measurements.barometricVerticalRate,
    ]) ?? 0) / 60;
  const estimator = new KinematicFusionEstimator({
    initialAltitude,
    initialVerticalRate,
    initialAltitudeVariance: 10_000,
    initialVerticalRateVariance: 100,
    processNoiseAltitude: 10_000,
    processNoiseVerticalRate: 25,
    defaultDeltaSeconds: scenario.cadenceMs / 1_000,
  });

  return (sample) => {
    const rawFusion = estimator.update({
      sourceId: sample.sourceId,
      sampleIndex: sample.sampleIndex,
      timestampMs: sample.timestampMs,
      measurements: {
        barometricAltitude: sample.measurements.barometricAltitude,
        gpsAltitude: sample.measurements.gpsAltitude,
        inertialVerticalRate: finite(sample.measurements.inertialVerticalRate)
          ? sample.measurements.inertialVerticalRate / 60
          : null,
        barometricVerticalRate: finite(sample.measurements.barometricVerticalRate)
          ? sample.measurements.barometricVerticalRate / 60
          : null,
      },
    });
    const fusion = displayFusion(rawFusion);
    return {
      rawFusion,
      fusion,
      modelSample: projectModelSample(sample.measurements, fusion),
    };
  };
}

export function projectInvestigationScenario(
  scenario: TemporalScenario,
): InvestigationModelProjectionPoint[] {
  const project = createInvestigationModelProjector(scenario);
  return scenario.samples.map((sample) => project(sample));
}
