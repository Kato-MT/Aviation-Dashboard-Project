import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CONFIGURATION_SIMULATOR_CONTRACT,
  ConfigurationSimulatorController,
  createConfigurationSimulatorController,
  type ConfigurationDemo,
  type ConfigurationHealth,
} from '../../src/features/lab/configurationRuntime';
import {
  BrowserDemoAdapter,
  type BrowserDemoOptions,
  type DemoAdapterEvent,
  type DemoAdapterListener,
} from '../../src/streaming/browserDemoAdapter';
import type { HealthMonitorOptions, SourceHealth } from '../../src/streaming/health';
import { STREAM_PROTOCOL_VERSION, type StreamMessage } from '../../src/streaming/protocol';

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const telemetryMessage: StreamMessage = {
  protocolVersion: STREAM_PROTOCOL_VERSION,
  type: 'telemetry',
  sourceId: 'demo-alpha',
  sequence: 1,
  timestamp: '2026-01-01T00:00:00.150Z',
  measurements: { airspeed: 123.45, altitude: 5_100 },
  qualityFlags: ['synthetic'],
};

function messageEvent(
  injectedFaults: string[] = [],
): Extract<DemoAdapterEvent, { type: 'message' }> {
  return { type: 'message', message: telemetryMessage, injectedFaults };
}

function sourceHealth(sourceId: string, overrides: Partial<SourceHealth> = {}): SourceHealth {
  return {
    sourceId,
    status: 'healthy',
    receivedMessages: 0,
    duplicateMessages: 0,
    outOfOrderMessages: 0,
    missingMessages: 0,
    remoteQueueDepth: 0,
    remoteDroppedMessages: 0,
    localDroppedMessages: 0,
    reconnectAttempts: 0,
    ...overrides,
  };
}

class FakeDemo implements ConfigurationDemo {
  private listener: DemoAdapterListener | undefined;
  private readonly capturedListeners: DemoAdapterListener[] = [];
  readonly log: string[];
  startCount = 0;
  stopCount = 0;
  disposeCount = 0;

  constructor(
    log: string[] = [],
    private readonly hooks: {
      onStart?: () => void;
      onUnsubscribe?: (listener: DemoAdapterListener) => void;
      onDispose?: (listener: DemoAdapterListener | undefined) => void;
    } = {},
  ) {
    this.log = log;
  }

  subscribe(listener: DemoAdapterListener): () => void {
    this.log.push('subscribe');
    this.listener = listener;
    this.capturedListeners.push(listener);
    return () => {
      this.log.push('unsubscribe');
      this.hooks.onUnsubscribe?.(listener);
      if (this.listener === listener) this.listener = undefined;
    };
  }

  start(): void {
    this.startCount += 1;
    this.log.push('start');
    this.hooks.onStart?.();
  }

  stop(): void {
    this.stopCount += 1;
    this.log.push('stop');
  }

  dispose(): void {
    this.disposeCount += 1;
    this.log.push('dispose');
    this.hooks.onDispose?.(this.capturedListeners.at(-1));
    this.listener = undefined;
  }

  emit(event: DemoAdapterEvent): void {
    this.listener?.(event);
  }

  emitLate(event: DemoAdapterEvent, run = 0): void {
    this.capturedListeners[run]?.(event);
  }
}

function fixedHealth(snapshot: () => SourceHealth[]): ConfigurationHealth {
  return {
    observe: (_message, receivedAt) =>
      sourceHealth('demo-alpha', {
        receivedMessages: 1,
        ...(receivedAt === undefined ? {} : { heartbeatAgeMs: 0 }),
      }),
    snapshot,
  };
}

describe('configuration simulator runtime', () => {
  it('starts one zero-network demo with the fixed deterministic contract', () => {
    vi.useFakeTimers();
    const webSocketConstructor = vi.fn();
    vi.stubGlobal('WebSocket', webSocketConstructor);
    let demoOptions: BrowserDemoOptions | undefined;
    let healthOptions: HealthMonitorOptions | undefined;
    const controller = createConfigurationSimulatorController({
      createDemo: (options) => {
        demoOptions = options;
        return new BrowserDemoAdapter(options);
      },
      createHealth: (options) => {
        healthOptions = options;
        return fixedHealth(() => []);
      },
    });
    const listener = vi.fn();
    controller.subscribe(listener);

    controller.start();
    controller.start();

    expect(demoOptions).toEqual({
      seed: 20_260_717,
      sources: [
        {
          sourceId: 'demo-alpha',
          profileId: 'generic-fixed-wing.synthetic.v1',
          phase: 0,
        },
        {
          sourceId: 'demo-bravo',
          profileId: 'generic-rotary-wing.synthetic.v1',
          phase: 1.7,
        },
      ],
      samplesPerSource: 160,
      sampleIntervalMs: 150,
      queueCapacity: 64,
      heartbeatEvery: 8,
      startTime: '2026-01-01T00:00:00.000Z',
    });
    expect(healthOptions).toEqual({ staleAfterMs: 2_500, disconnectedAfterMs: 7_500 });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(controller.getState().phase).toBe('running');
    expect(webSocketConstructor).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(2);

    controller.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('supersedes a stopped generation and ignores its late callbacks', () => {
    vi.useFakeTimers();
    const demos: FakeDemo[] = [];
    const controller = createConfigurationSimulatorController({
      createDemo: () => {
        const demo = new FakeDemo();
        demos.push(demo);
        return demo;
      },
      createHealth: () => fixedHealth(() => []),
    });

    controller.start();
    controller.start();
    expect(demos).toHaveLength(1);
    expect(demos[0]?.startCount).toBe(1);

    controller.stop();
    controller.start();
    expect(demos).toHaveLength(2);
    const current = controller.getState();
    demos[0]?.emitLate(messageEvent(['late-generation-fault']));

    expect(controller.getState()).toBe(current);
    expect(controller.getState().injectedFaultIds).toEqual([]);
    expect(demos[0]?.disposeCount).toBe(1);
    expect(demos[1]?.startCount).toBe(1);
    controller.dispose();
  });

  it('invalidates before unsubscribe and disposes instead of stopping', () => {
    vi.useFakeTimers();
    const log: string[] = [];
    const late = messageEvent(['late-teardown-fault']);
    const demo = new FakeDemo(log, {
      onUnsubscribe: (listener) => listener(late),
      onDispose: (listener) => listener?.(late),
    });
    const controller = createConfigurationSimulatorController({
      createDemo: () => demo,
      createHealth: () => fixedHealth(() => []),
    });
    controller.start();

    controller.stop();

    expect(log).toEqual(['subscribe', 'start', 'unsubscribe', 'dispose']);
    expect(demo.stopCount).toBe(0);
    expect(controller.getState()).toMatchObject({
      phase: 'stopped',
      injectedFaultIds: [],
      terminalIssue: null,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('falls back to stop when an injected demo has no dispose method', () => {
    vi.useFakeTimers();
    const log: string[] = [];
    let listener: DemoAdapterListener | undefined;
    const demo: ConfigurationDemo = {
      subscribe: (value) => {
        listener = value;
        return () => {
          log.push('unsubscribe');
          listener = undefined;
        };
      },
      start: () => log.push('start'),
      stop: () => log.push('stop'),
    };
    const controller = createConfigurationSimulatorController({
      createDemo: () => demo,
      createHealth: () => fixedHealth(() => []),
    });

    controller.start();
    controller.stop();

    expect(listener).toBeUndefined();
    expect(log).toEqual(['start', 'unsubscribe', 'stop']);
  });

  it('completes the real 160-sample run and releases every timer and listener', () => {
    vi.useFakeTimers();
    const controller = createConfigurationSimulatorController();

    controller.start();
    expect(controller.getState().aggregate).toMatchObject({ sources: 2, messages: 2 });
    expect(vi.getTimerCount()).toBe(2);

    vi.advanceTimersByTime(160 * 150);

    expect(controller.getState()).toMatchObject({
      phase: 'complete',
      aggregate: {
        sources: 2,
        messages: 364,
        dropped: 0,
        heartbeatAgeMs: 0,
        queue: 0,
        reconnects: 0,
      },
      terminalIssue: null,
    });
    expect(controller.getState().sourceHealth.map((source) => source.status)).toEqual([
      'ended',
      'ended',
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('contains construction and start failures as terminal evidence', () => {
    vi.useFakeTimers();
    const createDemo = vi.fn(() => {
      throw new Error('constructor exploded');
    });
    const constructionFailure = createConfigurationSimulatorController({ createDemo });
    expect(() => constructionFailure.start()).not.toThrow();
    expect(constructionFailure.getState()).toMatchObject({
      phase: 'failed',
      terminalIssue: expect.stringContaining('constructor exploded'),
    });

    const log: string[] = [];
    const demo = new FakeDemo(log, {
      onStart: () => {
        throw new Error('start exploded');
      },
    });
    const startFailure = createConfigurationSimulatorController({
      createDemo: () => demo,
    });
    expect(() => startFailure.start()).not.toThrow();
    expect(log).toEqual(['subscribe', 'start', 'unsubscribe', 'dispose']);
    expect(startFailure.getState()).toMatchObject({
      phase: 'failed',
      terminalIssue: expect.stringContaining('start exploded'),
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('derives degraded and stale health without double-counting shared drops', () => {
    vi.useFakeTimers();
    let status: SourceHealth['status'] = 'healthy';
    const demo = new FakeDemo();
    const controller = createConfigurationSimulatorController({
      createDemo: () => demo,
      createHealth: () =>
        fixedHealth(() => [
          sourceHealth('demo-alpha', {
            status,
            receivedMessages: 10,
            remoteQueueDepth: 3,
            remoteDroppedMessages: 5,
            reconnectAttempts: 2,
            heartbeatAgeMs: 120,
          }),
          sourceHealth('demo-bravo', {
            status,
            receivedMessages: 12,
            remoteQueueDepth: 3,
            remoteDroppedMessages: 5,
            heartbeatAgeMs: 250,
          }),
        ]),
    });
    controller.start();
    demo.emit({ type: 'queue-pressure', totalDropped: 5, depth: 4 });

    expect(controller.getState()).toMatchObject({
      phase: 'degraded',
      aggregate: {
        sources: 2,
        messages: 22,
        dropped: 5,
        heartbeatAgeMs: 250,
        queue: 4,
        reconnects: 2,
      },
    });

    status = 'stale';
    vi.advanceTimersByTime(CONFIGURATION_SIMULATOR_CONTRACT.sampleIntervalMs);
    expect(controller.getState().phase).toBe('stale');
    controller.dispose();
  });

  it('keeps snapshots immutable, bounded, and free of raw telemetry payloads', () => {
    vi.useFakeTimers();
    const demo = new FakeDemo();
    const controller = createConfigurationSimulatorController({
      createDemo: () => demo,
      createHealth: () =>
        fixedHealth(() =>
          Array.from({ length: 20 }, (_, index) =>
            sourceHealth(`source-${String(index).padStart(2, '0')}`, {
              receivedMessages: index + 1,
              remoteQueueDepth: 3,
              remoteDroppedMessages: 5,
              reconnectAttempts: index === 0 ? 2 : 0,
              heartbeatAgeMs: index,
              lastMessageAt: 'raw-time-must-not-survive',
              lastHeartbeatAt: 'raw-heartbeat-must-not-survive',
              lastSequence: 99,
            }),
          ),
        ),
    });
    controller.start();
    demo.emit({ type: 'queue-pressure', totalDropped: 5, depth: 4 });
    demo.emit(
      messageEvent([
        ...Array.from({ length: 40 }, (_, index) => `fault-${index}`),
        'INVALID FAULT ID',
      ]),
    );
    const snapshot = controller.getState();
    const serialized = JSON.stringify(snapshot);

    expect(snapshot.sourceHealth).toHaveLength(16);
    expect(snapshot.injectedFaultIds).toHaveLength(32);
    expect(snapshot.aggregate).toEqual({
      sources: 16,
      messages: 136,
      dropped: 5,
      heartbeatAgeMs: 15,
      queue: 4,
      reconnects: 2,
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.aggregate)).toBe(true);
    expect(Object.isFrozen(snapshot.sourceHealth)).toBe(true);
    expect(Object.isFrozen(snapshot.sourceHealth[0])).toBe(true);
    expect(Object.isFrozen(snapshot.injectedFaultIds)).toBe(true);
    expect(serialized).not.toContain('measurements');
    expect(serialized).not.toContain('airspeed');
    expect(serialized).not.toContain('123.45');
    expect(serialized).not.toContain('raw-time-must-not-survive');
    expect(serialized).not.toContain('raw-heartbeat-must-not-survive');
    expect(serialized).not.toContain('lastSequence');
    controller.dispose();
  });

  it('releases on complete and route disposal, then ignores every late callback', () => {
    vi.useFakeTimers();
    const completeDemo = new FakeDemo();
    const completeController = createConfigurationSimulatorController({
      createDemo: () => completeDemo,
      createHealth: () => fixedHealth(() => []),
    });
    completeController.start();
    completeDemo.emit({ type: 'complete' });
    const completed = completeController.getState();
    completeDemo.emitLate(messageEvent(['after-complete']));

    expect(completeController.getState()).toBe(completed);
    expect(completed.phase).toBe('complete');
    expect(completeDemo.disposeCount).toBe(1);
    expect(vi.getTimerCount()).toBe(0);

    const disposeDemo = new FakeDemo();
    const disposeController = new ConfigurationSimulatorController({
      createDemo: () => disposeDemo,
      createHealth: () => fixedHealth(() => []),
    });
    const listener = vi.fn();
    disposeController.subscribe(listener);
    disposeController.start();
    disposeController.dispose();
    const disposed = disposeController.getState();
    listener.mockClear();
    disposeDemo.emitLate(messageEvent(['after-dispose']));
    disposeController.start();

    expect(disposeController.getState()).toBe(disposed);
    expect(disposed.phase).toBe('stopped');
    expect(disposed.injectedFaultIds).toEqual([]);
    expect(listener).not.toHaveBeenCalled();
    expect(disposeDemo.disposeCount).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
