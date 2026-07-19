import type { DetectionComparison } from './types';

export const TEMPORAL_CHANNELS = [
  'airspeed',
  'altitude',
  'verticalRate',
  'fuel',
  'vibration',
] as const;

export const TEMPORAL_FAULT_LABELS = [
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
] as const;

export const TEMPORAL_LABELS = ['nominal', ...TEMPORAL_FAULT_LABELS] as const;

export type TemporalChannel = (typeof TEMPORAL_CHANNELS)[number];
export type TemporalFaultLabel = (typeof TEMPORAL_FAULT_LABELS)[number];
export type TemporalLabel = (typeof TEMPORAL_LABELS)[number];
export type TemporalPredictedLabel = TemporalLabel | 'unknown';

export type TemporalSample = Readonly<Partial<Record<TemporalChannel, number | null | undefined>>>;

export interface TemporalEpisodeMetrics {
  readonly f1: number;
  readonly falsePositiveRate: number;
  readonly [key: string]: unknown;
}

export interface TemporalFaultModelArtifact {
  readonly artifactVersion: 'temporal-fault-model.v1';
  readonly modelVersion: string;
  readonly modelType:
    | 'causal-dilated-convolution-nearest-centroid'
    | 'causal-multiscale-feature-nearest-centroid'
    | 'causal-multiscale-feature-nearest-prototype';
  readonly generatedAt: string;
  readonly syntheticDataOnly: true;
  readonly enabledByDefault: boolean;
  readonly schemaVersion: 'telemetry.v1';
  readonly profile: { readonly id: string; readonly version: string };
  readonly windowLength: 40;
  readonly cadenceMs: number;
  readonly channels: readonly TemporalChannel[];
  readonly units: Readonly<Record<TemporalChannel, string>>;
  readonly featureNames: readonly string[];
  readonly featureCenter: readonly number[];
  readonly featureScale: readonly number[];
  readonly classCentroids?: Readonly<Record<TemporalLabel, readonly number[]>>;
  readonly classPrototypeIds?: Readonly<Record<TemporalLabel, readonly string[]>>;
  readonly classPrototypes?: Readonly<Record<TemporalLabel, readonly (readonly number[])[]>>;
  readonly classRadii: Readonly<Record<TemporalLabel, number>>;
  readonly nominalPrototypePhases?: readonly string[];
  readonly nominalPrototypes?: readonly (readonly number[])[];
  readonly anomalyDistanceThreshold?: number;
  readonly confidenceThreshold?: number;
  readonly temperature?: number;
  readonly relativeScoreThreshold?: number;
  readonly similarityTemperature?: number;
  readonly anomalyMarginThreshold: number;
  readonly evaluation: {
    readonly episodeMetrics?: TemporalEpisodeMetrics;
    readonly selectedWindowMetrics?: TemporalEpisodeMetrics;
    readonly classificationMacroF1: number;
    readonly [key: string]: unknown;
  };
  readonly qualityGate: {
    readonly minimumEpisodeF1?: number;
    readonly maximumFalsePositiveRate?: number;
    readonly minimumSelectedWindowF1?: number;
    readonly maximumSelectedWindowFalsePositiveRate?: number;
    readonly minimumClassificationMacroF1: number;
    readonly minimumPerFaultClassificationRecall: number;
    readonly observedMinimumPerFaultClassificationRecall: number;
    readonly passed: boolean;
  };
  readonly training: {
    readonly configurationSha256: string;
    readonly [key: string]: unknown;
  };
  readonly limitations: readonly string[];
  readonly [key: string]: unknown;
}

export interface TemporalFeatureVector {
  readonly names: readonly string[];
  readonly values: readonly number[];
}

export interface TemporalFaultHypothesis {
  readonly faultType: TemporalFaultLabel;
  readonly relativeScore: number;
  readonly distance: number;
}

export interface TemporalActivationState {
  readonly userSelection: 'enabled' | 'disabled';
  readonly eligibility: 'eligible' | 'ineligible';
  readonly active: boolean;
  readonly inactiveReason: 'user-disabled' | 'quality-gate-failed' | 'artifact-disabled' | null;
}

export interface TemporalModelScore {
  readonly modelVersion: string;
  readonly authority: DetectionComparison['authority'];
  readonly activation: TemporalActivationState;
  readonly qualityGatePassed: boolean;
  readonly predictedLabel: TemporalPredictedLabel;
  readonly nearestLabel: TemporalLabel;
  readonly relativeScore: number;
  readonly distance: number;
  readonly anomalyDistance?: number;
  readonly anomalyMargin: number;
  readonly abstained: boolean;
  readonly anomalous: boolean;
  readonly relativeScores: Readonly<Record<TemporalLabel, number>>;
  readonly hypotheses: readonly TemporalFaultHypothesis[];
}
