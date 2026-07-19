import {
  TEMPORAL_DATA_CLASSIFICATION,
  type FusedKinematicState,
  type FusionEstimate,
  type FusionInput,
  type FusionMeasurements,
  type FusionSensorId,
  type FusionUncertainty,
  type SensorInnovation,
} from './types';

interface Covariance2x2 {
  p00: number;
  p01: number;
  p10: number;
  p11: number;
}

export interface FusionEstimatorConfig {
  initialAltitude: number;
  initialVerticalRate: number;
  initialAltitudeVariance: number;
  initialVerticalRateVariance: number;
  processNoiseAltitude: number;
  processNoiseVerticalRate: number;
  defaultDeltaSeconds: number;
  measurementVariance: Record<FusionSensorId, number>;
}

export type FusionEstimatorOptions = Partial<Omit<FusionEstimatorConfig, 'measurementVariance'>> & {
  measurementVariance?: Partial<Record<FusionSensorId, number>> | undefined;
};

const DEFAULT_MEASUREMENT_VARIANCE: Record<FusionSensorId, number> = {
  barometricAltitude: 64,
  gpsAltitude: 225,
  inertialVerticalRate: 225,
  barometricVerticalRate: 625,
};

const DEFAULT_CONFIG: FusionEstimatorConfig = {
  initialAltitude: 0,
  initialVerticalRate: 0,
  initialAltitudeVariance: 40_000,
  initialVerticalRateVariance: 10_000,
  processNoiseAltitude: 2,
  processNoiseVerticalRate: 6,
  defaultDeltaSeconds: 1,
  measurementVariance: DEFAULT_MEASUREMENT_VARIANCE,
};

const SENSOR_MODELS = [
  { sensorId: 'barometricAltitude', component: 'altitude' },
  { sensorId: 'gpsAltitude', component: 'altitude' },
  { sensorId: 'inertialVerticalRate', component: 'verticalRate' },
  { sensorId: 'barometricVerticalRate', component: 'verticalRate' },
] as const;

const MINIMUM_VARIANCE = 1e-9;
const CONFIDENCE_95 = 1.96;

function requireFinitePositive(value: number, label: string, allowZero = false): void {
  const valid = Number.isFinite(value) && (allowZero ? value >= 0 : value > 0);
  if (!valid)
    throw new Error(`${label} must be a ${allowZero ? 'nonnegative' : 'positive'} finite number.`);
}

function finiteMeasurement(
  measurements: FusionMeasurements,
  sensorId: FusionSensorId,
): number | null {
  const value = measurements[sensorId];
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value)) {
    throw new Error(`Fusion measurement ${sensorId} must be finite when present.`);
  }
  return value;
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function uncertainty(state: FusedKinematicState, covariance: Covariance2x2): FusionUncertainty {
  const altitudeStandardDeviation = Math.sqrt(Math.max(MINIMUM_VARIANCE, covariance.p00));
  const verticalRateStandardDeviation = Math.sqrt(Math.max(MINIMUM_VARIANCE, covariance.p11));
  return {
    altitudeStandardDeviation,
    verticalRateStandardDeviation,
    altitude95: [
      state.altitude - CONFIDENCE_95 * altitudeStandardDeviation,
      state.altitude + CONFIDENCE_95 * altitudeStandardDeviation,
    ],
    verticalRate95: [
      state.verticalRate - CONFIDENCE_95 * verticalRateStandardDeviation,
      state.verticalRate + CONFIDENCE_95 * verticalRateStandardDeviation,
    ],
  };
}

/**
 * Two-state Kalman filter for hidden altitude and vertical rate.
 *
 * The prediction step links altitude to vertical rate. Sequential measurement
 * updates then fuse two redundant altitude sensors and two redundant rate
 * sensors while retaining each sensor's residual as diagnostic evidence.
 */
export class KinematicFusionEstimator {
  readonly config: FusionEstimatorConfig;
  private state: FusedKinematicState;
  private covariance: Covariance2x2;
  private previousTimestampMs: number | null = null;

  constructor(options: FusionEstimatorOptions = {}) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...options,
      measurementVariance: {
        ...DEFAULT_MEASUREMENT_VARIANCE,
        ...options.measurementVariance,
      },
    };
    requireFinitePositive(this.config.initialAltitudeVariance, 'initialAltitudeVariance');
    requireFinitePositive(this.config.initialVerticalRateVariance, 'initialVerticalRateVariance');
    requireFinitePositive(this.config.processNoiseAltitude, 'processNoiseAltitude', true);
    requireFinitePositive(this.config.processNoiseVerticalRate, 'processNoiseVerticalRate', true);
    requireFinitePositive(this.config.defaultDeltaSeconds, 'defaultDeltaSeconds');
    for (const [sensorId, variance] of Object.entries(this.config.measurementVariance)) {
      requireFinitePositive(variance, `${sensorId} measurement variance`);
    }
    if (
      !Number.isFinite(this.config.initialAltitude) ||
      !Number.isFinite(this.config.initialVerticalRate)
    ) {
      throw new Error('Initial fusion state must be finite.');
    }
    this.state = {
      altitude: this.config.initialAltitude,
      verticalRate: this.config.initialVerticalRate,
    };
    this.covariance = {
      p00: this.config.initialAltitudeVariance,
      p01: 0,
      p10: 0,
      p11: this.config.initialVerticalRateVariance,
    };
  }

  update(input: FusionInput): FusionEstimate {
    if (![input.sampleIndex, input.timestampMs].every(Number.isFinite)) {
      throw new Error('Fusion sample index and timestamp must be finite.');
    }
    const deltaSeconds = this.deltaSeconds(input.timestampMs);
    this.predict(deltaSeconds);
    const predicted = { ...this.state };
    const innovations: SensorInnovation[] = [];
    const missingSensors: FusionSensorId[] = [];
    const altitudeObservations: number[] = [];
    const verticalRateObservations: number[] = [];

    for (const model of SENSOR_MODELS) {
      const observedValue = finiteMeasurement(input.measurements, model.sensorId);
      if (observedValue === null) {
        missingSensors.push(model.sensorId);
        continue;
      }
      if (model.component === 'altitude') altitudeObservations.push(observedValue);
      else verticalRateObservations.push(observedValue);
      innovations.push(
        this.measurementUpdate(
          model.sensorId,
          model.component,
          observedValue,
          this.config.measurementVariance[model.sensorId],
        ),
      );
    }

    this.previousTimestampMs = input.timestampMs;
    const estimated = { ...this.state };
    const estimateUncertainty = uncertainty(estimated, this.covariance);
    const maximumAbsoluteNormalizedInnovation = innovations.reduce(
      (maximum, entry) => Math.max(maximum, Math.abs(entry.normalizedInnovation)),
      0,
    );
    const observed = {
      altitude: mean(altitudeObservations),
      verticalRate: mean(verticalRateObservations),
    };
    const evidence = {
      evidenceVersion: 'sensor-fusion.v1' as const,
      ruleId: 'temporal.sensor-fusion.innovation' as const,
      sourceId: input.sourceId,
      sampleIndex: input.sampleIndex,
      timestampMs: input.timestampMs,
      message:
        maximumAbsoluteNormalizedInnovation > 3
          ? 'A redundant sensor observation exceeded the three-sigma innovation boundary.'
          : 'Available redundant observations remained within the three-sigma innovation boundary.',
      predicted,
      observed,
      estimated,
      innovations,
      uncertainty: estimateUncertainty,
      expectedCondition: 'absolute normalized innovation <= 3 for available sensors',
      maximumAbsoluteNormalizedInnovation,
      synthetic: true as const,
      dataClassification: TEMPORAL_DATA_CLASSIFICATION,
    };

    return {
      predicted,
      estimated,
      innovations,
      missingSensors,
      uncertainty: estimateUncertainty,
      evidence,
    };
  }

  private deltaSeconds(timestampMs: number): number {
    if (this.previousTimestampMs === null) return this.config.defaultDeltaSeconds;
    const deltaSeconds = (timestampMs - this.previousTimestampMs) / 1_000;
    if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) {
      throw new Error('Fusion timestamps must increase strictly.');
    }
    return Math.min(deltaSeconds, 60);
  }

  private predict(deltaSeconds: number): void {
    const { altitude, verticalRate } = this.state;
    const { p00, p01, p10, p11 } = this.covariance;
    this.state = {
      altitude: altitude + verticalRate * deltaSeconds,
      verticalRate,
    };
    this.covariance = {
      p00:
        p00 +
        deltaSeconds * (p01 + p10) +
        deltaSeconds * deltaSeconds * p11 +
        this.config.processNoiseAltitude * deltaSeconds * deltaSeconds,
      p01: p01 + deltaSeconds * p11,
      p10: p10 + deltaSeconds * p11,
      p11: p11 + this.config.processNoiseVerticalRate * deltaSeconds,
    };
  }

  private measurementUpdate(
    sensorId: FusionSensorId,
    component: 'altitude' | 'verticalRate',
    observedValue: number,
    measurementVariance: number,
  ): SensorInnovation {
    const predictedValue = this.state[component];
    const innovation = observedValue - predictedValue;
    const old = this.covariance;
    const innovationVariance = (component === 'altitude' ? old.p00 : old.p11) + measurementVariance;
    const gain0 = (component === 'altitude' ? old.p00 : old.p01) / innovationVariance;
    const gain1 = (component === 'altitude' ? old.p10 : old.p11) / innovationVariance;
    this.state = {
      altitude: this.state.altitude + gain0 * innovation,
      verticalRate: this.state.verticalRate + gain1 * innovation,
    };

    if (component === 'altitude') {
      this.covariance = {
        p00: old.p00 - gain0 * old.p00,
        p01: old.p01 - gain0 * old.p01,
        p10: old.p10 - gain1 * old.p00,
        p11: old.p11 - gain1 * old.p01,
      };
    } else {
      this.covariance = {
        p00: old.p00 - gain0 * old.p10,
        p01: old.p01 - gain0 * old.p11,
        p10: old.p10 - gain1 * old.p10,
        p11: old.p11 - gain1 * old.p11,
      };
    }

    const offDiagonal = (this.covariance.p01 + this.covariance.p10) / 2;
    this.covariance = {
      p00: Math.max(MINIMUM_VARIANCE, this.covariance.p00),
      p01: offDiagonal,
      p10: offDiagonal,
      p11: Math.max(MINIMUM_VARIANCE, this.covariance.p11),
    };

    return {
      sensorId,
      observedValue,
      predictedValue,
      innovation,
      innovationVariance,
      normalizedInnovation: innovation / Math.sqrt(innovationVariance),
      kalmanGain: [gain0, gain1],
      posteriorValue: this.state[component],
    };
  }
}
