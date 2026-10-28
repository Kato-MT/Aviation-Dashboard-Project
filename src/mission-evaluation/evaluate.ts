import type { TemporalScenarioInvestigation } from '../investigation/types';
import { INVESTIGATION_MODEL_WINDOW_LENGTH } from '../investigation/modelProjection';
import {
  POLICY_IDS,
  type AlertInterval,
  type MissionEvaluationInput,
  type MissionEvaluationResult,
  type MissionPolicyResult,
  type ModelState,
  type PolicyId,
  type PredictionPoint,
} from './types';

export const FIRST_ELIGIBLE_INDEX = INVESTIGATION_MODEL_WINDOW_LENGTH - 1;
export const MAX_EVALUATION_SAMPLES = 10_000;
const MODEL_STATES: readonly ModelState[] = [
  'warmup',
  'unavailable',
  'abstained',
  'nominal',
  'anomalous',
];

export function extractPredictions(
  investigation: TemporalScenarioInvestigation,
): PredictionPoint[] {
  return investigation.points.map((point) => {
    const score = point.model.score;
    const modelState: ModelState =
      point.model.warmupRemaining > 0
        ? 'warmup'
        : score === null || !score.activation.active
          ? 'unavailable'
          : score.abstained || score.predictedLabel === 'unknown'
            ? 'abstained'
            : score.anomalous
              ? 'anomalous'
              : 'nominal';
    return {
      sampleIndex: point.sampleIndex,
      timestampMs: point.timestampMs,
      phase: point.phase,
      modelState,
      deterministic: point.indications.length > 0,
    };
  });
}

function validateInput(input: MissionEvaluationInput): void {
  for (const key of ['caseId', 'family', 'variantId'] as const) {
    if (typeof input[key] !== 'string' || input[key].length === 0 || input[key].length > 200) {
      throw new Error(`Mission ${key} must contain 1 to 200 characters.`);
    }
  }
  if (!Number.isInteger(input.seed) || input.seed < 1 || input.seed > 2_147_483_647) {
    throw new Error('Mission seed must be a positive 32-bit integer.');
  }
  if (!Number.isFinite(input.cadenceMs) || input.cadenceMs <= 0) {
    throw new Error('Mission cadence must be positive and finite.');
  }
  if (input.predictions.length === 0 || input.predictions.length > MAX_EVALUATION_SAMPLES) {
    throw new Error(`Mission must contain 1 to ${MAX_EVALUATION_SAMPLES} predictions.`);
  }
  const startMs = input.predictions[0]!.timestampMs;
  for (const [index, point] of input.predictions.entries()) {
    if (
      point.sampleIndex !== index ||
      !Number.isFinite(point.timestampMs) ||
      point.timestampMs !== startMs + index * input.cadenceMs
    ) {
      throw new Error(
        'Mission predictions must have contiguous zero-based indices and exact cadence.',
      );
    }
    if (
      !MODEL_STATES.includes(point.modelState) ||
      typeof point.deterministic !== 'boolean' ||
      typeof point.phase !== 'string' ||
      point.phase.length === 0
    ) {
      throw new Error(
        'Mission prediction has an invalid state, phase, or deterministic indication.',
      );
    }
    if (index < FIRST_ELIGIBLE_INDEX !== (point.modelState === 'warmup')) {
      throw new Error('Mission predictions must preserve the 39-sample model warmup.');
    }
  }
  const timeline = input.faultTimeline;
  if (timeline === undefined || (input.family === 'nominal') !== (timeline === null)) {
    throw new Error('Mission requires explicit, family-compatible fault truth.');
  }
  if (timeline !== null) {
    if (
      ![timeline.onsetIndex, timeline.activeEndIndex, timeline.recoveryEndIndex].every(
        Number.isInteger,
      ) ||
      timeline.onsetIndex < 0 ||
      timeline.activeEndIndex < timeline.onsetIndex ||
      timeline.recoveryEndIndex < timeline.activeEndIndex ||
      timeline.recoveryEndIndex >= input.predictions.length
    ) {
      throw new Error('Mission fault timeline must be ordered, inclusive, and inside the mission.');
    }
  }
}

function policyStreak(policyId: PolicyId): number {
  if (!POLICY_IDS.includes(policyId)) throw new Error(`Unsupported mission policy '${policyId}'.`);
  return policyId === 'deterministic' ? 1 : Number(policyId.slice(-1));
}

function scorePolicy(input: MissionEvaluationInput, policyId: PolicyId): MissionPolicyResult {
  const streakRequired = policyStreak(policyId);
  const deterministic = policyId === 'deterministic';
  const timeline = input.faultTimeline;
  const intervals: AlertInterval[] = [];
  let streak = 0;
  let open: AlertInterval | null = null;
  let answeredSamples = 0;
  let abstainedSamples = 0;
  let unavailableSamples = 0;
  let eligibleExposureMs = 0;
  let faultFreeExposureMs = 0;
  let activeEligibleSamples = 0;
  let activeAlarmSamples = 0;
  let recoveryEligibleSamples = 0;
  let recoveryAlarmSamples = 0;
  let recoveryAlarmMs = 0;
  let postRecoveryAlarmSamples = 0;
  let postRecoveryAlarmMs = 0;
  let carryoverAfterRecoveryMs = 0;
  for (const point of input.predictions.slice(FIRST_ELIGIBLE_INDEX)) {
    const index = point.sampleIndex;
    const exposureMs = index === input.predictions.length - 1 ? 0 : input.cadenceMs;
    const unavailable = !deterministic && point.modelState === 'unavailable';
    const abstained = !deterministic && point.modelState === 'abstained';
    if (unavailable) unavailableSamples += 1;
    else if (abstained) abstainedSamples += 1;
    else answeredSamples += 1;
    if (!unavailable) eligibleExposureMs += exposureMs;
    const active =
      timeline !== null && index >= timeline.onsetIndex && index <= timeline.activeEndIndex;
    const recovering =
      timeline !== null && index > timeline.activeEndIndex && index <= timeline.recoveryEndIndex;
    const postRecovery = timeline !== null && index > timeline.recoveryEndIndex;
    if (active) activeEligibleSamples += 1;
    if (recovering) recoveryEligibleSamples += 1;
    if (!active && !recovering && !unavailable) faultFreeExposureMs += exposureMs;
    const positive = deterministic ? point.deterministic : point.modelState === 'anomalous';
    streak = positive ? streak + 1 : 0;
    if (streak < streakRequired) {
      open = null;
      continue;
    }
    if (open === null) {
      let startIndex = index;
      // Rules have no model warmup. Preserve a pre-existing rule interval rather
      // than inventing a new detection when the shared evaluation window opens.
      if (deterministic && index === FIRST_ELIGIBLE_INDEX) {
        while (startIndex > 0 && input.predictions[startIndex - 1]!.deterministic) startIndex -= 1;
      }
      open = {
        startIndex,
        endIndex: index,
        startMs: input.predictions[startIndex]!.timestampMs,
        endMs: point.timestampMs,
      };
      intervals.push(open);
    } else {
      open.endIndex = index;
      open.endMs = point.timestampMs;
    }
    if (active) activeAlarmSamples += 1;
    if (recovering) {
      recoveryAlarmSamples += 1;
      recoveryAlarmMs += exposureMs;
    }
    if (postRecovery) {
      postRecoveryAlarmSamples += 1;
      postRecoveryAlarmMs += exposureMs;
      if (open.startIndex <= timeline!.recoveryEndIndex) carryoverAfterRecoveryMs += exposureMs;
    }
  }
  const nominal = timeline === null;
  const eligibleSamples = Math.max(0, input.predictions.length - FIRST_ELIGIBLE_INDEX);
  const nominalEvaluable = nominal ? eligibleSamples > unavailableSamples : null;
  const eligibleStarts = intervals.filter((event) => event.startIndex >= FIRST_ELIGIBLE_INDEX);
  const preOnsetFalseAlarmEpisodes =
    timeline === null
      ? 0
      : eligibleStarts.filter((event) => event.startIndex < timeline.onsetIndex).length;
  const postRecoveryFalseAlarmEpisodes =
    timeline === null
      ? 0
      : eligibleStarts.filter((event) => event.startIndex > timeline.recoveryEndIndex).length;
  const observableFault = nominal ? null : activeEligibleSamples > 0;
  const detection =
    timeline === null
      ? undefined
      : eligibleStarts.find(
          (event) =>
            event.startIndex >= timeline.onsetIndex && event.startIndex <= timeline.activeEndIndex,
        );
  const activeDetected = observableFault ? detection !== undefined : null;
  return {
    policyId,
    authority: deterministic ? 'deterministic-rules' : 'advisory',
    intervals,
    warmupSamples: Math.min(FIRST_ELIGIBLE_INDEX, input.predictions.length),
    eligibleSamples,
    answeredSamples,
    abstainedSamples,
    unavailableSamples,
    eligibleExposureMs,
    faultFreeExposureMs,
    activeEligibleSamples,
    activeAlarmSamples,
    recoveryEligibleSamples,
    recoveryAlarmSamples,
    recoveryAlarmMs,
    postRecoveryAlarmSamples,
    postRecoveryAlarmMs,
    carryoverAfterRecoveryMs,
    nominalEvaluable,
    nominalFalseAlarm: nominalEvaluable ? intervals.length > 0 : null,
    falseAlarmEpisodes: nominal
      ? eligibleStarts.length
      : preOnsetFalseAlarmEpisodes + postRecoveryFalseAlarmEpisodes,
    preOnsetFalseAlarmEpisodes,
    postRecoveryFalseAlarmEpisodes,
    observableFault,
    activeDetected,
    detectionIndex: detection?.startIndex ?? null,
    detectionDelayMs:
      detection === undefined
        ? null
        : (detection.startIndex - timeline!.onsetIndex) * input.cadenceMs,
    missReason: nominal
      ? null
      : observableFault === false
        ? 'no-eligible-active-samples'
        : activeDetected
          ? null
          : 'no-new-alert-during-active',
  };
}

export function evaluateMission(
  input: MissionEvaluationInput,
  policyIds: readonly PolicyId[] = POLICY_IDS,
): MissionEvaluationResult {
  validateInput(input);
  if (policyIds.length === 0 || new Set(policyIds).size !== policyIds.length) {
    throw new Error('Mission evaluation requires a nonempty set of unique policies.');
  }
  return {
    caseId: input.caseId,
    seed: input.seed,
    family: input.family,
    variantId: input.variantId,
    cadenceMs: input.cadenceMs,
    sampleCount: input.predictions.length,
    faultTimeline: input.faultTimeline === null ? null : { ...input.faultTimeline },
    policies: Object.fromEntries(
      policyIds.map((policyId) => [policyId, scorePolicy(input, policyId)]),
    ),
  };
}
