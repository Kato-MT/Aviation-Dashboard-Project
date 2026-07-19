import { describe, expect, it } from 'vitest';

import {
  CAMPAIGN_SCHEMA_VERSION,
  type CampaignProgress,
  type CampaignResult,
  type CampaignSpec,
} from '../../src/campaign/types';
import { buildDefaultTemporalCampaignSpec } from '../../src/campaign/defaultTemporalCampaign';
import { CAMPAIGN_WORKER_PROTOCOL_VERSION } from '../../src/campaign/worker-protocol';
import {
  createTemporalCampaignWorkerHandler,
  executeTemporalCampaign,
  expectedTemporalModelLabelAtPoint,
  type TemporalCampaignExecutor,
} from '../../src/workers/temporalCampaign.worker';

function spec(scenarioId = 'gradual-drift', seeds = [17]): CampaignSpec {
  return {
    schemaVersion: CAMPAIGN_SCHEMA_VERSION,
    campaignId: `temporal-${scenarioId}`,
    createdAt: '2026-07-17T12:00:00.000Z',
    profiles: [{ profileId: 'generic-fixed-wing', profileVersion: '1.0.0' }],
    scenarios: [
      {
        scenarioId,
        label: `Synthetic ${scenarioId}`,
        phase: 'temporal-verification',
        expectedDetections: [],
        negativeRuleIds: [],
        syntheticDurationMs: 179_000,
      },
    ],
    seeds,
    bootstrap: { iterations: 16, confidenceLevel: 0.9, seed: 23 },
    metadata: {
      synthetic: true,
      dataClassification: 'SYNTHETIC_UNCLASSIFIED',
    },
  };
}

function abortError(): Error {
  const error = new Error('cancelled test executor');
  error.name = 'AbortError';
  return error;
}

describe('temporal campaign worker execution', () => {
  it('uses point lifecycle labels for calibration before, during, and after a fault episode', () => {
    expect(expectedTemporalModelLabelAtPoint([])).toBe('nominal');
    expect(expectedTemporalModelLabelAtPoint([{ faultId: 'lag', lifecycle: 'active' }])).toBe(
      'sensor-lag',
    );
    expect(expectedTemporalModelLabelAtPoint([{ faultId: 'lag', lifecycle: 'recovering' }])).toBe(
      'sensor-lag',
    );
    expect(
      expectedTemporalModelLabelAtPoint([
        { faultId: 'gradual-drift', lifecycle: 'active' },
        { faultId: 'noise-growth', lifecycle: 'active' },
      ]),
    ).toBe('simultaneous-faults');
    expect(expectedTemporalModelLabelAtPoint([])).toBe('nominal');
  });

  it('completes the bounded 93-case release matrix and records honest outcomes', async () => {
    const campaign = buildDefaultTemporalCampaignSpec(
      [3101, 3102, 3103],
      '2026-07-17T12:00:00.000Z',
    );
    const result = await executeTemporalCampaign(campaign, new AbortController().signal);
    expect(result.status).toBe('completed');
    expect(result.summary).toEqual({
      plannedCases: 93,
      attemptedCases: 93,
      completedCases: 93,
      failedCases: 0,
      remainingCases: 0,
    });
    expect(result.metrics.confusion).toEqual({
      truePositives: 145,
      falsePositives: 27,
      trueNegatives: 564,
      falseNegatives: 8,
    });
    expect(result.metrics.episodes).toEqual({
      precision: 0.8430232558139535,
      recall: 0.9477124183006536,
      f1: 0.8923076923076924,
    });
    expect(result.metrics.falseAlarmsPerRun).toBe(27 / 93);
    expect(
      result.replayManifest.cases.filter(({ variation }) => variation !== undefined),
    ).toHaveLength(90);
    const modelObservations = result.cases.flatMap(({ calibration }) => calibration);
    expect(modelObservations.length).toBeGreaterThan(0);
    expect(modelObservations.some(({ abstained }) => !abstained)).toBe(true);
    expect(modelObservations.filter(({ abstained }) => abstained).length).toBeLessThan(
      modelObservations.length,
    );
  }, 15_000);

  it('executes 180-sample observed-only analysis with progress and advisory calibration', async () => {
    const progress: CampaignProgress[] = [];
    const result = await executeTemporalCampaign(spec(), new AbortController().signal, (event) =>
      progress.push(event),
    );

    expect(result.status).toBe('completed');
    expect(result.summary).toMatchObject({ plannedCases: 1, completedCases: 1, failedCases: 0 });
    expect(progress).toHaveLength(1);
    expect(result.cases[0]?.syntheticDurationMs).toBe(179_000);
    expect(result.cases[0]?.calibration.length).toBe(141);
    expect(result.cases[0]?.detections.length).toBeGreaterThan(0);
    expect(
      result.cases[0]?.detections.every(
        ({ details }) =>
          details?.authority === 'deterministic-rules' &&
          details.evidenceSource === 'observed-telemetry-only' &&
          details.authoritative === true &&
          (details.modelAdvisory as { authority?: string } | undefined)?.authority ===
            'advisory-only',
      ),
    ).toBe(true);
    expect(new Set(result.cases[0]?.detections.map(({ ruleId }) => ruleId)).size).toBe(
      result.cases[0]?.detections.length,
    );
    expect(
      result.cases[0]?.detections.every(
        ({ detectedAtMs }) =>
          detectedAtMs !== undefined && detectedAtMs >= 0 && detectedAtMs <= 179_000,
      ),
    ).toBe(true);
  });

  it('retains one pre-onset false alarm and the first valid post-onset detection per rule', async () => {
    const campaign = spec('stuck-value', [3101]);
    campaign.scenarios[0]!.variation = {
      variationId: 'bounded-detection-test',
      generatorScenarioId: 'stuck-value',
      severityScale: 0.65,
      durationScale: 0.75,
      onsetPhase: 'climb',
    };
    campaign.scenarios[0]!.expectedDetections = [
      { ruleId: 'investigation.fusion.innovation', episodeStartMs: 50_000 },
    ];
    const result = await executeTemporalCampaign(campaign, new AbortController().signal);
    const campaignCase = result.cases[0]!;
    const fusionDetections = campaignCase.detections.filter(
      ({ ruleId }) => ruleId === 'investigation.fusion.innovation',
    );

    expect(fusionDetections.map(({ detectedAtMs }) => detectedAtMs)).toEqual([37_000, 50_000]);
    expect(campaignCase.matchedDetections[0]).toMatchObject({
      detection: { ruleId: 'investigation.fusion.innovation', detectedAtMs: 50_000 },
      timeToDetectionMs: 0,
    });
    expect(campaignCase.unexpectedDetections).toContainEqual(
      expect.objectContaining({
        ruleId: 'investigation.fusion.innovation',
        detectedAtMs: 37_000,
      }),
    );
    expect(campaignCase.missingDetections).toEqual([]);
  });

  it('replays the same temporal campaign deterministically', async () => {
    const campaign = spec('oscillation', [31]);
    const first = await executeTemporalCampaign(campaign, new AbortController().signal);
    const second = await executeTemporalCampaign(campaign, new AbortController().signal);
    expect(second).toEqual(first);
  });

  it('executes an explicitly parameterized fault variant and preserves replay parameters', async () => {
    const campaign = spec('gradual-drift-variant', [41]);
    campaign.scenarios[0]!.variation = {
      variationId: 'high-long-descent',
      generatorScenarioId: 'gradual-drift',
      severityScale: 1.35,
      durationScale: 1.25,
      onsetPhase: 'descent',
    };
    campaign.scenarios[0]!.phase = 'descent';
    const result = await executeTemporalCampaign(campaign, new AbortController().signal);
    expect(result.status).toBe('completed');
    expect(result.replayManifest.cases[0]?.variation).toEqual(campaign.scenarios[0]!.variation);
    expect(result.replayManifest.cases[0]?.caseId).toContain('variation=high-long-descent');
  });

  it('contains an unsupported parameterized onset phase as an explicit case failure', async () => {
    const campaign = spec('gradual-drift-variant', [42]);
    campaign.scenarios[0]!.variation = {
      variationId: 'unsupported-phase',
      generatorScenarioId: 'gradual-drift',
      severityScale: 1,
      durationScale: 1,
      onsetPhase: 'orbit',
    };
    const result = await executeTemporalCampaign(campaign, new AbortController().signal);
    expect(result.cases[0]).toMatchObject({
      status: 'failed',
      error: {
        message: expect.stringContaining("Unsupported temporal campaign onset phase 'orbit'"),
      },
    });
  });

  it('returns a deterministic partial result after cancellation between cases', async () => {
    const controller = new AbortController();
    const statuses: Array<CampaignProgress['currentCaseStatus']> = [];
    const result = await executeTemporalCampaign(
      spec('gain-error', [1, 2]),
      controller.signal,
      (progress) => {
        statuses.push(progress.currentCaseStatus);
        if (progress.completedCases === 1) controller.abort('test');
      },
    );
    expect(result.status).toBe('cancelled');
    expect(result.summary).toMatchObject({
      attemptedCases: 1,
      completedCases: 1,
      remainingCases: 1,
    });
    expect(statuses).toEqual(['completed', 'cancelled']);
  });

  it('contains an unsupported scenario as an evaluator case error', async () => {
    const result = await executeTemporalCampaign(
      spec('not-a-temporal-scenario'),
      new AbortController().signal,
    );
    expect(result.status).toBe('completed-with-errors');
    expect(result.cases[0]).toMatchObject({
      status: 'failed',
      error: {
        name: 'Error',
        message: "Unsupported temporal campaign scenario 'not-a-temporal-scenario'.",
      },
    });
  });

  it('fails unsupported profile IDs and versions closed instead of generating fixed-wing data', async () => {
    const unsupportedId = spec('nominal');
    unsupportedId.profiles = [{ profileId: 'generic-rotary-wing', profileVersion: '1.0.0' }];
    const unsupportedIdResult = await executeTemporalCampaign(
      unsupportedId,
      new AbortController().signal,
    );
    expect(unsupportedIdResult.cases[0]).toMatchObject({
      status: 'failed',
      error: {
        name: 'UnsupportedTemporalCampaignProfileError',
        message: expect.stringContaining('supports only'),
      },
    });

    const unsupportedVersion = spec('nominal');
    unsupportedVersion.profiles = [{ profileId: 'generic-fixed-wing', profileVersion: '2.2.0' }];
    const unsupportedVersionResult = await executeTemporalCampaign(
      unsupportedVersion,
      new AbortController().signal,
    );
    expect(unsupportedVersionResult.cases[0]).toMatchObject({
      status: 'failed',
      error: { name: 'UnsupportedTemporalCampaignProfileError' },
    });
  });

  it('yields between real cases so a queued worker cancellation can publish partial evidence', async () => {
    const responses: Array<{ type: string; requestId: string; result?: CampaignResult }> = [];
    let resolveTerminal: (() => void) | undefined;
    let cancellationQueued = false;
    const terminal = new Promise<void>((resolve) => {
      resolveTerminal = resolve;
    });
    const handler = createTemporalCampaignWorkerHandler((response) => {
      responses.push(response);
      if (response.type === 'campaign.progress' && !cancellationQueued) {
        cancellationQueued = true;
        setTimeout(() => {
          handler.handleMessage({
            protocolVersion: CAMPAIGN_WORKER_PROTOCOL_VERSION,
            type: 'campaign.cancel',
            requestId: 'queued-cancel',
          });
        }, 0);
      }
      if (response.type === 'campaign.cancelled') resolveTerminal?.();
    });
    handler.handleMessage({
      protocolVersion: CAMPAIGN_WORKER_PROTOCOL_VERSION,
      type: 'campaign.run',
      requestId: 'queued-cancel',
      spec: spec('nominal', [1, 2, 3]),
    });
    await terminal;

    const cancelled = responses.find(({ type }) => type === 'campaign.cancelled');
    expect(cancelled?.result).toMatchObject({
      status: 'cancelled',
      summary: { completedCases: 1, remainingCases: 2 },
    });
  });

  it('emits progress and a result through the versioned worker protocol', async () => {
    const responses: Array<{ type: string; requestId: string }> = [];
    let resolveTerminal: (() => void) | undefined;
    const terminal = new Promise<void>((resolve) => {
      resolveTerminal = resolve;
    });
    const handler = createTemporalCampaignWorkerHandler((response) => {
      responses.push(response);
      if (response.type === 'campaign.result' || response.type === 'campaign.error') {
        resolveTerminal?.();
      }
    });
    handler.handleMessage({
      protocolVersion: CAMPAIGN_WORKER_PROTOCOL_VERSION,
      type: 'campaign.run',
      requestId: 'worker-success',
      spec: spec('nominal'),
    });
    await terminal;
    expect(responses.map(({ type }) => type)).toEqual(['campaign.progress', 'campaign.result']);
    expect(responses.every(({ requestId }) => requestId === 'worker-success')).toBe(true);
    expect(handler.activeRequestCount()).toBe(0);
  });

  it('rejects malformed, duplicate, and concurrent requests and cancels the active controller', async () => {
    const responses: Array<{ type: string; requestId: string; error?: { message: string } }> = [];
    let resolveCancelled: (() => void) | undefined;
    const cancelled = new Promise<void>((resolve) => {
      resolveCancelled = resolve;
    });
    const waitingExecutor: TemporalCampaignExecutor = (_campaign, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            reject(abortError());
          },
          { once: true },
        );
      });
    const handler = createTemporalCampaignWorkerHandler((response) => {
      responses.push(response);
      if (response.type === 'campaign.cancelled') resolveCancelled?.();
    }, waitingExecutor);

    handler.handleMessage({ type: 'campaign.run', requestId: 'malformed' });
    const request = {
      protocolVersion: CAMPAIGN_WORKER_PROTOCOL_VERSION,
      type: 'campaign.run' as const,
      requestId: 'duplicate-id',
      spec: spec(),
    };
    handler.handleMessage(request);
    handler.handleMessage(request);
    handler.handleMessage({
      ...request,
      requestId: 'concurrent-id',
    });
    expect(handler.activeRequestCount()).toBe(1);
    handler.handleMessage({
      protocolVersion: CAMPAIGN_WORKER_PROTOCOL_VERSION,
      type: 'campaign.cancel',
      requestId: 'duplicate-id',
    });
    await cancelled;

    expect(responses[0]).toMatchObject({
      type: 'campaign.error',
      requestId: 'malformed',
      error: { message: 'Malformed campaign worker request.' },
    });
    expect(
      responses.some(
        (response) =>
          response.requestId === 'duplicate-id' &&
          response.error?.message === 'Duplicate active campaign request ID.',
      ),
    ).toBe(true);
    expect(
      responses.some(
        (response) =>
          response.requestId === 'concurrent-id' &&
          response.error?.message === 'Only one temporal campaign request may be active.',
      ),
    ).toBe(true);
    expect(responses.at(-1)).toMatchObject({
      type: 'campaign.cancelled',
      requestId: 'duplicate-id',
    });
    expect(handler.activeRequestCount()).toBe(0);
  });
});
