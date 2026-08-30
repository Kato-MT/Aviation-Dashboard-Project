import { describe, expect, it, vi } from 'vitest';

import {
  CampaignCancelledError,
  TemporalCampaignBrowserClient,
  type CampaignWorkerLike,
} from '../../src/campaign/browserClient';
import { runCampaign } from '../../src/campaign/runner';
import {
  CAMPAIGN_SCHEMA_VERSION,
  type CampaignResult,
  type CampaignSpec,
} from '../../src/campaign/types';
import {
  CAMPAIGN_WORKER_PROTOCOL_VERSION,
  type CampaignWorkerRequest,
} from '../../src/campaign/worker-protocol';

function spec(): CampaignSpec {
  return {
    schemaVersion: CAMPAIGN_SCHEMA_VERSION,
    campaignId: 'browser-client-test',
    createdAt: '2026-07-17T12:00:00.000Z',
    profiles: [{ profileId: 'generic-fixed-wing', profileVersion: '2.2.0' }],
    scenarios: [
      {
        scenarioId: 'nominal',
        label: 'Synthetic nominal',
        phase: 'nominal',
        expectedDetections: [],
        negativeRuleIds: [],
        syntheticDurationMs: 179_000,
      },
    ],
    seeds: [1],
    bootstrap: { iterations: 8, confidenceLevel: 0.9, seed: 2 },
    metadata: { synthetic: true, dataClassification: 'SYNTHETIC_UNCLASSIFIED' },
  };
}

async function validResult(): Promise<CampaignResult> {
  return runCampaign(spec(), {
    buildScenario: () => ({ input: null }),
    evaluateScenario: () => ({ detections: [], calibration: [], syntheticDurationMs: 179_000 }),
  });
}

async function cancelledResult(
  campaign: CampaignSpec = spec(),
  completedCases = 0,
): Promise<CampaignResult> {
  const controller = new AbortController();
  if (completedCases === 0) controller.abort('cancel-before-start');
  return runCampaign(
    campaign,
    {
      buildScenario: () => ({ input: null }),
      evaluateScenario: () => ({ detections: [], calibration: [], syntheticDurationMs: 179_000 }),
    },
    {
      signal: controller.signal,
      onProgress: (progress) => {
        if (progress.completedCases === completedCases) controller.abort('test-cancel');
      },
    },
  );
}

function progressResponse(
  requestId: string,
  overrides: Partial<{
    campaignId: string;
    completedCases: number;
    totalCases: number;
    currentCaseId: string | null;
    currentCaseStatus: 'completed' | 'failed' | 'cancelled' | null;
  }> = {},
) {
  return {
    protocolVersion: CAMPAIGN_WORKER_PROTOCOL_VERSION,
    type: 'campaign.progress' as const,
    requestId,
    progress: {
      campaignId: spec().campaignId,
      completedCases: 1,
      totalCases: 1,
      currentCaseId: 'case-1',
      currentCaseStatus: 'completed' as const,
      ...overrides,
    },
  };
}

class FakeWorker implements CampaignWorkerLike {
  readonly messages: CampaignWorkerRequest[] = [];
  readonly messageListeners = new Set<(event: MessageEvent<unknown>) => void>();
  readonly errorListeners = new Set<(event: ErrorEvent) => void>();
  readonly messageErrorListeners = new Set<(event: MessageEvent<unknown>) => void>();
  terminated = false;

  postMessage(message: CampaignWorkerRequest): void {
    this.messages.push(message);
  }

  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  addEventListener(type: 'error', listener: (event: ErrorEvent) => void): void;
  addEventListener(type: 'messageerror', listener: (event: MessageEvent<unknown>) => void): void;
  addEventListener(
    type: 'message' | 'error' | 'messageerror',
    listener: ((event: MessageEvent<unknown>) => void) | ((event: ErrorEvent) => void),
  ): void {
    if (type === 'message') {
      this.messageListeners.add(listener as (event: MessageEvent<unknown>) => void);
    } else if (type === 'error') {
      this.errorListeners.add(listener as (event: ErrorEvent) => void);
    } else {
      this.messageErrorListeners.add(listener as (event: MessageEvent<unknown>) => void);
    }
  }

  removeEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  removeEventListener(type: 'error', listener: (event: ErrorEvent) => void): void;
  removeEventListener(type: 'messageerror', listener: (event: MessageEvent<unknown>) => void): void;
  removeEventListener(
    type: 'message' | 'error' | 'messageerror',
    listener: ((event: MessageEvent<unknown>) => void) | ((event: ErrorEvent) => void),
  ): void {
    if (type === 'message') {
      this.messageListeners.delete(listener as (event: MessageEvent<unknown>) => void);
    } else if (type === 'error') {
      this.errorListeners.delete(listener as (event: ErrorEvent) => void);
    } else {
      this.messageErrorListeners.delete(listener as (event: MessageEvent<unknown>) => void);
    }
  }

  terminate(): void {
    this.terminated = true;
  }

  emitMessage(data: unknown): void {
    for (const listener of [...this.messageListeners]) {
      listener({ data } as MessageEvent<unknown>);
    }
  }

  emitError(message: string): void {
    for (const listener of [...this.errorListeners]) listener({ message } as ErrorEvent);
  }

  emitMessageError(): void {
    for (const listener of [...this.messageErrorListeners]) {
      listener({ data: undefined } as MessageEvent<unknown>);
    }
  }
}

describe('temporal campaign browser client', () => {
  it('validates and resolves progress and result responses', async () => {
    const worker = new FakeWorker();
    const client = new TemporalCampaignBrowserClient(() => worker);
    const progress: number[] = [];
    const promise = client.run(spec(), {
      requestId: 'success',
      onProgress: (event) => progress.push(event.completedCases),
    });
    expect(worker.messages[0]).toMatchObject({ type: 'campaign.run', requestId: 'success' });
    worker.emitMessage(progressResponse('success'));
    const result = await validResult();
    worker.emitMessage({
      protocolVersion: CAMPAIGN_WORKER_PROTOCOL_VERSION,
      type: 'campaign.result',
      requestId: 'success',
      result,
    });
    await expect(promise).resolves.toEqual(result);
    expect(progress).toEqual([1]);
    client.terminate();
  });

  it('sends cancellation and rejects with visible completed-case evidence', async () => {
    const worker = new FakeWorker();
    const client = new TemporalCampaignBrowserClient(() => worker);
    const submittedSpec = spec();
    submittedSpec.seeds = [1, 2];
    const promise = client.run(submittedSpec, { requestId: 'cancel-me' });
    expect(client.cancel()).toBe(true);
    expect(worker.messages.at(-1)).toMatchObject({
      type: 'campaign.cancel',
      requestId: 'cancel-me',
    });
    const partialResult = await cancelledResult(submittedSpec, 1);
    worker.emitMessage({
      protocolVersion: CAMPAIGN_WORKER_PROTOCOL_VERSION,
      type: 'campaign.cancelled',
      requestId: 'cancel-me',
      completedCases: 1,
      result: partialResult,
    });
    const error = await promise.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CampaignCancelledError);
    expect(error).toMatchObject({ completedCases: 1, partialResult });
  });

  it('rejects an invalid submitted spec before posting a worker request', async () => {
    const worker = new FakeWorker();
    const client = new TemporalCampaignBrowserClient(() => worker);
    const invalidSpec = spec();
    invalidSpec.seeds = [];

    await expect(client.run(invalidSpec, { requestId: 'invalid-spec' })).rejects.toThrow(
      'seeds must contain at least one seed',
    );
    expect(worker.messages).toEqual([]);

    const valid = client.run(spec(), { requestId: 'valid-after-invalid' });
    expect(worker.messages).toHaveLength(1);
    client.terminate();
    await expect(valid).rejects.toThrow('terminated');
  });

  it('binds progress to the submitted campaign and exact matrix size', async () => {
    const campaignWorker = new FakeWorker();
    const campaignClient = new TemporalCampaignBrowserClient(() => campaignWorker);
    const campaignPromise = campaignClient.run(spec(), { requestId: 'wrong-campaign' });
    campaignWorker.emitMessage(
      progressResponse('wrong-campaign', { campaignId: 'substituted-campaign' }),
    );
    await expect(campaignPromise).rejects.toThrow(
      'campaignId does not match the submitted campaign',
    );

    const totalWorker = new FakeWorker();
    const totalClient = new TemporalCampaignBrowserClient(() => totalWorker);
    const totalPromise = totalClient.run(spec(), { requestId: 'wrong-total' });
    totalWorker.emitMessage(progressResponse('wrong-total', { totalCases: 2 }));
    await expect(totalPromise).rejects.toThrow(
      'totalCases does not match the submitted campaign matrix',
    );
  });

  it('rejects regressing, skipped, and post-cancellation progress', async () => {
    const regressionSpec = spec();
    regressionSpec.seeds = [1, 2];
    const regressionWorker = new FakeWorker();
    const regressionClient = new TemporalCampaignBrowserClient(() => regressionWorker);
    const regressionPromise = regressionClient.run(regressionSpec, { requestId: 'regression' });
    regressionWorker.emitMessage(
      progressResponse('regression', { completedCases: 1, totalCases: 2 }),
    );
    regressionWorker.emitMessage(
      progressResponse('regression', {
        completedCases: 0,
        totalCases: 2,
        currentCaseId: null,
        currentCaseStatus: null,
      }),
    );
    await expect(regressionPromise).rejects.toThrow('completedCases regressed');

    const skippedSpec = spec();
    skippedSpec.seeds = [1, 2];
    const skippedWorker = new FakeWorker();
    const skippedClient = new TemporalCampaignBrowserClient(() => skippedWorker);
    const skippedPromise = skippedClient.run(skippedSpec, { requestId: 'skipped' });
    skippedWorker.emitMessage(progressResponse('skipped', { completedCases: 2, totalCases: 2 }));
    await expect(skippedPromise).rejects.toThrow('advance exactly one processed case');

    const cancellationWorker = new FakeWorker();
    const cancellationClient = new TemporalCampaignBrowserClient(() => cancellationWorker);
    const cancellationPromise = cancellationClient.run(regressionSpec, {
      requestId: 'post-cancel-progress',
    });
    cancellationWorker.emitMessage(
      progressResponse('post-cancel-progress', {
        completedCases: 0,
        totalCases: 2,
        currentCaseStatus: 'cancelled',
      }),
    );
    cancellationWorker.emitMessage(
      progressResponse('post-cancel-progress', { completedCases: 1, totalCases: 2 }),
    );
    await expect(cancellationPromise).rejects.toThrow(
      'progress after reporting cancellation progress',
    );
  });

  it('rejects self-consistent terminal results substituted for the submitted spec', async () => {
    const campaignWorker = new FakeWorker();
    const campaignClient = new TemporalCampaignBrowserClient(() => campaignWorker);
    const campaignPromise = campaignClient.run(spec(), { requestId: 'terminal-campaign' });
    const differentCampaignSpec = spec();
    differentCampaignSpec.campaignId = 'substituted-campaign';
    const differentCampaignResult = await runCampaign(differentCampaignSpec, {
      buildScenario: () => ({ input: null }),
      evaluateScenario: () => ({ detections: [], calibration: [], syntheticDurationMs: 179_000 }),
    });
    campaignWorker.emitMessage({
      protocolVersion: CAMPAIGN_WORKER_PROTOCOL_VERSION,
      type: 'campaign.result',
      requestId: 'terminal-campaign',
      result: differentCampaignResult,
    });
    await expect(campaignPromise).rejects.toThrow(
      'result campaignId does not match the submitted campaign',
    );

    const specWorker = new FakeWorker();
    const specClient = new TemporalCampaignBrowserClient(() => specWorker);
    const specPromise = specClient.run(spec(), { requestId: 'terminal-spec' });
    const differentSpec = spec();
    differentSpec.seeds = [2];
    const differentSpecResult = await runCampaign(differentSpec, {
      buildScenario: () => ({ input: null }),
      evaluateScenario: () => ({ detections: [], calibration: [], syntheticDurationMs: 179_000 }),
    });
    specWorker.emitMessage({
      protocolVersion: CAMPAIGN_WORKER_PROTOCOL_VERSION,
      type: 'campaign.result',
      requestId: 'terminal-spec',
      result: differentSpecResult,
    });
    await expect(specPromise).rejects.toThrow(
      'result spec does not match the submitted campaign spec',
    );
  });

  it('surfaces evaluator errors and browser worker errors', async () => {
    const protocolWorker = new FakeWorker();
    const protocolClient = new TemporalCampaignBrowserClient(() => protocolWorker);
    const protocolPromise = protocolClient.run(spec(), { requestId: 'evaluator-error' });
    protocolWorker.emitMessage({
      protocolVersion: CAMPAIGN_WORKER_PROTOCOL_VERSION,
      type: 'campaign.error',
      requestId: 'evaluator-error',
      error: { name: 'EvaluationError', message: 'visible evaluator failure' },
    });
    await expect(protocolPromise).rejects.toMatchObject({
      name: 'EvaluationError',
      message: 'visible evaluator failure',
    });

    const runtimeWorker = new FakeWorker();
    const runtimeClient = new TemporalCampaignBrowserClient(() => runtimeWorker);
    const runtimePromise = runtimeClient.run(spec(), { requestId: 'runtime-error' });
    runtimeWorker.emitError('worker runtime failed visibly');
    await expect(runtimePromise).rejects.toThrow('worker runtime failed visibly');
  });

  it('rejects malformed and mismatched worker responses', async () => {
    const malformedWorker = new FakeWorker();
    const malformedClient = new TemporalCampaignBrowserClient(() => malformedWorker);
    const malformed = malformedClient.run(spec(), { requestId: 'malformed' });
    malformedWorker.emitMessage({ type: 'campaign.result', requestId: 'malformed' });
    await expect(malformed).rejects.toThrow('Malformed campaign worker response');

    const mismatchWorker = new FakeWorker();
    const mismatchClient = new TemporalCampaignBrowserClient(() => mismatchWorker);
    const mismatch = mismatchClient.run(spec(), { requestId: 'expected-id' });
    const partialResult = await cancelledResult();
    mismatchWorker.emitMessage({
      protocolVersion: CAMPAIGN_WORKER_PROTOCOL_VERSION,
      type: 'campaign.cancelled',
      requestId: 'different-id',
      completedCases: 0,
      result: partialResult,
    });
    await expect(mismatch).rejects.toThrow('does not match');

    const inconsistentWorker = new FakeWorker();
    const inconsistentClient = new TemporalCampaignBrowserClient(() => inconsistentWorker);
    const inconsistent = inconsistentClient.run(spec(), { requestId: 'inconsistent-cancel' });
    const completedResult = await validResult();
    inconsistentWorker.emitMessage({
      protocolVersion: CAMPAIGN_WORKER_PROTOCOL_VERSION,
      type: 'campaign.cancelled',
      requestId: 'inconsistent-cancel',
      completedCases: 1,
      result: completedResult,
    });
    await expect(inconsistent).rejects.toThrow('do not match');
  });

  it('enforces one active request and terminates cleanly', async () => {
    const worker = new FakeWorker();
    const client = new TemporalCampaignBrowserClient(() => worker);
    const first = client.run(spec(), { requestId: 'first' });
    await expect(client.run(spec(), { requestId: 'second' })).rejects.toThrow('Only one');
    client.terminate();
    await expect(first).rejects.toThrow('terminated');
    expect(worker.terminated).toBe(true);
    expect(worker.messageListeners.size).toBe(0);
    expect(worker.errorListeners.size).toBe(0);
    expect(worker.messageErrorListeners.size).toBe(0);
    await expect(client.run(spec())).rejects.toThrow('terminated');
  });

  it('bounds silent runs and cancellations, then recreates a clean worker', async () => {
    vi.useFakeTimers();
    try {
      const workers = [new FakeWorker(), new FakeWorker(), new FakeWorker()];
      let factoryIndex = 0;
      const client = new TemporalCampaignBrowserClient(() => workers[factoryIndex++]!, {
        runTimeoutMs: 100,
        cancelTimeoutMs: 25,
      });

      const silentRun = client.run(spec(), { requestId: 'silent-run' });
      const silentRunError = silentRun.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(100);
      await expect(silentRunError).resolves.toMatchObject({
        name: 'TimeoutError',
        message: expect.stringContaining('did not finish'),
      });
      expect(workers[0]?.terminated).toBe(true);
      expect(workers[0]?.messageListeners.size).toBe(0);
      expect(workers[1]?.messageListeners.size).toBe(1);

      const silentCancel = client.run(spec(), { requestId: 'silent-cancel' });
      const silentCancelError = silentCancel.catch((error: unknown) => error);
      expect(client.cancel()).toBe(true);
      await vi.advanceTimersByTimeAsync(25);
      await expect(silentCancelError).resolves.toMatchObject({
        name: 'TimeoutError',
        message: expect.stringContaining('acknowledge cancellation'),
      });
      expect(workers[1]?.terminated).toBe(true);
      expect(workers[2]?.messageListeners.size).toBe(1);
      client.terminate();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects message deserialization failures and replaces the failed worker', async () => {
    const workers = [new FakeWorker(), new FakeWorker()];
    let factoryIndex = 0;
    const client = new TemporalCampaignBrowserClient(() => workers[factoryIndex++]!);
    const promise = client.run(spec(), { requestId: 'message-error' });
    workers[0]!.emitMessageError();

    await expect(promise).rejects.toThrow('could not be deserialized');
    expect(workers[0]?.terminated).toBe(true);
    expect(workers[0]?.messageErrorListeners.size).toBe(0);
    expect(workers[1]?.messageErrorListeners.size).toBe(1);
    client.terminate();
  });

  it('maps an AbortSignal to the active cancellation request', async () => {
    const worker = new FakeWorker();
    const client = new TemporalCampaignBrowserClient(() => worker);
    const controller = new AbortController();
    const promise = client.run(spec(), { requestId: 'signal-cancel', signal: controller.signal });
    controller.abort();
    expect(worker.messages.at(-1)).toMatchObject({
      type: 'campaign.cancel',
      requestId: 'signal-cancel',
    });
    const partialResult = await cancelledResult();
    worker.emitMessage({
      protocolVersion: CAMPAIGN_WORKER_PROTOCOL_VERSION,
      type: 'campaign.cancelled',
      requestId: 'signal-cancel',
      completedCases: 0,
      result: partialResult,
    });
    await expect(promise).rejects.toBeInstanceOf(CampaignCancelledError);
  });
});
