import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CampaignCancelledError,
  type BrowserCampaignRunOptions,
} from '../../src/campaign/browserClient';
import { runCampaign as runCampaignDomain } from '../../src/campaign/runner';
import type { CampaignProgress, CampaignResult, CampaignSpec } from '../../src/campaign/types';
import { CAMPAIGN_DEFAULT_SEEDS_INPUT, prepareCampaignRun } from '../../src/features/lab/campaign';
import { LabSession, type LabCampaignClient } from '../../src/features/lab/session';

const NOW = '2026-08-29T12:00:00.000Z';

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

class FakeCampaignClient implements LabCampaignClient {
  readonly completion = deferred<CampaignResult>();
  readonly run = vi.fn((_spec: CampaignSpec, options: BrowserCampaignRunOptions = {}) => {
    this.options = options;
    return this.completion.promise;
  });
  readonly cancel = vi.fn(() => true);
  readonly terminate = vi.fn();
  private options: BrowserCampaignRunOptions | undefined;

  emitProgress(progress: CampaignProgress): void {
    this.options?.onProgress?.(progress);
  }
}

function factoryFor(...clients: FakeCampaignClient[]) {
  let index = 0;
  const factory = vi.fn(() => {
    const client = clients[index];
    if (!client) throw new Error('No fake Campaign client remains.');
    index += 1;
    return client;
  });
  return factory;
}

async function activeSession(factory: () => LabCampaignClient): Promise<LabSession> {
  const session = new LabSession({ campaignClientFactory: factory, now: () => NOW });
  await session.start();
  session.setCampaignSeedsInput('3101');
  return session;
}

async function campaignResult(options: { failFirst?: boolean; cancelAfter?: number } = {}) {
  const prepared = prepareCampaignRun({ seedsInput: '3101' }, NOW);
  const controller = new AbortController();
  return runCampaignDomain(
    prepared.spec,
    {
      buildScenario: (context) => ({ input: context.caseId }),
      evaluateScenario: (_scenario, context) => {
        if (options.failFirst && context.caseIndex === 0) {
          throw new Error('contained Campaign fixture failure');
        }
        return {
          detections: [],
          calibration: [],
          syntheticDurationMs: context.scenario.syntheticDurationMs,
        };
      },
    },
    {
      signal: controller.signal,
      onProgress: (progress) => {
        if (options.cancelAfter !== undefined && progress.completedCases === options.cancelAfter) {
          controller.abort('Campaign fixture cancellation');
        }
      },
    },
  );
}

let completed: CampaignResult;
let completedWithErrors: CampaignResult;
let cancelled: CampaignResult;

beforeAll(async () => {
  [completed, completedWithErrors, cancelled] = await Promise.all([
    campaignResult(),
    campaignResult({ failFirst: true }),
    campaignResult({ cancelAfter: 1 }),
  ]);
});

describe('LabSession Campaign ownership', () => {
  it('starts with the bounded 93-case defaults without constructing a worker', async () => {
    const factory = vi.fn<() => LabCampaignClient>();
    const session = new LabSession({ campaignClientFactory: factory, now: () => NOW });
    await session.start();

    expect(session.getState().campaign).toEqual({
      seedsInput: CAMPAIGN_DEFAULT_SEEDS_INPUT,
      phase: 'idle',
      progress: undefined,
      current: undefined,
      resultSettingsStale: false,
      issue: undefined,
    });
    expect(factory).not.toHaveBeenCalled();
    session.stop();
  });

  it('validates before client creation and retains prior settled evidence on invalid input', async () => {
    const first = new FakeCampaignClient();
    const factory = factoryFor(first);
    const session = await activeSession(factory);
    const run = session.runCampaign();
    first.completion.resolve(completed);
    expect(await run).toBe(true);
    const settled = session.getState().campaign.current;

    session.setCampaignSeedsInput('3101,,3102');
    expect(await session.runCampaign()).toBe(false);

    expect(factory).toHaveBeenCalledOnce();
    expect(session.getState().campaign.current).toBe(settled);
    expect(session.getState().campaign.phase).toBe('failed');
    expect(session.getState().campaign.issue).toContain('cannot be empty');
    expect(session.getState().campaign.resultSettingsStale).toBe(true);
    session.stop();
  });

  it('publishes monotonic progress and an immutable completed result atomically', async () => {
    const client = new FakeCampaignClient();
    const session = await activeSession(factoryFor(client));
    const run = session.runCampaign();
    client.emitProgress({
      campaignId: completed.campaignId,
      completedCases: 1,
      totalCases: 31,
      currentCaseId: completed.cases[0]!.caseId,
      currentCaseStatus: 'completed',
    });
    expect(session.getState().campaign.progress?.completedCases).toBe(1);

    client.completion.resolve(completed);
    expect(await run).toBe(true);

    const state = session.getState().campaign;
    expect(state.phase).toBe('completed');
    expect(state.progress).toMatchObject({ completedCases: 31, totalCases: 31 });
    expect(state.current?.result).toEqual(completed);
    expect(Object.isFrozen(state.current)).toBe(true);
    expect(client.terminate).toHaveBeenCalledOnce();
    session.stop();
  });

  it('distinguishes completed-with-errors and keeps failed cases out of completion counts', async () => {
    const client = new FakeCampaignClient();
    const session = await activeSession(factoryFor(client));
    const run = session.runCampaign();
    client.completion.resolve(completedWithErrors);
    expect(await run).toBe(true);

    expect(session.getState().campaign.phase).toBe('completed-with-errors');
    expect(session.getState().campaign.current?.result.summary).toMatchObject({
      attemptedCases: 31,
      completedCases: 30,
      failedCases: 1,
    });
    expect(session.getState().campaign.issue).toContain('contained case failures');
    session.stop();
  });

  it('waits for verified partial evidence after graceful cancellation', async () => {
    const client = new FakeCampaignClient();
    const session = await activeSession(factoryFor(client));
    const run = session.runCampaign();

    expect(session.cancelCampaign()).toBe(true);
    expect(session.getState().campaign.phase).toBe('cancelling');
    client.completion.reject(new CampaignCancelledError(cancelled));
    expect(await run).toBe(true);

    expect(session.getState().campaign.phase).toBe('cancelled');
    expect(session.getState().campaign.current?.result.status).toBe('cancelled');
    expect(session.getState().campaign.current?.result.summary).toMatchObject({
      attemptedCases: 1,
      remainingCases: 30,
    });
    expect(client.cancel).toHaveBeenCalledOnce();
    expect(client.terminate).toHaveBeenCalledOnce();
    session.stop();
  });

  it('hard-stops on route exit, rejects late completion, and starts with a fresh client', async () => {
    const first = new FakeCampaignClient();
    const second = new FakeCampaignClient();
    const session = await activeSession(factoryFor(first, second));
    const staleRun = session.runCampaign();

    session.leaveCampaign('Campaign closed');
    expect(session.getState().campaign.phase).toBe('stopped');
    expect(session.getState().campaign.issue).toContain('before verified partial evidence');
    expect(first.terminate).toHaveBeenCalledOnce();
    first.completion.resolve(completed);
    expect(await staleRun).toBe(false);
    expect(session.getState().campaign.current).toBeUndefined();

    const currentRun = session.runCampaign();
    second.completion.resolve(completed);
    expect(await currentRun).toBe(true);
    expect(session.getState().campaign.phase).toBe('completed');
    expect(second.terminate).toHaveBeenCalledOnce();
    session.stop();
  });

  it('clear invalidates pending work, terminates its client, and restores exact defaults', async () => {
    const client = new FakeCampaignClient();
    const session = await activeSession(factoryFor(client));
    const run = session.runCampaign();

    session.clear();
    client.completion.resolve(completed);
    expect(await run).toBe(false);
    expect(client.terminate).toHaveBeenCalledOnce();
    expect(session.getState().campaign).toEqual({
      seedsInput: CAMPAIGN_DEFAULT_SEEDS_INPUT,
      phase: 'idle',
      progress: undefined,
      current: undefined,
      resultSettingsStale: false,
      issue: undefined,
    });
    expect(session.getState().message).toContain('No records were persisted');
    session.stop();
  });

  it('stop never relabels a hard termination as cancellation or resumes it on start', async () => {
    const client = new FakeCampaignClient();
    const session = await activeSession(factoryFor(client));
    const run = session.runCampaign();

    session.stop();
    expect(session.getState().campaign.phase).toBe('stopped');
    expect(session.getState().campaign.current).toBeUndefined();
    expect(client.cancel).not.toHaveBeenCalled();
    expect(client.terminate).toHaveBeenCalledOnce();
    client.completion.reject(new Error('PRIVATE_LATE_CAMPAIGN_FAILURE'));
    expect(await run).toBe(false);

    await session.start();
    expect(session.getState().campaign.phase).toBe('stopped');
    expect(JSON.stringify(session.getState())).not.toContain('PRIVATE_LATE_CAMPAIGN_FAILURE');
    session.stop();
  });

  it('marks seed edits stale without mutating settled evidence and clears staleness on restore', async () => {
    const client = new FakeCampaignClient();
    const session = await activeSession(factoryFor(client));
    const run = session.runCampaign();
    client.completion.resolve(completed);
    expect(await run).toBe(true);
    const settled = session.getState().campaign.current;

    session.setCampaignSeedsInput('3102');
    expect(session.getState().campaign.current).toBe(settled);
    expect(session.getState().campaign.resultSettingsStale).toBe(true);
    session.setCampaignSeedsInput('3101');
    expect(session.getState().campaign.current).toBe(settled);
    expect(session.getState().campaign.resultSettingsStale).toBe(false);
    session.stop();
  });
});
