import { beforeAll, describe, expect, it } from 'vitest';

import { runCampaign, type CampaignResult } from '../../src/campaign';
import {
  CAMPAIGN_DEFAULT_SEEDS_INPUT,
  CAMPAIGN_SCENARIO_COUNT,
  MAX_CAMPAIGN_CASE_COUNT,
  MAX_CAMPAIGN_SEEDS_INPUT_LENGTH,
  prepareCampaignRun,
  parseCampaignSeeds,
  settleCampaignResult,
  verifyCampaignSettledSnapshot,
  type CampaignSettledSnapshot,
  type PreparedCampaignRun,
} from '../../src/features/lab/campaign';

const createdAt = '2026-08-29T12:00:00.000Z';
const settledAt = '2026-08-29T12:05:00.000Z';
let prepared: Readonly<PreparedCampaignRun>;
let result: CampaignResult;

beforeAll(async () => {
  prepared = prepareCampaignRun({ seedsInput: '3101' }, createdAt);
  result = await runCampaign(prepared.spec, {
    buildScenario: () => ({ input: null }),
    evaluateScenario: () => ({ detections: [], calibration: [] }),
  });
});

describe('React Campaign pure contract', () => {
  it('parses one to twelve unique positive decimal integer seeds', () => {
    expect(parseCampaignSeeds(CAMPAIGN_DEFAULT_SEEDS_INPUT)).toEqual([3101, 3102, 3103]);
    expect(parseCampaignSeeds(' 1, 002,2147483647 ')).toEqual([1, 2, 2_147_483_647]);
    expect(Object.isFrozen(parseCampaignSeeds('17,23'))).toBe(true);
  });

  it.each([
    ['', /at least one decimal integer/],
    ['   ', /at least one decimal integer/],
    ['1,,2', /entry 2 cannot be empty/],
    [',1', /entry 1 cannot be empty/],
    ['1,', /entry 2 cannot be empty/],
    ['1e3', /decimal integer/],
    ['1.0', /decimal integer/],
    ['+1', /decimal integer/],
    ['-1', /decimal integer/],
    ['0', /between 1 and 2147483647/],
    ['2147483648', /between 1 and 2147483647/],
    ['1,01', /unique/],
    [Array.from({ length: 13 }, (_, index) => index + 1).join(','), /12 entries/],
    ['1'.repeat(MAX_CAMPAIGN_SEEDS_INPUT_LENGTH + 1), /256 characters/],
  ])('rejects ambiguous or out-of-bound seed input %#', (input, message) => {
    expect(() => parseCampaignSeeds(input)).toThrow(message);
  });

  it('projects exact 31, 93, and 372 case matrices through the existing default builder', () => {
    const one = prepareCampaignRun({ seedsInput: '1' }, createdAt);
    const three = prepareCampaignRun({ seedsInput: CAMPAIGN_DEFAULT_SEEDS_INPUT }, createdAt);
    const twelve = prepareCampaignRun(
      { seedsInput: Array.from({ length: 12 }, (_, index) => index + 1).join(',') },
      createdAt,
    );

    expect(one.configuration.matrix).toMatchObject({
      profileCount: 1,
      scenarioCount: 31,
      nominalScenarioCount: 1,
      faultFamilyCount: 10,
      variationsPerFault: 3,
      seedCount: 1,
      plannedCases: 31,
    });
    expect(three.configuration.matrix.plannedCases).toBe(93);
    expect(twelve.configuration.matrix.plannedCases).toBe(MAX_CAMPAIGN_CASE_COUNT);
    for (const preparedRun of [one, three, twelve]) {
      expect(preparedRun.spec.scenarios).toHaveLength(CAMPAIGN_SCENARIO_COUNT);
      expect(preparedRun.spec.profiles).toEqual([
        { profileId: 'generic-fixed-wing', profileVersion: '1.0.0' },
      ]);
      expect(preparedRun.configuration.generator).toEqual({
        sampleCount: 180,
        cadenceMs: 1_000,
        syntheticDurationMs: 179_000,
      });
      expect(preparedRun.configuration.variations).toEqual([
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
      ]);
      expect(preparedRun.configuration.bootstrap).toEqual({
        iterations: 300,
        confidenceLevel: 0.95,
        seed: 22_072,
      });
    }
  });

  it('is deterministic for fixed controls and time and returns a deeply immutable prepared run', () => {
    const first = prepareCampaignRun({ seedsInput: '17,23' }, createdAt);
    const second = prepareCampaignRun({ seedsInput: '17, 23' }, createdAt);
    expect(second).toEqual(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.configuration.seeds)).toBe(true);
    expect(Object.isFrozen(first.spec.scenarios[1]!.variation)).toBe(true);
  });

  it('settles only an integrity-verified result for the exact prepared spec', async () => {
    const snapshot = await settleCampaignResult(prepared, result, settledAt);
    await expect(verifyCampaignSettledSnapshot(snapshot)).resolves.toBeUndefined();
    expect(snapshot).toMatchObject({
      settledAt,
      configuration: { matrix: { plannedCases: 31 } },
      result: { status: 'completed', summary: { completedCases: 31 } },
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.result.metrics.scenarioCoverage)).toBe(true);
  });

  it('does not retain mutable result references after settlement', async () => {
    const mutableResult = structuredClone(result);
    const snapshot = await settleCampaignResult(prepared, mutableResult, settledAt);
    mutableResult.summary.completedCases = 0;
    mutableResult.metrics.confusion.falseNegatives = 999;
    mutableResult.spec.seeds[0] = 999;

    expect(snapshot.result.summary.completedCases).toBe(31);
    expect(snapshot.result.metrics.confusion.falseNegatives).not.toBe(999);
    expect(snapshot.configuration.seeds).toEqual([3101]);
  });

  it('rejects forged integrity and a valid result substituted from another prepared request', async () => {
    const forged = structuredClone(result);
    forged.replayManifest.specSha256 = '0'.repeat(64);
    await expect(settleCampaignResult(prepared, forged, settledAt)).rejects.toThrow(/digest/);

    const otherPrepared = prepareCampaignRun({ seedsInput: '3102' }, createdAt);
    await expect(settleCampaignResult(otherPrepared, result, settledAt)).rejects.toThrow(
      /does not match the prepared request/,
    );
  });

  it('rejects a forged settled configuration even when the embedded result remains valid', async () => {
    const snapshot = structuredClone(
      await settleCampaignResult(prepared, result, settledAt),
    ) as CampaignSettledSnapshot;
    (snapshot.configuration.matrix as { plannedCases: number }).plannedCases = 93;
    await expect(verifyCampaignSettledSnapshot(snapshot)).rejects.toThrow(
      /captured configuration does not match/,
    );
  });
});
