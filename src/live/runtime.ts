import {
  LiveAirspaceClient,
  type LiveAirspaceClientOptions,
  type LiveTransportStatus,
} from './client';
import type { LiveStreamMessage } from './protocol';
import { getRegionConfig } from './regions';
import { LiveAirspaceSession, type LiveSessionOptions, type LiveSessionState } from './session';

export interface LiveClientControl {
  start(): void;
  stop(): void;
}

export type LiveClientFactory = (options: LiveAirspaceClientOptions) => LiveClientControl;
export type LiveStateSubscriber = (state: LiveSessionState) => void;

export interface LiveAirspaceRuntimeOptions {
  regionId: string;
  apiBaseUrl?: string;
  session?: Partial<LiveSessionOptions>;
  freshnessIntervalMs?: number;
  now?: () => number;
  clientFactory?: LiveClientFactory;
}

export class LiveAirspaceRuntime {
  private readonly options: LiveAirspaceRuntimeOptions;
  private readonly subscribers = new Set<LiveStateSubscriber>();
  private session: LiveAirspaceSession;
  private client: LiveClientControl;
  private freshnessTimer?: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(options: LiveAirspaceRuntimeOptions) {
    this.options = options;
    this.requireRegion(options.regionId);
    if ((options.freshnessIntervalMs ?? 1_000) < 250) {
      throw new RangeError('freshnessIntervalMs must be at least 250 milliseconds.');
    }
    this.session = new LiveAirspaceSession(options.regionId, options.session);
    this.client = this.createClient(options.regionId);
  }

  get state(): LiveSessionState {
    return this.session.state;
  }

  subscribe(subscriber: LiveStateSubscriber): () => void {
    this.subscribers.add(subscriber);
    subscriber(this.state);
    return () => this.subscribers.delete(subscriber);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.client.start();
    this.freshnessTimer = setInterval(
      () => this.refreshFreshness(),
      this.options.freshnessIntervalMs ?? 1_000,
    );
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.freshnessTimer) clearInterval(this.freshnessTimer);
    this.freshnessTimer = undefined;
    this.client.stop();
  }

  switchRegion(regionId: string): void {
    this.requireRegion(regionId);
    if (regionId === this.state.regionId) return;
    const wasRunning = this.running;
    if (wasRunning) this.client.stop();
    this.session = new LiveAirspaceSession(regionId, this.options.session);
    this.client = this.createClient(regionId);
    this.publish();
    if (wasRunning) this.client.start();
  }

  selectAircraft(aircraftId?: string): void {
    if (
      aircraftId &&
      !this.state.snapshot?.aircraft.some((aircraft) => aircraft.aircraftId === aircraftId) &&
      !this.state.trails.has(aircraftId)
    ) {
      return;
    }
    this.session.selectAircraft(aircraftId);
    this.publish();
  }

  private createClient(regionId: string): LiveClientControl {
    const factory = this.options.clientFactory ?? ((options) => new LiveAirspaceClient(options));
    return factory({
      regionId,
      ...(this.options.apiBaseUrl ? { apiBaseUrl: this.options.apiBaseUrl } : {}),
      onMessage: (message) => this.handleMessage(message),
      onStatus: (status) => this.handleStatus(status),
      onProtocolError: (errors) => {
        this.session.recordError(`Rejected live message: ${errors.join(' ')}`);
        this.publish();
      },
      onError: (message) => {
        this.session.recordError(message);
        this.publish();
      },
    });
  }

  private handleMessage(message: LiveStreamMessage): void {
    switch (message.type) {
      case 'airspace.snapshot':
        this.session.applySnapshot(message.snapshot);
        break;
      case 'feed.health':
        this.session.applyHealth(message.health);
        break;
      case 'error':
        if (message.recoverable) this.session.recordError(message.message);
        else this.session.markError(message.message);
        break;
      case 'hello':
        break;
    }
    this.publish();
  }

  private handleStatus(status: LiveTransportStatus): void {
    if (status === 'connecting') this.session.markConnecting();
    else if (status === 'reconnecting') this.session.markConnecting(true);
    else if (status === 'offline') {
      this.session.markOffline('The live stream is temporarily offline.');
    } else if (status === 'open') this.session.markConnected();
    this.publish();
  }

  private refreshFreshness(): void {
    const previous = this.state;
    this.session.evaluateFreshness((this.options.now ?? Date.now)());
    if (this.state !== previous) this.publish();
  }

  private publish(): void {
    for (const subscriber of this.subscribers) subscriber(this.state);
  }

  private requireRegion(regionId: string): void {
    if (!getRegionConfig(regionId))
      throw new RangeError(`Unknown live-airspace region: ${regionId}.`);
  }
}
