import { sha256Hex } from '../core/hash';
import { computeCampaignMetrics } from './metrics';
import {
  CAMPAIGN_SCHEMA_VERSION,
  type CampaignCaseResult,
  type CampaignDetection,
  type CampaignExpectedDetection,
  type CampaignResult,
  type CampaignSpec,
} from './types';

export const MAX_CAMPAIGN_PROFILES = 4;
export const MAX_CAMPAIGN_SCENARIOS = 64;
export const MAX_CAMPAIGN_SEEDS = 12;
export const MAX_CAMPAIGN_CASES = 372;
export const MAX_CAMPAIGN_SPEC_BYTES = 256 * 1024;
export const MAX_CAMPAIGN_RESULT_BYTES = 10 * 1024 * 1024;
export const MAX_CAMPAIGN_RULES_PER_CASE = 128;
export const MAX_CAMPAIGN_CALIBRATION_OBSERVATIONS_PER_CASE = 2_048;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${path} must be a nonempty string.`);
  }
}

function requireFiniteNumber(value: unknown, path: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number.`);
  }
}

function requireNonnegativeInteger(value: unknown, path: string): asserts value is number {
  requireFiniteNumber(value, path);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${path} must be a nonnegative integer.`);
  }
}

function requireUnique(values: readonly string[], path: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`${path} must not contain duplicates.`);
  }
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function requireSerializedSize(value: unknown, maximumBytes: number, path: string): void {
  const size = utf8ByteLength(stableCampaignStringify(value));
  if (size > maximumBytes) {
    throw new Error(`${path} exceeds the ${maximumBytes}-byte limit.`);
  }
}

/** Validates the serializable campaign contract before matrix construction. */
export function assertCampaignSpec(value: unknown): asserts value is CampaignSpec {
  if (!isRecord(value)) throw new Error('Campaign spec must be an object.');
  requireSerializedSize(value, MAX_CAMPAIGN_SPEC_BYTES, 'Campaign spec');
  if (value.schemaVersion !== CAMPAIGN_SCHEMA_VERSION) {
    throw new Error(`Campaign spec schemaVersion must be '${CAMPAIGN_SCHEMA_VERSION}'.`);
  }
  requireString(value.campaignId, 'campaignId');
  requireString(value.createdAt, 'createdAt');
  if (Number.isNaN(Date.parse(value.createdAt))) {
    throw new Error('createdAt must be a valid timestamp.');
  }

  if (!Array.isArray(value.profiles) || value.profiles.length === 0) {
    throw new Error('profiles must contain at least one profile.');
  }
  if (value.profiles.length > MAX_CAMPAIGN_PROFILES) {
    throw new Error(`profiles must not exceed ${MAX_CAMPAIGN_PROFILES} entries.`);
  }
  const profileKeys = value.profiles.map((profile, index) => {
    if (!isRecord(profile)) throw new Error(`profiles[${index}] must be an object.`);
    requireString(profile.profileId, `profiles[${index}].profileId`);
    requireString(profile.profileVersion, `profiles[${index}].profileVersion`);
    return `${profile.profileId}@${profile.profileVersion}`;
  });
  requireUnique(profileKeys, 'profiles');

  if (!Array.isArray(value.scenarios) || value.scenarios.length === 0) {
    throw new Error('scenarios must contain at least one scenario.');
  }
  if (value.scenarios.length > MAX_CAMPAIGN_SCENARIOS) {
    throw new Error(`scenarios must not exceed ${MAX_CAMPAIGN_SCENARIOS} entries.`);
  }
  const scenarioIds = value.scenarios.map((scenario, scenarioIndex) => {
    if (!isRecord(scenario)) throw new Error(`scenarios[${scenarioIndex}] must be an object.`);
    requireString(scenario.scenarioId, `scenarios[${scenarioIndex}].scenarioId`);
    requireString(scenario.label, `scenarios[${scenarioIndex}].label`);
    requireString(scenario.phase, `scenarios[${scenarioIndex}].phase`);
    requireFiniteNumber(
      scenario.syntheticDurationMs,
      `scenarios[${scenarioIndex}].syntheticDurationMs`,
    );
    if (scenario.syntheticDurationMs < 0) {
      throw new Error(`scenarios[${scenarioIndex}].syntheticDurationMs must be nonnegative.`);
    }
    if (!Array.isArray(scenario.expectedDetections)) {
      throw new Error(`scenarios[${scenarioIndex}].expectedDetections must be an array.`);
    }
    const expectedRuleIds = scenario.expectedDetections.map((expected, expectedIndex) => {
      if (!isRecord(expected)) {
        throw new Error(
          `scenarios[${scenarioIndex}].expectedDetections[${expectedIndex}] must be an object.`,
        );
      }
      requireString(
        expected.ruleId,
        `scenarios[${scenarioIndex}].expectedDetections[${expectedIndex}].ruleId`,
      );
      requireFiniteNumber(
        expected.episodeStartMs,
        `scenarios[${scenarioIndex}].expectedDetections[${expectedIndex}].episodeStartMs`,
      );
      if (expected.episodeStartMs < 0) {
        throw new Error('episodeStartMs must be nonnegative.');
      }
      return expected.ruleId;
    });
    requireUnique(expectedRuleIds, `scenarios[${scenarioIndex}].expectedDetections`);
    if (!Array.isArray(scenario.negativeRuleIds)) {
      throw new Error(`scenarios[${scenarioIndex}].negativeRuleIds must be an array.`);
    }
    const negativeRuleIds = scenario.negativeRuleIds.map((ruleId, negativeIndex) => {
      requireString(ruleId, `scenarios[${scenarioIndex}].negativeRuleIds[${negativeIndex}]`);
      return ruleId;
    });
    requireUnique(negativeRuleIds, `scenarios[${scenarioIndex}].negativeRuleIds`);
    if (negativeRuleIds.some((ruleId) => expectedRuleIds.includes(ruleId))) {
      throw new Error(
        `Scenario '${scenario.scenarioId}' declares a rule as positive and negative.`,
      );
    }
    if (scenario.variation !== undefined) {
      if (!isRecord(scenario.variation)) {
        throw new Error(`scenarios[${scenarioIndex}].variation must be an object.`);
      }
      requireString(
        scenario.variation.variationId,
        `scenarios[${scenarioIndex}].variation.variationId`,
      );
      requireString(
        scenario.variation.generatorScenarioId,
        `scenarios[${scenarioIndex}].variation.generatorScenarioId`,
      );
      requireString(
        scenario.variation.onsetPhase,
        `scenarios[${scenarioIndex}].variation.onsetPhase`,
      );
      requireFiniteNumber(
        scenario.variation.severityScale,
        `scenarios[${scenarioIndex}].variation.severityScale`,
      );
      requireFiniteNumber(
        scenario.variation.durationScale,
        `scenarios[${scenarioIndex}].variation.durationScale`,
      );
      if (scenario.variation.severityScale <= 0 || scenario.variation.durationScale <= 0) {
        throw new Error(`scenarios[${scenarioIndex}].variation scales must be greater than zero.`);
      }
    }
    return scenario.scenarioId;
  });
  requireUnique(scenarioIds, 'scenarios');

  if (!Array.isArray(value.seeds) || value.seeds.length === 0) {
    throw new Error('seeds must contain at least one seed.');
  }
  if (value.seeds.length > MAX_CAMPAIGN_SEEDS) {
    throw new Error(`seeds must not exceed ${MAX_CAMPAIGN_SEEDS} entries.`);
  }
  const seedKeys = value.seeds.map((seed, index) => {
    requireNonnegativeInteger(seed, `seeds[${index}]`);
    if (seed > 0xffff_ffff) throw new Error(`seeds[${index}] must fit in 32 bits.`);
    return String(seed);
  });
  requireUnique(seedKeys, 'seeds');

  const totalCases = value.profiles.length * value.scenarios.length * value.seeds.length;
  if (totalCases > MAX_CAMPAIGN_CASES) {
    throw new Error(`Campaign matrix must not exceed ${MAX_CAMPAIGN_CASES} cases.`);
  }

  if (!isRecord(value.bootstrap)) throw new Error('bootstrap must be an object.');
  requireNonnegativeInteger(value.bootstrap.iterations, 'bootstrap.iterations');
  if (value.bootstrap.iterations < 1 || value.bootstrap.iterations > 10_000) {
    throw new Error('bootstrap.iterations must be between 1 and 10000.');
  }
  requireFiniteNumber(value.bootstrap.confidenceLevel, 'bootstrap.confidenceLevel');
  if (value.bootstrap.confidenceLevel <= 0 || value.bootstrap.confidenceLevel >= 1) {
    throw new Error('bootstrap.confidenceLevel must be between zero and one.');
  }
  requireNonnegativeInteger(value.bootstrap.seed, 'bootstrap.seed');
  if (!isRecord(value.metadata)) throw new Error('metadata must be an object.');
  if (value.metadata.synthetic !== true) throw new Error('metadata.synthetic must be true.');
  if (value.metadata.dataClassification !== 'SYNTHETIC_UNCLASSIFIED') {
    throw new Error("metadata.dataClassification must be 'SYNTHETIC_UNCLASSIFIED'.");
  }
}

function assertSerializable(value: unknown, path = 'value'): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${path} contains a nonfinite number.`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertSerializable(entry, `${path}[${index}]`));
    return;
  }
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) throw new Error(`${path}.${key} is undefined.`);
      assertSerializable(entry, `${path}.${key}`);
    }
    return;
  }
  throw new Error(`${path} contains a non-JSON value.`);
}

/** Stable JSON representation used for fingerprints and deterministic equality checks. */
export function stableCampaignStringify(value: unknown): string {
  assertSerializable(value);
  const normalize = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (isRecord(entry)) {
      return Object.fromEntries(
        Object.keys(entry)
          .sort()
          .map((key) => [key, normalize(entry[key])]),
      );
    }
    return entry;
  };
  return JSON.stringify(normalize(value));
}

function requireArray(value: unknown, path: string): asserts value is unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array.`);
}

function requireBoolean(value: unknown, path: string): asserts value is boolean {
  if (typeof value !== 'boolean') throw new Error(`${path} must be a boolean.`);
}

function requireNonnegativeFinite(value: unknown, path: string): asserts value is number {
  requireFiniteNumber(value, path);
  if (value < 0) throw new Error(`${path} must be nonnegative.`);
}

function assertExpectedDetection(
  value: unknown,
  path: string,
): asserts value is CampaignExpectedDetection {
  if (!isRecord(value)) throw new Error(`${path} must be an object.`);
  requireString(value.ruleId, `${path}.ruleId`);
  requireNonnegativeFinite(value.episodeStartMs, `${path}.episodeStartMs`);
}

function assertDetection(value: unknown, path: string): asserts value is CampaignDetection {
  if (!isRecord(value)) throw new Error(`${path} must be an object.`);
  requireString(value.ruleId, `${path}.ruleId`);
  if (value.detectedAtMs !== undefined) {
    requireNonnegativeFinite(value.detectedAtMs, `${path}.detectedAtMs`);
  }
  if (value.confidence !== undefined) {
    requireFiniteNumber(value.confidence, `${path}.confidence`);
    if (value.confidence < 0 || value.confidence > 1) {
      throw new Error(`${path}.confidence must be between zero and one.`);
    }
  }
  if (value.details !== undefined) assertSerializable(value.details, `${path}.details`);
}

function sameMultiset(left: readonly unknown[], right: readonly unknown[]): boolean {
  const counts = new Map<string, number>();
  for (const value of left) {
    const key = stableCampaignStringify(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const value of right) {
    const key = stableCampaignStringify(value);
    const count = counts.get(key) ?? 0;
    if (count === 0) return false;
    if (count === 1) counts.delete(key);
    else counts.set(key, count - 1);
  }
  return counts.size === 0;
}

function assertCampaignCase(value: unknown, path: string): asserts value is CampaignCaseResult {
  if (!isRecord(value)) throw new Error(`${path} must be an object.`);
  requireString(value.caseId, `${path}.caseId`);
  requireNonnegativeInteger(value.caseIndex, `${path}.caseIndex`);
  if (!isRecord(value.profile)) throw new Error(`${path}.profile must be an object.`);
  requireString(value.profile.profileId, `${path}.profile.profileId`);
  requireString(value.profile.profileVersion, `${path}.profile.profileVersion`);
  requireString(value.scenarioId, `${path}.scenarioId`);
  requireString(value.phase, `${path}.phase`);
  requireNonnegativeInteger(value.seed, `${path}.seed`);
  if (!['completed', 'failed'].includes(String(value.status))) {
    throw new Error(`${path}.status is invalid.`);
  }
  requireNonnegativeFinite(value.syntheticDurationMs, `${path}.syntheticDurationMs`);

  requireArray(value.expectedDetections, `${path}.expectedDetections`);
  if (value.expectedDetections.length > MAX_CAMPAIGN_RULES_PER_CASE) {
    throw new Error(
      `${path}.expectedDetections must not exceed ${MAX_CAMPAIGN_RULES_PER_CASE} entries.`,
    );
  }
  value.expectedDetections.forEach((entry, index) =>
    assertExpectedDetection(entry, `${path}.expectedDetections[${index}]`),
  );
  requireUnique(
    value.expectedDetections.map((entry) => (entry as CampaignExpectedDetection).ruleId),
    `${path}.expectedDetections`,
  );
  requireArray(value.negativeRuleIds, `${path}.negativeRuleIds`);
  if (value.negativeRuleIds.length > MAX_CAMPAIGN_RULES_PER_CASE) {
    throw new Error(
      `${path}.negativeRuleIds must not exceed ${MAX_CAMPAIGN_RULES_PER_CASE} entries.`,
    );
  }
  value.negativeRuleIds.forEach((entry, index) =>
    requireString(entry, `${path}.negativeRuleIds[${index}]`),
  );
  requireUnique(value.negativeRuleIds as string[], `${path}.negativeRuleIds`);

  requireArray(value.detections, `${path}.detections`);
  if (value.detections.length > MAX_CAMPAIGN_RULES_PER_CASE) {
    throw new Error(`${path}.detections must not exceed ${MAX_CAMPAIGN_RULES_PER_CASE} entries.`);
  }
  value.detections.forEach((entry, index) =>
    assertDetection(entry, `${path}.detections[${index}]`),
  );
  requireArray(value.matchedDetections, `${path}.matchedDetections`);
  if (value.matchedDetections.length > MAX_CAMPAIGN_RULES_PER_CASE) {
    throw new Error(
      `${path}.matchedDetections must not exceed ${MAX_CAMPAIGN_RULES_PER_CASE} entries.`,
    );
  }
  const matchedExpected: CampaignExpectedDetection[] = [];
  const matchedObserved: CampaignDetection[] = [];
  for (const [index, entry] of value.matchedDetections.entries()) {
    const matchPath = `${path}.matchedDetections[${index}]`;
    if (!isRecord(entry)) throw new Error(`${matchPath} must be an object.`);
    assertExpectedDetection(entry.expected, `${matchPath}.expected`);
    assertDetection(entry.detection, `${matchPath}.detection`);
    if (entry.timeToDetectionMs !== undefined) {
      requireNonnegativeFinite(entry.timeToDetectionMs, `${matchPath}.timeToDetectionMs`);
      if (
        entry.detection.detectedAtMs === undefined ||
        entry.timeToDetectionMs !== entry.detection.detectedAtMs - entry.expected.episodeStartMs
      ) {
        throw new Error(`${matchPath}.timeToDetectionMs is inconsistent.`);
      }
    }
    if (
      entry.detection.detectedAtMs !== undefined &&
      entry.detection.detectedAtMs < entry.expected.episodeStartMs
    ) {
      throw new Error(`${matchPath} occurs before the expected episode.`);
    }
    matchedExpected.push(entry.expected);
    matchedObserved.push(entry.detection);
  }
  requireArray(value.missingDetections, `${path}.missingDetections`);
  if (value.missingDetections.length > MAX_CAMPAIGN_RULES_PER_CASE) {
    throw new Error(
      `${path}.missingDetections must not exceed ${MAX_CAMPAIGN_RULES_PER_CASE} entries.`,
    );
  }
  value.missingDetections.forEach((entry, index) =>
    assertExpectedDetection(entry, `${path}.missingDetections[${index}]`),
  );
  requireArray(value.unexpectedDetections, `${path}.unexpectedDetections`);
  if (value.unexpectedDetections.length > MAX_CAMPAIGN_RULES_PER_CASE) {
    throw new Error(
      `${path}.unexpectedDetections must not exceed ${MAX_CAMPAIGN_RULES_PER_CASE} entries.`,
    );
  }
  value.unexpectedDetections.forEach((entry, index) =>
    assertDetection(entry, `${path}.unexpectedDetections[${index}]`),
  );
  requireArray(value.calibration, `${path}.calibration`);
  if (value.calibration.length > MAX_CAMPAIGN_CALIBRATION_OBSERVATIONS_PER_CASE) {
    throw new Error(
      `${path}.calibration must be an array with at most ${MAX_CAMPAIGN_CALIBRATION_OBSERVATIONS_PER_CASE} entries.`,
    );
  }
  for (const [index, entry] of value.calibration.entries()) {
    const observationPath = `${path}.calibration[${index}]`;
    if (!isRecord(entry)) throw new Error(`${observationPath} must be an object.`);
    requireFiniteNumber(entry.confidence, `${observationPath}.confidence`);
    if (entry.confidence < 0 || entry.confidence > 1) {
      throw new Error(`${observationPath}.confidence must be between zero and one.`);
    }
    requireBoolean(entry.correct, `${observationPath}.correct`);
    requireBoolean(entry.abstained, `${observationPath}.abstained`);
  }
  if (!isRecord(value.confusion)) throw new Error(`${path}.confusion must be an object.`);
  for (const key of ['truePositives', 'falsePositives', 'trueNegatives', 'falseNegatives']) {
    requireNonnegativeInteger(value.confusion[key], `${path}.confusion.${key}`);
  }

  const expectedDetections = value.expectedDetections as CampaignExpectedDetection[];
  const missingDetections = value.missingDetections as CampaignExpectedDetection[];
  const detections = value.detections as CampaignDetection[];
  const unexpectedDetections = value.unexpectedDetections as CampaignDetection[];
  if (value.status === 'failed') {
    if (!isRecord(value.error)) throw new Error(`${path}.error is required for a failed case.`);
    requireString(value.error.name, `${path}.error.name`);
    requireString(value.error.message, `${path}.error.message`);
    if (
      detections.length !== 0 ||
      matchedObserved.length !== 0 ||
      unexpectedDetections.length !== 0 ||
      value.calibration.length !== 0 ||
      !sameMultiset(missingDetections, expectedDetections) ||
      Object.values(value.confusion).some((count) => count !== 0)
    ) {
      throw new Error(`${path} failed-case evidence is inconsistent.`);
    }
    return;
  }
  if (value.error !== undefined) throw new Error(`${path}.error is only valid for a failed case.`);
  if (!sameMultiset([...matchedExpected, ...missingDetections], expectedDetections)) {
    throw new Error(`${path} expected detection partitions are inconsistent.`);
  }
  if (!sameMultiset([...matchedObserved, ...unexpectedDetections], detections)) {
    throw new Error(`${path} detection partitions are inconsistent.`);
  }
  const observedNegativeRules = new Set(
    unexpectedDetections
      .filter((detection) => (value.negativeRuleIds as string[]).includes(detection.ruleId))
      .map((detection) => detection.ruleId),
  );
  const derivedConfusion = {
    truePositives: matchedObserved.length,
    falsePositives: unexpectedDetections.length,
    trueNegatives: value.negativeRuleIds.length - observedNegativeRules.size,
    falseNegatives: missingDetections.length,
  };
  if (stableCampaignStringify(value.confusion) !== stableCampaignStringify(derivedConfusion)) {
    throw new Error(`${path}.confusion is inconsistent with detection evidence.`);
  }
}

export function assertCampaignResult(value: unknown): asserts value is CampaignResult {
  if (!isRecord(value)) throw new Error('Campaign result must be an object.');
  if (value.schemaVersion !== CAMPAIGN_SCHEMA_VERSION) {
    throw new Error(`Campaign result schemaVersion must be '${CAMPAIGN_SCHEMA_VERSION}'.`);
  }
  requireString(value.runId, 'runId');
  requireString(value.campaignId, 'campaignId');
  requireString(value.createdAt, 'createdAt');
  if (Number.isNaN(Date.parse(value.createdAt))) {
    throw new Error('createdAt must be a valid timestamp.');
  }
  if (!['completed', 'completed-with-errors', 'cancelled'].includes(String(value.status))) {
    throw new Error('Campaign result has an unsupported status.');
  }
  assertCampaignSpec(value.spec);
  const spec = value.spec as CampaignSpec;
  if (spec.campaignId !== value.campaignId) {
    throw new Error('Campaign result and spec campaign IDs do not match.');
  }
  if (spec.createdAt !== value.createdAt) {
    throw new Error('Campaign result and spec timestamps do not match.');
  }
  if (!isRecord(value.replayManifest) || !Array.isArray(value.replayManifest.cases)) {
    throw new Error('Campaign result replayManifest is invalid.');
  }
  if (value.replayManifest.schemaVersion !== CAMPAIGN_SCHEMA_VERSION) {
    throw new Error(`replayManifest.schemaVersion must be '${CAMPAIGN_SCHEMA_VERSION}'.`);
  }
  if (value.replayManifest.campaignId !== value.campaignId) {
    throw new Error('Campaign result and replay manifest campaign IDs do not match.');
  }
  requireString(value.replayManifest.specSha256, 'replayManifest.specSha256');
  if (!/^[a-f0-9]{64}$/.test(value.replayManifest.specSha256)) {
    throw new Error('replayManifest.specSha256 must be a lowercase SHA-256 digest.');
  }
  const plannedCases = spec.profiles.length * spec.scenarios.length * spec.seeds.length;
  if (value.replayManifest.cases.length !== plannedCases) {
    throw new Error(`Campaign replay manifest must contain exactly ${plannedCases} cases.`);
  }
  if (value.replayManifest.cases.length > MAX_CAMPAIGN_CASES) {
    throw new Error(`Campaign replay manifest must not exceed ${MAX_CAMPAIGN_CASES} cases.`);
  }

  const expectedReplayCases = spec.profiles.flatMap((profile) =>
    spec.scenarios.flatMap((scenario) =>
      spec.seeds.map((seed) => ({
        profile,
        scenario,
        seed,
      })),
    ),
  );
  const replayCaseIds: string[] = [];
  value.replayManifest.cases.forEach((entry, index) => {
    const path = `replayManifest.cases[${index}]`;
    if (!isRecord(entry)) throw new Error(`${path} must be an object.`);
    requireString(entry.caseId, `${path}.caseId`);
    requireNonnegativeInteger(entry.caseIndex, `${path}.caseIndex`);
    if (entry.caseIndex !== index) throw new Error(`${path}.caseIndex must equal ${index}.`);
    if (!isRecord(entry.profile)) throw new Error(`${path}.profile must be an object.`);
    requireString(entry.profile.profileId, `${path}.profile.profileId`);
    requireString(entry.profile.profileVersion, `${path}.profile.profileVersion`);
    requireString(entry.scenarioId, `${path}.scenarioId`);
    requireString(entry.phase, `${path}.phase`);
    requireNonnegativeInteger(entry.seed, `${path}.seed`);

    const expected = expectedReplayCases[index];
    if (
      expected === undefined ||
      stableCampaignStringify(entry.profile) !== stableCampaignStringify(expected.profile) ||
      entry.scenarioId !== expected.scenario.scenarioId ||
      entry.phase !== expected.scenario.phase ||
      entry.seed !== expected.seed
    ) {
      throw new Error(`${path} does not match the campaign matrix.`);
    }
    if (
      stableCampaignStringify(entry.variation ?? null) !==
      stableCampaignStringify(expected.scenario.variation ?? null)
    ) {
      throw new Error(`${path}.variation does not match the campaign spec.`);
    }
    replayCaseIds.push(entry.caseId);
  });
  requireUnique(replayCaseIds, 'replayManifest.cases case IDs');

  if (!Array.isArray(value.cases)) throw new Error('Campaign result cases must be an array.');
  if (value.cases.length > plannedCases || value.cases.length > MAX_CAMPAIGN_CASES) {
    throw new Error(`Campaign result must not exceed ${MAX_CAMPAIGN_CASES} cases.`);
  }
  const resultCaseIds: string[] = [];
  for (const [index, campaignCase] of value.cases.entries()) {
    const path = `cases[${index}]`;
    assertCampaignCase(campaignCase, path);
    if (campaignCase.caseIndex !== index) throw new Error(`${path}.caseIndex must equal ${index}.`);
    const replayCase = value.replayManifest.cases[index];
    if (
      !isRecord(replayCase) ||
      campaignCase.caseId !== replayCase.caseId ||
      stableCampaignStringify(campaignCase.profile) !==
        stableCampaignStringify(replayCase.profile) ||
      campaignCase.scenarioId !== replayCase.scenarioId ||
      campaignCase.phase !== replayCase.phase ||
      campaignCase.seed !== replayCase.seed
    ) {
      throw new Error(`${path} does not match its replay manifest entry.`);
    }
    resultCaseIds.push(campaignCase.caseId);
  }
  requireUnique(resultCaseIds, 'cases case IDs');

  if (!isRecord(value.summary)) throw new Error('Campaign result summary must be an object.');
  for (const key of [
    'plannedCases',
    'attemptedCases',
    'completedCases',
    'failedCases',
    'remainingCases',
  ]) {
    requireNonnegativeInteger(value.summary[key], `summary.${key}`);
  }
  const completedCases = value.cases.filter(
    (campaignCase) => campaignCase.status === 'completed',
  ).length;
  const failedCases = value.cases.length - completedCases;
  const expectedSummary = {
    plannedCases,
    attemptedCases: value.cases.length,
    completedCases,
    failedCases,
    remainingCases: plannedCases - value.cases.length,
  };
  if (stableCampaignStringify(value.summary) !== stableCampaignStringify(expectedSummary)) {
    throw new Error('Campaign result summary is inconsistent with its case evidence.');
  }
  const expectedStatus =
    value.cases.length < plannedCases
      ? 'cancelled'
      : failedCases > 0
        ? 'completed-with-errors'
        : 'completed';
  if (value.status !== expectedStatus) {
    throw new Error(`Campaign result status must be '${expectedStatus}'.`);
  }

  if (!isRecord(value.metrics)) throw new Error('Campaign result metrics must be an object.');
  const expectedMetrics = computeCampaignMetrics(spec, value.cases as CampaignCaseResult[]);
  if (stableCampaignStringify(value.metrics) !== stableCampaignStringify(expectedMetrics)) {
    throw new Error('Campaign result metrics are inconsistent with its case evidence.');
  }
  assertSerializable(value, 'campaignResult');
  requireSerializedSize(value, MAX_CAMPAIGN_RESULT_BYTES, 'Campaign result');
}

/** Verifies asynchronous cryptographic evidence after structural validation succeeds. */
export async function verifyCampaignResultIntegrity(result: CampaignResult): Promise<void> {
  assertCampaignResult(result);
  const specSha256 = await sha256Hex(stableCampaignStringify(result.spec));
  if (result.replayManifest.specSha256 !== specSha256) {
    throw new Error('Campaign replay manifest digest does not match the embedded spec.');
  }
  const expectedRunId = `${result.campaignId}-${specSha256.slice(0, 16)}`;
  if (result.runId !== expectedRunId) {
    throw new Error('Campaign runId does not match its campaign ID and spec digest.');
  }
}

export function serializeCampaignResult(result: CampaignResult): string {
  assertCampaignResult(result);
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (utf8ByteLength(serialized) > MAX_CAMPAIGN_RESULT_BYTES) {
    throw new Error(`Campaign result exceeds the ${MAX_CAMPAIGN_RESULT_BYTES}-byte limit.`);
  }
  return serialized;
}

export function parseCampaignResult(json: string): CampaignResult {
  if (utf8ByteLength(json) > MAX_CAMPAIGN_RESULT_BYTES) {
    throw new Error(`Campaign result exceeds the ${MAX_CAMPAIGN_RESULT_BYTES}-byte limit.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(json) as unknown;
  } catch (error) {
    throw new Error('Campaign result is not valid JSON.', { cause: error });
  }
  assertCampaignResult(value);
  return value;
}

export function validateCampaignResultRoundTrip(result: CampaignResult): CampaignResult {
  const parsed = parseCampaignResult(serializeCampaignResult(result));
  if (stableCampaignStringify(parsed) !== stableCampaignStringify(result)) {
    throw new Error('Campaign result changed during JSON round trip.');
  }
  return parsed;
}
