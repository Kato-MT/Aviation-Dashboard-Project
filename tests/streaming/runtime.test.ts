import { afterEach, describe, expect, it, vi } from 'vitest';

import { BoundedExponentialBackoff } from '../../src/streaming/backoff';
import { BoundedQueue } from '../../src/streaming/boundedQueue';
import { BrowserDemoAdapter, type DemoAdapterEvent } from '../../src/streaming/browserDemoAdapter';
import { StreamHealthMonitor } from '../../src/streaming/health';
import { STREAM_PROTOCOL_VERSION, type StreamMessage } from '../../src/streaming/protocol';
import {
  ReconnectingStreamClient,
  type WebSocketEventLike,
  type WebSocketLike,
} from '../../src/streaming/streamClient';

afterEach(() => vi.useRealTimers());

describe('bounded streaming runtime', () => {
  it('drops the oldest entry and exposes counters', () => {
    const queue = new BoundedQueue<number>(2, 'drop-oldest');
    queue.push(1);
    queue.push(2);
    const result = queue.push(3);
    expect(result).toMatchObject({ accepted: true, dropped: 1, depth: 2, totalDropped: 1 });
    expect(queue.drain()).toEqual([2, 3]);
    expect(queue.snapshot()).toMatchObject({ totalEnqueued: 3, totalDequeued: 2, totalDropped: 1 });
  });

  it('can reject the newest entry instead', () => {
    const queue = new BoundedQueue<number>(1, 'drop-newest');
    queue.push(1);
    expect(queue.push(2)).toMatchObject({ accepted: false, dropped: 2, totalDropped: 1 });
    expect(queue.shift()).toBe(1);
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects invalid queue capacity %s', (capacity) => {
    expect(() => new BoundedQueue(capacity)).toThrow(RangeError);
  });

  it('bounds exponential reconnect attempts and delay', () => {
    const backoff = new BoundedExponentialBackoff({
      initialDelayMs: 100,
      maximumDelayMs: 250,
      multiplier: 2,
      maximumAttempts: 4,
      jitterRatio: 0,
    });
    expect([
      backoff.nextDelay(),
      backoff.nextDelay(),
      backoff.nextDelay(),
      backoff.nextDelay(),
    ]).toEqual([100, 200, 250, 250]);
    expect(backoff.nextDelay()).toBeNull();
    backoff.reset();
    expect(backoff.nextDelay()).toBe(100);
  });

  it('tracks missing, duplicate, and out-of-order messages', () => {
    const monitor = new StreamHealthMonitor({ staleAfterMs: 1_000, disconnectedAfterMs: 3_000 });
    const make = (sequence: number): StreamMessage => ({
      protocolVersion: STREAM_PROTOCOL_VERSION,
      type: 'telemetry',
      sourceId: 'source-a',
      sequence,
      timestamp: new Date(sequence * 1_000).toISOString(),
      measurements: { airspeed: 120 },
      qualityFlags: [],
    });
    monitor.observe(make(0), 0);
    monitor.observe(make(2), 100);
    monitor.observe(make(2), 200);
    const health = monitor.observe(make(1), 300);
    expect(health).toMatchObject({
      status: 'degraded',
      missingMessages: 1,
      duplicateMessages: 1,
      outOfOrderMessages: 1,
    });
  });

  it('transitions a quiet source through stale and disconnected', () => {
    const monitor = new StreamHealthMonitor({ staleAfterMs: 1_000, disconnectedAfterMs: 3_000 });
    monitor.observe(
      {
        protocolVersion: STREAM_PROTOCOL_VERSION,
        type: 'telemetry',
        sourceId: 'source-a',
        sequence: 0,
        timestamp: '2026-01-01T00:00:00.000Z',
        measurements: { airspeed: 120 },
        qualityFlags: [],
      },
      10_000,
    );
    expect(monitor.snapshot(11_001)[0]?.status).toBe('stale');
    expect(monitor.snapshot(13_001)[0]?.status).toBe('disconnected');
  });

  it('emits the same protocol for multiple browser-demo sources', () => {
    vi.useFakeTimers();
    const events: DemoAdapterEvent[] = [];
    const adapter = new BrowserDemoAdapter({
      seed: 7,
      sampleIntervalMs: 10,
      samplesPerSource: 2,
      heartbeatEvery: 10,
      sources: [
        { sourceId: 'alpha', profileId: 'fixed.synthetic.v1', phase: 0 },
        { sourceId: 'bravo', profileId: 'rotary.synthetic.v1', phase: 1 },
      ],
    });
    adapter.subscribe((event) => events.push(event));
    adapter.start();
    vi.advanceTimersByTime(30);
    const messages = events.filter((event) => event.type === 'message');
    expect(
      messages.filter((event) => event.type === 'message' && event.message.type === 'hello'),
    ).toHaveLength(2);
    expect(
      messages.filter((event) => event.type === 'message' && event.message.type === 'telemetry'),
    ).toHaveLength(4);
    expect(
      messages.filter((event) => event.type === 'message' && event.message.type === 'end'),
    ).toHaveLength(2);
    expect(events.at(-1)).toEqual({ type: 'complete' });
  });

  it('restarts browser demo runs from the same deterministic seed', () => {
    vi.useFakeTimers();
    const telemetry: StreamMessage[] = [];
    const adapter = new BrowserDemoAdapter({
      seed: 99,
      sampleIntervalMs: 10,
      samplesPerSource: 1,
      heartbeatEvery: 10,
      sources: [{ sourceId: 'alpha', profileId: 'fixed.synthetic.v1', phase: 0 }],
    });
    adapter.subscribe((event) => {
      if (event.type === 'message' && event.message.type === 'telemetry') {
        telemetry.push(event.message);
      }
    });
    adapter.start();
    vi.advanceTimersByTime(20);
    adapter.start();
    vi.advanceTimersByTime(20);
    expect(telemetry).toHaveLength(2);
    expect(telemetry[1]).toEqual(telemetry[0]);
  });

  it('disposes delayed deliveries after browser-demo completion', () => {
    vi.useFakeTimers();
    const listener = vi.fn<(event: DemoAdapterEvent) => void>();
    const adapter = new BrowserDemoAdapter({
      sampleIntervalMs: 10,
      samplesPerSource: 1,
      heartbeatEvery: 10,
      sources: [{ sourceId: 'alpha', profileId: 'fixed.synthetic.v1', phase: 0 }],
      faultPlan: {
        seed: 7,
        scenarios: [
          {
            id: 'latency',
            enabled: true,
            startAtMessage: 0,
            every: 1,
            value: 100,
          },
        ],
      },
    });
    adapter.subscribe(listener);

    adapter.start();
    vi.advanceTimersByTime(10);
    expect(vi.getTimerCount()).toBe(3);

    adapter.dispose();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(200);
    expect(listener).not.toHaveBeenCalled();
  });

  it('allows repeated browser-demo disposal without recreating resources', () => {
    vi.useFakeTimers();
    const adapter = new BrowserDemoAdapter({
      sampleIntervalMs: 10,
      samplesPerSource: 2,
      heartbeatEvery: 10,
      sources: [{ sourceId: 'alpha', profileId: 'fixed.synthetic.v1', phase: 0 }],
    });
    adapter.start();
    expect(vi.getTimerCount()).toBe(1);

    adapter.dispose();
    expect(() => adapter.dispose()).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);

    adapter.start();
    vi.advanceTimersByTime(100);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps stop as an operator end and allows a later restart', () => {
    vi.useFakeTimers();
    const events: DemoAdapterEvent[] = [];
    const adapter = new BrowserDemoAdapter({
      sampleIntervalMs: 10,
      samplesPerSource: 1,
      heartbeatEvery: 10,
      sources: [{ sourceId: 'alpha', profileId: 'fixed.synthetic.v1', phase: 0 }],
    });
    adapter.subscribe((event) => events.push(event));

    adapter.start();
    adapter.stop();
    adapter.start();
    vi.advanceTimersByTime(10);

    const endReasons = events.flatMap((event) =>
      event.type === 'message' && event.message.type === 'end' ? [event.message.reason] : [],
    );
    expect(endReasons).toEqual(['operator_stop', 'complete']);
    expect(events.filter((event) => event.type === 'complete')).toHaveLength(1);
  });

  it('does not call existing or new listeners after browser-demo disposal', () => {
    vi.useFakeTimers();
    const existingListener = vi.fn<(event: DemoAdapterEvent) => void>();
    const newListener = vi.fn<(event: DemoAdapterEvent) => void>();
    const adapter = new BrowserDemoAdapter({
      sampleIntervalMs: 10,
      samplesPerSource: 1,
      heartbeatEvery: 10,
      sources: [{ sourceId: 'alpha', profileId: 'fixed.synthetic.v1', phase: 0 }],
    });
    adapter.subscribe(existingListener);
    adapter.dispose();
    adapter.subscribe(newListener);

    adapter.start();
    adapter.stop();
    vi.advanceTimersByTime(100);

    expect(existingListener).not.toHaveBeenCalled();
    expect(newListener).not.toHaveBeenCalled();
  });

  it('surfaces WebSocket queue pressure instead of silently dropping', async () => {
    class FakeSocket implements WebSocketLike {
      readonly readyState = 1;
      private listeners = new Map<string, Set<(event: WebSocketEventLike) => void>>();

      addEventListener(type: string, listener: (event: WebSocketEventLike) => void): void {
        const listeners = this.listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }

      removeEventListener(type: string, listener: (event: WebSocketEventLike) => void): void {
        this.listeners.get(type)?.delete(listener);
      }

      close(): void {}

      emit(type: string, event: WebSocketEventLike): void {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
    }

    const socket = new FakeSocket();
    const received: StreamMessage[] = [];
    const dropped: number[] = [];
    const client = new ReconnectingStreamClient({
      url: 'ws://synthetic.test',
      queueCapacity: 2,
      queueOverflowStrategy: 'drop-oldest',
      drainBatchSize: 1,
      backoff: { maximumAttempts: 0 },
      heartbeatStaleAfterMs: 1_000,
      heartbeatDisconnectedAfterMs: 2_000,
      webSocketFactory: () => socket,
      onMessage: (message) => received.push(message),
      onQueuePressure: (count) => dropped.push(count),
    });
    client.start();
    for (const sequence of [1, 2, 3]) {
      socket.emit('message', {
        data: JSON.stringify({
          protocolVersion: STREAM_PROTOCOL_VERSION,
          type: 'telemetry',
          sourceId: 'source-a',
          sequence,
          timestamp: new Date(sequence * 1_000).toISOString(),
          measurements: { airspeed: 120 + sequence },
          qualityFlags: [],
        }),
      });
    }
    await Promise.resolve();
    await Promise.resolve();
    expect(dropped).toEqual([1]);
    expect(received.map((message) => message.sequence)).toEqual([2, 3]);
    expect(client.getQueueSnapshot().totalDropped).toBe(1);
    client.stop();
  });
});
