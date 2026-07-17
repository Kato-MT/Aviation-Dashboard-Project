import type {
  DetectionComparison,
  DeterministicFindingSummary,
  LearnedBaselineArtifact,
  LearnedBaselineScore,
} from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumberArray(value: unknown, length?: number): value is number[] {
  return (
    Array.isArray(value) &&
    (length === undefined || value.length === length) &&
    value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))
  );
}

export function parseLearnedBaselineArtifact(value: unknown): LearnedBaselineArtifact {
  if (!isRecord(value)) {
    throw new Error('Learned-baseline artifact must be an object.');
  }
  if (value.artifactVersion !== 'learned-baseline.v1') {
    throw new Error('Unsupported learned-baseline artifact version.');
  }
  if (value.modelType !== 'robust-regularized-covariance-mahalanobis') {
    throw new Error('Unsupported learned-baseline model type.');
  }
  if (!Array.isArray(value.channels) || value.channels.length === 0) {
    throw new Error('Model channels must be a non-empty array.');
  }
  const channels = value.channels;
  if (channels.some((entry) => typeof entry !== 'string' || entry.trim() === '')) {
    throw new Error('Every model channel must be a non-empty string.');
  }
  if (new Set(channels).size !== channels.length) {
    throw new Error('Model channel names must be unique.');
  }
  const width = channels.length;
  if (!isFiniteNumberArray(value.center, width) || !isFiniteNumberArray(value.scale, width)) {
    throw new Error('Model center and scale dimensions must match channels.');
  }
  if (value.scale.some((entry) => entry <= 0)) {
    throw new Error('Every model scale must be positive.');
  }
  if (
    !Array.isArray(value.inverseCovariance) ||
    value.inverseCovariance.length !== width ||
    value.inverseCovariance.some((row) => !isFiniteNumberArray(row, width))
  ) {
    throw new Error('inverseCovariance must be a finite square channel matrix.');
  }
  if (typeof value.scoreThreshold !== 'number' || !Number.isFinite(value.scoreThreshold)) {
    throw new Error('scoreThreshold must be finite.');
  }
  if (!isRecord(value.evaluation) || !isRecord(value.evaluation.metrics)) {
    throw new Error('Model evaluation metrics are required.');
  }
  if (!isRecord(value.qualityGate) || typeof value.qualityGate.passed !== 'boolean') {
    throw new Error('Model quality gate is required.');
  }
  return value as unknown as LearnedBaselineArtifact;
}

export function modelPassesQualityGate(artifact: LearnedBaselineArtifact): boolean {
  const metrics = artifact.evaluation.metrics;
  return (
    artifact.qualityGate.passed &&
    metrics.f1 >= artifact.qualityGate.minimumF1 &&
    metrics.falsePositiveRate <= artifact.qualityGate.maximumFalsePositiveRate
  );
}

export function scoreLearnedBaseline(
  artifactInput: LearnedBaselineArtifact | unknown,
  measurements: Readonly<Record<string, number | null | undefined>>,
  userEnabled = false,
): LearnedBaselineScore {
  const artifact = parseLearnedBaselineArtifact(artifactInput);
  const observed = artifact.channels.map((channel) => {
    const value = measurements[channel];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`A finite measurement is required for model channel ${channel}.`);
    }
    return value;
  });
  const residual = observed.map(
    (value, index) => (value - artifact.center[index]!) / artifact.scale[index]!,
  );
  const projected = artifact.inverseCovariance.map((row) =>
    row.reduce((sum, weight, index) => sum + weight * residual[index]!, 0),
  );
  const signed = residual.map((value, index) => value * projected[index]!);
  const score = Math.max(
    0,
    signed.reduce((sum, value) => sum + value, 0),
  );
  const absoluteTotal = signed.reduce((sum, value) => sum + Math.abs(value), 0);
  const qualityGatePassed = modelPassesQualityGate(artifact);
  const active = userEnabled && artifact.enabledByDefault && qualityGatePassed;
  const contributions = artifact.channels
    .map((channel, index) => ({
      channel,
      observed: observed[index]!,
      center: artifact.center[index]!,
      standardizedResidual: residual[index]!,
      signedContribution: signed[index]!,
      absoluteShare: absoluteTotal === 0 ? 0 : Math.abs(signed[index]!) / absoluteTotal,
    }))
    .sort((left, right) => right.absoluteShare - left.absoluteShare);

  return {
    modelVersion: artifact.modelVersion,
    score,
    threshold: artifact.scoreThreshold,
    anomalous: active && score >= artifact.scoreThreshold,
    active,
    qualityGatePassed,
    contributions,
  };
}

export function compareDetections(
  deterministicFindings: DeterministicFindingSummary[],
  learnedBaseline: LearnedBaselineScore,
): DetectionComparison {
  const rulesIndicate = deterministicFindings.length > 0;
  const modelIndicates = learnedBaseline.anomalous;
  const agreement = rulesIndicate
    ? modelIndicates
      ? 'both-indicate'
      : 'rules-only'
    : modelIndicates
      ? 'model-only'
      : 'both-nominal';
  return {
    authority: 'deterministic-rules',
    deterministicFindings,
    learnedBaseline,
    agreement,
  };
}
