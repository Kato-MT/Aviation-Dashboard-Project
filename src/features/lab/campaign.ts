import {
  buildDefaultTemporalCampaignSpec,
  DEFAULT_TEMPORAL_CAMPAIGN_CADENCE_MS,
  DEFAULT_TEMPORAL_CAMPAIGN_SAMPLE_COUNT,
  DEFAULT_TEMPORAL_CAMPAIGN_VARIATIONS,
  SUPPORTED_TEMPORAL_CAMPAIGN_PROFILE,
} from '../../campaign/defaultTemporalCampaign';
import {
  assertCampaignSpec,
  stableCampaignStringify,
  verifyCampaignResultIntegrity,
} from '../../campaign/serialization';
import type { CampaignBootstrapSpec, CampaignResult, CampaignSpec } from '../../campaign/types';

export const CAMPAIGN_DEFAULT_SEEDS_INPUT = '3101, 3102, 3103' as const;
export const MIN_CAMPAIGN_SEED = 1 as const;
export const MAX_CAMPAIGN_SEED = 2_147_483_647 as const;
export const MIN_CAMPAIGN_SEED_COUNT = 1 as const;
export const MAX_CAMPAIGN_SEED_COUNT = 12 as const;
export const MAX_CAMPAIGN_SEEDS_INPUT_LENGTH = 256 as const;
export const CAMPAIGN_PROFILE_COUNT = 1 as const;
export const CAMPAIGN_SCENARIO_COUNT = 31 as const;
export const CAMPAIGN_NOMINAL_SCENARIO_COUNT = 1 as const;
export const CAMPAIGN_FAULT_FAMILY_COUNT = 10 as const;
export const CAMPAIGN_VARIATIONS_PER_FAULT = 3 as const;
export const MIN_CAMPAIGN_CASE_COUNT = 31 as const;
export const MAX_CAMPAIGN_CASE_COUNT = 372 as const;
export const CAMPAIGN_SYNTHETIC_DURATION_MS = 179_000 as const;

export interface CampaignControlInput {
  readonly seedsInput: string;
}

export interface CampaignMatrixProjection {
  readonly profileCount: typeof CAMPAIGN_PROFILE_COUNT;
  readonly scenarioCount: typeof CAMPAIGN_SCENARIO_COUNT;
  readonly nominalScenarioCount: typeof CAMPAIGN_NOMINAL_SCENARIO_COUNT;
  readonly faultFamilyCount: typeof CAMPAIGN_FAULT_FAMILY_COUNT;
  readonly variationsPerFault: typeof CAMPAIGN_VARIATIONS_PER_FAULT;
  readonly seedCount: number;
  readonly plannedCases: number;
}

export interface CampaignGeneratorConfiguration {
  readonly sampleCount: typeof DEFAULT_TEMPORAL_CAMPAIGN_SAMPLE_COUNT;
  readonly cadenceMs: typeof DEFAULT_TEMPORAL_CAMPAIGN_CADENCE_MS;
  readonly syntheticDurationMs: typeof CAMPAIGN_SYNTHETIC_DURATION_MS;
}

export interface CampaignVariationConfiguration {
  readonly variationId: string;
  readonly severityScale: number;
  readonly durationScale: number;
  readonly onsetPhase: string;
}

export interface CampaignRunConfiguration {
  readonly seeds: readonly number[];
  readonly profile: {
    readonly profileId: typeof SUPPORTED_TEMPORAL_CAMPAIGN_PROFILE.profileId;
    readonly profileVersion: typeof SUPPORTED_TEMPORAL_CAMPAIGN_PROFILE.profileVersion;
  };
  readonly matrix: CampaignMatrixProjection;
  readonly generator: CampaignGeneratorConfiguration;
  readonly variations: readonly CampaignVariationConfiguration[];
  readonly bootstrap: CampaignBootstrapSpec;
}

export interface PreparedCampaignRun {
  readonly configuration: CampaignRunConfiguration;
  readonly spec: CampaignSpec;
}

export interface CampaignSettledSnapshot {
  readonly configuration: CampaignRunConfiguration;
  readonly result: CampaignResult;
  readonly settledAt: string;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function immutableCopy<T>(value: T): Readonly<T> {
  return deepFreeze(structuredClone(value));
}

function validTimestamp(value: string, label: string): string {
  const timestampMs = Date.parse(value);
  if (value.trim() === '' || !Number.isFinite(timestampMs)) {
    throw new Error(`${label} must be a valid timestamp.`);
  }
  return new Date(timestampMs).toISOString();
}

function requireCampaignInvariant(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new Error(`Campaign invariant failed: ${detail}.`);
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function parseCampaignSeeds(input: string): readonly number[] {
  if (typeof input !== 'string') throw new Error('Campaign seeds must be text.');
  if (input.length > MAX_CAMPAIGN_SEEDS_INPUT_LENGTH) {
    throw new Error(
      `Campaign seeds input must not exceed ${MAX_CAMPAIGN_SEEDS_INPUT_LENGTH} characters.`,
    );
  }
  if (input.trim() === '') throw new Error('Campaign seeds require at least one decimal integer.');
  const entries = input.split(',');
  if (entries.length > MAX_CAMPAIGN_SEED_COUNT) {
    throw new Error(`Campaign seeds must not exceed ${MAX_CAMPAIGN_SEED_COUNT} entries.`);
  }
  const seeds = entries.map((entry, index) => {
    const normalized = entry.trim();
    if (normalized === '') {
      throw new Error(`Campaign seed entry ${index + 1} cannot be empty.`);
    }
    if (!/^\d+$/.test(normalized)) {
      throw new Error(`Campaign seed entry ${index + 1} must be a decimal integer.`);
    }
    const seed = Number(normalized);
    if (!Number.isSafeInteger(seed) || seed < MIN_CAMPAIGN_SEED || seed > MAX_CAMPAIGN_SEED) {
      throw new Error(
        `Campaign seed entry ${index + 1} must be between ${MIN_CAMPAIGN_SEED} and ${MAX_CAMPAIGN_SEED}.`,
      );
    }
    return seed;
  });
  if (new Set(seeds).size !== seeds.length) {
    throw new Error('Campaign seeds must be unique.');
  }
  return deepFreeze(seeds);
}

function configurationForSeeds(seeds: readonly number[]): CampaignRunConfiguration {
  const seedCount = seeds.length;
  return {
    seeds: [...seeds],
    profile: { ...SUPPORTED_TEMPORAL_CAMPAIGN_PROFILE },
    matrix: {
      profileCount: CAMPAIGN_PROFILE_COUNT,
      scenarioCount: CAMPAIGN_SCENARIO_COUNT,
      nominalScenarioCount: CAMPAIGN_NOMINAL_SCENARIO_COUNT,
      faultFamilyCount: CAMPAIGN_FAULT_FAMILY_COUNT,
      variationsPerFault: CAMPAIGN_VARIATIONS_PER_FAULT,
      seedCount,
      plannedCases: CAMPAIGN_SCENARIO_COUNT * seedCount,
    },
    generator: {
      sampleCount: DEFAULT_TEMPORAL_CAMPAIGN_SAMPLE_COUNT,
      cadenceMs: DEFAULT_TEMPORAL_CAMPAIGN_CADENCE_MS,
      syntheticDurationMs: CAMPAIGN_SYNTHETIC_DURATION_MS,
    },
    variations: DEFAULT_TEMPORAL_CAMPAIGN_VARIATIONS.map((variation) => ({ ...variation })),
    bootstrap: { iterations: 300, confidenceLevel: 0.95, seed: 22_072 },
  };
}

function validateDefaultCampaignSpec(spec: Readonly<CampaignSpec>, seeds: readonly number[]): void {
  assertCampaignSpec(spec);
  requireCampaignInvariant(
    spec.profiles.length === CAMPAIGN_PROFILE_COUNT &&
      spec.profiles[0]?.profileId === SUPPORTED_TEMPORAL_CAMPAIGN_PROFILE.profileId &&
      spec.profiles[0]?.profileVersion === SUPPORTED_TEMPORAL_CAMPAIGN_PROFILE.profileVersion,
    'default profile identity is inconsistent',
  );
  requireCampaignInvariant(
    sameNumbers(spec.seeds, seeds),
    'default spec seeds do not match the prepared configuration',
  );
  requireCampaignInvariant(
    spec.scenarios.length === CAMPAIGN_SCENARIO_COUNT &&
      spec.scenarios[0]?.scenarioId === 'nominal' &&
      spec.scenarios.filter(({ scenarioId }) => scenarioId === 'nominal').length === 1,
    'default scenario matrix is not nominal plus thirty fault variations',
  );
  requireCampaignInvariant(
    spec.scenarios.every(
      ({ syntheticDurationMs }) => syntheticDurationMs === CAMPAIGN_SYNTHETIC_DURATION_MS,
    ),
    'default synthetic duration is inconsistent',
  );
  const faultScenarios = spec.scenarios.slice(1);
  const faultFamilies = new Set(
    faultScenarios.map(({ variation }) => variation?.generatorScenarioId),
  );
  requireCampaignInvariant(
    faultScenarios.every(({ variation }) => variation !== undefined) &&
      faultFamilies.size === CAMPAIGN_FAULT_FAMILY_COUNT &&
      !faultFamilies.has(undefined),
    'default fault-family coverage is inconsistent',
  );
  for (const expectedVariation of DEFAULT_TEMPORAL_CAMPAIGN_VARIATIONS) {
    const matching = faultScenarios.filter(
      ({ variation }) => variation?.variationId === expectedVariation.variationId,
    );
    requireCampaignInvariant(
      matching.length === CAMPAIGN_FAULT_FAMILY_COUNT &&
        matching.every(
          ({ variation }) =>
            variation?.severityScale === expectedVariation.severityScale &&
            variation.durationScale === expectedVariation.durationScale &&
            variation.onsetPhase === expectedVariation.onsetPhase,
        ),
      `default variation ${expectedVariation.variationId} is inconsistent`,
    );
  }
  requireCampaignInvariant(
    spec.bootstrap.iterations === 300 &&
      spec.bootstrap.confidenceLevel === 0.95 &&
      spec.bootstrap.seed === 22_072,
    'default bootstrap configuration is inconsistent',
  );
  requireCampaignInvariant(
    spec.metadata.synthetic === true &&
      spec.metadata.dataClassification === 'SYNTHETIC_UNCLASSIFIED' &&
      spec.metadata.sampleCount === DEFAULT_TEMPORAL_CAMPAIGN_SAMPLE_COUNT &&
      spec.metadata.cadenceMs === DEFAULT_TEMPORAL_CAMPAIGN_CADENCE_MS &&
      spec.metadata.faultFamilyCount === CAMPAIGN_FAULT_FAMILY_COUNT &&
      spec.metadata.faultVariationCount === CAMPAIGN_VARIATIONS_PER_FAULT &&
      spec.metadata.declaredScenarioCount === CAMPAIGN_SCENARIO_COUNT - 1 &&
      spec.metadata.deterministicAuthority === true,
    'default synthetic metadata is inconsistent',
  );
  const expectedSpec = buildDefaultTemporalCampaignSpec(seeds, spec.createdAt);
  requireCampaignInvariant(
    stableCampaignStringify(spec) === stableCampaignStringify(expectedSpec),
    'campaign spec does not exactly match the bundled default builder',
  );
}

function validateConfiguration(
  configuration: Readonly<CampaignRunConfiguration>,
  spec: Readonly<CampaignSpec>,
): void {
  const expected = configurationForSeeds(spec.seeds);
  requireCampaignInvariant(
    stableCampaignStringify(configuration) === stableCampaignStringify(expected),
    'captured configuration does not match the default spec',
  );
  requireCampaignInvariant(
    configuration.matrix.plannedCases >= MIN_CAMPAIGN_CASE_COUNT &&
      configuration.matrix.plannedCases <= MAX_CAMPAIGN_CASE_COUNT,
    'planned case count is outside the React Campaign boundary',
  );
}

export function prepareCampaignRun(
  input: Readonly<CampaignControlInput>,
  createdAt = new Date().toISOString(),
): Readonly<PreparedCampaignRun> {
  const seeds = parseCampaignSeeds(input.seedsInput);
  const normalizedCreatedAt = validTimestamp(createdAt, 'Campaign creation time');
  const spec = buildDefaultTemporalCampaignSpec(seeds, normalizedCreatedAt);
  validateDefaultCampaignSpec(spec, seeds);
  const prepared: PreparedCampaignRun = {
    configuration: configurationForSeeds(seeds),
    spec,
  };
  validateConfiguration(prepared.configuration, prepared.spec);
  return immutableCopy(prepared);
}

export async function verifyCampaignSettledSnapshot(
  snapshot: Readonly<CampaignSettledSnapshot>,
): Promise<void> {
  await verifyCampaignResultIntegrity(snapshot.result);
  validateDefaultCampaignSpec(snapshot.result.spec, snapshot.configuration.seeds);
  validateConfiguration(snapshot.configuration, snapshot.result.spec);
  requireCampaignInvariant(
    snapshot.result.summary.plannedCases === snapshot.configuration.matrix.plannedCases,
    'terminal summary does not match the captured matrix',
  );
  requireCampaignInvariant(
    snapshot.result.cases.every(
      ({ syntheticDurationMs }) =>
        syntheticDurationMs === snapshot.configuration.generator.syntheticDurationMs,
    ),
    'case duration evidence does not match the captured generator',
  );
  validTimestamp(snapshot.settledAt, 'Campaign settlement time');
}

export async function settleCampaignResult(
  prepared: Readonly<PreparedCampaignRun>,
  result: Readonly<CampaignResult>,
  settledAt = new Date().toISOString(),
): Promise<Readonly<CampaignSettledSnapshot>> {
  const capturedPrepared = structuredClone(prepared) as PreparedCampaignRun;
  const capturedResult = structuredClone(result) as CampaignResult;
  validateDefaultCampaignSpec(capturedPrepared.spec, capturedPrepared.configuration.seeds);
  validateConfiguration(capturedPrepared.configuration, capturedPrepared.spec);
  await verifyCampaignResultIntegrity(capturedResult);
  requireCampaignInvariant(
    stableCampaignStringify(capturedResult.spec) === stableCampaignStringify(capturedPrepared.spec),
    'terminal result spec does not match the prepared request',
  );
  const snapshot: CampaignSettledSnapshot = {
    configuration: capturedPrepared.configuration,
    result: capturedResult,
    settledAt: validTimestamp(settledAt, 'Campaign settlement time'),
  };
  await verifyCampaignSettledSnapshot(snapshot);
  return immutableCopy(snapshot);
}
