import type {
  CalibrationStatistics,
  CampaignBootstrapIntervals,
  CampaignCaseResult,
  CampaignGroupMetrics,
  CampaignMetrics,
  CampaignSpec,
  ConfidenceInterval,
  ConfusionMatrix,
  DistributionSummary,
  EpisodeMetrics,
  ScenarioCoverage,
} from './types';

export function emptyConfusionMatrix(): ConfusionMatrix {
  return { truePositives: 0, falsePositives: 0, trueNegatives: 0, falseNegatives: 0 };
}

export function addConfusionMatrices(
  left: ConfusionMatrix,
  right: ConfusionMatrix,
): ConfusionMatrix {
  return {
    truePositives: left.truePositives + right.truePositives,
    falsePositives: left.falsePositives + right.falsePositives,
    trueNegatives: left.trueNegatives + right.trueNegatives,
    falseNegatives: left.falseNegatives + right.falseNegatives,
  };
}

/** Null denotes an unidentifiable denominator rather than an artificial zero or one. */
export function computeEpisodeMetrics(confusion: ConfusionMatrix): EpisodeMetrics {
  const precisionDenominator = confusion.truePositives + confusion.falsePositives;
  const recallDenominator = confusion.truePositives + confusion.falseNegatives;
  const precision =
    precisionDenominator === 0 ? null : confusion.truePositives / precisionDenominator;
  const recall = recallDenominator === 0 ? null : confusion.truePositives / recallDenominator;
  const f1 =
    precision === null || recall === null || precision + recall === 0
      ? precision === 0 && recall === 0
        ? 0
        : null
      : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1 };
}

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(sortedValues: readonly number[], probability: number): number | null {
  if (sortedValues.length === 0) return null;
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.floor((sortedValues.length - 1) * probability)),
  );
  return sortedValues[index] ?? null;
}

export function summarizeDistribution(values: readonly number[]): DistributionSummary {
  const sorted = [...values].filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length === 0) {
    return { count: 0, minimum: null, maximum: null, mean: null, median: null, p95: null };
  }
  const midpoint = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? ((sorted[midpoint - 1] ?? 0) + (sorted[midpoint] ?? 0)) / 2
      : (sorted[midpoint] ?? null);
  return {
    count: sorted.length,
    minimum: sorted[0] ?? null,
    maximum: sorted.at(-1) ?? null,
    mean: mean(sorted),
    median,
    p95: percentile(sorted, 0.95),
  };
}

export function computeCalibrationStatistics(
  cases: readonly CampaignCaseResult[],
): CalibrationStatistics {
  const observations = cases.flatMap((campaignCase) =>
    campaignCase.status === 'completed' ? campaignCase.calibration : [],
  );
  const answered = observations.filter((observation) => !observation.abstained);
  const correct = answered.filter((observation) => observation.correct);
  const incorrect = answered.filter((observation) => !observation.correct);
  const brierValues = answered.map(
    (observation) => (observation.confidence - (observation.correct ? 1 : 0)) ** 2,
  );

  let expectedCalibrationError: number | null = null;
  if (answered.length > 0) {
    let weightedError = 0;
    for (let binIndex = 0; binIndex < 10; binIndex += 1) {
      const lower = binIndex / 10;
      const upper = (binIndex + 1) / 10;
      const inBin = answered.filter((observation) =>
        binIndex === 9
          ? observation.confidence >= lower && observation.confidence <= upper
          : observation.confidence >= lower && observation.confidence < upper,
      );
      if (inBin.length === 0) continue;
      const confidence = mean(inBin.map((observation) => observation.confidence)) ?? 0;
      const accuracy = inBin.filter((observation) => observation.correct).length / inBin.length;
      weightedError += (inBin.length / answered.length) * Math.abs(accuracy - confidence);
    }
    expectedCalibrationError = weightedError;
  }

  return {
    observations: observations.length,
    answered: answered.length,
    abstained: observations.length - answered.length,
    abstentionRate:
      observations.length === 0
        ? null
        : (observations.length - answered.length) / observations.length,
    meanConfidence: mean(answered.map((observation) => observation.confidence)),
    meanConfidenceCorrect: mean(correct.map((observation) => observation.confidence)),
    meanConfidenceIncorrect: mean(incorrect.map((observation) => observation.confidence)),
    brierScore: mean(brierValues),
    expectedCalibrationError,
  };
}

function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function confidenceInterval(
  estimate: number | null,
  values: number[],
  confidenceLevel: number,
  iterations: number,
): ConfidenceInterval {
  values.sort((left, right) => left - right);
  const alpha = 1 - confidenceLevel;
  return {
    estimate,
    lower: percentile(values, alpha / 2),
    upper: percentile(values, 1 - alpha / 2),
    confidenceLevel,
    iterations,
  };
}

export function computeBootstrapIntervals(
  cases: readonly CampaignCaseResult[],
  spec: CampaignSpec['bootstrap'],
): CampaignBootstrapIntervals {
  const completed = cases.filter((campaignCase) => campaignCase.status === 'completed');
  const aggregate = completed.reduce(
    (matrix, campaignCase) => addConfusionMatrices(matrix, campaignCase.confusion),
    emptyConfusionMatrix(),
  );
  const estimate = computeEpisodeMetrics(aggregate);
  const precisionValues: number[] = [];
  const recallValues: number[] = [];
  const f1Values: number[] = [];
  const random = createSeededRandom(spec.seed);

  if (completed.length > 0) {
    for (let iteration = 0; iteration < spec.iterations; iteration += 1) {
      let sampled = emptyConfusionMatrix();
      for (let sampleIndex = 0; sampleIndex < completed.length; sampleIndex += 1) {
        const selected = completed[Math.floor(random() * completed.length)];
        if (selected) sampled = addConfusionMatrices(sampled, selected.confusion);
      }
      const metrics = computeEpisodeMetrics(sampled);
      if (metrics.precision !== null) precisionValues.push(metrics.precision);
      if (metrics.recall !== null) recallValues.push(metrics.recall);
      if (metrics.f1 !== null) f1Values.push(metrics.f1);
    }
  }

  return {
    precision: confidenceInterval(
      estimate.precision,
      precisionValues,
      spec.confidenceLevel,
      spec.iterations,
    ),
    recall: confidenceInterval(
      estimate.recall,
      recallValues,
      spec.confidenceLevel,
      spec.iterations,
    ),
    f1: confidenceInterval(estimate.f1, f1Values, spec.confidenceLevel, spec.iterations),
  };
}

function groupedMetrics(
  cases: readonly CampaignCaseResult[],
  key: (campaignCase: CampaignCaseResult) => string,
): CampaignGroupMetrics[] {
  const groups = new Map<string, CampaignCaseResult[]>();
  for (const campaignCase of cases) {
    if (campaignCase.status !== 'completed') continue;
    const groupId = key(campaignCase);
    const group = groups.get(groupId) ?? [];
    group.push(campaignCase);
    groups.set(groupId, group);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([groupId, groupedCases]) => {
      const confusion = groupedCases.reduce(
        (matrix, campaignCase) => addConfusionMatrices(matrix, campaignCase.confusion),
        emptyConfusionMatrix(),
      );
      return {
        groupId,
        completedCases: groupedCases.length,
        confusion,
        episodes: computeEpisodeMetrics(confusion),
      };
    });
}

function scenarioCoverage(
  spec: CampaignSpec,
  cases: readonly CampaignCaseResult[],
): ScenarioCoverage[] {
  const plannedPerScenario = spec.profiles.length * spec.seeds.length;
  return spec.scenarios.map((scenario) => {
    const completed = cases.filter(
      (campaignCase) =>
        campaignCase.status === 'completed' && campaignCase.scenarioId === scenario.scenarioId,
    );
    const expectedEpisodes = completed.reduce(
      (sum, campaignCase) => sum + campaignCase.expectedDetections.length,
      0,
    );
    const detectedExpectedEpisodes = completed.reduce(
      (sum, campaignCase) => sum + campaignCase.matchedDetections.length,
      0,
    );
    return {
      scenarioId: scenario.scenarioId,
      plannedCases: plannedPerScenario,
      completedCases: completed.length,
      casesWithAllExpected: completed.filter(
        (campaignCase) => campaignCase.missingDetections.length === 0,
      ).length,
      expectedEpisodes,
      detectedExpectedEpisodes,
      coverage: expectedEpisodes === 0 ? null : detectedExpectedEpisodes / expectedEpisodes,
    };
  });
}

export function computeCampaignMetrics(
  spec: CampaignSpec,
  cases: readonly CampaignCaseResult[],
): CampaignMetrics {
  const completed = cases.filter((campaignCase) => campaignCase.status === 'completed');
  const confusion = completed.reduce(
    (matrix, campaignCase) => addConfusionMatrices(matrix, campaignCase.confusion),
    emptyConfusionMatrix(),
  );
  const syntheticDurationMs = completed.reduce(
    (sum, campaignCase) => sum + campaignCase.syntheticDurationMs,
    0,
  );
  const syntheticHours = syntheticDurationMs / 3_600_000;
  const timeToDetectionValues = completed.flatMap((campaignCase) =>
    campaignCase.matchedDetections.flatMap((match) =>
      match.timeToDetectionMs === undefined ? [] : [match.timeToDetectionMs],
    ),
  );

  return {
    confusion,
    episodes: computeEpisodeMetrics(confusion),
    confusionByProfile: groupedMetrics(
      completed,
      (campaignCase) => `${campaignCase.profile.profileId}@${campaignCase.profile.profileVersion}`,
    ),
    confusionByPhase: groupedMetrics(completed, (campaignCase) => campaignCase.phase),
    confusionByFault: groupedMetrics(completed, (campaignCase) => campaignCase.scenarioId),
    scenarioCoverage: scenarioCoverage(spec, cases),
    falseAlarmsPerRun: completed.length === 0 ? null : confusion.falsePositives / completed.length,
    falseAlarmsPerSyntheticHour:
      syntheticHours === 0 ? null : confusion.falsePositives / syntheticHours,
    syntheticHours,
    timeToDetection: summarizeDistribution(timeToDetectionValues),
    calibration: computeCalibrationStatistics(completed),
    bootstrap: computeBootstrapIntervals(completed, spec.bootstrap),
  };
}
