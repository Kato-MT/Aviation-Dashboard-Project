export const CAMPAIGN_SCHEMA_VERSION = 'campaign.v1' as const;
export type CampaignSchemaVersion = typeof CAMPAIGN_SCHEMA_VERSION;

export interface CampaignProfileSpec {
  profileId: string;
  profileVersion: string;
}

export interface CampaignExpectedDetection {
  ruleId: string;
  /** Synthetic episode start relative to the case start. */
  episodeStartMs: number;
}

export interface CampaignScenarioVariation {
  variationId: string;
  generatorScenarioId: string;
  severityScale: number;
  durationScale: number;
  onsetPhase: string;
}

export interface CampaignScenarioSpec {
  scenarioId: string;
  label: string;
  phase: string;
  expectedDetections: CampaignExpectedDetection[];
  /** Declared negative opportunities make true negatives measurable. */
  negativeRuleIds: string[];
  syntheticDurationMs: number;
  /** Explicit parameters for a generated fault variant. Omitted for legacy and nominal cases. */
  variation?: CampaignScenarioVariation | undefined;
}

export interface CampaignBootstrapSpec {
  iterations: number;
  confidenceLevel: number;
  seed: number;
}

export interface CampaignSpec {
  schemaVersion: CampaignSchemaVersion;
  campaignId: string;
  createdAt: string;
  profiles: CampaignProfileSpec[];
  scenarios: CampaignScenarioSpec[];
  seeds: number[];
  bootstrap: CampaignBootstrapSpec;
  metadata: {
    synthetic: true;
    dataClassification: 'SYNTHETIC_UNCLASSIFIED';
    [key: string]: unknown;
  };
}

export interface CampaignCaseContext {
  caseId: string;
  caseIndex: number;
  totalCases: number;
  campaignId: string;
  profile: CampaignProfileSpec;
  scenario: CampaignScenarioSpec;
  seed: number;
}

export interface BuiltCampaignScenario<TInput> {
  input: TInput;
  expectedDetections?: CampaignExpectedDetection[];
  negativeRuleIds?: string[];
  syntheticDurationMs?: number;
}

export interface CampaignDetection {
  ruleId: string;
  detectedAtMs?: number;
  confidence?: number;
  details?: Record<string, unknown>;
}

export interface CampaignCalibrationObservation {
  confidence: number;
  correct: boolean;
  abstained: boolean;
}

export interface CampaignEvaluation {
  detections: CampaignDetection[];
  calibration: CampaignCalibrationObservation[];
  syntheticDurationMs?: number;
}

export interface ConfusionMatrix {
  truePositives: number;
  falsePositives: number;
  trueNegatives: number;
  falseNegatives: number;
}

export interface CampaignDetectionMatch {
  expected: CampaignExpectedDetection;
  detection: CampaignDetection;
  timeToDetectionMs?: number;
}

export interface CampaignCaseError {
  name: string;
  message: string;
}

export interface CampaignCaseResult {
  caseId: string;
  caseIndex: number;
  profile: CampaignProfileSpec;
  scenarioId: string;
  phase: string;
  seed: number;
  status: 'completed' | 'failed';
  syntheticDurationMs: number;
  expectedDetections: CampaignExpectedDetection[];
  negativeRuleIds: string[];
  detections: CampaignDetection[];
  matchedDetections: CampaignDetectionMatch[];
  missingDetections: CampaignExpectedDetection[];
  unexpectedDetections: CampaignDetection[];
  calibration: CampaignCalibrationObservation[];
  confusion: ConfusionMatrix;
  error?: CampaignCaseError;
}

export interface EpisodeMetrics {
  precision: number | null;
  recall: number | null;
  f1: number | null;
}

export interface CampaignGroupMetrics {
  groupId: string;
  completedCases: number;
  confusion: ConfusionMatrix;
  episodes: EpisodeMetrics;
}

export interface ScenarioCoverage {
  scenarioId: string;
  plannedCases: number;
  completedCases: number;
  casesWithAllExpected: number;
  expectedEpisodes: number;
  detectedExpectedEpisodes: number;
  coverage: number | null;
}

export interface DistributionSummary {
  count: number;
  minimum: number | null;
  maximum: number | null;
  mean: number | null;
  median: number | null;
  p95: number | null;
}

export interface CalibrationStatistics {
  observations: number;
  answered: number;
  abstained: number;
  abstentionRate: number | null;
  meanConfidence: number | null;
  meanConfidenceCorrect: number | null;
  meanConfidenceIncorrect: number | null;
  brierScore: number | null;
  expectedCalibrationError: number | null;
}

export interface ConfidenceInterval {
  estimate: number | null;
  lower: number | null;
  upper: number | null;
  confidenceLevel: number;
  iterations: number;
}

export interface CampaignBootstrapIntervals {
  precision: ConfidenceInterval;
  recall: ConfidenceInterval;
  f1: ConfidenceInterval;
}

export interface CampaignMetrics {
  confusion: ConfusionMatrix;
  episodes: EpisodeMetrics;
  confusionByProfile: CampaignGroupMetrics[];
  confusionByPhase: CampaignGroupMetrics[];
  confusionByFault: CampaignGroupMetrics[];
  scenarioCoverage: ScenarioCoverage[];
  falseAlarmsPerRun: number | null;
  falseAlarmsPerSyntheticHour: number | null;
  syntheticHours: number;
  timeToDetection: DistributionSummary;
  calibration: CalibrationStatistics;
  bootstrap: CampaignBootstrapIntervals;
}

export interface CampaignReplayCase {
  caseId: string;
  caseIndex: number;
  profile: CampaignProfileSpec;
  scenarioId: string;
  phase: string;
  seed: number;
  variation?: CampaignScenarioVariation | undefined;
}

export interface CampaignReplayManifest {
  schemaVersion: CampaignSchemaVersion;
  campaignId: string;
  specSha256: string;
  cases: CampaignReplayCase[];
}

export interface CampaignResult {
  schemaVersion: CampaignSchemaVersion;
  runId: string;
  campaignId: string;
  createdAt: string;
  status: 'completed' | 'completed-with-errors' | 'cancelled';
  spec: CampaignSpec;
  replayManifest: CampaignReplayManifest;
  cases: CampaignCaseResult[];
  summary: {
    plannedCases: number;
    attemptedCases: number;
    completedCases: number;
    failedCases: number;
    remainingCases: number;
  };
  metrics: CampaignMetrics;
}

export interface CampaignProgress {
  campaignId: string;
  completedCases: number;
  totalCases: number;
  currentCaseId: string | null;
  currentCaseStatus: 'completed' | 'failed' | 'cancelled' | null;
}

export interface CampaignRunnerDependencies<TInput> {
  buildScenario(
    context: CampaignCaseContext,
    signal?: AbortSignal,
  ): BuiltCampaignScenario<TInput> | Promise<BuiltCampaignScenario<TInput>>;
  evaluateScenario(
    scenario: BuiltCampaignScenario<TInput>,
    context: CampaignCaseContext,
    signal?: AbortSignal,
  ): CampaignEvaluation | Promise<CampaignEvaluation>;
}

export interface CampaignRunnerOptions {
  signal?: AbortSignal;
  onProgress?: (progress: CampaignProgress) => void;
}
