import { DECLARED_TEMPORAL_FAULTS, temporalFaultOnsetFraction } from '../temporal/generator';
import type { MissionPhase, TemporalFaultId } from '../temporal/types';
import {
  CAMPAIGN_SCHEMA_VERSION,
  type CampaignScenarioSpec,
  type CampaignScenarioVariation,
  type CampaignSpec,
} from './types';

export const DEFAULT_TEMPORAL_CAMPAIGN_SAMPLE_COUNT = 180;
export const DEFAULT_TEMPORAL_CAMPAIGN_CADENCE_MS = 1_000;
export const SUPPORTED_TEMPORAL_CAMPAIGN_PROFILE = {
  profileId: 'generic-fixed-wing',
  profileVersion: '1.0.0',
} as const;

export const DEFAULT_TEMPORAL_CAMPAIGN_VARIATIONS = [
  {
    variationId: 'low-short-climb',
    severityScale: 0.65,
    durationScale: 0.75,
    onsetPhase: 'climb',
  },
  {
    variationId: 'standard-cruise',
    severityScale: 1,
    durationScale: 1,
    onsetPhase: 'cruise',
  },
  {
    variationId: 'high-long-descent',
    severityScale: 1.35,
    durationScale: 1.25,
    onsetPhase: 'descent',
  },
] as const satisfies readonly Omit<CampaignScenarioVariation, 'generatorScenarioId'>[];

export const TEMPORAL_INVESTIGATION_RULE_IDS = [
  'investigation.sensor.missing',
  'investigation.fusion.innovation',
  'investigation.redundancy.altitude-disagreement',
  'investigation.redundancy.speed-disagreement',
  'investigation.redundancy.vertical-rate-disagreement',
  'investigation.vibration.rolling-noise',
  'investigation.sensor.stuck-barometric-altitude',
  'investigation.fuel.quantity-flow-relationship',
] as const;

type TemporalInvestigationRuleId = (typeof TEMPORAL_INVESTIGATION_RULE_IDS)[number];

export const TEMPORAL_EXPECTED_RULES_BY_FAULT: Readonly<
  Record<TemporalFaultId, readonly TemporalInvestigationRuleId[]>
> = {
  'gradual-drift': [
    'investigation.redundancy.altitude-disagreement',
    'investigation.fusion.innovation',
  ],
  'noise-growth': ['investigation.vibration.rolling-noise'],
  oscillation: ['investigation.redundancy.vertical-rate-disagreement'],
  lag: ['investigation.redundancy.speed-disagreement'],
  'intermittent-dropout': ['investigation.sensor.missing'],
  'stuck-value': [
    'investigation.sensor.stuck-barometric-altitude',
    'investigation.redundancy.altitude-disagreement',
    'investigation.fusion.innovation',
  ],
  'gain-error': ['investigation.redundancy.speed-disagreement'],
  'fuel-leak': ['investigation.fuel.quantity-flow-relationship'],
  'cross-sensor-decoupling': [
    'investigation.redundancy.altitude-disagreement',
    'investigation.fusion.innovation',
  ],
  'simultaneous-faults': [
    'investigation.fuel.quantity-flow-relationship',
    'investigation.redundancy.vertical-rate-disagreement',
    'investigation.redundancy.altitude-disagreement',
    'investigation.fusion.innovation',
  ],
};

function negativeRules(expectedRuleIds: readonly TemporalInvestigationRuleId[]): string[] {
  const expected = new Set(expectedRuleIds);
  return TEMPORAL_INVESTIGATION_RULE_IDS.filter((ruleId) => !expected.has(ruleId));
}

function faultScenario(
  definition: (typeof DECLARED_TEMPORAL_FAULTS)[number],
  declaredVariation: (typeof DEFAULT_TEMPORAL_CAMPAIGN_VARIATIONS)[number],
): CampaignScenarioSpec {
  const expectedRuleIds = TEMPORAL_EXPECTED_RULES_BY_FAULT[definition.id];
  const variation: CampaignScenarioVariation = {
    ...declaredVariation,
    generatorScenarioId: definition.id,
  };
  return {
    scenarioId: `${definition.id}--${variation.variationId}`,
    label: `${definition.label}, ${variation.variationId}`,
    phase: variation.onsetPhase,
    expectedDetections: expectedRuleIds.map((ruleId) => ({
      ruleId,
      episodeStartMs:
        Math.floor(
          DEFAULT_TEMPORAL_CAMPAIGN_SAMPLE_COUNT *
            temporalFaultOnsetFraction(definition, variation.onsetPhase as MissionPhase),
        ) * DEFAULT_TEMPORAL_CAMPAIGN_CADENCE_MS,
    })),
    negativeRuleIds: negativeRules(expectedRuleIds),
    syntheticDurationMs:
      (DEFAULT_TEMPORAL_CAMPAIGN_SAMPLE_COUNT - 1) * DEFAULT_TEMPORAL_CAMPAIGN_CADENCE_MS,
    variation,
  };
}

export function buildDefaultTemporalCampaignSpec(
  seeds: readonly number[],
  createdAt = new Date().toISOString(),
): CampaignSpec {
  if (seeds.length === 0) throw new Error('A temporal campaign requires at least one seed.');
  if (seeds.some((seed) => !Number.isInteger(seed) || seed < 1 || seed > 2_147_483_647)) {
    throw new Error('Temporal campaign seeds must be positive 32-bit integers.');
  }
  const uniqueSeeds = [...new Set(seeds)];
  if (uniqueSeeds.length !== seeds.length) {
    throw new Error('Temporal campaign seeds must be unique.');
  }
  const createdAtMs = Date.parse(createdAt);
  if (!Number.isFinite(createdAtMs)) throw new Error('Campaign creation time must be valid.');

  const nominal: CampaignScenarioSpec = {
    scenarioId: 'nominal',
    label: 'Nominal synthetic mission',
    phase: 'all',
    expectedDetections: [],
    negativeRuleIds: [...TEMPORAL_INVESTIGATION_RULE_IDS],
    syntheticDurationMs:
      (DEFAULT_TEMPORAL_CAMPAIGN_SAMPLE_COUNT - 1) * DEFAULT_TEMPORAL_CAMPAIGN_CADENCE_MS,
  };

  return {
    schemaVersion: CAMPAIGN_SCHEMA_VERSION,
    campaignId: `temporal-${createdAt.replaceAll(/[^0-9]/g, '').slice(0, 14)}-${uniqueSeeds.join('-')}`,
    createdAt: new Date(createdAtMs).toISOString(),
    profiles: [{ ...SUPPORTED_TEMPORAL_CAMPAIGN_PROFILE }],
    scenarios: [
      nominal,
      ...DECLARED_TEMPORAL_FAULTS.flatMap((definition) =>
        DEFAULT_TEMPORAL_CAMPAIGN_VARIATIONS.map((variation) =>
          faultScenario(definition, variation),
        ),
      ),
    ],
    seeds: uniqueSeeds,
    bootstrap: {
      iterations: 300,
      confidenceLevel: 0.95,
      seed: 22_072,
    },
    metadata: {
      synthetic: true,
      dataClassification: 'SYNTHETIC_UNCLASSIFIED',
      applicationFeature: 'temporal-fault-intelligence',
      deterministicAuthority: true,
      sampleCount: DEFAULT_TEMPORAL_CAMPAIGN_SAMPLE_COUNT,
      cadenceMs: DEFAULT_TEMPORAL_CAMPAIGN_CADENCE_MS,
      faultFamilyCount: DECLARED_TEMPORAL_FAULTS.length,
      faultVariationCount: DEFAULT_TEMPORAL_CAMPAIGN_VARIATIONS.length,
      declaredScenarioCount:
        DECLARED_TEMPORAL_FAULTS.length * DEFAULT_TEMPORAL_CAMPAIGN_VARIATIONS.length,
      severityScales: DEFAULT_TEMPORAL_CAMPAIGN_VARIATIONS.map(
        ({ severityScale }) => severityScale,
      ),
      durationScales: DEFAULT_TEMPORAL_CAMPAIGN_VARIATIONS.map(
        ({ durationScale }) => durationScale,
      ),
      onsetPhases: DEFAULT_TEMPORAL_CAMPAIGN_VARIATIONS.map(({ onsetPhase }) => onsetPhase),
      supportedGeneratorProfile: `${SUPPORTED_TEMPORAL_CAMPAIGN_PROFILE.profileId}@${SUPPORTED_TEMPORAL_CAMPAIGN_PROFILE.profileVersion}`,
      unsupportedProfilesFailClosed: true,
    },
  };
}
