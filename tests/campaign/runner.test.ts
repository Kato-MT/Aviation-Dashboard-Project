import { describe, expect, it } from 'vitest';

import {
  CAMPAIGN_SCHEMA_VERSION,
  runCampaign,
  type CampaignCaseContext,
  type CampaignEvaluation,
  type CampaignSpec,
} from '../../src/campaign';

function campaignSpec(overrides: Partial<CampaignSpec> = {}): CampaignSpec {
  return {
    schemaVersion: CAMPAIGN_SCHEMA_VERSION,
    campaignId: 'campaign-test-v1',
    createdAt: '2026-07-17T12:00:00.000Z',
    profiles: [
      { profileId: 'profile-a', profileVersion: '1.0.0' },
      { profileId: 'profile-b', profileVersion: '2.0.0' },
    ],
    scenarios: [
      {
        scenarioId: 'fault-a',
        label: 'Synthetic fault A',
        phase: 'detection',
        expectedDetections: [{ ruleId: 'rule.a', episodeStartMs: 100 }],
        negativeRuleIds: ['rule.safe'],
        syntheticDurationMs: 3_600_000,
      },
      {
        scenarioId: 'nominal',
        label: 'Synthetic nominal phase',
        phase: 'calibration',
        expectedDetections: [],
        negativeRuleIds: ['rule.a'],
        syntheticDurationMs: 1_800_000,
      },
    ],
    seeds: [7, 11],
    bootstrap: { iterations: 64, confidenceLevel: 0.95, seed: 99 },
    metadata: {
      synthetic: true,
      dataClassification: 'SYNTHETIC_UNCLASSIFIED',
      purpose: 'campaign unit test',
    },
    ...overrides,
  };
}

function evaluationFor(context: CampaignCaseContext): CampaignEvaluation {
  if (context.scenario.scenarioId === 'fault-a') {
    return {
      detections: [{ ruleId: 'rule.a', detectedAtMs: 150, confidence: 0.9 }],
      calibration: [{ confidence: 0.9, correct: true, abstained: false }],
    };
  }
  return {
    detections: [],
    calibration: [{ confidence: 0.45, correct: true, abstained: true }],
  };
}

describe('campaign runner', () => {
  it('executes the complete profile, scenario, and seed matrix deterministically', async () => {
    const spec = campaignSpec();
    const progress: string[] = [];
    const dependencies = {
      buildScenario: (context: CampaignCaseContext) => ({ input: context.caseId }),
      evaluateScenario: (_scenario: { input: string }, context: CampaignCaseContext) =>
        evaluationFor(context),
    };

    const first = await runCampaign(spec, dependencies, {
      onProgress: (event) => progress.push(`${event.completedCases}:${event.currentCaseId}`),
    });
    const second = await runCampaign(spec, dependencies);

    expect(first).toEqual(second);
    expect(first.status).toBe('completed');
    expect(first.summary).toEqual({
      plannedCases: 8,
      attemptedCases: 8,
      completedCases: 8,
      failedCases: 0,
      remainingCases: 0,
    });
    expect(first.replayManifest.specSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.replayManifest.cases).toHaveLength(8);
    expect(progress).toHaveLength(8);
    expect(first.metrics.confusion).toEqual({
      truePositives: 4,
      falsePositives: 0,
      trueNegatives: 8,
      falseNegatives: 0,
    });
    expect(first.metrics.timeToDetection.mean).toBe(50);
    expect(first.metrics.scenarioCoverage[0]).toMatchObject({
      scenarioId: 'fault-a',
      plannedCases: 4,
      completedCases: 4,
      coverage: 1,
    });
    expect(first.metrics.confusionByProfile).toHaveLength(2);
    expect(first.metrics.confusionByPhase).toHaveLength(2);
    expect(first.metrics.confusionByFault).toHaveLength(2);
    expect(first.metrics.bootstrap).toEqual(second.metrics.bootstrap);
  });

  it('percent-encodes structured case ID values so delimiter-bearing inputs cannot collide', async () => {
    const firstSpec = campaignSpec({
      profiles: [{ profileId: 'profile|a', profileVersion: '1@0' }],
      scenarios: [
        {
          ...campaignSpec().scenarios[0]!,
          scenarioId: 'fault|phase=calibration',
          phase: 'verification',
        },
      ],
      seeds: [1],
    });
    const secondSpec = campaignSpec({
      profiles: [{ profileId: 'profile|a', profileVersion: '1@0' }],
      scenarios: [
        {
          ...campaignSpec().scenarios[0]!,
          scenarioId: 'fault',
          phase: 'calibration|phase=verification',
        },
      ],
      seeds: [1],
    });
    const dependencies = {
      buildScenario: (context: CampaignCaseContext) => ({ input: context.caseId }),
      evaluateScenario: (_scenario: { input: string }, context: CampaignCaseContext) =>
        evaluationFor(context),
    };

    const first = await runCampaign(firstSpec, dependencies);
    const second = await runCampaign(secondSpec, dependencies);

    expect(first.cases[0]?.caseId).not.toBe(second.cases[0]?.caseId);
    expect(first.cases[0]?.caseId).toContain('profile=profile%7Ca@1%400');
    expect(first.cases[0]?.caseId).toContain('scenario=fault%7Cphase%3Dcalibration');
    expect(second.cases[0]?.caseId).toContain('phase=calibration%7Cphase%3Dverification');
  });

  it('reports expected, missing, unexpected, timing, calibration, and false alarms', async () => {
    const spec = campaignSpec({
      profiles: [{ profileId: 'profile-a', profileVersion: '1.0.0' }],
      scenarios: [
        {
          scenarioId: 'mixed',
          label: 'Mixed outcomes',
          phase: 'verification',
          expectedDetections: [
            { ruleId: 'rule.a', episodeStartMs: 10 },
            { ruleId: 'rule.b', episodeStartMs: 10 },
          ],
          negativeRuleIds: ['rule.safe'],
          syntheticDurationMs: 3_600_000,
        },
      ],
      seeds: [1],
    });
    const result = await runCampaign(spec, {
      buildScenario: () => ({ input: 'input' }),
      evaluateScenario: () => ({
        detections: [
          { ruleId: 'rule.a', detectedAtMs: 20, confidence: 0.9 },
          { ruleId: 'rule.a', detectedAtMs: 30, confidence: 0.8 },
          { ruleId: 'rule.safe', detectedAtMs: 5, confidence: 0.7 },
          { ruleId: 'rule.unknown', detectedAtMs: 40, confidence: 0.4 },
        ],
        calibration: [
          { confidence: 0.9, correct: true, abstained: false },
          { confidence: 0.7, correct: false, abstained: false },
          { confidence: 0.5, correct: false, abstained: true },
        ],
      }),
    });

    const campaignCase = result.cases[0]!;
    expect(campaignCase.matchedDetections).toHaveLength(1);
    expect(campaignCase.missingDetections.map((entry) => entry.ruleId)).toEqual(['rule.b']);
    expect(campaignCase.unexpectedDetections.map((entry) => entry.ruleId)).toEqual([
      'rule.a',
      'rule.safe',
      'rule.unknown',
    ]);
    expect(campaignCase.confusion).toEqual({
      truePositives: 1,
      falsePositives: 3,
      trueNegatives: 0,
      falseNegatives: 1,
    });
    expect(campaignCase.matchedDetections[0]?.timeToDetectionMs).toBe(10);
    expect(result.metrics.episodes.precision).toBe(0.25);
    expect(result.metrics.episodes.recall).toBe(0.5);
    expect(result.metrics.episodes.f1).toBeCloseTo(1 / 3);
    expect(result.metrics.falseAlarmsPerRun).toBe(3);
    expect(result.metrics.falseAlarmsPerSyntheticHour).toBe(3);
    expect(result.metrics.calibration).toMatchObject({
      observations: 3,
      answered: 2,
      abstained: 1,
      abstentionRate: 1 / 3,
    });
    expect(result.metrics.calibration.brierScore).toBeCloseTo(0.25);
  });

  it('returns a deterministic partial result when cancelled between cases', async () => {
    const controller = new AbortController();
    const progress: string[] = [];
    const result = await runCampaign(
      campaignSpec(),
      {
        buildScenario: (context) => ({ input: context.caseId }),
        evaluateScenario: (_scenario, context) => evaluationFor(context),
      },
      {
        signal: controller.signal,
        onProgress: (event) => {
          progress.push(String(event.currentCaseStatus));
          if (event.completedCases === 1) controller.abort('test cancellation');
        },
      },
    );

    expect(result.status).toBe('cancelled');
    expect(result.summary.attemptedCases).toBe(1);
    expect(result.summary.remainingCases).toBe(7);
    expect(progress).toEqual(['completed', 'cancelled']);
  });

  it('does not commit an in-flight case after its signal is aborted', async () => {
    const controller = new AbortController();
    const result = await runCampaign(
      campaignSpec({ profiles: [{ profileId: 'p', profileVersion: '1' }], seeds: [1] }),
      {
        buildScenario: (context) => ({ input: context.caseId }),
        evaluateScenario: (_scenario, context) => {
          controller.abort();
          return evaluationFor(context);
        },
      },
      { signal: controller.signal },
    );
    expect(result.status).toBe('cancelled');
    expect(result.cases).toEqual([]);
    expect(result.summary.attemptedCases).toBe(0);
  });

  it('contains evaluator failures and continues the remaining matrix', async () => {
    const spec = campaignSpec({
      profiles: [{ profileId: 'profile-a', profileVersion: '1.0.0' }],
      scenarios: [campaignSpec().scenarios[0]!],
      seeds: [1, 2, 3],
    });
    const visited: number[] = [];
    const result = await runCampaign(spec, {
      buildScenario: (context) => ({ input: context.seed }),
      evaluateScenario: (_scenario, context) => {
        visited.push(context.seed);
        if (context.seed === 2) throw new Error('contained evaluator failure');
        return evaluationFor(context);
      },
    });

    expect(visited).toEqual([1, 2, 3]);
    expect(result.status).toBe('completed-with-errors');
    expect(result.summary).toMatchObject({ completedCases: 2, failedCases: 1 });
    expect(result.cases[1]).toMatchObject({
      status: 'failed',
      error: { name: 'Error', message: 'contained evaluator failure' },
    });
    expect(result.metrics.confusion.truePositives).toBe(2);
  });

  it('does not reinterpret or duplicate a committed case when progress reporting throws', async () => {
    let evaluations = 0;
    let progressCalls = 0;
    const campaign = campaignSpec({
      profiles: [{ profileId: 'profile-a', profileVersion: '1.0.0' }],
      scenarios: [campaignSpec().scenarios[0]!],
      seeds: [1, 2],
    });

    await expect(
      runCampaign(
        campaign,
        {
          buildScenario: (context) => ({ input: context.caseId }),
          evaluateScenario: (_scenario, context) => {
            evaluations += 1;
            return evaluationFor(context);
          },
        },
        {
          onProgress: () => {
            progressCalls += 1;
            throw new Error('progress consumer failed');
          },
        },
      ),
    ).rejects.toThrow('progress consumer failed');
    expect(evaluations).toBe(1);
    expect(progressCalls).toBe(1);
  });
});
