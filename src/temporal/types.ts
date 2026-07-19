export const TEMPORAL_SCHEMA_VERSION = 'temporal-synthetic.v1' as const;
export const TEMPORAL_DATA_CLASSIFICATION = 'SYNTHETIC_UNCLASSIFIED' as const;

export type MissionPhase = 'ground' | 'takeoff' | 'climb' | 'cruise' | 'descent' | 'landing';

export interface PhaseObservation {
  sampleIndex: number;
  timestampMs: number;
  speed: number;
  altitude: number;
  verticalRate: number;
}

export interface PhaseConditionEvidence {
  metric: 'speed' | 'altitude' | 'verticalRate' | 'absoluteVerticalRate';
  comparator: '>=' | '<=';
  threshold: number;
  observedValue: number;
  satisfied: boolean;
}

export interface PhaseTransitionEvidence {
  evidenceVersion: 'phase-transition.v1';
  ruleId: 'temporal.phase.transition';
  from: MissionPhase;
  to: MissionPhase;
  sampleIndex: number;
  timestampMs: number;
  confirmationSamples: number;
  observed: Pick<PhaseObservation, 'speed' | 'altitude' | 'verticalRate'>;
  expectedCondition: string;
  hysteresisCondition: string;
  conditionEvidence: PhaseConditionEvidence[];
  synthetic: true;
  dataClassification: typeof TEMPORAL_DATA_CLASSIFICATION;
}

export interface PhaseEvaluation {
  phase: MissionPhase;
  candidatePhase: MissionPhase | null;
  candidateCount: number;
  transitioned: boolean;
  transitionEvidence?: PhaseTransitionEvidence | undefined;
}

export type FusionSensorId =
  'barometricAltitude' | 'gpsAltitude' | 'inertialVerticalRate' | 'barometricVerticalRate';

export interface FusionMeasurements {
  barometricAltitude?: number | null | undefined;
  gpsAltitude?: number | null | undefined;
  inertialVerticalRate?: number | null | undefined;
  barometricVerticalRate?: number | null | undefined;
}

export interface FusionInput {
  sourceId: string;
  sampleIndex: number;
  timestampMs: number;
  measurements: FusionMeasurements;
}

export interface FusedKinematicState {
  altitude: number;
  verticalRate: number;
}

export interface SensorInnovation {
  sensorId: FusionSensorId;
  observedValue: number;
  predictedValue: number;
  innovation: number;
  innovationVariance: number;
  normalizedInnovation: number;
  kalmanGain: readonly [number, number];
  posteriorValue: number;
}

export interface FusionUncertainty {
  altitudeStandardDeviation: number;
  verticalRateStandardDeviation: number;
  altitude95: readonly [number, number];
  verticalRate95: readonly [number, number];
}

export interface FusionFindingEvidence {
  evidenceVersion: 'sensor-fusion.v1';
  ruleId: 'temporal.sensor-fusion.innovation';
  sourceId: string;
  sampleIndex: number;
  timestampMs: number;
  message: string;
  predicted: FusedKinematicState;
  observed: {
    altitude: number | null;
    verticalRate: number | null;
  };
  estimated: FusedKinematicState;
  innovations: SensorInnovation[];
  uncertainty: FusionUncertainty;
  expectedCondition: string;
  maximumAbsoluteNormalizedInnovation: number;
  synthetic: true;
  dataClassification: typeof TEMPORAL_DATA_CLASSIFICATION;
}

export interface FusionEstimate {
  predicted: FusedKinematicState;
  estimated: FusedKinematicState;
  innovations: SensorInnovation[];
  missingSensors: FusionSensorId[];
  uncertainty: FusionUncertainty;
  evidence: FusionFindingEvidence;
}

export type TemporalFaultId =
  | 'gradual-drift'
  | 'noise-growth'
  | 'oscillation'
  | 'lag'
  | 'intermittent-dropout'
  | 'stuck-value'
  | 'gain-error'
  | 'fuel-leak'
  | 'cross-sensor-decoupling'
  | 'simultaneous-faults';

export type TemporalSensorId =
  | 'indicatedAirspeed'
  | 'gpsGroundSpeed'
  | 'barometricAltitude'
  | 'gpsAltitude'
  | 'inertialVerticalRate'
  | 'barometricVerticalRate'
  | 'fuelQuantity'
  | 'fuelFlow'
  | 'vibration';

export type TemporalQuality = 'nominal' | 'injected' | 'missing' | 'recovering';

export interface TemporalFaultDefinition {
  id: TemporalFaultId;
  label: string;
  description: string;
  targetSensors: readonly TemporalSensorId[];
  onsetFraction: number;
  durationFraction: number;
  recoveryFraction: number;
}

export interface ResolvedFaultTimeline {
  faultId: TemporalFaultId;
  onsetIndex: number;
  durationSamples: number;
  recoverySamples: number;
  activeEndIndex: number;
  recoveryEndIndex: number;
}

export interface TemporalFaultConfiguration {
  /** Multiplier applied to the declared synthetic fault magnitude. */
  severityScale: number;
  /** Multiplier applied to the declared active duration. */
  durationScale: number;
  /** Optional mission phase used instead of the fault definition's default onset. */
  onsetPhase: MissionPhase | null;
}

export interface TemporalFaultLabel extends ResolvedFaultTimeline {
  label: string;
  lifecycle: 'active' | 'recovering';
  targetSensors: readonly TemporalSensorId[];
  synthetic: true;
}

export interface TemporalMeasurements {
  indicatedAirspeed: number | null;
  gpsGroundSpeed: number | null;
  barometricAltitude: number | null;
  gpsAltitude: number | null;
  inertialVerticalRate: number | null;
  barometricVerticalRate: number | null;
  fuelQuantity: number | null;
  fuelFlow: number | null;
  vibration: number | null;
}

export interface TemporalTruth {
  speed: number;
  altitude: number;
  verticalRate: number;
  fuel: number;
  fuelFlow: number;
  vibration: number;
}

export interface TemporalSample {
  sampleIndex: number;
  sourceId: 'synthetic-fixed-wing-1';
  timestampMs: number;
  timestamp: string;
  phaseTruth: MissionPhase;
  truth: TemporalTruth;
  measurements: TemporalMeasurements;
  quality: Record<TemporalSensorId, TemporalQuality>;
  faultLabels: TemporalFaultLabel[];
  synthetic: true;
  dataClassification: typeof TEMPORAL_DATA_CLASSIFICATION;
}

export interface TemporalScenario {
  schemaVersion: typeof TEMPORAL_SCHEMA_VERSION;
  profileId: 'generic-fixed-wing';
  scenarioId: TemporalFaultId | 'nominal';
  seed: number;
  cadenceMs: number;
  startedAt: string;
  synthetic: true;
  dataClassification: typeof TEMPORAL_DATA_CLASSIFICATION;
  /** Present when a caller explicitly varies the declared fault configuration. */
  faultConfiguration?: TemporalFaultConfiguration | undefined;
  faultTimeline: ResolvedFaultTimeline | null;
  samples: TemporalSample[];
}
