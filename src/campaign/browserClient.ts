import TemporalCampaignWorker from '../workers/temporalCampaign.worker?worker&inline';
import {
  assertCampaignResult,
  assertCampaignSpec,
  stableCampaignStringify,
  verifyCampaignResultIntegrity,
} from './serialization';
import {
  CAMPAIGN_WORKER_PROTOCOL_VERSION,
  isCampaignWorkerResponse,
  type CampaignWorkerRequest,
  type CampaignWorkerResponse,
} from './worker-protocol';
import type { CampaignProgress, CampaignResult, CampaignSpec } from './types';

export interface CampaignWorkerLike {
  postMessage(message: CampaignWorkerRequest): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  addEventListener(type: 'error', listener: (event: ErrorEvent) => void): void;
  addEventListener(type: 'messageerror', listener: (event: MessageEvent<unknown>) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  removeEventListener(type: 'error', listener: (event: ErrorEvent) => void): void;
  removeEventListener(type: 'messageerror', listener: (event: MessageEvent<unknown>) => void): void;
  terminate(): void;
}

export type CampaignWorkerFactory = () => CampaignWorkerLike;

export interface BrowserCampaignRunOptions {
  requestId?: string | undefined;
  signal?: AbortSignal | undefined;
  onProgress?: ((progress: CampaignProgress) => void) | undefined;
}

export interface CampaignWorkerWatchdogOptions {
  runTimeoutMs?: number | undefined;
  cancelTimeoutMs?: number | undefined;
}

interface ActiveRun {
  requestId: string;
  campaignId: string;
  expectedTotalCases: number;
  submittedSpecJson: string;
  lastProgressCompletedCases: number;
  cancellationProgressSeen: boolean;
  onProgress: (progress: CampaignProgress) => void;
  resolve: (result: CampaignResult) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal | undefined;
  abortHandler?: (() => void) | undefined;
  runWatchdog?: ReturnType<typeof setTimeout> | undefined;
  cancelWatchdog?: ReturnType<typeof setTimeout> | undefined;
  cancelRequested: boolean;
  terminalResponsePending: boolean;
}

const DEFAULT_RUN_TIMEOUT_MS = 120_000;
const DEFAULT_CANCEL_TIMEOUT_MS = 5_000;

let requestSequence = 0;

function nextRequestId(): string {
  requestSequence += 1;
  return `temporal-campaign-${Date.now()}-${requestSequence}`;
}

function errorWithName(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

function positiveTimeout(value: number | undefined, fallback: number, name: string): number {
  const timeout = value ?? fallback;
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error(`${name} must be a positive finite number.`);
  }
  return timeout;
}

function normalizedError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function validateProgress(value: CampaignProgress, active: ActiveRun): void {
  if (
    typeof value.campaignId !== 'string' ||
    !Number.isInteger(value.completedCases) ||
    value.completedCases < 0 ||
    !Number.isInteger(value.totalCases) ||
    value.totalCases < 0 ||
    value.completedCases > value.totalCases
  ) {
    throw new Error('Malformed campaign progress response.');
  }
  if (value.campaignId !== active.campaignId) {
    throw new Error('Campaign progress campaignId does not match the submitted campaign.');
  }
  if (value.totalCases !== active.expectedTotalCases) {
    throw new Error('Campaign progress totalCases does not match the submitted campaign matrix.');
  }
  if (value.currentCaseId !== null && typeof value.currentCaseId !== 'string') {
    throw new Error('Malformed campaign progress currentCaseId.');
  }
  if (
    value.currentCaseStatus !== null &&
    !['completed', 'failed', 'cancelled'].includes(value.currentCaseStatus)
  ) {
    throw new Error('Malformed campaign progress currentCaseStatus.');
  }
  if (active.cancellationProgressSeen) {
    throw new Error('Campaign worker sent progress after reporting cancellation progress.');
  }
  if (value.completedCases < active.lastProgressCompletedCases) {
    throw new Error('Campaign progress completedCases regressed.');
  }

  if (value.currentCaseStatus === 'completed' || value.currentCaseStatus === 'failed') {
    if (value.currentCaseId === null) {
      throw new Error('Completed or failed campaign progress requires a currentCaseId.');
    }
    if (value.completedCases !== active.lastProgressCompletedCases + 1) {
      throw new Error('Campaign progress must advance exactly one processed case at a time.');
    }
  } else {
    if (value.completedCases !== active.lastProgressCompletedCases) {
      throw new Error('Noncommitting campaign progress cannot change the processed-case count.');
    }
    if (value.currentCaseStatus === null && value.currentCaseId !== null) {
      throw new Error('Campaign progress without a case status cannot identify a current case.');
    }
    if (value.currentCaseStatus === 'cancelled' && value.currentCaseId === null) {
      throw new Error('Cancelled campaign progress requires the uncommitted currentCaseId.');
    }
  }

  active.lastProgressCompletedCases = value.completedCases;
  if (value.currentCaseStatus === 'cancelled') active.cancellationProgressSeen = true;
}

function validateTerminalResult(result: CampaignResult, active: ActiveRun): void {
  if (result.campaignId !== active.campaignId) {
    throw new Error('Campaign worker result campaignId does not match the submitted campaign.');
  }
  if (stableCampaignStringify(result.spec) !== active.submittedSpecJson) {
    throw new Error('Campaign worker result spec does not match the submitted campaign spec.');
  }
}

function validateResponseDetails(response: CampaignWorkerResponse, active: ActiveRun): void {
  switch (response.type) {
    case 'campaign.progress':
      validateProgress(response.progress, active);
      break;
    case 'campaign.result':
      assertCampaignResult(response.result);
      validateTerminalResult(response.result, active);
      if (response.result.status === 'cancelled') {
        throw new Error('Campaign result response cannot carry a cancelled result.');
      }
      break;
    case 'campaign.cancelled':
      if (!Number.isInteger(response.completedCases) || response.completedCases < 0) {
        throw new Error('Malformed campaign cancellation response.');
      }
      assertCampaignResult(response.result);
      validateTerminalResult(response.result, active);
      if (
        response.result.status !== 'cancelled' ||
        response.result.summary.completedCases !== response.completedCases
      ) {
        throw new Error('Campaign cancellation result and completed-case evidence do not match.');
      }
      break;
    case 'campaign.error':
      if (
        typeof response.error.name !== 'string' ||
        response.error.name === '' ||
        typeof response.error.message !== 'string' ||
        response.error.message === ''
      ) {
        throw new Error('Malformed campaign error response.');
      }
      break;
  }
}

export class CampaignCancelledError extends Error {
  readonly completedCases: number;
  readonly partialResult: CampaignResult;

  constructor(partialResult: CampaignResult) {
    const completedCases = partialResult.summary.completedCases;
    super(
      `Temporal campaign was cancelled after ${completedCases} completed cases with ` +
        `${partialResult.summary.remainingCases} cases remaining.`,
    );
    this.name = 'CampaignCancelledError';
    this.completedCases = completedCases;
    this.partialResult = partialResult;
  }
}

export class TemporalCampaignBrowserClient {
  private worker: CampaignWorkerLike | null = null;
  private readonly factory: CampaignWorkerFactory;
  private readonly runTimeoutMs: number;
  private readonly cancelTimeoutMs: number;
  private active: ActiveRun | null = null;
  private terminated = false;
  private workerInitializationError: Error | null = null;

  private readonly messageListener = (event: MessageEvent<unknown>): void => {
    void this.handleResponse(event.data);
  };

  private readonly errorListener = (event: ErrorEvent): void => {
    const error =
      event.error instanceof Error
        ? event.error
        : new Error(event.message || 'Temporal campaign worker failed.');
    this.failActiveAndRecycle(error);
  };

  private readonly messageErrorListener = (): void => {
    this.failActiveAndRecycle(
      new Error('Temporal campaign worker response could not be deserialized.'),
    );
  };

  constructor(
    factory: CampaignWorkerFactory = () => new TemporalCampaignWorker(),
    watchdogs: CampaignWorkerWatchdogOptions = {},
  ) {
    this.factory = factory;
    this.runTimeoutMs = positiveTimeout(
      watchdogs.runTimeoutMs,
      DEFAULT_RUN_TIMEOUT_MS,
      'runTimeoutMs',
    );
    this.cancelTimeoutMs = positiveTimeout(
      watchdogs.cancelTimeoutMs,
      DEFAULT_CANCEL_TIMEOUT_MS,
      'cancelTimeoutMs',
    );
    this.attachWorker(this.factory());
  }

  run(spec: CampaignSpec, options: BrowserCampaignRunOptions = {}): Promise<CampaignResult> {
    if (this.terminated) {
      return Promise.reject(new Error('Temporal campaign browser client has been terminated.'));
    }
    if (this.active !== null) {
      return Promise.reject(new Error('Only one temporal campaign request may be active.'));
    }
    const requestId = options.requestId ?? nextRequestId();
    if (requestId.trim() === '') return Promise.reject(new Error('requestId must be nonempty.'));
    if (options.signal?.aborted) {
      return Promise.reject(
        errorWithName('AbortError', 'Temporal campaign was cancelled before start.'),
      );
    }

    let submittedSpecJson: string;
    try {
      assertCampaignSpec(spec);
      submittedSpecJson = stableCampaignStringify(spec);
    } catch (error) {
      return Promise.reject(normalizedError(error));
    }
    const submittedSpec = JSON.parse(submittedSpecJson) as CampaignSpec;
    const expectedTotalCases =
      submittedSpec.profiles.length * submittedSpec.scenarios.length * submittedSpec.seeds.length;

    let worker: CampaignWorkerLike;
    try {
      worker = this.requireWorker();
    } catch (error) {
      return Promise.reject(normalizedError(error));
    }

    return new Promise<CampaignResult>((resolve, reject) => {
      const active: ActiveRun = {
        requestId,
        campaignId: submittedSpec.campaignId,
        expectedTotalCases,
        submittedSpecJson,
        lastProgressCompletedCases: 0,
        cancellationProgressSeen: false,
        onProgress: options.onProgress ?? (() => undefined),
        resolve,
        reject,
        signal: options.signal,
        cancelRequested: false,
        terminalResponsePending: false,
      };
      if (options.signal) {
        active.abortHandler = () => {
          this.cancel();
        };
        options.signal.addEventListener('abort', active.abortHandler, { once: true });
      }
      this.active = active;
      active.runWatchdog = setTimeout(() => {
        if (this.active !== active || active.cancelRequested) return;
        this.failActiveAndRecycle(
          errorWithName(
            'TimeoutError',
            `Temporal campaign worker did not finish within ${this.runTimeoutMs} ms.`,
          ),
        );
      }, this.runTimeoutMs);
      try {
        worker.postMessage({
          protocolVersion: CAMPAIGN_WORKER_PROTOCOL_VERSION,
          type: 'campaign.run',
          requestId,
          spec: submittedSpec,
        });
      } catch (error) {
        this.failActiveAndRecycle(normalizedError(error));
      }
    });
  }

  cancel(): boolean {
    if (this.terminated || this.active === null) return false;
    const active = this.active;
    if (active.terminalResponsePending) return false;
    if (active.cancelRequested) return true;
    const worker = this.worker;
    if (worker === null) {
      this.rejectActive(new Error('Temporal campaign worker is unavailable.'));
      return false;
    }
    active.cancelRequested = true;
    if (active.runWatchdog !== undefined) {
      clearTimeout(active.runWatchdog);
      active.runWatchdog = undefined;
    }
    active.cancelWatchdog = setTimeout(() => {
      if (this.active !== active) return;
      this.failActiveAndRecycle(
        errorWithName(
          'TimeoutError',
          `Temporal campaign worker did not acknowledge cancellation within ${this.cancelTimeoutMs} ms.`,
        ),
      );
    }, this.cancelTimeoutMs);
    try {
      worker.postMessage({
        protocolVersion: CAMPAIGN_WORKER_PROTOCOL_VERSION,
        type: 'campaign.cancel',
        requestId: this.active.requestId,
      });
      return true;
    } catch (error) {
      this.failActiveAndRecycle(normalizedError(error));
      return false;
    }
  }

  terminate(): void {
    if (this.terminated) return;
    if (this.active) this.rejectActive(new Error('Temporal campaign worker was terminated.'));
    this.terminated = true;
    this.disposeWorker();
  }

  private async handleResponse(value: unknown): Promise<void> {
    if (!this.active) return;
    if (!isCampaignWorkerResponse(value)) {
      this.failActiveAndRecycle(new Error('Malformed campaign worker response.'));
      return;
    }
    if (value.requestId !== this.active.requestId) {
      this.failActiveAndRecycle(
        new Error('Campaign worker response requestId does not match the active run.'),
      );
      return;
    }
    const active = this.active;
    try {
      validateResponseDetails(value, active);
    } catch (error) {
      this.failActiveAndRecycle(normalizedError(error));
      return;
    }

    if (value.type !== 'campaign.progress') {
      if (active.terminalResponsePending) {
        this.failActiveAndRecycle(new Error('Campaign worker sent multiple terminal responses.'));
        return;
      }
      active.terminalResponsePending = true;
      if (value.type === 'campaign.result' || value.type === 'campaign.cancelled') {
        try {
          await verifyCampaignResultIntegrity(value.result);
        } catch (error) {
          if (this.active === active) this.failActiveAndRecycle(normalizedError(error));
          return;
        }
        if (this.active !== active) return;
      }
    } else if (active.terminalResponsePending) {
      this.failActiveAndRecycle(
        new Error('Campaign worker sent progress after a terminal response.'),
      );
      return;
    }

    switch (value.type) {
      case 'campaign.progress':
        try {
          this.active.onProgress(value.progress);
        } catch (error) {
          this.cancel();
          this.failActiveAndRecycle(normalizedError(error));
        }
        break;
      case 'campaign.result': {
        const { resolve } = this.active;
        this.releaseActive();
        resolve(value.result);
        break;
      }
      case 'campaign.cancelled':
        this.rejectActive(new CampaignCancelledError(value.result));
        break;
      case 'campaign.error':
        this.rejectActive(errorWithName(value.error.name, value.error.message));
        break;
    }
  }

  private rejectActive(error: Error): void {
    if (!this.active) return;
    const { reject } = this.active;
    this.releaseActive();
    reject(error);
  }

  private releaseActive(): void {
    const active = this.active;
    if (active?.signal && active.abortHandler) {
      active.signal.removeEventListener('abort', active.abortHandler);
    }
    if (active?.runWatchdog !== undefined) clearTimeout(active.runWatchdog);
    if (active?.cancelWatchdog !== undefined) clearTimeout(active.cancelWatchdog);
    this.active = null;
  }

  private failActiveAndRecycle(error: Error): void {
    this.rejectActive(error);
    if (!this.terminated) this.recycleWorker();
  }

  private attachWorker(worker: CampaignWorkerLike): void {
    this.worker = worker;
    worker.addEventListener('message', this.messageListener);
    worker.addEventListener('error', this.errorListener);
    worker.addEventListener('messageerror', this.messageErrorListener);
  }

  private disposeWorker(): void {
    const worker = this.worker;
    if (worker === null) return;
    worker.removeEventListener('message', this.messageListener);
    worker.removeEventListener('error', this.errorListener);
    worker.removeEventListener('messageerror', this.messageErrorListener);
    worker.terminate();
    this.worker = null;
  }

  private recycleWorker(): void {
    this.disposeWorker();
    try {
      this.attachWorker(this.factory());
      this.workerInitializationError = null;
    } catch (error) {
      this.workerInitializationError = normalizedError(error);
    }
  }

  private requireWorker(): CampaignWorkerLike {
    if (this.worker !== null) return this.worker;
    if (this.workerInitializationError !== null) {
      const error = this.workerInitializationError;
      this.workerInitializationError = null;
      throw error;
    }
    const worker = this.factory();
    this.attachWorker(worker);
    return worker;
  }
}
