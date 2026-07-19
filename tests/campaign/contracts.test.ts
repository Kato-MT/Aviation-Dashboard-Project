import { describe, expect, it } from 'vitest';

import {
  CAMPAIGN_SCHEMA_VERSION,
  CAMPAIGN_WORKER_PROTOCOL_VERSION,
  MAX_CAMPAIGN_CASES,
  MAX_CAMPAIGN_CALIBRATION_OBSERVATIONS_PER_CASE,
  MAX_CAMPAIGN_RESULT_BYTES,
  MAX_CAMPAIGN_RULES_PER_CASE,
  MAX_CAMPAIGN_SEEDS,
  MAX_CAMPAIGN_SPEC_BYTES,
  assertCampaignSpec,
  assertCampaignResult,
  isCampaignWorkerRequest,
  isCampaignWorkerResponse,
  parseCampaignResult,
  runCampaign,
  serializeCampaignResult,
  stableCampaignStringify,
  validateCampaignResultRoundTrip,
  verifyCampaignResultIntegrity,
  type CampaignSpec,
} from '../../src/campaign';

function nominalSpec(): CampaignSpec {
  return {
    schemaVersion: CAMPAIGN_SCHEMA_VERSION,
    campaignId: 'nominal-edge-campaign',
    createdAt: '2026-07-17T12:00:00.000Z',
    profiles: [{ profileId: 'profile', profileVersion: '1.0.0' }],
    scenarios: [
      {
        scenarioId: 'nominal',
        label: 'Nominal synthetic case',
        phase: 'nominal',
        expectedDetections: [],
        negativeRuleIds: [],
        syntheticDurationMs: 0,
      },
    ],
    seeds: [1],
    bootstrap: { iterations: 16, confidenceLevel: 0.9, seed: 5 },
    metadata: {
      synthetic: true,
      dataClassification: 'SYNTHETIC_UNCLASSIFIED',
    },
  };
}

describe('campaign contracts and metric edge cases', () => {
  it('uses null rather than a fabricated metric when no episodes or duration exist', async () => {
    const result = await runCampaign(nominalSpec(), {
      buildScenario: () => ({ input: null }),
      evaluateScenario: () => ({ detections: [], calibration: [] }),
    });

    expect(result.metrics.episodes).toEqual({ precision: null, recall: null, f1: null });
    expect(result.metrics.falseAlarmsPerRun).toBe(0);
    expect(result.metrics.falseAlarmsPerSyntheticHour).toBeNull();
    expect(result.metrics.timeToDetection).toEqual({
      count: 0,
      minimum: null,
      maximum: null,
      mean: null,
      median: null,
      p95: null,
    });
    expect(result.metrics.calibration).toMatchObject({
      observations: 0,
      abstentionRate: null,
      brierScore: null,
      expectedCalibrationError: null,
    });
    expect(result.metrics.bootstrap.precision).toMatchObject({
      estimate: null,
      lower: null,
      upper: null,
      iterations: 16,
    });
  });

  it('round trips a result without changing its replay or metrics evidence', async () => {
    const result = await runCampaign(nominalSpec(), {
      buildScenario: () => ({ input: { value: 1 } }),
      evaluateScenario: () => ({
        detections: [{ ruleId: 'unexpected.rule', detectedAtMs: 10, details: { source: 'test' } }],
        calibration: [{ confidence: 0.2, correct: false, abstained: false }],
        syntheticDurationMs: 1_000,
      }),
    });
    const json = serializeCampaignResult(result);
    const parsed = parseCampaignResult(json);
    expect(parsed).toEqual(result);
    expect(validateCampaignResultRoundTrip(result)).toEqual(result);
    await expect(verifyCampaignResultIntegrity(parsed)).resolves.toBeUndefined();
  });

  it('rejects forged replay, summary, metrics, and digest evidence', async () => {
    const result = await runCampaign(nominalSpec(), {
      buildScenario: () => ({ input: null }),
      evaluateScenario: () => ({ detections: [], calibration: [] }),
    });

    const forgedReplay = structuredClone(result);
    forgedReplay.replayManifest.cases[0]!.scenarioId = 'forged';
    expect(() => assertCampaignResult(forgedReplay)).toThrow(/campaign matrix/);

    const forgedSummary = structuredClone(result);
    forgedSummary.summary.completedCases = 0;
    expect(() => assertCampaignResult(forgedSummary)).toThrow(/summary is inconsistent/);

    const forgedMetrics = structuredClone(result);
    forgedMetrics.metrics.confusion.truePositives = 1;
    expect(() => assertCampaignResult(forgedMetrics)).toThrow(/metrics are inconsistent/);

    const forgedPartitions = structuredClone(result);
    forgedPartitions.cases[0]!.unexpectedDetections = [{ ruleId: 'forged.rule' }];
    expect(() => assertCampaignResult(forgedPartitions)).toThrow(/partitions are inconsistent/);

    const forgedDigest = structuredClone(result);
    forgedDigest.replayManifest.specSha256 = '0'.repeat(64);
    await expect(verifyCampaignResultIntegrity(forgedDigest)).rejects.toThrow(/digest/);

    const forgedRunId = structuredClone(result);
    forgedRunId.runId = 'forged-run';
    await expect(verifyCampaignResultIntegrity(forgedRunId)).rejects.toThrow(/runId/);
  });

  it('rejects malformed JSON and unsupported result versions', () => {
    expect(() => parseCampaignResult('{')).toThrow('not valid JSON');
    expect(() =>
      parseCampaignResult(
        JSON.stringify({
          schemaVersion: 'campaign.v99',
          runId: 'x',
          campaignId: 'x',
        }),
      ),
    ).toThrow('schemaVersion');
  });

  it('validates matrix uniqueness and explicit synthetic metadata', () => {
    const duplicateSeeds = nominalSpec();
    duplicateSeeds.seeds = [1, 1];
    expect(() => assertCampaignSpec(duplicateSeeds)).toThrow('seeds must not contain duplicates');

    const conflictingRule = nominalSpec();
    conflictingRule.scenarios[0]!.expectedDetections = [{ ruleId: 'same.rule', episodeStartMs: 0 }];
    conflictingRule.scenarios[0]!.negativeRuleIds = ['same.rule'];
    expect(() => assertCampaignSpec(conflictingRule)).toThrow('positive and negative');

    const invalidClassification = nominalSpec();
    (invalidClassification.metadata as { dataClassification: string }).dataClassification =
      'UNKNOWN';
    expect(() => assertCampaignSpec(invalidClassification)).toThrow('SYNTHETIC_UNCLASSIFIED');
  });

  it('bounds low-level campaign matrices and serialized payloads', async () => {
    const excessiveSeeds = nominalSpec();
    excessiveSeeds.seeds = Array.from({ length: MAX_CAMPAIGN_SEEDS + 1 }, (_, index) => index);
    expect(() => assertCampaignSpec(excessiveSeeds)).toThrow(`seeds must not exceed`);

    const excessiveMatrix = nominalSpec();
    excessiveMatrix.profiles = Array.from({ length: 4 }, (_, index) => ({
      profileId: `profile-${index}`,
      profileVersion: '1.0.0',
    }));
    excessiveMatrix.scenarios = Array.from({ length: 32 }, (_, index) => ({
      ...excessiveMatrix.scenarios[0]!,
      scenarioId: `scenario-${index}`,
    }));
    excessiveMatrix.seeds = [1, 2, 3];
    expect(() => assertCampaignSpec(excessiveMatrix)).toThrow(
      `Campaign matrix must not exceed ${MAX_CAMPAIGN_CASES} cases`,
    );

    const excessiveSpec = nominalSpec();
    excessiveSpec.metadata.note = 'x'.repeat(MAX_CAMPAIGN_SPEC_BYTES);
    expect(() => assertCampaignSpec(excessiveSpec)).toThrow('Campaign spec exceeds');

    expect(() => parseCampaignResult('x'.repeat(MAX_CAMPAIGN_RESULT_BYTES + 1))).toThrow(
      'Campaign result exceeds',
    );

    const result = await runCampaign(nominalSpec(), {
      buildScenario: () => ({ input: null }),
      evaluateScenario: () => ({ detections: [], calibration: [] }),
    });
    const excessiveDetections = structuredClone(result);
    excessiveDetections.cases[0]!.detections = Array.from(
      { length: MAX_CAMPAIGN_RULES_PER_CASE + 1 },
      (_, index) => ({ ruleId: `rule-${index}` }),
    );
    expect(() => assertCampaignResult(excessiveDetections)).toThrow(
      `detections must not exceed ${MAX_CAMPAIGN_RULES_PER_CASE}`,
    );

    const excessiveCalibration = structuredClone(result);
    excessiveCalibration.cases[0]!.calibration = Array.from(
      { length: MAX_CAMPAIGN_CALIBRATION_OBSERVATIONS_PER_CASE + 1 },
      () => ({ confidence: 0.5, correct: true, abstained: false }),
    );
    expect(() => assertCampaignResult(excessiveCalibration)).toThrow(
      `calibration must be an array with at most ${MAX_CAMPAIGN_CALIBRATION_OBSERVATIONS_PER_CASE}`,
    );

    const prettyBoundary = await runCampaign(nominalSpec(), {
      buildScenario: () => ({ input: null }),
      evaluateScenario: () => ({
        detections: [{ ruleId: 'unexpected.rule', details: { note: '' } }],
        calibration: [],
      }),
    });
    const compactBaseBytes = new TextEncoder().encode(
      stableCampaignStringify(prettyBoundary),
    ).byteLength;
    const padding = 'x'.repeat(Math.floor((MAX_CAMPAIGN_RESULT_BYTES - compactBaseBytes) / 2));
    prettyBoundary.cases[0]!.detections[0]!.details = { note: padding };
    prettyBoundary.cases[0]!.unexpectedDetections[0]!.details = { note: padding };
    expect(
      new TextEncoder().encode(stableCampaignStringify(prettyBoundary)).byteLength,
    ).toBeLessThanOrEqual(MAX_CAMPAIGN_RESULT_BYTES);
    expect(() => serializeCampaignResult(prettyBoundary)).toThrow('Campaign result exceeds');
  });

  it('rejects every malformed campaign-spec boundary with an explicit path', () => {
    const valid = nominalSpec();
    const scenario = valid.scenarios[0]!;
    const profile = valid.profiles[0]!;
    const invalidScenarios = (patch: Record<string, unknown>): unknown => ({
      ...valid,
      scenarios: [{ ...scenario, ...patch }],
    });
    const invalidExpected = (entries: unknown[]): unknown =>
      invalidScenarios({ expectedDetections: entries });
    const invalidCases: readonly [unknown, RegExp][] = [
      [null, /must be an object/],
      [{ ...valid, schemaVersion: 'campaign.v99' }, /schemaVersion/],
      [{ ...valid, campaignId: ' ' }, /campaignId/],
      [{ ...valid, createdAt: 'not-a-time' }, /valid timestamp/],
      [{ ...valid, profiles: [] }, /at least one profile/],
      [{ ...valid, profiles: [null] }, /profiles\[0\].*object/],
      [{ ...valid, profiles: [{ ...profile, profileId: '' }] }, /profileId/],
      [{ ...valid, profiles: [{ ...profile, profileVersion: '' }] }, /profileVersion/],
      [{ ...valid, profiles: [profile, profile] }, /profiles.*duplicates/],
      [{ ...valid, scenarios: [] }, /at least one scenario/],
      [{ ...valid, scenarios: [null] }, /scenarios\[0\].*object/],
      [invalidScenarios({ scenarioId: '' }), /scenarioId/],
      [invalidScenarios({ label: '' }), /label/],
      [invalidScenarios({ phase: '' }), /phase/],
      [invalidScenarios({ syntheticDurationMs: Number.NaN }), /finite number/],
      [invalidScenarios({ syntheticDurationMs: -1 }), /nonnegative/],
      [invalidScenarios({ expectedDetections: null }), /expectedDetections.*array/],
      [invalidExpected([null]), /expectedDetections\[0\].*object/],
      [invalidExpected([{ ruleId: '', episodeStartMs: 0 }]), /ruleId/],
      [invalidExpected([{ ruleId: 'rule', episodeStartMs: Number.NaN }]), /finite number/],
      [invalidExpected([{ ruleId: 'rule', episodeStartMs: -1 }]), /nonnegative/],
      [
        invalidExpected([
          { ruleId: 'rule', episodeStartMs: 0 },
          { ruleId: 'rule', episodeStartMs: 1 },
        ]),
        /expectedDetections.*duplicates/,
      ],
      [invalidScenarios({ negativeRuleIds: null }), /negativeRuleIds.*array/],
      [invalidScenarios({ negativeRuleIds: [''] }), /negativeRuleIds\[0\]/],
      [invalidScenarios({ negativeRuleIds: ['rule', 'rule'] }), /negativeRuleIds.*duplicates/],
      [invalidScenarios({ variation: null }), /variation must be an object/],
      [
        invalidScenarios({
          variation: {
            variationId: '',
            generatorScenarioId: 'fault',
            severityScale: 1,
            durationScale: 1,
            onsetPhase: 'climb',
          },
        }),
        /variationId/,
      ],
      [
        invalidScenarios({
          variation: {
            variationId: 'variant',
            generatorScenarioId: 'fault',
            severityScale: Number.NaN,
            durationScale: 1,
            onsetPhase: 'climb',
          },
        }),
        /severityScale.*finite number/,
      ],
      [
        invalidScenarios({
          variation: {
            variationId: 'variant',
            generatorScenarioId: 'fault',
            severityScale: 0,
            durationScale: 1,
            onsetPhase: 'climb',
          },
        }),
        /scales must be greater than zero/,
      ],
      [{ ...valid, scenarios: [scenario, scenario] }, /scenarios.*duplicates/],
      [{ ...valid, seeds: [] }, /at least one seed/],
      [{ ...valid, seeds: [1.5] }, /nonnegative integer/],
      [{ ...valid, seeds: [-1] }, /nonnegative integer/],
      [{ ...valid, seeds: [0x1_0000_0000] }, /fit in 32 bits/],
      [{ ...valid, bootstrap: null }, /bootstrap.*object/],
      [{ ...valid, bootstrap: { ...valid.bootstrap, iterations: 0 } }, /between 1 and 10000/],
      [{ ...valid, bootstrap: { ...valid.bootstrap, iterations: 10_001 } }, /between 1 and 10000/],
      [
        { ...valid, bootstrap: { ...valid.bootstrap, confidenceLevel: Number.NaN } },
        /finite number/,
      ],
      [{ ...valid, bootstrap: { ...valid.bootstrap, confidenceLevel: 0 } }, /between zero and one/],
      [{ ...valid, bootstrap: { ...valid.bootstrap, confidenceLevel: 1 } }, /between zero and one/],
      [{ ...valid, bootstrap: { ...valid.bootstrap, seed: -1 } }, /nonnegative integer/],
      [{ ...valid, metadata: null }, /metadata.*object/],
      [{ ...valid, metadata: { ...valid.metadata, synthetic: false } }, /synthetic must be true/],
    ];
    for (const [value, message] of invalidCases) {
      expect(() => assertCampaignSpec(value)).toThrow(message);
    }
  });

  it('rejects non-JSON evidence and malformed result boundaries', async () => {
    expect(() => stableCampaignStringify({ value: Number.POSITIVE_INFINITY })).toThrow(/nonfinite/);
    expect(() => stableCampaignStringify({ value: undefined })).toThrow(/undefined/);
    expect(() => stableCampaignStringify(Symbol('not-json'))).toThrow(/non-JSON/);

    const result = await runCampaign(nominalSpec(), {
      buildScenario: () => ({ input: null }),
      evaluateScenario: () => ({ detections: [], calibration: [] }),
    });
    const baseCase = result.cases[0]!;
    const invalidCase = (patch: Record<string, unknown>): unknown => ({
      ...result,
      cases: [{ ...baseCase, ...patch }],
    });
    const invalidResults: readonly [unknown, RegExp][] = [
      [null, /must be an object/],
      [{ ...result, schemaVersion: 'campaign.v99' }, /schemaVersion/],
      [{ ...result, runId: '' }, /runId/],
      [{ ...result, campaignId: '' }, /campaignId/],
      [{ ...result, createdAt: '' }, /createdAt/],
      [
        { ...result, createdAt: 'not-a-time', spec: { ...result.spec, createdAt: 'not-a-time' } },
        /valid timestamp/,
      ],
      [{ ...result, status: 'running' }, /unsupported status/],
      [{ ...result, campaignId: 'different' }, /campaign IDs do not match/],
      [{ ...result, createdAt: '2026-07-18T00:00:00.000Z' }, /timestamps do not match/],
      [{ ...result, replayManifest: null }, /replayManifest/],
      [
        {
          ...result,
          replayManifest: { ...result.replayManifest, schemaVersion: 'campaign.v99' },
        },
        /replayManifest.schemaVersion/,
      ],
      [
        {
          ...result,
          replayManifest: { ...result.replayManifest, campaignId: 'different' },
        },
        /replay manifest campaign IDs/,
      ],
      [{ ...result, replayManifest: { ...result.replayManifest, specSha256: '' } }, /specSha256/],
      [
        {
          ...result,
          replayManifest: { ...result.replayManifest, specSha256: 'A'.repeat(64) },
        },
        /lowercase SHA-256/,
      ],
      [{ ...result, cases: null }, /cases must be an array/],
      [{ ...result, cases: [null] }, /cases\[0\].*object/],
      [{ ...result, cases: [{ ...result.cases[0], caseId: '' }] }, /caseId/],
      [{ ...result, cases: [{ ...result.cases[0], status: 'pending' }] }, /status is invalid/],
      [invalidCase({ profile: null }), /profile must be an object/],
      [invalidCase({ syntheticDurationMs: -1 }), /syntheticDurationMs must be nonnegative/],
      [
        invalidCase({
          expectedDetections: Array.from(
            { length: MAX_CAMPAIGN_RULES_PER_CASE + 1 },
            (_, index) => ({ ruleId: `expected-${index}`, episodeStartMs: 0 }),
          ),
        }),
        /expectedDetections must not exceed/,
      ],
      [
        invalidCase({ negativeRuleIds: Array(MAX_CAMPAIGN_RULES_PER_CASE + 1).fill('rule') }),
        /negativeRuleIds must not exceed/,
      ],
      [{ ...result, cases: [{ ...result.cases[0], detections: null }] }, /detections.*array/],
      [
        invalidCase({
          matchedDetections: Array(MAX_CAMPAIGN_RULES_PER_CASE + 1).fill({}),
        }),
        /matchedDetections must not exceed/,
      ],
      [invalidCase({ matchedDetections: [null] }), /matchedDetections\[0\].*object/],
      [
        invalidCase({
          missingDetections: Array(MAX_CAMPAIGN_RULES_PER_CASE + 1).fill({
            ruleId: 'rule',
            episodeStartMs: 0,
          }),
        }),
        /missingDetections must not exceed/,
      ],
      [
        invalidCase({
          unexpectedDetections: Array(MAX_CAMPAIGN_RULES_PER_CASE + 1).fill({ ruleId: 'rule' }),
        }),
        /unexpectedDetections must not exceed/,
      ],
      [invalidCase({ calibration: [null] }), /calibration\[0\].*object/],
      [
        invalidCase({ calibration: [{ confidence: -1, correct: true, abstained: false }] }),
        /confidence must be between zero and one/,
      ],
      [
        invalidCase({ calibration: [{ confidence: 0.5, correct: 'yes', abstained: false }] }),
        /correct must be a boolean/,
      ],
      [invalidCase({ confusion: null }), /confusion must be an object/],
      [
        invalidCase({ error: { name: 'Error', message: 'unexpected' } }),
        /only valid for a failed case/,
      ],
      [{ ...result, summary: null }, /summary.*object/],
      [{ ...result, summary: { ...result.summary, completedCases: -1 } }, /nonnegative integer/],
      [{ ...result, metrics: null }, /metrics.*object/],
      [{ ...result, metrics: { ...result.metrics, extra: Number.NaN } }, /nonfinite/],
    ];
    for (const [value, message] of invalidResults) {
      expect(() => assertCampaignResult(value)).toThrow(message);
    }
  });

  it('defines a versioned worker message protocol without a Worker runtime', () => {
    expect(
      isCampaignWorkerRequest({
        protocolVersion: CAMPAIGN_WORKER_PROTOCOL_VERSION,
        type: 'campaign.run',
        requestId: 'request-1',
        spec: nominalSpec(),
      }),
    ).toBe(true);
    expect(
      isCampaignWorkerRequest({
        protocolVersion: CAMPAIGN_WORKER_PROTOCOL_VERSION,
        type: 'campaign.cancel',
        requestId: 'request-1',
      }),
    ).toBe(true);
    expect(
      isCampaignWorkerResponse({
        protocolVersion: CAMPAIGN_WORKER_PROTOCOL_VERSION,
        type: 'campaign.cancelled',
        requestId: 'request-1',
        completedCases: 4,
        result: {},
      }),
    ).toBe(true);
    expect(
      isCampaignWorkerResponse({
        protocolVersion: CAMPAIGN_WORKER_PROTOCOL_VERSION,
        type: 'campaign.cancelled',
        requestId: 'request-1',
        completedCases: 4,
      }),
    ).toBe(false);
    expect(isCampaignWorkerRequest({ type: 'campaign.cancel', requestId: 'request-1' })).toBe(
      false,
    );
  });
});
