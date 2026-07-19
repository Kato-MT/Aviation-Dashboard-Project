import type { LearnedBaselineScore } from '../ml/types';
import type {
  TemporalFaultLabel as ModelHypothesisType,
  TemporalModelScore,
} from '../ml/temporalTypes';
import type {
  FusionFindingEvidence,
  FusionSensorId,
  MissionPhase,
  PhaseEvaluation,
  PhaseTransitionEvidence,
  TemporalFaultLabel,
  TemporalScenario,
} from '../temporal/types';

export type InvestigationAgreement = 'both-indicate' | 'rules-only' | 'model-only' | 'both-nominal';

export type InvestigationSignalDecision = 'indicate' | 'nominal' | 'not-available';

export interface InvestigationDeterministicRuleState {
  readonly authority: 'deterministic-rules';
  readonly role: 'authoritative';
  readonly state: 'indicate' | 'nominal';
  readonly indicationCount: number;
  readonly ruleIds: readonly string[];
}

export interface InvestigationCovarianceCompatibilityReason {
  readonly code: string;
  readonly detail: string;
  readonly channels: readonly string[];
}

export interface InvestigationCovarianceAdvisoryState {
  readonly authority: 'deterministic-rules';
  readonly role: 'advisory';
  readonly registryEntryId: 'generic-fixed-wing.robust-covariance';
  readonly state: 'indicate' | 'nominal' | 'disabled' | 'ineligible' | 'unsupported';
  readonly decision: InvestigationSignalDecision;
  readonly supported: boolean;
  readonly active: boolean;
  readonly score: LearnedBaselineScore | null;
  readonly threshold: number;
  readonly unsupportedReason: string | null;
  readonly compatibilityReasons: readonly InvestigationCovarianceCompatibilityReason[];
}

export interface InvestigationKalmanResidualChannel {
  readonly sensorId: FusionSensorId;
  readonly normalizedInnovation: number;
  readonly absoluteNormalizedInnovation: number;
  readonly innovation: number;
  readonly observedValue: number;
  readonly predictedValue: number;
}

export interface InvestigationKalmanInnovationState {
  readonly authority: 'deterministic-rules';
  readonly role: 'supporting-evidence';
  readonly state: 'indicate' | 'nominal' | 'unsupported';
  readonly decision: InvestigationSignalDecision;
  readonly threshold: 3;
  readonly maximumAbsoluteNormalizedInnovation: number | null;
  readonly topResidualSensorChannels: readonly InvestigationKalmanResidualChannel[];
  readonly missingSensors: readonly FusionSensorId[];
  readonly unsupportedReason: string | null;
}

export interface InvestigationTemporalAdvisoryState {
  readonly authority: 'deterministic-rules';
  readonly role: 'advisory';
  readonly state: 'warming-up' | 'indicate' | 'nominal' | 'abstained' | 'disabled' | 'ineligible';
  readonly decision: InvestigationSignalDecision;
  readonly warmupRemaining: number;
  readonly score: TemporalModelScore | null;
}

export interface InvestigationFourWayAgreement {
  readonly authority: 'deterministic-rules';
  readonly authoritativeDecision: 'indicate' | 'nominal';
  readonly state: 'unanimous-indicate' | 'unanimous-nominal' | 'mixed';
  readonly complete: boolean;
  readonly decisions: {
    readonly deterministicRules: 'indicate' | 'nominal';
    readonly covarianceAdvisory: InvestigationSignalDecision;
    readonly kalmanInnovation: InvestigationSignalDecision;
    readonly temporalAdvisory: InvestigationSignalDecision;
  };
  readonly indicatingSignals: number;
  readonly nominalSignals: number;
  readonly unavailableSignals: readonly (
    'covariance-advisory' | 'kalman-innovation' | 'temporal-advisory'
  )[];
}

export interface InvestigationPointEvidence {
  readonly deterministicRules: InvestigationDeterministicRuleState;
  readonly covarianceAdvisory: InvestigationCovarianceAdvisoryState;
  readonly kalmanInnovation: InvestigationKalmanInnovationState;
  readonly temporalAdvisory: InvestigationTemporalAdvisoryState;
  readonly fourWayAgreement: InvestigationFourWayAgreement;
}

export interface InvestigationIndication {
  readonly indicationId: string;
  readonly ruleId: string;
  readonly label: string;
  readonly severity: 'warning' | 'error';
  readonly sampleIndex: number;
  readonly timestampMs: number;
  readonly sensorIds: readonly string[];
  readonly observedValue: number | string | null;
  readonly expectedCondition: string;
  readonly hypothesisTypes: readonly ModelHypothesisType[];
  readonly evidence: Readonly<Record<string, number | string | boolean | null>>;
}

export interface InvestigationFusionPoint {
  readonly predicted: { readonly altitude: number; readonly verticalRate: number };
  readonly observed: {
    readonly altitude: number | null;
    readonly verticalRate: number | null;
  };
  readonly estimated: { readonly altitude: number; readonly verticalRate: number };
  readonly altitude95: readonly [number, number];
  readonly verticalRate95: readonly [number, number];
  readonly missingSensors: readonly FusionSensorId[];
  readonly evidence: FusionFindingEvidence;
}

export interface InvestigationModelPoint {
  readonly warmupRemaining: number;
  readonly score: TemporalModelScore | null;
}

export interface InvestigationProductionAgreement {
  readonly authority: 'deterministic-rules';
  readonly state: InvestigationAgreement;
  readonly authoritativeIndication: boolean;
  readonly advisoryModelIndication: boolean;
}

export interface InvestigationPoint {
  readonly sampleIndex: number;
  readonly timestampMs: number;
  readonly timestamp: string;
  readonly phase: MissionPhase;
  readonly phaseEvaluation: PhaseEvaluation;
  readonly fusion: InvestigationFusionPoint;
  readonly maximumAbsoluteNormalizedResidual: number;
  readonly activeGroundTruthLabels: readonly TemporalFaultLabel[];
  readonly indications: readonly InvestigationIndication[];
  readonly model: InvestigationModelPoint;
  readonly agreement: InvestigationProductionAgreement;
  /** Observed-only detector evidence. Ground-truth labels are display metadata, never inputs here. */
  readonly detectorEvidence: InvestigationPointEvidence;
}

export interface InvestigationMarker {
  readonly kind: 'onset' | 'active-end' | 'recovery-end';
  readonly sampleIndex: number;
  readonly timestampMs: number;
  readonly label: string;
}

export interface NumericSeriesPoint {
  readonly sampleIndex: number;
  readonly timestampMs: number;
  readonly value: number | null;
}

export interface InvestigationSeries {
  readonly expectedAltitude: readonly NumericSeriesPoint[];
  readonly observedAltitude: readonly NumericSeriesPoint[];
  readonly predictedAltitude: readonly NumericSeriesPoint[];
  readonly estimatedAltitude: readonly NumericSeriesPoint[];
  readonly altitude95Lower: readonly NumericSeriesPoint[];
  readonly altitude95Upper: readonly NumericSeriesPoint[];
  readonly expectedVerticalRate: readonly NumericSeriesPoint[];
  readonly observedVerticalRate: readonly NumericSeriesPoint[];
  readonly predictedVerticalRate: readonly NumericSeriesPoint[];
  readonly estimatedVerticalRate: readonly NumericSeriesPoint[];
  readonly verticalRate95Lower: readonly NumericSeriesPoint[];
  readonly verticalRate95Upper: readonly NumericSeriesPoint[];
}

export interface InvestigationHypothesisScore {
  readonly hypothesisType: ModelHypothesisType;
  readonly indicationCount: number;
  readonly firstIndicationIndex: number | null;
  readonly score: number;
}

export interface InvestigationDetectionSummary {
  readonly deterministicIndex: number | null;
  readonly deterministicDelaySamples: number | null;
  readonly deterministicDelayMs: number | null;
  readonly modelIndex: number | null;
  readonly modelDelaySamples: number | null;
  readonly modelDelayMs: number | null;
}

export interface TemporalScenarioInvestigation {
  readonly scenario: Readonly<
    Pick<
      TemporalScenario,
      'scenarioId' | 'seed' | 'cadenceMs' | 'startedAt' | 'synthetic' | 'dataClassification'
    >
  >;
  readonly points: readonly InvestigationPoint[];
  readonly phaseTransitions: readonly PhaseTransitionEvidence[];
  readonly indications: readonly InvestigationIndication[];
  readonly markers: readonly InvestigationMarker[];
  readonly series: InvestigationSeries;
  readonly hypothesisScores: readonly InvestigationHypothesisScore[];
  readonly detection: InvestigationDetectionSummary;
  readonly detectionIndex: number | null;
  readonly detectionDelaySamples: number | null;
  readonly modelDetectionIndex: number | null;
}
