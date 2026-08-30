// @vitest-environment jsdom
import { act, useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CampaignCancelledError,
  type BrowserCampaignRunOptions,
} from '../../src/campaign/browserClient';
import { runCampaign as runCampaignDomain } from '../../src/campaign/runner';
import type { CampaignProgress, CampaignResult, CampaignSpec } from '../../src/campaign/types';
import { CampaignView } from '../../src/features/lab/CampaignView';
import { prepareCampaignRun } from '../../src/features/lab/campaign';
import { LabSession, type LabCampaignClient } from '../../src/features/lab/session';

const ui = vi.hoisted(() => ({ download: vi.fn() }));
vi.mock('../../src/ui/dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/ui/dom')>()),
  downloadText: ui.download,
}));

const NOW = '2026-08-29T12:00:00.000Z';
const buildIdentity = {
  applicationVersion: '3.0.0-test',
  releaseSha: 'campaign-view-test',
  releaseStatus: 'unreleased',
  buildTarget: 'mock-staging',
} as const;

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

  progress(progress: CampaignProgress): void {
    this.options?.onProgress?.(progress);
  }
}

async function makeResult(cancelAfter?: number): Promise<CampaignResult> {
  const prepared = prepareCampaignRun({ seedsInput: '3101' }, NOW);
  const controller = new AbortController();
  return runCampaignDomain(
    prepared.spec,
    {
      buildScenario: (context) => ({ input: context.caseId }),
      evaluateScenario: (_scenario, context) => ({
        detections: [],
        calibration: [],
        syntheticDurationMs: context.scenario.syntheticDurationMs,
      }),
    },
    {
      signal: controller.signal,
      onProgress: (progress) => {
        if (cancelAfter !== undefined && progress.completedCases === cancelAfter) {
          controller.abort('Campaign View cancellation fixture');
        }
      },
    },
  );
}

let completed: CampaignResult;
let cancelled: CampaignResult;
let root: Root;
let container: HTMLDivElement;
let session: LabSession;
let client: FakeCampaignClient;
let factory: ReturnType<typeof vi.fn<() => LabCampaignClient>>;

beforeAll(async () => {
  [completed, cancelled] = await Promise.all([makeResult(), makeResult(1)]);
});

beforeEach(async () => {
  vi.resetAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('React Campaign must not fetch data.');
    }),
  );
  client = new FakeCampaignClient();
  factory = vi.fn(() => client);
  session = new LabSession({ campaignClientFactory: factory, now: () => NOW });
  await session.start();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  function Harness() {
    const state = useSyncExternalStore(session.subscribe, session.getState);
    return <CampaignView state={state} session={session} buildIdentity={buildIdentity} />;
  }
  await act(async () => root.render(<Harness />));
});

afterEach(async () => {
  session.stop();
  await act(async () => root.unmount());
  container.remove();
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

function button(name: string): HTMLButtonElement {
  const match = [...container.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === name,
  );
  expect(match, name).toBeDefined();
  return match!;
}

async function click(name: string): Promise<void> {
  await act(async () => button(name).click());
}

async function setSeeds(value: string): Promise<void> {
  const input = container.querySelector<HTMLInputElement>('#campaign-seeds')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  expect(setter).toBeDefined();
  await act(async () => {
    setter!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function completeRun(): Promise<void> {
  await setSeeds('3101');
  await click('Run Campaign');
  await act(async () => {
    client.completion.resolve(completed);
    await vi.waitFor(() => expect(session.getState().campaign.phase).toBe('completed'));
  });
}

describe('React Campaign view', () => {
  it('renders exact bounded defaults and rejects malformed seeds before worker creation', async () => {
    expect(container.querySelector('#campaign-status')?.textContent).toBe('Not run');
    expect(container.textContent).toContain('3 seeds × 31 scenarios = 93 planned cases');
    expect(container.textContent).toContain('generic-fixed-wing@1.0.0');
    expect(button('Cancel Campaign').disabled).toBe(true);
    expect(button('Export minimized Campaign JSON').disabled).toBe(true);

    await setSeeds('3101,,3102');
    expect(container.textContent).toContain('Campaign seed entry 2 cannot be empty');
    expect(button('Run Campaign').disabled).toBe(true);
    expect(factory).not.toHaveBeenCalled();
  });

  it('renders processed progress, terminal metrics, coverage, groups, and exact identity', async () => {
    await setSeeds('3101');
    await click('Run Campaign');
    act(() =>
      client.progress({
        campaignId: completed.campaignId,
        completedCases: 7,
        totalCases: 31,
        currentCaseId: completed.cases[6]!.caseId,
        currentCaseStatus: 'completed',
      }),
    );
    expect(container.querySelector('#campaign-progress-label')?.textContent).toContain(
      'Processed 7 of 31',
    );

    await act(async () => {
      client.completion.resolve(completed);
      await vi.waitFor(() => expect(session.getState().campaign.phase).toBe('completed'));
    });

    expect(container.querySelector('#campaign-status')?.textContent).toBe('Completed');
    expect(
      container.querySelectorAll('[aria-label="Campaign scenario coverage table"] tbody tr'),
    ).toHaveLength(31);
    expect(container.textContent).toContain('Matched opportunities');
    expect(container.textContent).toContain('Bootstrap intervals');
    expect(container.textContent).toContain(completed.replayManifest.specSha256);
    expect(container.textContent).toContain('No contained case failures');
    expect(client.terminate).toHaveBeenCalledOnce();
  });

  it('distinguishes graceful cancellation and retains verified partial evidence', async () => {
    await setSeeds('3101');
    await click('Run Campaign');
    await click('Cancel Campaign');
    expect(container.querySelector('#campaign-status')?.textContent).toBe('Cancelling');

    await act(async () => {
      client.completion.reject(new CampaignCancelledError(cancelled));
      await vi.waitFor(() => expect(session.getState().campaign.phase).toBe('cancelled'));
    });

    expect(container.querySelector('#campaign-status')?.textContent).toBe(
      'Cancelled with partial evidence',
    );
    expect(container.textContent).toContain('verified partial evidence for 1 processed cases');
    expect(button('Export minimized Campaign JSON').disabled).toBe(false);
  });

  it('exports a schema-versioned privacy-minimized report without raw or per-case success data', async () => {
    await completeRun();
    await click('Export minimized Campaign JSON');
    await vi.waitFor(() => expect(ui.download).toHaveBeenCalledOnce());

    const [filename, serialized, mediaType] = ui.download.mock.calls[0]!;
    expect(filename).toMatch(/^temporal-campaign-.*\.json$/u);
    expect(mediaType).toBe('application/json');
    const report = JSON.parse(serialized as string) as Record<string, unknown>;
    expect(report).toMatchObject({
      reportSchemaVersion: 'campaign-report.v1',
      buildIdentities: { reactShell: buildIdentity },
      terminal: { status: 'completed' },
      exportPolicy: {
        sourceDataIncluded: false,
        samplesIncluded: false,
        successfulCaseRowsIncluded: false,
        detectionsIncluded: false,
        calibrationObservationsIncluded: false,
        replayManifestCasesIncluded: false,
        browserStateIncluded: false,
        endpointsIncluded: false,
      },
    });
    const serializedReport = JSON.stringify(report);
    for (const forbidden of [
      '"samples"',
      '"cases"',
      '"detections"',
      '"calibrationObservations"',
      '"replayManifest"',
      '"endpoints"',
    ]) {
      expect(serializedReport).not.toContain(forbidden);
    }
  });

  it('retains settled evidence under stale controls without storage or data-plane access', async () => {
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    await completeRun();
    const settled = session.getState().campaign.current;

    await setSeeds('3102');
    expect(session.getState().campaign.current).toBe(settled);
    expect(container.textContent).toContain('settled snapshot from different seed controls');
    expect(storage).not.toHaveBeenCalled();
  });
});
