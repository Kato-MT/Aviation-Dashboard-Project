export interface ModelEvaluationMetrics {
  truePositives: number;
  falsePositives: number;
  trueNegatives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  f1: number;
  falsePositiveRate: number;
}

export interface LearnedBaselineArtifact {
  artifactVersion: 'learned-baseline.v1';
  modelVersion: string;
  modelType: 'robust-regularized-covariance-mahalanobis';
  generatedAt: string;
  syntheticDataOnly: true;
  enabledByDefault: boolean;
  channels: string[];
  center: number[];
  scale: number[];
  inverseCovariance: number[][];
  scoreThreshold: number;
  training: {
    seeds: number[];
    samplesPerSeed: number;
    totalSamples: number;
    winsorizationLimit: number;
    covarianceRegularization: number;
  };
  calibration: {
    seeds: number[];
    samplesPerSeed: number;
    thresholdPercentile: number;
  };
  evaluation: {
    seeds: number[];
    samplesPerSeed: number;
    faultFraction: number;
    metrics: ModelEvaluationMetrics;
    byFault: Record<string, { samples: number; detected: number; recall: number }>;
  };
  qualityGate: {
    minimumF1: number;
    maximumFalsePositiveRate: number;
    passed: boolean;
  };
  limitations: string[];
}

export interface ChannelResidualContribution {
  channel: string;
  observed: number;
  center: number;
  standardizedResidual: number;
  signedContribution: number;
  absoluteShare: number;
}

export interface LearnedBaselineScore {
  modelVersion: string;
  score: number;
  threshold: number;
  anomalous: boolean;
  active: boolean;
  qualityGatePassed: boolean;
  contributions: ChannelResidualContribution[];
}

export interface DeterministicFindingSummary {
  ruleId: string;
  severity: string;
  sourceId?: string;
  timestamp?: string;
}

export interface DetectionComparison {
  authority: 'deterministic-rules';
  deterministicFindings: DeterministicFindingSummary[];
  learnedBaseline: LearnedBaselineScore;
  agreement: 'both-nominal' | 'both-indicate' | 'rules-only' | 'model-only';
}
