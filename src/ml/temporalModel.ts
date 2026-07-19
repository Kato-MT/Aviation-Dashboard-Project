import {
  TEMPORAL_CHANNELS,
  TEMPORAL_FAULT_LABELS,
  TEMPORAL_LABELS,
  type TemporalActivationState,
  type TemporalChannel,
  type TemporalFaultHypothesis,
  type TemporalFaultModelArtifact,
  type TemporalFeatureVector,
  type TemporalLabel,
  type TemporalModelScore,
  type TemporalPredictedLabel,
  type TemporalSample,
} from './temporalTypes';

const WINDOW_LENGTH = 40;
const FEATURE_SUFFIXES = [
  'mean',
  'std',
  'half-shift',
  'd1-rms',
  'd2-rms',
  'd4-rms',
  'curvature-rms',
  'freeze-ratio',
  'missing-fraction',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function finiteNumberArray(value: unknown, length?: number): value is number[] {
  return (
    Array.isArray(value) &&
    (length === undefined || value.length === length) &&
    value.every(isFiniteNumber)
  );
}

function assertFiniteField(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (!isFiniteNumber(value)) {
    throw new Error(`Temporal artifact ${field} must be finite.`);
  }
  return value;
}

function expectedFeatureNames(): string[] {
  const names = TEMPORAL_CHANNELS.flatMap((channel) =>
    FEATURE_SUFFIXES.map((suffix) => `${channel}.${suffix}`),
  );
  names.push(
    'cross.altitude-vertical-rate-correlation',
    'cross.altitude-vertical-rate-best-lag',
    'cross.altitude-vertical-rate-lag-improvement',
    'cross.airspeed-altitude-correlation',
    'cross.fuel-slope',
    'cross.vibration-growth-ratio',
  );
  return names;
}

export function parseTemporalFaultModelArtifact(value: unknown): TemporalFaultModelArtifact {
  if (!isRecord(value)) {
    throw new Error('Temporal fault-model artifact must be an object.');
  }
  if (value.artifactVersion !== 'temporal-fault-model.v1') {
    throw new Error('Unsupported temporal fault-model artifact version.');
  }
  if (
    value.modelType !== 'causal-dilated-convolution-nearest-centroid' &&
    value.modelType !== 'causal-multiscale-feature-nearest-centroid' &&
    value.modelType !== 'causal-multiscale-feature-nearest-prototype'
  ) {
    throw new Error('Unsupported temporal fault-model type.');
  }
  if (value.schemaVersion !== 'telemetry.v1') {
    throw new Error('Unsupported temporal telemetry schema version.');
  }
  if (value.windowLength !== WINDOW_LENGTH) {
    throw new Error(`Temporal model windowLength must be ${WINDOW_LENGTH}.`);
  }
  if (!Array.isArray(value.channels) || value.channels.length !== TEMPORAL_CHANNELS.length) {
    throw new Error('Temporal model channels do not match the supported channel contract.');
  }
  if (value.channels.some((channel, index) => channel !== TEMPORAL_CHANNELS[index])) {
    throw new Error('Temporal model channels do not match the supported channel contract.');
  }
  if (!isRecord(value.units)) {
    throw new Error('Temporal model units are required.');
  }
  for (const channel of TEMPORAL_CHANNELS) {
    if (typeof value.units[channel] !== 'string' || value.units[channel] === '') {
      throw new Error(`Temporal model unit is required for ${channel}.`);
    }
  }

  const names = expectedFeatureNames();
  if (
    !Array.isArray(value.featureNames) ||
    value.featureNames.length !== names.length ||
    value.featureNames.some((name, index) => name !== names[index])
  ) {
    throw new Error('Temporal feature names do not match the supported encoder contract.');
  }
  if (!finiteNumberArray(value.featureCenter, names.length)) {
    throw new Error('Temporal feature center dimensions must match feature names.');
  }
  if (
    !finiteNumberArray(value.featureScale, names.length) ||
    value.featureScale.some((scale) => scale <= 0)
  ) {
    throw new Error('Temporal feature scales must be positive and match feature names.');
  }
  if (!isRecord(value.classRadii)) {
    throw new Error('Temporal class radii are required.');
  }
  for (const label of TEMPORAL_LABELS) {
    if (!isFiniteNumber(value.classRadii[label]) || value.classRadii[label] <= 0) {
      throw new Error(`Temporal class radius for ${label} must be positive.`);
    }
  }
  if (value.modelType === 'causal-multiscale-feature-nearest-prototype') {
    if (!isRecord(value.classPrototypeIds) || !isRecord(value.classPrototypes)) {
      throw new Error('Temporal class prototype identities and vectors are required.');
    }
    for (const label of TEMPORAL_LABELS) {
      const prototypes = value.classPrototypes[label];
      const prototypeIds = value.classPrototypeIds[label];
      if (
        !Array.isArray(prototypes) ||
        prototypes.length === 0 ||
        prototypes.some((prototype) => !finiteNumberArray(prototype, names.length))
      ) {
        throw new Error(`Temporal prototypes for ${label} must match feature dimensions.`);
      }
      if (
        !Array.isArray(prototypeIds) ||
        prototypeIds.length !== prototypes.length ||
        prototypeIds.some((prototypeId) => typeof prototypeId !== 'string' || prototypeId === '')
      ) {
        throw new Error(`Temporal prototype identities for ${label} are required.`);
      }
    }
  } else {
    if (!isRecord(value.classCentroids)) {
      throw new Error('Temporal class centroids are required.');
    }
    for (const label of TEMPORAL_LABELS) {
      if (!finiteNumberArray(value.classCentroids[label], names.length)) {
        throw new Error(`Temporal centroid for ${label} must match feature dimensions.`);
      }
    }
  }
  if (
    value.modelType === 'causal-multiscale-feature-nearest-centroid' ||
    value.modelType === 'causal-multiscale-feature-nearest-prototype'
  ) {
    if (
      !Array.isArray(value.nominalPrototypes) ||
      value.nominalPrototypes.length === 0 ||
      value.nominalPrototypes.some((prototype) => !finiteNumberArray(prototype, names.length))
    ) {
      throw new Error('Integrated temporal nominal prototypes must match feature dimensions.');
    }
    if (
      !Array.isArray(value.nominalPrototypePhases) ||
      value.nominalPrototypePhases.length !== value.nominalPrototypes.length ||
      value.nominalPrototypePhases.some((phase) => typeof phase !== 'string' || phase === '')
    ) {
      throw new Error('Integrated temporal nominal prototype phases are required.');
    }
    const anomalyDistanceThreshold = assertFiniteField(value, 'anomalyDistanceThreshold');
    if (anomalyDistanceThreshold <= 0) {
      throw new Error('Integrated temporal anomalyDistanceThreshold must be positive.');
    }
  }
  const prototypeModel = value.modelType === 'causal-multiscale-feature-nearest-prototype';
  const scoreThreshold = assertFiniteField(
    value,
    prototypeModel ? 'relativeScoreThreshold' : 'confidenceThreshold',
  );
  const temperature = assertFiniteField(
    value,
    prototypeModel ? 'similarityTemperature' : 'temperature',
  );
  assertFiniteField(value, 'anomalyMarginThreshold');
  const cadenceMs = assertFiniteField(value, 'cadenceMs');
  if (scoreThreshold < 0 || scoreThreshold > 1) {
    throw new Error('Temporal score threshold must be between zero and one.');
  }
  if (temperature <= 0) {
    throw new Error('Temporal temperature must be positive.');
  }
  if (cadenceMs <= 0) {
    throw new Error('Temporal cadenceMs must be positive.');
  }
  if (typeof value.enabledByDefault !== 'boolean') {
    throw new Error('Temporal enabledByDefault flag is required.');
  }
  if (value.syntheticDataOnly !== true) {
    throw new Error('Temporal artifact must declare syntheticDataOnly.');
  }
  if (
    !isRecord(value.profile) ||
    typeof value.profile.id !== 'string' ||
    typeof value.profile.version !== 'string'
  ) {
    throw new Error('Temporal profile identity is required.');
  }
  if (!isRecord(value.evaluation)) {
    throw new Error('Temporal evaluation metrics are required.');
  }
  const evaluationMetrics = isRecord(value.evaluation.selectedWindowMetrics)
    ? value.evaluation.selectedWindowMetrics
    : value.evaluation.episodeMetrics;
  if (!isRecord(evaluationMetrics)) {
    throw new Error('Temporal selected-window or episode metrics are required.');
  }
  assertFiniteField(evaluationMetrics, 'f1');
  assertFiniteField(evaluationMetrics, 'falsePositiveRate');
  assertFiniteField(value.evaluation, 'classificationMacroF1');
  if (!isRecord(value.qualityGate) || typeof value.qualityGate.passed !== 'boolean') {
    throw new Error('Temporal quality gate is required.');
  }
  const f1GateField = prototypeModel ? 'minimumSelectedWindowF1' : 'minimumEpisodeF1';
  const falsePositiveGateField = prototypeModel
    ? 'maximumSelectedWindowFalsePositiveRate'
    : 'maximumFalsePositiveRate';
  for (const field of [
    f1GateField,
    falsePositiveGateField,
    'minimumClassificationMacroF1',
    'minimumPerFaultClassificationRecall',
    'observedMinimumPerFaultClassificationRecall',
  ]) {
    assertFiniteField(value.qualityGate, field);
  }
  if (
    !isRecord(value.training) ||
    typeof value.training.configurationSha256 !== 'string' ||
    !/^[a-f\d]{64}$/i.test(value.training.configurationSha256)
  ) {
    throw new Error('Temporal training configuration SHA-256 is required.');
  }
  if (
    !Array.isArray(value.limitations) ||
    value.limitations.some((item) => typeof item !== 'string')
  ) {
    throw new Error('Temporal model limitations must be strings.');
  }
  return value as unknown as TemporalFaultModelArtifact;
}

export function temporalModelPassesQualityGate(artifact: TemporalFaultModelArtifact): boolean {
  const gate = artifact.qualityGate;
  const evaluation = artifact.evaluation;
  const metrics = evaluation.selectedWindowMetrics ?? evaluation.episodeMetrics;
  const minimumF1 = gate.minimumSelectedWindowF1 ?? gate.minimumEpisodeF1;
  const maximumFalsePositiveRate =
    gate.maximumSelectedWindowFalsePositiveRate ?? gate.maximumFalsePositiveRate;
  return (
    gate.passed &&
    metrics !== undefined &&
    minimumF1 !== undefined &&
    maximumFalsePositiveRate !== undefined &&
    metrics.f1 >= minimumF1 &&
    metrics.falsePositiveRate <= maximumFalsePositiveRate &&
    evaluation.classificationMacroF1 >= gate.minimumClassificationMacroF1 &&
    gate.observedMinimumPerFaultClassificationRecall >= gate.minimumPerFaultClassificationRecall
  );
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function populationStandardDeviation(values: readonly number[]): number {
  const origin = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - origin) ** 2, 0) / values.length);
}

function impute(values: readonly (number | null | undefined)[]): {
  values: number[];
  missingFraction: number;
} {
  const missing = values.filter(
    (value) => typeof value !== 'number' || !Number.isFinite(value),
  ).length;
  const first =
    values.find((value): value is number => typeof value === 'number' && Number.isFinite(value)) ??
    0;
  let prior = first;
  const output = values.map((value) => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      prior = value;
    }
    return prior;
  });
  return { values: output, missingFraction: missing / values.length };
}

function rms(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length);
}

function correlation(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length || left.length < 2) {
    return 0;
  }
  const leftMean = mean(left);
  const rightMean = mean(right);
  let numerator = 0;
  let leftEnergy = 0;
  let rightEnergy = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftDelta = left[index]! - leftMean;
    const rightDelta = right[index]! - rightMean;
    numerator += leftDelta * rightDelta;
    leftEnergy += leftDelta ** 2;
    rightEnergy += rightDelta ** 2;
  }
  const denominator = Math.sqrt(leftEnergy * rightEnergy);
  return denominator > 1e-12 ? numerator / denominator : 0;
}

export function extractTemporalFeatures(window: readonly TemporalSample[]): TemporalFeatureVector {
  if (window.length !== WINDOW_LENGTH) {
    throw new Error(`Expected exactly ${WINDOW_LENGTH} temporal samples.`);
  }
  const channelValues = {} as Record<TemporalChannel, number[]>;
  const features: number[] = [];
  const half = WINDOW_LENGTH / 2;
  for (const channel of TEMPORAL_CHANNELS) {
    const imputed = impute(window.map((sample) => sample[channel]));
    const values = imputed.values;
    channelValues[channel] = values;
    const origin = mean(values);
    const d1 = values.slice(1).map((value, index) => value - values[index]!);
    const d2 = values.slice(2).map((value, index) => value - values[index]!);
    const d4 = values.slice(4).map((value, index) => value - values[index]!);
    const curvature = values
      .slice(2)
      .map((value, index) => value - 2 * values[index + 1]! + values[index]!);
    const tolerance = Math.max(Math.abs(origin) * 1e-6, 1e-8);
    features.push(
      origin,
      populationStandardDeviation(values),
      mean(values.slice(half)) - mean(values.slice(0, half)),
      rms(d1),
      rms(d2),
      rms(d4),
      rms(curvature),
      d1.filter((value) => Math.abs(value) <= tolerance).length / d1.length,
      imputed.missingFraction,
    );
  }

  const altitude = channelValues.altitude;
  const verticalRate = channelValues.verticalRate;
  const airspeed = channelValues.airspeed;
  const fuel = channelValues.fuel;
  const vibration = channelValues.vibration;
  const altitudeChanges = altitude.slice(1).map((value, index) => value - altitude[index]!);
  const verticalRateAligned = verticalRate.slice(1);
  const zeroLagCorrelation = correlation(altitudeChanges, verticalRateAligned);
  let bestLag = -8;
  let bestLagCorrelation = 0;
  let bestKey: readonly [number, number] = [-1, Number.NEGATIVE_INFINITY];
  for (let lag = -8; lag <= 8; lag += 1) {
    const left =
      lag < 0
        ? altitudeChanges.slice(-lag)
        : lag > 0
          ? altitudeChanges.slice(0, -lag)
          : altitudeChanges;
    const right =
      lag < 0
        ? verticalRateAligned.slice(0, left.length)
        : lag > 0
          ? verticalRateAligned.slice(lag)
          : verticalRateAligned;
    const value = correlation(left, right);
    const key: readonly [number, number] = [Math.abs(value), -Math.abs(lag)];
    if (key[0] > bestKey[0] || (key[0] === bestKey[0] && key[1] > bestKey[1])) {
      bestLag = lag;
      bestLagCorrelation = value;
      bestKey = key;
    }
  }
  features.push(
    zeroLagCorrelation,
    bestLag,
    Math.abs(bestLagCorrelation) - Math.abs(zeroLagCorrelation),
    correlation(airspeed, altitude),
    (fuel.at(-1)! - fuel[0]!) / (WINDOW_LENGTH - 1),
    populationStandardDeviation(vibration.slice(half)) /
      Math.max(populationStandardDeviation(vibration.slice(0, half)), 1e-9),
  );
  if (features.some((value) => !Number.isFinite(value))) {
    throw new Error('Temporal feature extraction produced a nonfinite value.');
  }
  return { names: expectedFeatureNames(), values: features };
}

function distance(left: readonly number[], right: readonly number[]): number {
  return left.reduce((sum, value, index) => sum + (value - right[index]!) ** 2, 0) / left.length;
}

function softmax(values: readonly number[]): number[] {
  const maximum = Math.max(...values);
  const exponents = values.map((value) => Math.exp(value - maximum));
  const total = exponents.reduce((sum, value) => sum + value, 0);
  return exponents.map((value) => value / total);
}

function activationState(
  artifact: TemporalFaultModelArtifact,
  userEnabled: boolean,
  qualityGatePassed: boolean,
): TemporalActivationState {
  const inactiveReason = !userEnabled
    ? 'user-disabled'
    : !artifact.enabledByDefault
      ? 'artifact-disabled'
      : !qualityGatePassed
        ? 'quality-gate-failed'
        : null;
  return {
    userSelection: userEnabled ? 'enabled' : 'disabled',
    eligibility: artifact.enabledByDefault && qualityGatePassed ? 'eligible' : 'ineligible',
    active: inactiveReason === null,
    inactiveReason,
  };
}

export function scoreTemporalFaultModel(
  artifactInput: TemporalFaultModelArtifact | unknown,
  window: readonly TemporalSample[],
  userEnabled = false,
): TemporalModelScore {
  const artifact = parseTemporalFaultModelArtifact(artifactInput);
  const features = extractTemporalFeatures(window).values;
  const standardized = features.map(
    (value, index) => (value - artifact.featureCenter[index]!) / artifact.featureScale[index]!,
  );
  const prototypeModel = artifact.modelType === 'causal-multiscale-feature-nearest-prototype';
  const distances = Object.fromEntries(
    TEMPORAL_LABELS.map((label) => [
      label,
      prototypeModel
        ? Math.min(
            ...artifact.classPrototypes![label].map((prototype) =>
              distance(standardized, prototype),
            ),
          )
        : distance(standardized, artifact.classCentroids![label]),
    ]),
  ) as Record<TemporalLabel, number>;
  const similarityTemperature = artifact.similarityTemperature ?? artifact.temperature!;
  const relativeScoreValues = softmax(
    TEMPORAL_LABELS.map((label) => -distances[label] / similarityTemperature),
  );
  const relativeScores = Object.fromEntries(
    TEMPORAL_LABELS.map((label, index) => [label, relativeScoreValues[index]!]),
  ) as Record<TemporalLabel, number>;
  const integratedDetection =
    artifact.modelType === 'causal-multiscale-feature-nearest-centroid' || prototypeModel;
  const anomalyDistance = integratedDetection
    ? Math.min(...artifact.nominalPrototypes!.map((prototype) => distance(standardized, prototype)))
    : distances.nominal;
  let nearestLabel: TemporalLabel;
  if (integratedDetection && anomalyDistance <= artifact.anomalyDistanceThreshold!) {
    nearestLabel = 'nominal';
  } else {
    const candidates = integratedDetection ? TEMPORAL_FAULT_LABELS : TEMPORAL_LABELS;
    nearestLabel = candidates[0];
    for (const label of candidates.slice(1)) {
      if (distances[label] < distances[nearestLabel]) nearestLabel = label;
    }
  }
  const relativeScore = relativeScores[nearestLabel];
  const nearestFaultDistance = Math.min(...TEMPORAL_FAULT_LABELS.map((label) => distances[label]));
  const anomalyMargin = distances.nominal - nearestFaultDistance;
  const insufficientFaultMargin =
    !integratedDetection &&
    nearestLabel !== 'nominal' &&
    anomalyMargin <= artifact.anomalyMarginThreshold;
  const distanceExceedsRadius =
    nearestLabel !== 'nominal' && distances[nearestLabel] > artifact.classRadii[nearestLabel];
  const minimumRelativeScore = artifact.relativeScoreThreshold ?? artifact.confidenceThreshold!;
  const rawAbstained =
    distanceExceedsRadius || relativeScore < minimumRelativeScore || insufficientFaultMargin;
  const rawPredictedLabel: TemporalPredictedLabel = rawAbstained ? 'unknown' : nearestLabel;
  const hypotheses: TemporalFaultHypothesis[] = TEMPORAL_FAULT_LABELS.map((faultType) => ({
    faultType,
    relativeScore: relativeScores[faultType],
    distance: distances[faultType],
  }))
    .sort(
      (left, right) =>
        right.relativeScore - left.relativeScore ||
        (left.faultType < right.faultType ? -1 : left.faultType > right.faultType ? 1 : 0),
    )
    .slice(0, 3);
  const qualityGatePassed = temporalModelPassesQualityGate(artifact);
  const activation = activationState(artifact, userEnabled, qualityGatePassed);
  return {
    modelVersion: artifact.modelVersion,
    authority: 'deterministic-rules',
    activation,
    qualityGatePassed,
    predictedLabel: activation.active ? rawPredictedLabel : 'unknown',
    nearestLabel,
    relativeScore,
    distance:
      integratedDetection && nearestLabel === 'nominal' ? anomalyDistance : distances[nearestLabel],
    anomalyDistance,
    anomalyMargin,
    abstained: !activation.active || rawAbstained,
    anomalous: activation.active && !rawAbstained && nearestLabel !== 'nominal',
    relativeScores,
    hypotheses,
  };
}
