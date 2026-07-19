import { sha256Hex } from '../core/hash';
import { computeCampaignMetrics, emptyConfusionMatrix } from './metrics';
import { assertCampaignSpec, stableCampaignStringify } from './serialization';
import {
  CAMPAIGN_SCHEMA_VERSION,
  type BuiltCampaignScenario,
  type CampaignCalibrationObservation,
  type CampaignCaseContext,
  type CampaignCaseResult,
  type CampaignDetection,
  type CampaignDetectionMatch,
  type CampaignEvaluation,
  type CampaignExpectedDetection,
  type CampaignProgress,
  type CampaignReplayManifest,
  type CampaignResult,
  type CampaignRunnerDependencies,
  type CampaignRunnerOptions,
  type CampaignScenarioSpec,
  type CampaignSpec,
} from './types';

function cloneJson<T>(value: T): T {
  return JSON.parse(stableCampaignStringify(value)) as T;
}

function caseIdFor(
  campaignId: string,
  profileId: string,
  profileVersion: string,
  scenarioId: string,
  phase: string,
  seed: number,
  variationId?: string,
): string {
  const encode = (value: string): string => encodeURIComponent(value);
  return [
    encode(campaignId),
    `profile=${encode(profileId)}@${encode(profileVersion)}`,
    `scenario=${encode(scenarioId)}`,
    `phase=${encode(phase)}`,
    ...(variationId === undefined ? [] : [`variation=${encode(variationId)}`]),
    `seed=${seed}`,
  ].join('|');
}

function buildCaseMatrix(spec: CampaignSpec): CampaignCaseContext[] {
  const totalCases = spec.profiles.length * spec.scenarios.length * spec.seeds.length;
  const cases: CampaignCaseContext[] = [];
  for (const profile of spec.profiles) {
    for (const scenario of spec.scenarios) {
      for (const seed of spec.seeds) {
        const caseIndex = cases.length;
        cases.push({
          caseId: caseIdFor(
            spec.campaignId,
            profile.profileId,
            profile.profileVersion,
            scenario.scenarioId,
            scenario.phase,
            seed,
            scenario.variation?.variationId,
          ),
          caseIndex,
          totalCases,
          campaignId: spec.campaignId,
          profile: { ...profile },
          scenario: cloneJson(scenario),
          seed,
        });
      }
    }
  }
  return cases;
}

async function createReplayManifest(
  spec: CampaignSpec,
  cases: readonly CampaignCaseContext[],
): Promise<CampaignReplayManifest> {
  return {
    schemaVersion: CAMPAIGN_SCHEMA_VERSION,
    campaignId: spec.campaignId,
    specSha256: await sha256Hex(stableCampaignStringify(spec)),
    cases: cases.map((campaignCase) => ({
      caseId: campaignCase.caseId,
      caseIndex: campaignCase.caseIndex,
      profile: { ...campaignCase.profile },
      scenarioId: campaignCase.scenario.scenarioId,
      phase: campaignCase.scenario.phase,
      seed: campaignCase.seed,
      ...(campaignCase.scenario.variation === undefined
        ? {}
        : { variation: cloneJson(campaignCase.scenario.variation) }),
    })),
  };
}

function normalizeExpectedDetections(
  values: readonly CampaignExpectedDetection[],
): CampaignExpectedDetection[] {
  const normalized = values.map((expected, index) => {
    if (typeof expected.ruleId !== 'string' || expected.ruleId.trim() === '') {
      throw new Error(`Expected detection ${index} requires a nonempty ruleId.`);
    }
    if (!Number.isFinite(expected.episodeStartMs) || expected.episodeStartMs < 0) {
      throw new Error(`Expected detection ${index} requires a nonnegative episodeStartMs.`);
    }
    return { ruleId: expected.ruleId, episodeStartMs: expected.episodeStartMs };
  });
  if (new Set(normalized.map((expected) => expected.ruleId)).size !== normalized.length) {
    throw new Error('Expected detections must use unique rule IDs per case.');
  }
  return normalized;
}

function normalizeNegativeRuleIds(values: readonly string[]): string[] {
  const normalized = values.map((ruleId, index) => {
    if (typeof ruleId !== 'string' || ruleId.trim() === '') {
      throw new Error(`Negative rule ${index} must be a nonempty string.`);
    }
    return ruleId;
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new Error('Negative rule IDs must be unique per case.');
  }
  return normalized;
}

function normalizeDetection(value: CampaignDetection, index: number): CampaignDetection {
  if (typeof value.ruleId !== 'string' || value.ruleId.trim() === '') {
    throw new Error(`Detection ${index} requires a nonempty ruleId.`);
  }
  const normalized: CampaignDetection = { ruleId: value.ruleId };
  if (value.detectedAtMs !== undefined) {
    if (!Number.isFinite(value.detectedAtMs) || value.detectedAtMs < 0) {
      throw new Error(`Detection ${index} detectedAtMs must be nonnegative and finite.`);
    }
    normalized.detectedAtMs = value.detectedAtMs;
  }
  if (value.confidence !== undefined) {
    if (!Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) {
      throw new Error(`Detection ${index} confidence must be between zero and one.`);
    }
    normalized.confidence = value.confidence;
  }
  if (value.details !== undefined) normalized.details = cloneJson(value.details);
  return normalized;
}

function normalizeCalibration(
  value: CampaignCalibrationObservation,
  index: number,
): CampaignCalibrationObservation {
  if (!Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) {
    throw new Error(`Calibration observation ${index} confidence must be between zero and one.`);
  }
  if (typeof value.correct !== 'boolean' || typeof value.abstained !== 'boolean') {
    throw new Error(`Calibration observation ${index} requires boolean outcome fields.`);
  }
  return {
    confidence: value.confidence,
    correct: value.correct,
    abstained: value.abstained,
  };
}

function normalizeDuration(value: number, path: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${path} must be nonnegative and finite.`);
  }
  return value;
}

function classifyDetections(
  expectedDetections: CampaignExpectedDetection[],
  negativeRuleIds: string[],
  detections: CampaignDetection[],
): Pick<
  CampaignCaseResult,
  'matchedDetections' | 'missingDetections' | 'unexpectedDetections' | 'confusion'
> {
  const unused = new Set(detections.map((_, index) => index));
  const matchedDetections: CampaignDetectionMatch[] = [];
  const missingDetections: CampaignExpectedDetection[] = [];

  for (const expected of expectedDetections) {
    const detectionIndex = detections.findIndex(
      (detection, index) =>
        unused.has(index) &&
        detection.ruleId === expected.ruleId &&
        (detection.detectedAtMs === undefined || detection.detectedAtMs >= expected.episodeStartMs),
    );
    if (detectionIndex < 0) {
      missingDetections.push({ ...expected });
      continue;
    }
    unused.delete(detectionIndex);
    const detection = detections[detectionIndex]!;
    const match: CampaignDetectionMatch = {
      expected: { ...expected },
      detection: cloneJson(detection),
    };
    if (detection.detectedAtMs !== undefined) {
      match.timeToDetectionMs = detection.detectedAtMs - expected.episodeStartMs;
    }
    matchedDetections.push(match);
  }

  const unexpectedDetections = detections
    .filter((_, index) => unused.has(index))
    .map((detection) => cloneJson(detection));
  const negativeSet = new Set(negativeRuleIds);
  const observedNegativeRules = new Set(
    unexpectedDetections
      .filter((detection) => negativeSet.has(detection.ruleId))
      .map((detection) => detection.ruleId),
  );

  return {
    matchedDetections,
    missingDetections,
    unexpectedDetections,
    confusion: {
      truePositives: matchedDetections.length,
      falsePositives: unexpectedDetections.length,
      trueNegatives: negativeRuleIds.length - observedNegativeRules.size,
      falseNegatives: missingDetections.length,
    },
  };
}

function completedCase<TInput>(
  context: CampaignCaseContext,
  built: BuiltCampaignScenario<TInput>,
  evaluation: CampaignEvaluation,
): CampaignCaseResult {
  const expectedDetections = normalizeExpectedDetections(
    built.expectedDetections ?? context.scenario.expectedDetections,
  );
  const negativeRuleIds = normalizeNegativeRuleIds(
    built.negativeRuleIds ?? context.scenario.negativeRuleIds,
  );
  if (
    negativeRuleIds.some((ruleId) =>
      expectedDetections.some((expected) => expected.ruleId === ruleId),
    )
  ) {
    throw new Error('A case cannot declare the same rule as expected and negative.');
  }
  const detections = evaluation.detections.map(normalizeDetection);
  const calibration = evaluation.calibration.map(normalizeCalibration);
  const duration = normalizeDuration(
    evaluation.syntheticDurationMs ??
      built.syntheticDurationMs ??
      context.scenario.syntheticDurationMs,
    'syntheticDurationMs',
  );
  const classification = classifyDetections(expectedDetections, negativeRuleIds, detections);
  return {
    caseId: context.caseId,
    caseIndex: context.caseIndex,
    profile: { ...context.profile },
    scenarioId: context.scenario.scenarioId,
    phase: context.scenario.phase,
    seed: context.seed,
    status: 'completed',
    syntheticDurationMs: duration,
    expectedDetections,
    negativeRuleIds,
    detections,
    matchedDetections: classification.matchedDetections,
    missingDetections: classification.missingDetections,
    unexpectedDetections: classification.unexpectedDetections,
    calibration,
    confusion: classification.confusion,
  };
}

function failedCase(context: CampaignCaseContext, error: unknown): CampaignCaseResult {
  const expectedDetections = normalizeExpectedDetections(context.scenario.expectedDetections);
  const negativeRuleIds = normalizeNegativeRuleIds(context.scenario.negativeRuleIds);
  return {
    caseId: context.caseId,
    caseIndex: context.caseIndex,
    profile: { ...context.profile },
    scenarioId: context.scenario.scenarioId,
    phase: context.scenario.phase,
    seed: context.seed,
    status: 'failed',
    syntheticDurationMs: context.scenario.syntheticDurationMs,
    expectedDetections,
    negativeRuleIds,
    detections: [],
    matchedDetections: [],
    missingDetections: expectedDetections.map((expected) => ({ ...expected })),
    unexpectedDetections: [],
    calibration: [],
    confusion: emptyConfusionMatrix(),
    error: {
      name: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

function isCancellation(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === 'AbortError');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error('Campaign execution was cancelled.');
  error.name = 'AbortError';
  throw error;
}

function reportProgress(
  callback: CampaignRunnerOptions['onProgress'],
  progress: CampaignProgress,
): void {
  callback?.(progress);
}

export async function runCampaign<TInput>(
  inputSpec: CampaignSpec,
  dependencies: CampaignRunnerDependencies<TInput>,
  options: CampaignRunnerOptions = {},
): Promise<CampaignResult> {
  assertCampaignSpec(inputSpec);
  const spec = cloneJson(inputSpec);
  const matrix = buildCaseMatrix(spec);
  const replayManifest = await createReplayManifest(spec, matrix);
  const runId = `${spec.campaignId}-${replayManifest.specSha256.slice(0, 16)}`;
  const cases: CampaignCaseResult[] = [];
  let cancelled = options.signal?.aborted === true;

  for (const context of matrix) {
    if (options.signal?.aborted) {
      cancelled = true;
      reportProgress(options.onProgress, {
        campaignId: spec.campaignId,
        completedCases: cases.length,
        totalCases: matrix.length,
        currentCaseId: context.caseId,
        currentCaseStatus: 'cancelled',
      });
      break;
    }

    let result: CampaignCaseResult;
    try {
      const built = await dependencies.buildScenario(context, options.signal);
      throwIfAborted(options.signal);
      const evaluation = await dependencies.evaluateScenario(built, context, options.signal);
      throwIfAborted(options.signal);
      result = completedCase(context, built, evaluation);
    } catch (error) {
      if (isCancellation(error, options.signal)) {
        cancelled = true;
        reportProgress(options.onProgress, {
          campaignId: spec.campaignId,
          completedCases: cases.length,
          totalCases: matrix.length,
          currentCaseId: context.caseId,
          currentCaseStatus: 'cancelled',
        });
        break;
      }
      result = failedCase(context, error);
    }

    cases.push(result);
    reportProgress(options.onProgress, {
      campaignId: spec.campaignId,
      completedCases: cases.length,
      totalCases: matrix.length,
      currentCaseId: context.caseId,
      currentCaseStatus: result.status,
    });
  }

  const completedCases = cases.filter((campaignCase) => campaignCase.status === 'completed').length;
  const failedCases = cases.length - completedCases;
  return {
    schemaVersion: CAMPAIGN_SCHEMA_VERSION,
    runId,
    campaignId: spec.campaignId,
    createdAt: spec.createdAt,
    status: cancelled ? 'cancelled' : failedCases > 0 ? 'completed-with-errors' : 'completed',
    spec,
    replayManifest,
    cases,
    summary: {
      plannedCases: matrix.length,
      attemptedCases: cases.length,
      completedCases,
      failedCases,
      remainingCases: matrix.length - cases.length,
    },
    metrics: computeCampaignMetrics(spec, cases),
  };
}

export function campaignScenarioFromSpec<TInput>(
  input: TInput,
  scenario: CampaignScenarioSpec,
): BuiltCampaignScenario<TInput> {
  return {
    input,
    expectedDetections: scenario.expectedDetections.map((expected) => ({ ...expected })),
    negativeRuleIds: [...scenario.negativeRuleIds],
    syntheticDurationMs: scenario.syntheticDurationMs,
  };
}
