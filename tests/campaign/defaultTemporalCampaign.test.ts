import { describe, expect, it } from 'vitest';

import {
  buildDefaultTemporalCampaignSpec,
  DEFAULT_TEMPORAL_CAMPAIGN_VARIATIONS,
  DEFAULT_TEMPORAL_CAMPAIGN_CADENCE_MS,
  DEFAULT_TEMPORAL_CAMPAIGN_SAMPLE_COUNT,
  TEMPORAL_EXPECTED_RULES_BY_FAULT,
  TEMPORAL_INVESTIGATION_RULE_IDS,
} from '../../src/campaign/defaultTemporalCampaign';
import { DECLARED_TEMPORAL_FAULTS } from '../../src/temporal/generator';

describe('default temporal campaign specification', () => {
  it('declares nominal plus three real variations of all ten synthetic fault families', () => {
    const spec = buildDefaultTemporalCampaignSpec([3101, 3102, 3103], '2026-07-17T12:00:00.000Z');
    expect(spec.schemaVersion).toBe('campaign.v1');
    expect(spec.scenarios).toHaveLength(
      DECLARED_TEMPORAL_FAULTS.length * DEFAULT_TEMPORAL_CAMPAIGN_VARIATIONS.length + 1,
    );
    expect(spec.scenarios[0]?.scenarioId).toBe('nominal');
    expect(
      new Set(spec.scenarios.slice(1).map(({ variation }) => variation?.generatorScenarioId)),
    ).toEqual(new Set(DECLARED_TEMPORAL_FAULTS.map(({ id }) => id)));
    expect(spec.seeds).toEqual([3101, 3102, 3103]);
    expect(spec.metadata).toMatchObject({
      synthetic: true,
      dataClassification: 'SYNTHETIC_UNCLASSIFIED',
      deterministicAuthority: true,
      sampleCount: DEFAULT_TEMPORAL_CAMPAIGN_SAMPLE_COUNT,
      cadenceMs: DEFAULT_TEMPORAL_CAMPAIGN_CADENCE_MS,
      faultFamilyCount: 10,
      faultVariationCount: 3,
      declaredScenarioCount: 30,
      unsupportedProfilesFailClosed: true,
    });
  });

  it('keeps expected and negative rule opportunities explicit and disjoint', () => {
    const spec = buildDefaultTemporalCampaignSpec([7], '2026-07-17T12:00:00.000Z');
    const nominal = spec.scenarios[0]!;
    expect(nominal.expectedDetections).toEqual([]);
    expect(nominal.negativeRuleIds).toEqual(TEMPORAL_INVESTIGATION_RULE_IDS);
    for (const scenario of spec.scenarios.slice(1)) {
      expect(scenario.variation).toBeDefined();
      const faultId = scenario.variation!
        .generatorScenarioId as keyof typeof TEMPORAL_EXPECTED_RULES_BY_FAULT;
      const expectedRuleIds = TEMPORAL_EXPECTED_RULES_BY_FAULT[faultId];
      expect(scenario.expectedDetections.map(({ ruleId }) => ruleId)).toEqual(expectedRuleIds);
      expect(scenario.expectedDetections.every(({ episodeStartMs }) => episodeStartMs >= 0)).toBe(
        true,
      );
      expect(scenario.negativeRuleIds).toHaveLength(
        TEMPORAL_INVESTIGATION_RULE_IDS.length - expectedRuleIds.length,
      );
      expect(
        scenario.negativeRuleIds.every((ruleId) =>
          expectedRuleIds.every((expectedRuleId) => expectedRuleId !== ruleId),
        ),
      ).toBe(true);
      expect(scenario.syntheticDurationMs).toBe(179_000);
    }
    expect(
      new Set(spec.scenarios.slice(1).map(({ variation }) => variation?.severityScale)),
    ).toEqual(
      new Set(DEFAULT_TEMPORAL_CAMPAIGN_VARIATIONS.map(({ severityScale }) => severityScale)),
    );
    expect(
      new Set(spec.scenarios.slice(1).map(({ variation }) => variation?.durationScale)),
    ).toEqual(
      new Set(DEFAULT_TEMPORAL_CAMPAIGN_VARIATIONS.map(({ durationScale }) => durationScale)),
    );
    expect(new Set(spec.scenarios.slice(1).map(({ variation }) => variation?.onsetPhase))).toEqual(
      new Set(DEFAULT_TEMPORAL_CAMPAIGN_VARIATIONS.map(({ onsetPhase }) => onsetPhase)),
    );
  });

  it('is deterministic for a fixed creation time and rejects ambiguous seeds', () => {
    const first = buildDefaultTemporalCampaignSpec([17, 23], '2026-07-17T12:00:00.000Z');
    const second = buildDefaultTemporalCampaignSpec([17, 23], '2026-07-17T12:00:00.000Z');
    expect(second).toEqual(first);
    expect(() => buildDefaultTemporalCampaignSpec([], '2026-07-17T12:00:00.000Z')).toThrow(
      /at least one seed/i,
    );
    expect(() => buildDefaultTemporalCampaignSpec([3, 3], '2026-07-17T12:00:00.000Z')).toThrow(
      /unique/i,
    );
    expect(() => buildDefaultTemporalCampaignSpec([0], '2026-07-17T12:00:00.000Z')).toThrow(
      /positive 32-bit/i,
    );
  });
});
