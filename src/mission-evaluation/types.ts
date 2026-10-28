export const MODEL_POLICY_IDS = ['model-k1', 'model-k2', 'model-k3', 'model-k5'] as const;
export const POLICY_IDS = [...MODEL_POLICY_IDS, 'deterministic'] as const;
export type ModelPolicyId = (typeof MODEL_POLICY_IDS)[number];
export type PolicyId = (typeof POLICY_IDS)[number];
export type ModelState = 'warmup' | 'unavailable' | 'abstained' | 'nominal' | 'anomalous';

/** Observations only. Fault labels and true phase deliberately do not belong here. */
export interface PredictionPoint {
  sampleIndex: number;
  timestampMs: number;
  phase: string;
  modelState: ModelState;
  deterministic: boolean;
}

export interface MissionTimeline {
  onsetIndex: number;
  activeEndIndex: number;
  recoveryEndIndex: number;
}

export interface MissionEvaluationInput {
  caseId: string;
  seed: number;
  family: string;
  variantId: string;
  cadenceMs: number;
  faultTimeline: MissionTimeline | null;
  predictions: readonly PredictionPoint[];
}

export interface AlertInterval {
  startIndex: number;
  endIndex: number;
  startMs: number;
  endMs: number;
}

export interface MissionPolicyResult {
  policyId: PolicyId;
  authority: 'advisory' | 'deterministic-rules';
  intervals: AlertInterval[];
  warmupSamples: number;
  eligibleSamples: number;
  answeredSamples: number;
  abstainedSamples: number;
  unavailableSamples: number;
  eligibleExposureMs: number;
  faultFreeExposureMs: number;
  activeEligibleSamples: number;
  activeAlarmSamples: number;
  recoveryEligibleSamples: number;
  recoveryAlarmSamples: number;
  recoveryAlarmMs: number;
  postRecoveryAlarmSamples: number;
  postRecoveryAlarmMs: number;
  /** Alarm exposure after recovery carried by an interval that began earlier. */
  carryoverAfterRecoveryMs: number;
  nominalEvaluable: boolean | null;
  nominalFalseAlarm: boolean | null;
  falseAlarmEpisodes: number;
  preOnsetFalseAlarmEpisodes: number;
  postRecoveryFalseAlarmEpisodes: number;
  observableFault: boolean | null;
  activeDetected: boolean | null;
  detectionIndex: number | null;
  detectionDelayMs: number | null;
  missReason: 'no-eligible-active-samples' | 'no-new-alert-during-active' | null;
}

export interface MissionEvaluationResult {
  caseId: string;
  seed: number;
  family: string;
  variantId: string;
  cadenceMs: number;
  sampleCount: number;
  faultTimeline: MissionTimeline | null;
  policies: Record<string, MissionPolicyResult>;
}

export interface MissionGroupSummary {
  missions: number;
  faultMissions: number;
  observableFaultMissions: number;
  unobservableFaultMissions: number;
  detectedFaultMissions: number;
  missedFaultMissions: number;
  activeRecall: number | null;
  nominalMissions: number;
  nominalEvaluableMissions: number;
  nominalUnavailableMissions: number;
  nominalFalseAlarmMissions: number;
  nominalFalseAlarmRate: number | null;
  falseAlarmEpisodes: number;
  preOnsetFalseAlarmEpisodes: number;
  postRecoveryFalseAlarmEpisodes: number;
  eligibleExposureMs: number;
  faultFreeExposureMs: number;
  falseAlarmsPerSyntheticHour: number | null;
  warmupSamples: number;
  eligibleSamples: number;
  answeredSamples: number;
  abstainedSamples: number;
  unavailableSamples: number;
  abstentionFraction: number | null;
  activeEligibleSamples: number;
  activeAlarmSamples: number;
  activeCoverage: number | null;
  recoveryEligibleSamples: number;
  recoveryAlarmSamples: number;
  recoveryAlarmMs: number;
  postRecoveryAlarmSamples: number;
  postRecoveryAlarmMs: number;
  carryoverAfterRecoveryMs: number;
  detectionDelayMs: {
    count: number;
    mean: number | null;
    median: number | null;
    p95: number | null;
  };
}

export interface MissionAggregate extends MissionGroupSummary {
  policyId: PolicyId;
  byFamily: Record<string, MissionGroupSummary>;
  byVariant: Record<string, MissionGroupSummary>;
}

export interface ConfidenceInterval {
  lower: number | null;
  upper: number | null;
  validReplicates: number;
}

export interface PairedBootstrapEvidence {
  unit: 'mission-seed';
  iterations: number;
  seed: number;
  confidenceLevel: 0.95;
  seedCount: number;
  baselineNominalFalseAlarmRate: ConfidenceInterval;
  candidateNominalFalseAlarmRate: ConfidenceInterval;
  nominalFalseAlarmRateDelta: ConfidenceInterval;
  baselineActiveRecall: ConfidenceInterval;
  candidateActiveRecall: ConfidenceInterval;
  activeRecallDelta: ConfidenceInterval;
  pairedMeanAddedDelayMs: ConfidenceInterval;
}

export interface PolicyConstraints {
  passed: boolean;
  overallRecallDrop: number | null;
  maximumFamilyRecallDrop: number | null;
  perFamilyRecallDrop: Record<string, number | null>;
  pairedDetections: number;
  pairedP95AddedDelayMs: number | null;
  reasons: string[];
}

export interface PolicyComparison {
  baselinePolicyId: 'model-k1';
  candidatePolicyId: ModelPolicyId;
  baseline: MissionAggregate;
  candidate: MissionAggregate;
  constraints: PolicyConstraints;
  confidence: PairedBootstrapEvidence;
}

export interface DevelopmentSelection {
  selectedPolicyId: ModelPolicyId;
  reason: string;
  comparisons: PolicyComparison[];
}

export interface FinalPolicyDecision {
  selectedPolicyId: ModelPolicyId;
  decision: 'improved' | 'inconclusive' | 'rejected' | 'no-improvement';
  reason: string;
  baseline: MissionAggregate;
  comparison: PolicyComparison | null;
}
