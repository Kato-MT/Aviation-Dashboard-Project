import { BoundedQueue } from './boundedQueue';
import {
  CommunicationFaultInjector,
  createDefaultFaultPlan,
  createSeededRandom,
  type CommunicationFaultPlan,
  type ScheduledStreamDelivery,
} from './faultInjection';
import {
  STREAM_PROTOCOL_VERSION,
  type EndMessage,
  type HeartbeatMessage,
  type HelloMessage,
  type StreamMessage,
  type TelemetryMessage,
} from './protocol';

export interface SyntheticStreamSource {
  sourceId: string;
  profileId: string;
  phase: number;
}

export interface BrowserDemoOptions {
  seed: number;
  sources: SyntheticStreamSource[];
  sampleIntervalMs: number;
  samplesPerSource: number;
  heartbeatEvery: number;
  queueCapacity: number;
  startTime: string;
  faultPlan?: CommunicationFaultPlan | undefined;
}

export type DemoAdapterEvent =
  | { type: 'message'; message: StreamMessage; injectedFaults: string[] }
  | { type: 'queue-pressure'; totalDropped: number; depth: number }
  | { type: 'disconnect'; reconnectAfterMs: number }
  | { type: 'complete' };

export type DemoAdapterListener = (event: DemoAdapterEvent) => void;

interface SourceState {
  source: SyntheticStreamSource;
  sequence: number;
  sampleIndex: number;
}

const DEFAULT_SOURCES: SyntheticStreamSource[] = [
  { sourceId: 'demo-alpha', profileId: 'generic-fixed-wing.synthetic.v1', phase: 0 },
  { sourceId: 'demo-bravo', profileId: 'generic-rotary-wing.synthetic.v1', phase: 1.7 },
];

export class BrowserDemoAdapter {
  private readonly options: BrowserDemoOptions;
  private readonly listeners = new Set<DemoAdapterListener>();
  private random: () => number;
  private injector: CommunicationFaultInjector;
  private queue: BoundedQueue<ScheduledStreamDelivery>;
  private states: SourceState[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly delayedDeliveries = new Set<ReturnType<typeof setTimeout>>();
  private running = false;
  private disposed = false;
  private startedAt = 0;
  private completionPending = false;

  constructor(options: Partial<BrowserDemoOptions> = {}) {
    this.options = {
      seed: options.seed ?? 2_021,
      sources: options.sources ?? DEFAULT_SOURCES,
      sampleIntervalMs: options.sampleIntervalMs ?? 250,
      samplesPerSource: options.samplesPerSource ?? 240,
      heartbeatEvery: options.heartbeatEvery ?? 10,
      queueCapacity: options.queueCapacity ?? 128,
      startTime: options.startTime ?? '2026-01-01T00:00:00.000Z',
      faultPlan: options.faultPlan,
    };
    if (this.options.sources.length === 0) {
      throw new RangeError('At least one synthetic source is required.');
    }
    if (
      !Number.isSafeInteger(this.options.sampleIntervalMs) ||
      this.options.sampleIntervalMs < 1 ||
      !Number.isSafeInteger(this.options.samplesPerSource) ||
      this.options.samplesPerSource < 1 ||
      !Number.isSafeInteger(this.options.heartbeatEvery) ||
      this.options.heartbeatEvery < 1
    ) {
      throw new RangeError(
        'Demo intervals, sample counts, and heartbeat cadence must be positive integers.',
      );
    }
    if (!Number.isFinite(Date.parse(this.options.startTime))) {
      throw new Error('Demo startTime must be a valid ISO-8601 timestamp.');
    }
    if (
      new Set(this.options.sources.map((source) => source.sourceId)).size !==
      this.options.sources.length
    ) {
      throw new Error('Synthetic source IDs must be unique.');
    }
    this.random = createSeededRandom(this.options.seed);
    this.injector = new CommunicationFaultInjector(
      this.options.faultPlan ?? createDefaultFaultPlan(this.options.seed),
    );
    this.queue = new BoundedQueue(this.options.queueCapacity, 'drop-oldest');
  }

  subscribe(listener: DemoAdapterListener): () => void {
    if (this.disposed) {
      return () => undefined;
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (this.running || this.disposed) {
      return;
    }
    this.running = true;
    this.clearDelayedDeliveries();
    this.completionPending = false;
    this.random = createSeededRandom(this.options.seed);
    this.injector = new CommunicationFaultInjector(
      this.options.faultPlan ?? createDefaultFaultPlan(this.options.seed),
    );
    this.queue = new BoundedQueue(this.options.queueCapacity, 'drop-oldest');
    this.startedAt = Date.now();
    this.states = this.options.sources.map((source) => ({
      source,
      sequence: 0,
      sampleIndex: 0,
    }));
    for (const state of this.states) {
      this.inject(this.createHello(state));
    }
    this.flushQueue();
    if (!this.disposed) {
      this.timer = setInterval(() => this.tick(), this.options.sampleIntervalMs);
    }
  }

  stop(): void {
    if (!this.running) {
      return;
    }
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.clearDelayedDeliveries();
    this.completionPending = false;
    for (const state of this.states) {
      state.sequence += 1;
      const end: EndMessage = {
        protocolVersion: STREAM_PROTOCOL_VERSION,
        type: 'end',
        sourceId: state.source.sourceId,
        sequence: state.sequence,
        timestamp: this.timestampFor(state.sampleIndex),
        reason: 'operator_stop',
        finalSequence: state.sequence,
      };
      this.inject(end);
    }
    for (const held of this.injector.flush()) {
      this.enqueue(held);
    }
    this.flushQueue();
  }

  dispose(): void {
    this.disposed = true;
    this.running = false;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.clearDelayedDeliveries();
    this.completionPending = false;
    this.queue.clear();
    this.listeners.clear();
  }

  private tick(): void {
    if (!this.running || this.disposed) {
      return;
    }
    let complete = true;
    for (const state of this.states) {
      if (state.sampleIndex >= this.options.samplesPerSource) {
        continue;
      }
      complete = false;
      state.sampleIndex += 1;
      state.sequence += 1;
      this.inject(this.createTelemetry(state));

      if (state.sampleIndex % this.options.heartbeatEvery === 0) {
        state.sequence += 1;
        this.inject(this.createHeartbeat(state));
      }
    }
    this.flushQueue();

    if (
      complete ||
      this.states.every((state) => state.sampleIndex >= this.options.samplesPerSource)
    ) {
      this.finishNormally();
    }
  }

  private finishNormally(): void {
    if (this.disposed) {
      return;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    for (const state of this.states) {
      state.sequence += 1;
      const end: EndMessage = {
        protocolVersion: STREAM_PROTOCOL_VERSION,
        type: 'end',
        sourceId: state.source.sourceId,
        sequence: state.sequence,
        timestamp: this.timestampFor(state.sampleIndex),
        reason: 'complete',
        finalSequence: state.sequence,
      };
      this.inject(end);
    }
    for (const held of this.injector.flush()) {
      this.enqueue(held);
    }
    this.flushQueue();
    if (this.disposed) {
      return;
    }
    this.running = false;
    this.completionPending = true;
    this.emitCompletionIfReady();
  }

  private createHello(state: SourceState): HelloMessage {
    return {
      protocolVersion: STREAM_PROTOCOL_VERSION,
      type: 'hello',
      sourceId: state.source.sourceId,
      sequence: state.sequence,
      timestamp: this.timestampFor(0),
      schemaVersion: 'telemetry.synthetic.v1',
      profileId: state.source.profileId,
      units: {
        airspeed: 'kn',
        altitude: 'ft',
        verticalRate: 'ft/min',
        fuel: '%',
        vibration: 'g',
      },
      capabilities: ['heartbeat', 'bounded-queue', 'synthetic-faults'],
    };
  }

  private createTelemetry(state: SourceState): TelemetryMessage {
    const time = state.sampleIndex / 10;
    const phase = state.source.phase;
    const noise = () => (this.random() - 0.5) * 2;
    return {
      protocolVersion: STREAM_PROTOCOL_VERSION,
      type: 'telemetry',
      sourceId: state.source.sourceId,
      sequence: state.sequence,
      timestamp: this.timestampFor(state.sampleIndex),
      measurements: {
        airspeed: 122 + 8 * Math.sin(time + phase) + noise(),
        altitude: 5_200 + 140 * Math.sin(time / 3 + phase) + noise() * 3,
        verticalRate: 280 * Math.cos(time / 3 + phase) + noise() * 15,
        fuel: Math.max(0, 92 - state.sampleIndex * 0.025 + noise() * 0.05),
        vibration: 0.24 + 0.025 * Math.sin(time * 2 + phase) + noise() * 0.004,
      },
      qualityFlags: ['synthetic', 'unclassified'],
    };
  }

  private createHeartbeat(state: SourceState): HeartbeatMessage {
    const snapshot = this.queue.snapshot();
    return {
      protocolVersion: STREAM_PROTOCOL_VERSION,
      type: 'heartbeat',
      sourceId: state.source.sourceId,
      sequence: state.sequence,
      timestamp: this.timestampFor(state.sampleIndex),
      status: snapshot.totalDropped > 0 ? 'degraded' : 'nominal',
      uptimeMs: Date.now() - this.startedAt,
      queueDepth: snapshot.depth,
      droppedMessages: snapshot.totalDropped,
    };
  }

  private inject(message: StreamMessage): void {
    if (this.disposed) {
      return;
    }
    const result = this.injector.transform(message);
    if (result.disconnect) {
      this.emit({ type: 'disconnect', reconnectAfterMs: 1_000 });
    }
    for (const delivery of result.deliveries) {
      this.enqueue(delivery);
    }
  }

  private enqueue(delivery: ScheduledStreamDelivery): void {
    const result = this.queue.push(delivery);
    if (result.dropped !== undefined) {
      this.emit({
        type: 'queue-pressure',
        totalDropped: result.totalDropped,
        depth: result.depth,
      });
    }
  }

  private flushQueue(): void {
    if (this.disposed) {
      this.queue.clear();
      return;
    }
    for (const delivery of this.queue.drain()) {
      if (delivery.delayMs === 0) {
        this.emit({
          type: 'message',
          message: delivery.message,
          injectedFaults: delivery.injectedFaults,
        });
      } else {
        const timer = setTimeout(() => {
          this.delayedDeliveries.delete(timer);
          if (this.disposed) {
            return;
          }
          this.emit({
            type: 'message',
            message: delivery.message,
            injectedFaults: delivery.injectedFaults,
          });
          this.emitCompletionIfReady();
        }, delivery.delayMs);
        this.delayedDeliveries.add(timer);
      }
    }
  }

  private clearDelayedDeliveries(): void {
    for (const timer of this.delayedDeliveries) {
      clearTimeout(timer);
    }
    this.delayedDeliveries.clear();
  }

  private emitCompletionIfReady(): void {
    if (this.completionPending && this.delayedDeliveries.size === 0) {
      this.completionPending = false;
      this.emit({ type: 'complete' });
    }
  }

  private timestampFor(sampleIndex: number): string {
    const start = Date.parse(this.options.startTime);
    return new Date(start + sampleIndex * this.options.sampleIntervalMs).toISOString();
  }

  private emit(event: DemoAdapterEvent): void {
    if (this.disposed) {
      return;
    }
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
