import {
  LiveAirspaceClient,
  type LiveAirspaceClientOptions,
  type LiveTransportStatus,
} from './client';
import { LiveServerClock } from './clock';
import type { LiveFeedBinding } from './types';
import type { LiveStreamMessage } from './protocol';
import { getRegionConfig } from './regions';
import { LiveAirspaceSession, type LiveSessionOptions, type LiveSessionState } from './session';
import { isSafeInteger } from './validation';

export interface LiveClientControl {
  start(): void;
  stop(): void;
}

export type LiveClientFactory = (options: LiveAirspaceClientOptions) => LiveClientControl;
export type LiveStateSubscriber = (state: LiveSessionState) => void;

export interface LiveAirspaceRuntimeOptions {
  regionId: string;
  providerId?: string;
  apiBaseUrl?: string;
  session?: Partial<LiveSessionOptions>;
  freshnessIntervalMs?: number;
  clock?: LiveServerClock;
  clientFactory?: LiveClientFactory;
}

interface RuntimeActivation {
  generation: number;
  session: LiveAirspaceSession;
  client?: LiveClientControl | undefined;
  freshnessTimer?: ReturnType<typeof setInterval> | undefined;
}

interface CleanupFailure {
  error: unknown;
}

export class LiveAirspaceRuntime {
  private readonly options: LiveAirspaceRuntimeOptions;
  private readonly subscribers = new Set<LiveStateSubscriber>();
  private readonly freshnessIntervalMs: number;
  private readonly clock: LiveServerClock;
  private session: LiveAirspaceSession;
  private activation?: RuntimeActivation | undefined;
  private running = false;
  private generation = 0;

  constructor(options: LiveAirspaceRuntimeOptions) {
    this.options = {
      ...options,
      ...(options.session ? { session: { ...options.session } } : {}),
    };
    this.requireRegion(options.regionId);
    this.clock = options.clock ?? new LiveServerClock();
    this.freshnessIntervalMs = options.freshnessIntervalMs ?? 1_000;
    if (!isSafeInteger(this.freshnessIntervalMs, 250, 2_147_483_647)) {
      throw new RangeError(
        'freshnessIntervalMs must be a timer-safe integer of at least 250 milliseconds.',
      );
    }
    this.session = new LiveAirspaceSession(
      options.regionId,
      this.options.session,
      options.providerId,
      () => this.clock.read(),
    );
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
    this.clock.invalidate();
    this.session.clear();
    this.running = true;
    this.activate(this.session, ++this.generation);
  }

  stop(): void {
    if (!this.running && !this.activation) return;
    this.running = false;
    const generation = ++this.generation;
    const session = this.session;
    const previous = this.activation;
    this.activation = undefined;
    this.clock.invalidate();
    session.clear();
    const failure = this.release(previous);
    if (failure) this.reportLifecycleFailure(session, generation, failure.error);
    else if (this.isCurrentTransition(session, generation)) this.publish();
  }

  switchRegion(regionId: string): void {
    this.requireRegion(regionId);
    if (regionId === this.state.regionId) return;
    this.clock.invalidate();
    const session = new LiveAirspaceSession(
      regionId,
      this.options.session,
      this.options.providerId,
      () => this.clock.read(),
    );
    const generation = ++this.generation;
    const previous = this.activation;
    this.activation = undefined;
    this.session = session;
    const failure = this.release(previous);
    if (!this.isCurrentTransition(session, generation)) return;
    if (failure) {
      this.running = false;
      this.reportLifecycleFailure(session, generation, failure.error);
      return;
    }
    this.publish();
    if (this.running && this.isCurrentTransition(session, generation)) {
      this.activate(session, generation);
    }
  }

  selectAircraft(aircraftId?: string): void {
    if (
      aircraftId &&
      !this.state.snapshot?.aircraft.some((aircraft) => aircraft.aircraftId === aircraftId) &&
      !this.state.histories.has(aircraftId)
    ) {
      return;
    }
    this.session.selectAircraft(aircraftId);
    this.publish();
  }

  selectHistorySample(
    aircraftId: string,
    sequence: number,
    expectedBinding: Readonly<LiveFeedBinding>,
  ): void {
    const previous = this.state;
    this.session.selectHistorySample(aircraftId, sequence, expectedBinding);
    if (this.state !== previous) this.publish();
  }

  private activate(session: LiveAirspaceSession, generation: number): void {
    if (!this.running || !this.isCurrentTransition(session, generation)) return;
    const activation: RuntimeActivation = { session, generation };
    this.activation = activation;
    try {
      activation.client = this.createClient(activation);
      if (!this.owns(activation)) {
        // Superseded construction must release its client without publishing into the new session.
        this.release(activation);
        return;
      }
      activation.freshnessTimer = setInterval(() => {
        if (this.owns(activation)) this.refreshFreshness(session);
      }, this.freshnessIntervalMs);
      activation.client.start();
    } catch (error) {
      if (!this.owns(activation)) return;
      this.running = false;
      this.activation = undefined;
      const failureGeneration = ++this.generation;
      const cleanupFailure = this.release(activation);
      this.reportLifecycleFailure(session, failureGeneration, error, cleanupFailure);
    }
  }

  private isCurrentTransition(session: LiveAirspaceSession, generation: number): boolean {
    return this.session === session && this.generation === generation;
  }

  private owns(activation: RuntimeActivation): boolean {
    return (
      this.running &&
      this.activation === activation &&
      this.isCurrentTransition(activation.session, activation.generation)
    );
  }

  private release(activation?: RuntimeActivation): CleanupFailure | undefined {
    if (!activation) return undefined;
    if (activation.freshnessTimer !== undefined) clearInterval(activation.freshnessTimer);
    activation.freshnessTimer = undefined;
    const client = activation.client;
    activation.client = undefined;
    try {
      client?.stop();
      return undefined;
    } catch (error) {
      return { error };
    }
  }

  private reportLifecycleFailure(
    session: LiveAirspaceSession,
    generation: number,
    error: unknown,
    cleanupFailure?: CleanupFailure,
  ): void {
    if (!this.isCurrentTransition(session, generation)) return;
    const message = error instanceof Error ? error.message : 'The live transport lifecycle failed.';
    session.markError(
      cleanupFailure ? message + ' The transport also failed to stop normally.' : message,
    );
    this.publish();
  }

  private createClient(activation: RuntimeActivation): LiveClientControl {
    const factory = this.options.clientFactory ?? ((options) => new LiveAirspaceClient(options));
    const { session } = activation;
    const acceptsCallback = () => this.owns(activation) && activation.client !== undefined;
    return factory({
      regionId: session.state.regionId,
      ...(this.options.providerId ? { providerId: this.options.providerId } : {}),
      ...(this.options.apiBaseUrl ? { apiBaseUrl: this.options.apiBaseUrl } : {}),
      readClock: () => this.clock.read(),
      onFeedBinding: (binding) => {
        if (!acceptsCallback()) return;
        this.bindFeed(session, binding);
      },
      onTimeSample: (sample) => {
        if (!acceptsCallback() || !session.state.binding) return;
        this.clock.synchronize(sample);
        session.updateTime(this.clock.estimate(sample.received));
        this.publish();
      },
      onMessage: (message) => {
        if (acceptsCallback()) this.handleMessage(session, message);
      },
      onStatus: (status) => {
        if (acceptsCallback()) this.handleStatus(session, status);
      },
      onProtocolError: (errors) => {
        if (!acceptsCallback()) return;
        session.recordError(`Rejected live message: ${errors.join(' ')}`);
        this.publish();
      },
      onError: (message) => {
        if (!acceptsCallback()) return;
        session.recordError(message);
        this.publish();
      },
    });
  }

  private handleMessage(session: LiveAirspaceSession, message: LiveStreamMessage): void {
    switch (message.type) {
      case 'airspace.snapshot':
        session.applySnapshot(message.snapshot);
        break;
      case 'feed.health':
        session.applyHealth(message.health);
        break;
      case 'error':
        if (message.recoverable) session.recordError(message.message);
        else session.markError(message.message);
        break;
      case 'hello':
        this.bindFeed(session, message);
        break;
      case 'pong':
        break;
    }
    this.publish();
  }

  private bindFeed(session: LiveAirspaceSession, binding: LiveFeedBinding): void {
    if (session.beginFeed(binding)) {
      this.clock.invalidate();
      this.publish();
    }
  }

  private handleStatus(session: LiveAirspaceSession, status: LiveTransportStatus): void {
    if (status === 'stopped') {
      this.stop();
      return;
    }
    if (status === 'connecting') session.markConnecting();
    else if (status === 'reconnecting') session.markConnecting(true);
    else if (status === 'offline') {
      session.markOffline('The live stream is temporarily offline.');
    } else if (status === 'open') session.markConnected();
    this.publish();
  }

  private refreshFreshness(session: LiveAirspaceSession): void {
    const previous = session.state;
    session.updateTime(this.clock.estimate());
    if (session.state !== previous) this.publish();
  }

  private publish(): void {
    const state = this.state;
    const generation = this.generation;
    for (const subscriber of [...this.subscribers]) {
      if (this.state !== state || this.generation !== generation) break;
      if (this.subscribers.has(subscriber)) subscriber(state);
    }
  }

  private requireRegion(regionId: string): void {
    if (!getRegionConfig(regionId))
      throw new RangeError(`Unknown live-airspace region: ${regionId}.`);
  }
}
