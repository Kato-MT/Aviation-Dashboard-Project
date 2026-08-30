import {
  BrowserDemoAdapter,
  type BrowserDemoOptions,
  type DemoAdapterEvent,
  type DemoAdapterListener,
  type SyntheticStreamSource,
} from '../../streaming/browserDemoAdapter';
import {
  StreamHealthMonitor,
  type ConnectionStatus,
  type HealthMonitorOptions,
  type SourceHealth,
} from '../../streaming/health';

export type ConfigurationSimulatorPhase =
  'idle' | 'running' | 'degraded' | 'stale' | 'complete' | 'stopped' | 'failed';

export interface ConfigurationSimulatorAggregate {
  sources: number;
  messages: number;
  dropped: number;
  heartbeatAgeMs: number | null;
  queue: number;
  reconnects: number;
}

export interface ConfigurationSimulatorSourceHealth {
  sourceId: string;
  status: ConnectionStatus;
  receivedMessages: number;
  duplicateMessages: number;
  outOfOrderMessages: number;
  missingMessages: number;
  remoteQueueDepth: number;
  remoteDroppedMessages: number;
  localDroppedMessages: number;
  reconnectAttempts: number;
  heartbeatAgeMs?: number;
}

export interface ConfigurationSimulatorSnapshot {
  phase: ConfigurationSimulatorPhase;
  aggregate: Readonly<ConfigurationSimulatorAggregate>;
  sourceHealth: readonly Readonly<ConfigurationSimulatorSourceHealth>[];
  injectedFaultIds: readonly string[];
  terminalIssue: string | null;
}

export interface ConfigurationDemo {
  subscribe(listener: DemoAdapterListener): () => void;
  start(): void;
  stop(): void;
  dispose?(): void;
}

type ObservedMessage = Extract<DemoAdapterEvent, { type: 'message' }>['message'];

export interface ConfigurationHealth {
  observe(message: ObservedMessage, receivedAt?: number): SourceHealth;
  snapshot(now?: number): SourceHealth[];
}

export interface ConfigurationSimulatorDependencies {
  createDemo?: (options: BrowserDemoOptions) => ConfigurationDemo;
  createHealth?: (options: HealthMonitorOptions) => ConfigurationHealth;
  now?: () => number;
}

const DEFAULT_SOURCES: readonly Readonly<SyntheticStreamSource>[] = Object.freeze([
  Object.freeze({
    sourceId: 'demo-alpha',
    profileId: 'generic-fixed-wing.synthetic.v1',
    phase: 0,
  }),
  Object.freeze({
    sourceId: 'demo-bravo',
    profileId: 'generic-rotary-wing.synthetic.v1',
    phase: 1.7,
  }),
]);

export const CONFIGURATION_SIMULATOR_CONTRACT = Object.freeze({
  seed: 20_260_717,
  sources: DEFAULT_SOURCES,
  samplesPerSource: 160,
  sampleIntervalMs: 150,
  queueCapacity: 64,
  heartbeatEvery: 8,
  staleAfterMs: 2_500,
  disconnectedAfterMs: 7_500,
  startTime: '2026-01-01T00:00:00.000Z',
});

const MAX_RETAINED_SOURCES = 16;
const MAX_RETAINED_FAULT_IDS = 32;
const MAX_SOURCE_ID_LENGTH = 128;
const MAX_FAULT_ID_LENGTH = 64;
const MAX_TERMINAL_ISSUE_LENGTH = 500;
const FAULT_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

const EMPTY_AGGREGATE: Readonly<ConfigurationSimulatorAggregate> = Object.freeze({
  sources: 0,
  messages: 0,
  dropped: 0,
  heartbeatAgeMs: null,
  queue: 0,
  reconnects: 0,
});

function freezeSnapshot(
  phase: ConfigurationSimulatorPhase,
  aggregate: ConfigurationSimulatorAggregate = EMPTY_AGGREGATE,
  sourceHealth: ConfigurationSimulatorSourceHealth[] = [],
  injectedFaultIds: string[] = [],
  terminalIssue: string | null = null,
): Readonly<ConfigurationSimulatorSnapshot> {
  const frozenSources = Object.freeze(sourceHealth.map((source) => Object.freeze({ ...source })));
  return Object.freeze({
    phase,
    aggregate: Object.freeze({ ...aggregate }),
    sourceHealth: frozenSources,
    injectedFaultIds: Object.freeze([...injectedFaultIds]),
    terminalIssue,
  });
}

function boundedCounter(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(value)));
}

function boundedSourceId(value: string): string {
  return value.slice(0, MAX_SOURCE_ID_LENGTH);
}

function issueText(error: unknown, fallback: string): string {
  const detail = error instanceof Error ? error.message.trim() : '';
  return (detail ? `${fallback} ${detail}` : fallback).slice(0, MAX_TERMINAL_ISSUE_LENGTH);
}

function combineIssues(...issues: Array<string | undefined>): string | undefined {
  const combined = issues.filter((issue): issue is string => Boolean(issue)).join(' ');
  return combined ? combined.slice(0, MAX_TERMINAL_ISSUE_LENGTH) : undefined;
}

function toRetainedHealth(sources: SourceHealth[]): ConfigurationSimulatorSourceHealth[] {
  return sources
    .slice(0, MAX_RETAINED_SOURCES)
    .map((source) => ({
      sourceId: boundedSourceId(source.sourceId),
      status: source.status,
      receivedMessages: boundedCounter(source.receivedMessages),
      duplicateMessages: boundedCounter(source.duplicateMessages),
      outOfOrderMessages: boundedCounter(source.outOfOrderMessages),
      missingMessages: boundedCounter(source.missingMessages),
      remoteQueueDepth: boundedCounter(source.remoteQueueDepth),
      remoteDroppedMessages: boundedCounter(source.remoteDroppedMessages),
      localDroppedMessages: boundedCounter(source.localDroppedMessages),
      reconnectAttempts: boundedCounter(source.reconnectAttempts),
      ...(source.heartbeatAgeMs === undefined
        ? {}
        : { heartbeatAgeMs: boundedCounter(source.heartbeatAgeMs) }),
    }))
    .sort((left, right) => left.sourceId.localeCompare(right.sourceId));
}

/**
 * Owns one deterministic in-browser simulator at a time and exposes only bounded health evidence.
 * Raw protocol messages are observed and immediately discarded.
 */
export class ConfigurationSimulatorController {
  private readonly createDemo: (options: BrowserDemoOptions) => ConfigurationDemo;
  private readonly createHealth: (options: HealthMonitorOptions) => ConfigurationHealth;
  private readonly now: () => number;
  private readonly listeners = new Set<() => void>();
  private state: Readonly<ConfigurationSimulatorSnapshot> = freezeSnapshot('idle');
  private generation = 0;
  private activeGeneration: number | undefined;
  private activeDemo: ConfigurationDemo | undefined;
  private unsubscribeDemo: (() => void) | undefined;
  private health: ConfigurationHealth | undefined;
  private healthTimer: ReturnType<typeof setInterval> | undefined;
  private adapterDroppedMessages = 0;
  private adapterQueueDepth = 0;
  private adapterReconnects = 0;
  private transportDegraded = false;
  private readonly injectedFaultIds = new Set<string>();
  private disposed = false;
  private suppressNotifications = false;
  private notificationPending = false;

  constructor(dependencies: ConfigurationSimulatorDependencies = {}) {
    this.createDemo = dependencies.createDemo ?? ((options) => new BrowserDemoAdapter(options));
    this.createHealth =
      dependencies.createHealth ?? ((options) => new StreamHealthMonitor(options));
    this.now = dependencies.now ?? (() => Date.now());
  }

  readonly getState = (): Readonly<ConfigurationSimulatorSnapshot> => this.state;

  readonly subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  start(): void {
    if (this.disposed || this.activeDemo !== undefined) return;

    const generation = ++this.generation;
    this.activeGeneration = generation;
    this.resetRunEvidence();
    this.suppressNotifications = true;
    this.publish(freezeSnapshot('running'));

    try {
      this.health = this.createHealth({
        staleAfterMs: CONFIGURATION_SIMULATOR_CONTRACT.staleAfterMs,
        disconnectedAfterMs: CONFIGURATION_SIMULATOR_CONTRACT.disconnectedAfterMs,
      });
      const demo = this.createDemo(this.demoOptions());
      this.activeDemo = demo;
      const subscription: { unsubscribe?: () => void } = {};
      this.unsubscribeDemo = () => subscription.unsubscribe?.();
      const subscribedUnsubscribe = demo.subscribe((event) => this.handleEvent(generation, event));
      subscription.unsubscribe = subscribedUnsubscribe;
      if (!this.isCurrent(generation)) {
        subscribedUnsubscribe();
        return;
      }
      this.unsubscribeDemo = subscribedUnsubscribe;
      demo.start();

      if (this.isCurrent(generation)) {
        this.healthTimer = setInterval(
          () => this.refreshHealthSafely(generation),
          CONFIGURATION_SIMULATOR_CONTRACT.sampleIntervalMs,
        );
        this.refreshHealth(generation);
      }
    } catch (error) {
      if (this.activeGeneration === generation) {
        const cleanupIssue = this.releaseActive();
        this.publish(
          freezeSnapshot(
            'failed',
            this.state.aggregate,
            [...this.state.sourceHealth],
            [...this.state.injectedFaultIds],
            combineIssues(
              issueText(error, 'The in-browser simulator could not start.'),
              cleanupIssue,
            ) ?? 'The in-browser simulator could not start.',
          ),
        );
      }
    } finally {
      this.suppressNotifications = false;
      if (this.notificationPending) {
        this.notificationPending = false;
        this.emit();
      }
    }
  }

  stop(): void {
    if (this.disposed) return;
    const cleanupIssue = this.releaseActive();
    this.publishTerminal(cleanupIssue ? 'failed' : 'stopped', cleanupIssue ?? null);
  }

  dispose(): void {
    if (this.disposed) return;
    const cleanupIssue = this.releaseActive();
    this.disposed = true;
    this.publishTerminal(cleanupIssue ? 'failed' : 'stopped', cleanupIssue ?? null);
    this.listeners.clear();
  }

  private demoOptions(): BrowserDemoOptions {
    return {
      seed: CONFIGURATION_SIMULATOR_CONTRACT.seed,
      sources: CONFIGURATION_SIMULATOR_CONTRACT.sources.map((source) => ({ ...source })),
      samplesPerSource: CONFIGURATION_SIMULATOR_CONTRACT.samplesPerSource,
      sampleIntervalMs: CONFIGURATION_SIMULATOR_CONTRACT.sampleIntervalMs,
      queueCapacity: CONFIGURATION_SIMULATOR_CONTRACT.queueCapacity,
      heartbeatEvery: CONFIGURATION_SIMULATOR_CONTRACT.heartbeatEvery,
      startTime: CONFIGURATION_SIMULATOR_CONTRACT.startTime,
    };
  }

  private resetRunEvidence(): void {
    this.health = undefined;
    this.adapterDroppedMessages = 0;
    this.adapterQueueDepth = 0;
    this.adapterReconnects = 0;
    this.transportDegraded = false;
    this.injectedFaultIds.clear();
  }

  private handleEvent(generation: number, event: DemoAdapterEvent): void {
    if (!this.isCurrent(generation)) return;
    try {
      switch (event.type) {
        case 'message':
          this.rememberFaultIds(event.injectedFaults);
          this.health?.observe(event.message, this.now());
          if (event.message.type === 'heartbeat') this.adapterQueueDepth = 0;
          this.refreshHealth(generation);
          break;
        case 'queue-pressure':
          this.adapterDroppedMessages = Math.max(
            this.adapterDroppedMessages,
            boundedCounter(event.totalDropped),
          );
          this.adapterQueueDepth = boundedCounter(event.depth);
          this.transportDegraded = true;
          this.refreshHealth(generation);
          break;
        case 'disconnect':
          this.adapterReconnects = boundedCounter(this.adapterReconnects + 1);
          this.transportDegraded = true;
          this.refreshHealth(generation);
          break;
        case 'complete':
          this.complete(generation);
          break;
      }
    } catch (error) {
      this.failActive(generation, error);
    }
  }

  private rememberFaultIds(ids: string[]): void {
    for (const value of ids) {
      if (this.injectedFaultIds.size >= MAX_RETAINED_FAULT_IDS) return;
      const id = value.trim();
      if (id.length > 0 && id.length <= MAX_FAULT_ID_LENGTH && FAULT_ID_PATTERN.test(id)) {
        this.injectedFaultIds.add(id);
      }
    }
  }

  private refreshHealthSafely(generation: number): void {
    if (!this.isCurrent(generation)) return;
    try {
      this.refreshHealth(generation);
    } catch (error) {
      this.failActive(generation, error);
    }
  }

  private refreshHealth(generation: number): void {
    if (!this.isCurrent(generation)) return;
    const sourceHealth = toRetainedHealth(this.health?.snapshot(this.now()) ?? []);
    const messages = sourceHealth.reduce((total, source) => total + source.receivedMessages, 0);
    const localDrops = sourceHealth.reduce(
      (total, source) => total + source.localDroppedMessages,
      0,
    );
    const maximumRemoteDrops = sourceHealth.reduce(
      (maximum, source) => Math.max(maximum, source.remoteDroppedMessages),
      0,
    );
    const maximumRemoteQueue = sourceHealth.reduce(
      (maximum, source) => Math.max(maximum, source.remoteQueueDepth),
      0,
    );
    const sourceReconnects = sourceHealth.reduce(
      (total, source) => total + source.reconnectAttempts,
      0,
    );
    const heartbeatAges = sourceHealth.flatMap((source) =>
      source.heartbeatAgeMs === undefined ? [] : [source.heartbeatAgeMs],
    );

    // BrowserDemoAdapter reports one shared queue counter on every source heartbeat.
    // Taking the maximum prevents that shared counter from being counted once per source.
    const sharedQueueDrops = Math.max(this.adapterDroppedMessages, maximumRemoteDrops);
    const aggregate: ConfigurationSimulatorAggregate = {
      sources: sourceHealth.length,
      messages: boundedCounter(messages),
      dropped: boundedCounter(sharedQueueDrops + localDrops),
      heartbeatAgeMs: heartbeatAges.length ? Math.max(...heartbeatAges) : null,
      queue: Math.max(this.adapterQueueDepth, maximumRemoteQueue),
      reconnects: Math.max(this.adapterReconnects, boundedCounter(sourceReconnects)),
    };
    const faultIds = [...this.injectedFaultIds];
    const phase = this.derivePhase(sourceHealth, aggregate, faultIds);
    this.publish(freezeSnapshot(phase, aggregate, sourceHealth, faultIds));
  }

  private derivePhase(
    sourceHealth: ConfigurationSimulatorSourceHealth[],
    aggregate: ConfigurationSimulatorAggregate,
    faultIds: string[],
  ): ConfigurationSimulatorPhase {
    if (
      sourceHealth.some((source) => source.status === 'stale' || source.status === 'disconnected')
    ) {
      return 'stale';
    }
    if (
      this.transportDegraded ||
      aggregate.dropped > 0 ||
      faultIds.length > 0 ||
      sourceHealth.some(
        (source) =>
          source.status === 'degraded' ||
          source.duplicateMessages > 0 ||
          source.outOfOrderMessages > 0 ||
          source.missingMessages > 0,
      )
    ) {
      return 'degraded';
    }
    return 'running';
  }

  private complete(generation: number): void {
    if (!this.isCurrent(generation)) return;
    const cleanupIssue = this.releaseActive();
    this.publishTerminal(cleanupIssue ? 'failed' : 'complete', cleanupIssue ?? null);
  }

  private failActive(generation: number, error: unknown): void {
    if (!this.isCurrent(generation)) return;
    const cleanupIssue = this.releaseActive();
    this.publishTerminal(
      'failed',
      combineIssues(
        issueText(error, 'The in-browser simulator stopped after a runtime failure.'),
        cleanupIssue,
      ) ?? 'The in-browser simulator stopped after a runtime failure.',
    );
  }

  private publishTerminal(
    phase: Extract<ConfigurationSimulatorPhase, 'complete' | 'stopped' | 'failed'>,
    terminalIssue: string | null,
  ): void {
    this.publish(
      freezeSnapshot(
        phase,
        { ...this.state.aggregate, queue: 0 },
        [...this.state.sourceHealth],
        [...this.state.injectedFaultIds],
        terminalIssue,
      ),
    );
  }

  /** Invalidation must happen before listener removal and adapter teardown. */
  private releaseActive(): string | undefined {
    this.generation += 1;
    this.activeGeneration = undefined;

    const unsubscribe = this.unsubscribeDemo;
    const demo = this.activeDemo;
    const timer = this.healthTimer;
    this.unsubscribeDemo = undefined;
    this.activeDemo = undefined;
    this.health = undefined;
    this.healthTimer = undefined;

    let unsubscribeIssue: string | undefined;
    let teardownIssue: string | undefined;
    try {
      unsubscribe?.();
    } catch (error) {
      unsubscribeIssue = issueText(error, 'The simulator listener could not be released.');
    }

    try {
      if (demo?.dispose) demo.dispose();
      else demo?.stop();
    } catch (error) {
      teardownIssue = issueText(error, 'The simulator could not be released.');
    }

    if (timer !== undefined) clearInterval(timer);
    return combineIssues(unsubscribeIssue, teardownIssue);
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && this.activeGeneration === generation && this.activeDemo !== undefined;
  }

  private publish(snapshot: Readonly<ConfigurationSimulatorSnapshot>): void {
    this.state = snapshot;
    if (this.suppressNotifications) {
      this.notificationPending = true;
      return;
    }
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export function createConfigurationSimulatorController(
  dependencies: ConfigurationSimulatorDependencies = {},
): ConfigurationSimulatorController {
  return new ConfigurationSimulatorController(dependencies);
}
