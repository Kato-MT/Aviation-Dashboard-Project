import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  LiveAirspaceClient,
  type LiveSocket,
  type LiveSocketEvent,
  type LiveTransportStatus,
} from '../../src/live/client';
import type { ClockReading, ServerTimeSample } from '../../src/live/clock';
import {
  parseLiveAcknowledgment,
  serializeLiveServerFrame,
  type LiveDeliveryMessage,
  type LiveDeliveryPayload,
} from '../../src/live/delivery';
import {
  LIVE_STREAM_PROTOCOL_VERSION,
  parseLivePing,
  type LiveHelloMessage,
  type LiveStreamMessage,
} from '../../src/live/protocol';
import { AIRSPACE_SCHEMA_VERSION, type AirspaceSnapshot } from '../../src/live/types';
import { MAX_LIVE_MESSAGE_BYTES } from '../../src/live/validation';
import { healthFixture, LIVE_FIXTURE_EPOCH } from './fixtures';

const NOW = '2026-08-27T12:00:00.000Z';
const activeClients = new Set<LiveAirspaceClient>();

function snapshot(): AirspaceSnapshot {
  return {
    schemaVersion: AIRSPACE_SCHEMA_VERSION,
    providerId: 'adsb-lol',
    feedEpoch: LIVE_FIXTURE_EPOCH,
    regionId: 'atlanta',
    sequence: 1,
    generatedAt: NOW,
    providerGeneratedAt: NOW,
    aircraft: [],
    validation: {
      receivedAircraft: 0,
      acceptedAircraft: 0,
      rejectedAircraft: 0,
      duplicateAircraft: 0,
      invalidFields: 0,
    },
  };
}

class FakeSocket implements LiveSocket {
  readyState = 0;
  readonly sent: string[] = [];
  readonly close = vi.fn(() => {
    this.readyState = 3;
  });
  private readonly listeners = new Map<string, Set<(event: LiveSocketEvent) => void>>();

  addEventListener(type: string, listener: (event: LiveSocketEvent) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: LiveSocketEvent) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  readonly send = vi.fn((data: string): void => {
    this.sent.push(data);
  });

  capture(type: string): Array<(event: LiveSocketEvent) => void> {
    return [...(this.listeners.get(type) ?? [])];
  }

  get listenerCount(): number {
    return [...this.listeners.values()].reduce((count, listeners) => count + listeners.size, 0);
  }

  emit(type: string, event: LiveSocketEvent = {}): void {
    if (type === 'open') this.readyState = 1;
    if (type === 'close') this.readyState = 3;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function makeClient(overrides: Partial<ConstructorParameters<typeof LiveAirspaceClient>[0]> = {}) {
  const messages: LiveStreamMessage[] = [];
  const statuses: LiveTransportStatus[] = [];
  const errors: string[] = [];
  const protocolErrors: string[][] = [];
  const sockets: FakeSocket[] = [];
  const client = new LiveAirspaceClient({
    regionId: 'atlanta',
    fetcher: vi.fn(async () => Response.json(snapshot())),
    socketFactory: (url) => {
      expect(url).toBe('ws://localhost/api/v1/airspace/atlanta/stream');
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    reconnect: { initialDelayMs: 100, maximumDelayMs: 100, jitterRatio: 0 },
    keepaliveMs: 1_000,
    onMessage: (message) => messages.push(message),
    onStatus: (status) => statuses.push(status),
    onError: (message) => errors.push(message),
    onProtocolError: (problems) => protocolErrors.push([...problems]),
    ...overrides,
  });
  activeClients.add(client);
  return { client, messages, statuses, errors, protocolErrors, sockets };
}

async function flushPromises(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function hello(regionId = 'atlanta'): LiveHelloMessage {
  return {
    type: 'hello',
    protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
    schemaVersion: AIRSPACE_SCHEMA_VERSION,
    providerId: 'adsb-lol',
    feedEpoch: LIVE_FIXTURE_EPOCH,
    regionId,
    pollIntervalMs: 10_000,
    generatedAt: NOW,
  };
}

function openStream(socket: FakeSocket): void {
  socket.emit('open');
  socket.emit('message', { data: serverFrame(hello()) });
}

let deliverySequence = 0;

function deliveryFrame(
  messages: LiveDeliveryPayload[],
  overrides: Partial<LiveDeliveryMessage> = {},
): LiveDeliveryMessage {
  const message = messages[0];
  const binding =
    message?.type === 'airspace.snapshot'
      ? message.snapshot
      : message?.type === 'feed.health'
        ? message.health
        : message?.type === 'pong'
          ? message
          : hello();
  return {
    type: 'delivery',
    protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
    providerId: binding.providerId,
    regionId: binding.regionId,
    feedEpoch: binding.feedEpoch,
    deliveryId: 'delivery-' + ++deliverySequence,
    messages,
    ...overrides,
  };
}

function serverFrame(message: LiveStreamMessage): string {
  return serializeLiveServerFrame(message.type === 'hello' ? message : deliveryFrame([message]));
}

function pongForRequest(request: string, generatedAt = NOW): string {
  const ping = parseLivePing(request);
  expect(ping).toBeDefined();
  return serverFrame({
    type: 'pong',
    providerId: 'adsb-lol',
    feedEpoch: LIVE_FIXTURE_EPOCH,
    regionId: 'atlanta',
    protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
    requestId: ping!.requestId,
    generatedAt,
  });
}

describe('LiveAirspaceClient', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    for (const client of activeClients) client.stop();
    activeClients.clear();
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('acknowledges an HTTP-first duplicate without republishing it or sampling time', async () => {
    const readClock = vi.fn(() => ({ monotonicMs: 0, wallMs: Date.parse(NOW) }));
    const onTimeSample = vi.fn();
    const state = makeClient({ readClock, onTimeSample });
    state.client.start();
    await flushPromises();
    const socket = state.sockets[0]!;
    openStream(socket);
    const before = [...state.messages];
    readClock.mockClear();
    onTimeSample.mockClear();
    const frame = deliveryFrame([
      {
        type: 'airspace.snapshot',
        protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
        snapshot: snapshot(),
      },
    ]);
    socket.emit('message', { data: serializeLiveServerFrame(frame) });
    expect(state.messages).toEqual(before);
    expect(socket.sent.map(parseLiveAcknowledgment)).toEqual([
      expect.objectContaining({
        type: 'ack',
        deliveryId: frame.deliveryId,
        feedEpoch: frame.feedEpoch,
      }),
    ]);
    expect(onTimeSample).not.toHaveBeenCalled();
    expect(readClock).not.toHaveBeenCalled();
  });

  it('validates the complete batch before delivering anything or acknowledging', async () => {
    const state = makeClient();
    state.client.start();
    await flushPromises();
    const socket = state.sockets[0]!;
    openStream(socket);
    state.messages.length = 0;
    const frame = deliveryFrame([
      {
        type: 'airspace.snapshot',
        protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
        snapshot: { ...snapshot(), sequence: 2 },
      },
      {
        type: 'feed.health',
        protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
        health: healthFixture(),
      },
    ]);
    const wire = JSON.stringify(frame).replace('"status":"live"', '"status":"invented"');
    socket.emit('message', { data: wire });
    expect(state.messages).toEqual([]);
    expect(socket.sent).toEqual([]);
    expect(state.protocolErrors).toHaveLength(1);
  });

  it.each([false, true])(
    'does not acknowledge or finish a batch after observer stop; restart=%s',
    async (restart) => {
      const received: string[] = [];
      const state = makeClient({
        onMessage: (message) => {
          received.push(message.type);
          if (message.type === 'airspace.snapshot' && message.snapshot.sequence === 2) {
            state.client.stop();
            if (restart) state.client.start();
          }
        },
      });
      state.client.start();
      await flushPromises();
      const socket = state.sockets[0]!;
      openStream(socket);
      received.length = 0;
      socket.emit('message', {
        data: serializeLiveServerFrame(
          deliveryFrame([
            {
              type: 'airspace.snapshot',
              protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
              snapshot: { ...snapshot(), sequence: 2 },
            },
            {
              type: 'feed.health',
              protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
              health: healthFixture(),
            },
          ]),
        ),
      });
      expect(received).toEqual(['airspace.snapshot']);
      expect(socket.sent).toEqual([]);
      expect(socket.close).toHaveBeenCalledOnce();
      expect(state.sockets).toHaveLength(restart ? 2 : 1);
    },
  );

  it('recovers once when sending the acknowledgment fails', async () => {
    const state = makeClient();
    state.client.start();
    await flushPromises();
    const socket = state.sockets[0]!;
    openStream(socket);
    socket.send.mockImplementation(() => {
      throw new Error('Send failed.');
    });
    socket.emit('message', {
      data: serverFrame({
        type: 'airspace.snapshot',
        protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
        snapshot: snapshot(),
      }),
    });
    expect(socket.close).toHaveBeenCalledOnce();
    expect(socket.listenerCount).toBe(0);
    expect(state.errors).toEqual(['The live connection could not acknowledge its delivery.']);
    await vi.advanceTimersByTimeAsync(100);
    expect(state.sockets).toHaveLength(2);
  });

  it('does not let a delivery acknowledgment satisfy the pong watchdog', async () => {
    const state = makeClient({ pongTimeoutMs: 1_000 });
    state.client.start();
    await flushPromises();
    const socket = state.sockets[0]!;
    openStream(socket);
    await vi.advanceTimersByTimeAsync(1_000);
    socket.emit('message', {
      data: serverFrame({
        type: 'airspace.snapshot',
        protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
        snapshot: snapshot(),
      }),
    });
    expect(socket.sent.filter((message) => parseLiveAcknowledgment(message))).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(state.errors).toContain('The live connection did not answer its keepalive.');
  });

  it('rejects an unwrapped domain message without acknowledging it', async () => {
    const state = makeClient();
    state.client.start();
    await flushPromises();
    const socket = state.sockets[0]!;
    openStream(socket);
    socket.emit('message', {
      data: JSON.stringify({
        type: 'airspace.snapshot',
        protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
        snapshot: snapshot(),
      }),
    });
    expect(socket.sent).toEqual([]);
    expect(state.protocolErrors).toHaveLength(1);
  });

  it.each([
    { ...snapshot(), extra: true },
    { ...snapshot(), providerId: 'wrong-provider' },
    { ...snapshot(), regionId: 'wrong-region' },
  ])('does not calibrate from a rejected HTTP snapshot: %j', async (value) => {
    const onTimeSample = vi.fn();
    const state = makeClient({
      fetcher: vi.fn(async () =>
        Response.json(value, { headers: { 'x-airspace-server-time': NOW } }),
      ),
      onTimeSample,
    });
    state.client.start();
    await flushPromises();
    expect(onTimeSample).not.toHaveBeenCalled();
    expect(state.messages).toEqual([]);
    expect(state.protocolErrors).toHaveLength(1);
  });

  it('accepts the feed binding before clock calibration and evidence delivery', async () => {
    const events: string[] = [];
    const state = makeClient({
      fetcher: vi.fn(async () =>
        Response.json(snapshot(), { headers: { 'x-airspace-server-time': NOW } }),
      ),
      onFeedBinding: (binding) => events.push('binding:' + binding.feedEpoch),
      onTimeSample: () => events.push('time'),
      onMessage: (message) => events.push(message.type),
    });
    state.client.start();
    await flushPromises();
    expect(events).toEqual(['binding:' + LIVE_FIXTURE_EPOCH, 'time', 'airspace.snapshot']);
    openStream(state.sockets[0]!);
    expect(events.slice(3)).toEqual(['time', 'hello']);
  });

  it.each([1, 2, 3])(
    'orders a delayed HTTP sequence %s against an accepted WebSocket sequence',
    async (sequence) => {
      const pending = deferred<Response>();
      const onTimeSample = vi.fn();
      const state = makeClient({ fetcher: vi.fn(() => pending.promise), onTimeSample });
      state.client.start();
      await flushPromises();
      openStream(state.sockets[0]!);
      state.sockets[0]!.emit('message', {
        data: serverFrame({
          type: 'airspace.snapshot',
          protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
          snapshot: { ...snapshot(), sequence: 2 },
        }),
      });
      onTimeSample.mockClear();
      pending.resolve(
        Response.json({ ...snapshot(), sequence }, { headers: { 'x-airspace-server-time': NOW } }),
      );
      await flushPromises();
      expect(onTimeSample).toHaveBeenCalledTimes(sequence > 2 ? 1 : 0);
      expect(
        state.messages
          .filter((message) => message.type === 'airspace.snapshot')
          .map((message) => message.snapshot.sequence),
      ).toEqual(sequence > 2 ? [2, 3] : [2]);
      expect(state.errors).toEqual([]);
    },
  );

  it.each(['snapshot', 'invalid', 'unavailable', 'rejection'] as const)(
    'ignores an obsolete bootstrap %s after a new-epoch reconnect',
    async (kind) => {
      const pending = deferred<Response>();
      const onTimeSample = vi.fn();
      const onFeedBinding = vi.fn();
      const state = makeClient({
        fetcher: vi.fn(() => pending.promise),
        onTimeSample,
        onFeedBinding,
      });
      state.client.start();
      await flushPromises();
      openStream(state.sockets[0]!);
      state.sockets[0]!.emit('close');
      await vi.advanceTimersByTimeAsync(100);
      const socket = state.sockets[1]!;
      socket.emit('open');
      socket.emit('message', {
        data: serverFrame({ ...hello(), feedEpoch: 'test-feed-2' }),
      });
      socket.emit('message', {
        data: serverFrame({
          type: 'airspace.snapshot',
          protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
          snapshot: { ...snapshot(), feedEpoch: 'test-feed-2', sequence: 0 },
        }),
      });
      onTimeSample.mockClear();
      const before = [...state.messages];
      if (kind === 'rejection') pending.reject(new Error('Obsolete request failed.'));
      else if (kind === 'invalid')
        pending.resolve(new Response('{', { headers: { 'x-airspace-server-time': NOW } }));
      else if (kind === 'unavailable')
        pending.resolve(
          Response.json(
            { health: healthFixture() },
            {
              status: 503,
              headers: { 'x-airspace-server-time': NOW },
            },
          ),
        );
      else
        pending.resolve(
          Response.json(
            { ...snapshot(), sequence: 99 },
            { headers: { 'x-airspace-server-time': NOW } },
          ),
        );
      await flushPromises();
      expect(state.messages).toEqual(before);
      expect(onTimeSample).not.toHaveBeenCalled();
      expect(onFeedBinding).toHaveBeenLastCalledWith(
        expect.objectContaining({ feedEpoch: 'test-feed-2' }),
      );
      expect(state.errors).toEqual([]);
      expect(state.protocolErrors).toEqual([]);
    },
  );

  it('rejects an epoch-changing second hello on the same connection', async () => {
    const onTimeSample = vi.fn();
    const onFeedBinding = vi.fn();
    const state = makeClient({ onTimeSample, onFeedBinding });
    state.client.start();
    await flushPromises();
    openStream(state.sockets[0]!);
    onTimeSample.mockClear();
    onFeedBinding.mockClear();
    state.sockets[0]!.emit('message', {
      data: serverFrame({ ...hello(), feedEpoch: 'old-epoch' }),
    });
    expect(onTimeSample).not.toHaveBeenCalled();
    expect(onFeedBinding).not.toHaveBeenCalled();
    expect(state.sockets[0]!.close).toHaveBeenCalledOnce();
    expect(state.protocolErrors.at(-1)).toContain(
      'A feed epoch change requires a new connection hello.',
    );
  });

  it.each([{ feedEpoch: 'old-epoch' }, { providerId: 'other' }, { regionId: 'other' }])(
    'does not satisfy a keepalive using the wrong feed binding: %j',
    async (overrides) => {
      const onTimeSample = vi.fn();
      const state = makeClient({ onTimeSample, pongTimeoutMs: 1_000 });
      state.client.start();
      await flushPromises();
      const socket = state.sockets[0]!;
      openStream(socket);
      onTimeSample.mockClear();
      await vi.advanceTimersByTimeAsync(1_000);
      socket.emit('message', {
        data: JSON.stringify({ ...JSON.parse(pongForRequest(socket.sent[0]!)), ...overrides }),
      });
      expect(onTimeSample).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(socket.close).toHaveBeenCalledOnce();
      expect(state.errors).toContain('The live connection did not answer its keepalive.');
    },
  );

  it('stops before timing and delivery if the binding observer disposes its activation', async () => {
    const onTimeSample = vi.fn();
    const state = makeClient({
      fetcher: vi.fn(async () =>
        Response.json(snapshot(), { headers: { 'x-airspace-server-time': NOW } }),
      ),
      onFeedBinding: () => client.stop(),
      onTimeSample,
    });
    const client: LiveAirspaceClient = state.client;
    client.start();
    await flushPromises();
    expect(onTimeSample).not.toHaveBeenCalled();
    expect(state.messages).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['north test', '../atlanta', 'atlanta/stream', 'atlanta?region=other'])(
    'rejects an unsafe region identifier before networking: %s',
    (regionId) => {
      const fetcher = vi.fn();
      const socketFactory = vi.fn();
      expect(() => makeClient({ regionId, fetcher, socketFactory })).toThrow('bounded identifiers');
      expect(fetcher).not.toHaveBeenCalled();
      expect(socketFactory).not.toHaveBeenCalled();
    },
  );

  it('loads the initial snapshot, opens a stream, and sends keepalives', async () => {
    const state = makeClient();
    state.client.start();
    await flushPromises();
    expect(state.messages[0]).toMatchObject({ type: 'airspace.snapshot' });
    expect(state.statuses).toEqual(['connecting']);

    openStream(state.sockets[0]!);
    expect(state.statuses.at(-1)).toBe('open');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(state.sockets[0]!.sent).toHaveLength(1);
    expect(parseLivePing(state.sockets[0]!.sent[0])).toMatchObject({
      type: 'ping',
      requestId: 'ping-1',
    });

    state.sockets[0]!.emit('message', { data: pongForRequest(state.sockets[0]!.sent[0]!) });
    state.client.stop();
    expect(state.statuses.at(-1)).toBe('stopped');
    expect(state.sockets[0]!.close).toHaveBeenCalledWith(1000, 'client stop');
  });

  it('measures the complete HTTP response without substituting its observation time', async () => {
    let reading: ClockReading = { monotonicMs: 10, wallMs: 100_010 };
    let bodyController!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        bodyController = controller;
      },
    });
    const pending = deferred<Response>();
    const samples: ServerTimeSample[] = [];
    const state = makeClient({
      fetcher: vi.fn(() => pending.promise),
      readClock: () => ({ ...reading }),
      onTimeSample: (sample) => samples.push(sample),
    });
    state.client.start();
    reading = { monotonicMs: 30, wallMs: 100_030 };
    const serverAt = '2026-08-27T12:01:00.000Z';
    pending.resolve(new Response(body, { headers: { 'x-airspace-server-time': serverAt } }));
    await flushPromises();
    expect(samples).toEqual([]);

    reading = { monotonicMs: 90, wallMs: 100_090 };
    bodyController.enqueue(new TextEncoder().encode(JSON.stringify(snapshot())));
    bodyController.close();
    await flushPromises();
    expect(samples).toEqual([
      {
        sent: { monotonicMs: 10, wallMs: 100_010 },
        received: reading,
        serverAt,
      },
    ]);
    expect(state.messages).toContainEqual(
      expect.objectContaining({
        type: 'airspace.snapshot',
        snapshot: expect.objectContaining({ generatedAt: NOW }),
      }),
    );
  });

  it.each([undefined, 'not-a-time', '2026-08-27T12:00:00Z'])(
    'does not invent a clock reference for a missing or invalid HTTP timestamp: %s',
    async (serverAt) => {
      const onTimeSample = vi.fn();
      const state = makeClient({
        fetcher: vi.fn(async () =>
          Response.json(snapshot(), {
            headers: serverAt === undefined ? {} : { 'x-airspace-server-time': serverAt },
          }),
        ),
        onTimeSample,
      });
      state.client.start();
      await flushPromises();
      expect(onTimeSample).not.toHaveBeenCalled();
      expect(state.messages).toHaveLength(1);
      expect(state.messages[0]?.type).toBe('airspace.snapshot');
    },
  );

  it('measures the first hello from connection start and ignores duplicate hello timing', async () => {
    let reading: ClockReading = { monotonicMs: 7.25, wallMs: 100_007 };
    const samples: ServerTimeSample[] = [];
    const state = makeClient({
      readClock: () => ({ ...reading }),
      onTimeSample: (sample) => samples.push(sample),
    });
    state.client.start();
    await flushPromises();
    reading = { monotonicMs: 27.75, wallMs: 100_027 };
    openStream(state.sockets[0]!);
    expect(samples).toEqual([
      {
        sent: { monotonicMs: 7.25, wallMs: 100_007 },
        received: reading,
        serverAt: NOW,
      },
    ]);
    reading = { monotonicMs: 50, wallMs: 100_050 };
    state.sockets[0]!.emit('message', { data: serverFrame(hello()) });
    expect(samples).toHaveLength(1);
  });

  it('measures only the matching pong and rejects a replay without satisfying the next watchdog', async () => {
    let reading: ClockReading = { monotonicMs: 10, wallMs: 100_010 };
    const samples: ServerTimeSample[] = [];
    const state = makeClient({
      readClock: () => ({ ...reading }),
      onTimeSample: (sample) => samples.push(sample),
      pongTimeoutMs: 1_000,
    });
    state.client.start();
    await flushPromises();
    const socket = state.sockets[0]!;
    openStream(socket);
    samples.length = 0;
    reading = { monotonicMs: 1_010, wallMs: 101_010 };
    await vi.advanceTimersByTimeAsync(1_000);
    const firstPong = pongForRequest(socket.sent[0]!, '2026-08-27T12:00:01.000Z');
    reading = { monotonicMs: 1_030, wallMs: 101_030 };
    socket.emit('message', { data: firstPong });
    expect(samples).toEqual([
      {
        sent: { monotonicMs: 1_010, wallMs: 101_010 },
        received: reading,
        serverAt: '2026-08-27T12:00:01.000Z',
      },
    ]);
    expect(state.messages.some((message) => message.type === 'pong')).toBe(false);
    socket.emit('message', { data: firstPong });
    expect(samples).toHaveLength(1);
    expect(state.protocolErrors.at(-1)).toContain('The pong does not match the pending keepalive.');

    reading = { monotonicMs: 2_010, wallMs: 102_010 };
    await vi.advanceTimersByTimeAsync(1_000);
    expect(socket.sent.filter((message) => parseLivePing(message))).toHaveLength(2);
    socket.emit('message', { data: firstPong });
    expect(samples).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(socket.close).toHaveBeenCalledOnce();
    expect(state.errors).toContain('The live connection did not answer its keepalive.');
  });

  it('does not publish timing from an obsolete HTTP response or retired socket', async () => {
    const pending = deferred<Response>();
    const onTimeSample = vi.fn();
    const state = makeClient({
      fetcher: vi
        .fn()
        .mockImplementationOnce(() => pending.promise)
        .mockImplementation(async () => Response.json(snapshot())),
      onTimeSample,
    });
    state.client.start();
    await flushPromises();
    const oldMessage = state.sockets[0]!.capture('message')[0]!;
    state.client.stop();
    state.client.start();
    pending.resolve(Response.json(snapshot(), { headers: { 'x-airspace-server-time': NOW } }));
    oldMessage({ data: serverFrame(hello()) });
    await flushPromises();
    expect(onTimeSample).not.toHaveBeenCalled();
    expect(state.messages).toHaveLength(1);
  });

  it.each(['bootstrap', 'hello'] as const)(
    'stops delivery if the %s timing observer retires its activation',
    async (source) => {
      const state = makeClient({
        fetcher: vi.fn(async () =>
          Response.json(snapshot(), {
            headers: source === 'bootstrap' ? { 'x-airspace-server-time': NOW } : {},
          }),
        ),
        onTimeSample: () => client.stop(),
      });
      const client: LiveAirspaceClient = state.client;
      client.start();
      await flushPromises();
      if (source === 'hello') {
        state.messages.length = 0;
        openStream(state.sockets[0]!);
      }
      expect(state.messages).toEqual([]);
      expect(state.sockets[0]!.listenerCount).toBe(0);
      expect(state.statuses.at(-1)).toBe('stopped');
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('reports a bootstrap clock-reader exception without an unhandled rejection', async () => {
    const state = makeClient({
      readClock: vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error('clock read failed');
        })
        .mockReturnValue({ monotonicMs: 10, wallMs: 100_010 }),
    });
    state.client.start();
    await flushPromises();
    expect(state.errors).toContain('clock read failed');
    expect(state.messages).toEqual([]);
  });

  it('delivers valid stream messages and rejects malformed payloads', async () => {
    const state = makeClient();
    state.client.start();
    await flushPromises();
    state.sockets[0]!.emit('open');

    state.sockets[0]!.emit('message', {
      data: serverFrame({
        type: 'hello',
        protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
        schemaVersion: AIRSPACE_SCHEMA_VERSION,
        regionId: 'atlanta',
        providerId: 'adsb-lol',
        feedEpoch: LIVE_FIXTURE_EPOCH,
        pollIntervalMs: 10_000,
        generatedAt: NOW,
      }),
    });
    state.sockets[0]!.emit('message', { data: '{' });
    state.sockets[0]!.emit('message', { data: new Uint8Array() });

    expect(state.messages.some(({ type }) => type === 'hello')).toBe(true);
    expect(state.protocolErrors).toEqual([
      ['Delivery is not valid JSON.'],
      ['WebSocket payload must be text JSON.'],
    ]);
    state.client.stop();
  });

  it('reconnects with bounded backoff after a close', async () => {
    const state = makeClient();
    state.client.start();
    await flushPromises();
    state.sockets[0]!.emit('open');
    state.sockets[0]!.emit('close');
    expect(state.statuses.at(-1)).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(100);
    expect(state.sockets).toHaveLength(2);
    expect(state.statuses.at(-1)).toBe('reconnecting');
    state.client.stop();
  });

  it('surfaces structured health from failed snapshot requests', async () => {
    const state = makeClient({
      fetcher: vi.fn(async () =>
        Response.json(
          {
            error: 'UPSTREAM_UNAVAILABLE',
            health: {
              schemaVersion: AIRSPACE_SCHEMA_VERSION,
              regionId: 'atlanta',
              providerId: 'adsb-lol',
              feedEpoch: LIVE_FIXTURE_EPOCH,
              status: 'offline',
              checkedAt: NOW,
              consecutiveFailures: 1,
              message: 'Provider unavailable.',
            },
          },
          { status: 503 },
        ),
      ),
    });
    state.client.start();
    await flushPromises();
    expect(state.messages.some(({ type }) => type === 'feed.health')).toBe(true);
    expect(state.errors).toEqual(['Snapshot request failed with HTTP 503.']);
    state.client.stop();
  });

  it('reports invalid snapshots and fetch failures without delivering unsafe data', async () => {
    const invalid = makeClient({ fetcher: vi.fn(async () => Response.json({ aircraft: 'many' })) });
    invalid.client.start();
    await flushPromises();
    expect(invalid.messages).toEqual([]);
    expect(invalid.protocolErrors[0]).toContain('snapshot.aircraft must be an array.');
    invalid.client.stop();

    const failed = makeClient({
      fetcher: vi.fn(async () => {
        throw new Error('Network unavailable');
      }),
    });
    failed.client.start();
    await flushPromises();
    expect(failed.errors).toEqual(['Network unavailable']);
    failed.client.stop();
  });

  it('handles socket construction and pre-open socket errors', async () => {
    const factory = vi.fn(() => {
      throw new Error('WebSocket blocked');
    });
    const state = makeClient({ socketFactory: factory });
    state.client.start();
    await flushPromises();
    expect(state.statuses).toEqual(['connecting', 'offline']);
    expect(state.errors).toContain('WebSocket blocked');
    await vi.advanceTimersByTimeAsync(100);
    expect(factory).toHaveBeenCalledTimes(2);
    state.client.stop();

    const socketState = makeClient();
    socketState.client.start();
    await flushPromises();
    socketState.sockets[0]!.emit('error');
    expect(socketState.sockets[0]!.close).toHaveBeenCalled();
    socketState.client.stop();
  });

  it('does not close an already-open socket for a generic error event', async () => {
    const state = makeClient();
    state.client.start();
    await flushPromises();
    state.sockets[0]!.emit('open');
    state.sockets[0]!.emit('error');
    expect(state.sockets[0]!.close).not.toHaveBeenCalled();
    state.client.stop();
  });

  it('normalizes custom API roots for a bounded region identifier', async () => {
    const fetcher = vi.fn(async () => Response.json({ ...snapshot(), regionId: 'north-test' }));
    const socketFactory = vi.fn(() => new FakeSocket());
    const state = makeClient({
      regionId: 'north-test',
      apiBaseUrl: 'https://example.test/custom/',
      fetcher,
      socketFactory,
    });
    state.client.start();
    await flushPromises();
    expect(fetcher).toHaveBeenCalledWith(
      'https://example.test/custom/airspace/north-test/snapshot',
      expect.anything(),
    );
    expect(socketFactory).toHaveBeenCalledWith(
      'wss://example.test/custom/airspace/north-test/stream',
    );
    state.client.stop();
  });

  it('uses safe fallback errors and ignores malformed error health payloads', async () => {
    const nonError = makeClient({
      fetcher: vi.fn(async () => {
        throw 'network rejection';
      }),
    });
    nonError.client.start();
    await flushPromises();
    expect(nonError.errors).toContain('The live airspace request failed.');
    nonError.client.stop();

    const malformedHealth = makeClient({
      fetcher: vi.fn(async () =>
        Response.json({ error: 'UPSTREAM_UNAVAILABLE', health: null }, { status: 503 }),
      ),
    });
    malformedHealth.client.start();
    await flushPromises();
    expect(malformedHealth.messages).toEqual([]);
    expect(malformedHealth.errors).toEqual(['Snapshot request failed with HTTP 503.']);
    malformedHealth.client.stop();
  });

  it('reports a missing browser WebSocket when no socket factory is provided', async () => {
    vi.stubGlobal('WebSocket', undefined);
    const statuses: LiveTransportStatus[] = [];
    const errors: string[] = [];
    const client = new LiveAirspaceClient({
      regionId: 'atlanta',
      fetcher: vi.fn(async () => Response.json(snapshot())),
      onMessage: vi.fn(),
      onStatus: (status) => statuses.push(status),
      onError: (message) => errors.push(message),
    });
    client.start();
    await flushPromises();
    expect(errors).toContain('WebSocket is not available.');
    expect(statuses).toContain('offline');
    client.stop();
  });

  it('is idempotent and ignores a snapshot that resolves after stop', async () => {
    let resolveResponse!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    const state = makeClient({ fetcher: vi.fn(() => pending) });
    state.client.start();
    state.client.start();
    expect(state.sockets).toHaveLength(1);
    state.client.stop();
    state.client.stop();
    resolveResponse(Response.json(snapshot()));
    await flushPromises();
    expect(state.messages).toEqual([]);
  });

  it('validates configuration', () => {
    expect(() => makeClient({ regionId: '' })).toThrow('regionId');
    expect(() => makeClient({ keepaliveMs: 999 })).toThrow('keepaliveMs');
  });

  it.each([
    'snapshot',
    'invalid-json',
    'invalid-shape',
    'health',
    'invalid-health',
    'empty-error',
    'rejection',
  ])('ignores an obsolete bootstrap %s after stop/start', async (kind) => {
    const pending = deferred<Response>();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => pending.promise)
      .mockImplementation(async () => Response.json({ ...snapshot(), sequence: 2 }));
    const state = makeClient({ fetcher });
    state.client.start();
    await flushPromises();
    state.client.stop();
    state.client.start();
    await flushPromises();
    const previousMessages = [...state.messages];
    const previousStatuses = [...state.statuses];
    if (kind === 'rejection') pending.reject(new Error('Obsolete failure.'));
    else if (kind === 'invalid-json') pending.resolve(new Response('{'));
    else if (kind === 'invalid-shape') pending.resolve(Response.json({ aircraft: 'bad' }));
    else if (kind === 'health')
      pending.resolve(Response.json({ health: healthFixture() }, { status: 503 }));
    else if (kind === 'invalid-health')
      pending.resolve(Response.json({ health: null }, { status: 503 }));
    else if (kind === 'empty-error') pending.resolve(new Response(null, { status: 503 }));
    else pending.resolve(Response.json(snapshot()));
    await flushPromises();
    expect(state.messages).toEqual(previousMessages);
    expect(state.messages[0]).toMatchObject({ snapshot: { sequence: 2 } });
    expect(state.statuses).toEqual(previousStatuses);
    expect(state.errors).toEqual([]);
    expect(state.protocolErrors).toEqual([]);
    expect(state.sockets[0]!.listenerCount).toBe(0);
    expect(state.sockets[1]!.listenerCount).toBe(4);
  });

  it('cancels a response arriving after stop without reading its body', async () => {
    const pending = deferred<Response>();
    const cancel = vi.fn();
    const state = makeClient({ fetcher: vi.fn(() => pending.promise) });
    state.client.start();
    await flushPromises();
    state.client.stop();
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }));
    pending.resolve(response);
    await flushPromises();
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
    expect(state.messages).toEqual([]);
    expect(state.errors).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops and aborts a stalled body without leaking its reader or reporting an obsolete error', async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }));
    const state = makeClient({ fetcher: vi.fn(async () => response) });
    state.client.start();
    await flushPromises();
    expect(response.body?.locked).toBe(true);
    state.client.stop();
    await flushPromises();
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
    expect(state.errors).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps new activation resources when an abort listener synchronously restarts the client', async () => {
    const signals: AbortSignal[] = [];
    let restart = true;
    const state = makeClient({
      fetcher: vi.fn((_input, init) => {
        const signal = init!.signal!;
        signals.push(signal);
        signal.addEventListener(
          'abort',
          () => {
            if (restart) {
              restart = false;
              state.client.start();
            }
          },
          { once: true },
        );
        return new Promise<Response>(() => undefined);
      }),
    });
    state.client.start();
    await flushPromises();
    const old = state.sockets[0]!;
    state.client.stop();
    await flushPromises();
    expect(signals).toHaveLength(2);
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);
    expect(old.close).toHaveBeenCalledOnce();
    expect(old.listenerCount).toBe(0);
    expect(state.sockets[1]!.close).not.toHaveBeenCalled();
    expect(state.sockets[1]!.listenerCount).toBe(4);
    expect(state.statuses).toEqual(['connecting', 'connecting']);
    state.client.stop();
    await flushPromises();
    expect(signals[1]!.aborted).toBe(true);
    expect(state.sockets[1]!.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels a timed-out bootstrap body without overwriting an accepted hello', async () => {
    const pending = deferred<Response>();
    const cancel = vi.fn();
    const state = makeClient({ fetcher: vi.fn(() => pending.promise), keepaliveMs: 60_000 });
    state.client.start();
    openStream(state.sockets[0]!);
    await vi.advanceTimersByTimeAsync(9_000);
    pending.resolve(new Response(new ReadableStream<Uint8Array>({ cancel })));
    await flushPromises();
    await vi.advanceTimersByTimeAsync(999);
    expect(state.errors).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.errors).toEqual([]);
    expect(cancel).toHaveBeenCalledOnce();
    expect(state.messages.map(({ type }) => type)).toEqual(['hello']);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('aborts a fetch ignoring its deadline and cancels a later response', async () => {
    const pending = deferred<Response>();
    let signal: AbortSignal | null | undefined;
    const state = makeClient({
      bootstrapTimeoutMs: 1_000,
      fetcher: vi.fn((_input, init) => {
        signal = init?.signal;
        return pending.promise;
      }),
    });
    state.client.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(signal?.aborted).toBe(true);
    expect(state.errors).toEqual(['The live request timed out.']);
    const cancel = vi.fn();
    pending.resolve(new Response(new ReadableStream<Uint8Array>({ cancel })));
    await flushPromises();
    expect(cancel).toHaveBeenCalledOnce();
    expect(state.messages).toEqual([]);
    expect(state.errors).toHaveLength(1);
  });

  it.each(['declared', 'chunked', 'lying-length', 'error-body'])(
    'bounds and cancels oversized bootstrap %s',
    async (kind) => {
      const cancel = vi.fn();
      let produced = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          produced++;
          controller.enqueue(new Uint8Array(512 * 1024));
        },
        cancel,
      });
      const headers = new Headers();
      if (kind === 'declared') headers.set('content-length', String(MAX_LIVE_MESSAGE_BYTES + 1));
      if (kind === 'lying-length') headers.set('content-length', '1');
      const response = new Response(body, { headers, status: kind === 'error-body' ? 503 : 200 });
      const state = makeClient({ fetcher: vi.fn(async () => response) });
      state.client.start();
      await flushPromises();
      expect(state.errors).toEqual(['The live response exceeds its byte limit.']);
      expect(state.messages).toEqual([]);
      expect(cancel).toHaveBeenCalledOnce();
      expect(produced).toBeLessThanOrEqual(kind === 'declared' ? 1 : 6);
      expect(response.body?.locked).toBe(false);
    },
  );

  it('accepts an exactly bounded bootstrap body and rejects invalid UTF-8', async () => {
    const json = JSON.stringify(snapshot());
    const exact = makeClient({
      fetcher: vi.fn(async () => new Response(json.padEnd(MAX_LIVE_MESSAGE_BYTES, ' '))),
    });
    exact.client.start();
    await flushPromises();
    expect(exact.messages).toHaveLength(1);
    expect(exact.errors).toEqual([]);
    exact.client.stop();

    const invalid = makeClient({
      fetcher: vi.fn(async () => new Response(Uint8Array.of(0xc3, 0x28))),
    });
    invalid.client.start();
    await flushPromises();
    expect(invalid.messages).toEqual([]);
    expect(invalid.errors).toEqual(['The live response is not valid UTF-8.']);
  });

  it.each([200, 503])(
    'does not disclose malformed response content for HTTP %s',
    async (status) => {
      const state = makeClient({
        fetcher: vi.fn(async () => new Response('PRIVATE_UPSTREAM_BODY', { status })),
      });
      state.client.start();
      await flushPromises();
      expect(state.messages).toEqual([]);
      expect(state.errors).toEqual([
        status === 503
          ? 'Snapshot request failed with HTTP 503.'
          : 'The snapshot response is not valid JSON.',
      ]);
      expect(JSON.stringify([state.errors, state.protocolErrors])).not.toContain(
        'PRIVATE_UPSTREAM_BODY',
      );
    },
  );

  it.each(['restart', 'reconnect'])(
    'ignores all captured old socket callbacks after %s',
    async (transition) => {
      const state = makeClient();
      state.client.start();
      await flushPromises();
      const old = state.sockets[0]!;
      openStream(old);
      const callbacks = new Map(
        ['open', 'message', 'close', 'error'].map((type) => [type, old.capture(type)]),
      );
      if (transition === 'restart') {
        state.client.stop();
        state.client.start();
      } else {
        old.emit('close');
        await vi.advanceTimersByTimeAsync(100);
      }
      await flushPromises();
      openStream(state.sockets[1]!);
      const messages = [...state.messages];
      const statuses = [...state.statuses];
      for (const type of ['open', 'close', 'error']) {
        for (const callback of callbacks.get(type)!) callback({});
      }
      for (const callback of callbacks.get('message')!) {
        callback({ data: serverFrame(hello()) });
        callback({
          data: serverFrame({
            type: 'airspace.snapshot',
            protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
            snapshot: { ...snapshot(), sequence: 999 },
          }),
        });
        callback({ data: '{' });
        callback({ data: new Uint8Array() });
        callback({ data: 'pong' });
      }
      expect(state.messages).toEqual(messages);
      expect(state.statuses).toEqual(statuses);
      expect(state.protocolErrors).toEqual([]);
      expect(state.errors).toEqual([]);
      expect(old.listenerCount).toBe(0);
      expect(state.sockets[1]!.listenerCount).toBe(4);
      expect(state.sockets[1]!.close).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(1);
    },
  );

  it('does not let an old pong satisfy the current connection watchdog', async () => {
    const state = makeClient({ pongTimeoutMs: 1_000 });
    state.client.start();
    await flushPromises();
    const oldMessage = state.sockets[0]!.capture('message')[0]!;
    state.client.stop();
    state.client.start();
    await flushPromises();
    openStream(state.sockets[1]!);
    await vi.advanceTimersByTimeAsync(1_000);
    oldMessage({ data: 'pong' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(state.errors).toEqual(['The live connection did not answer its keepalive.']);
    expect(state.sockets[1]!.close).toHaveBeenCalledOnce();
    expect(state.sockets[1]!.listenerCount).toBe(0);
  });

  it.each(['never-open', 'no-hello', 'no-pong', 'send-throws', 'closed-without-event'])(
    'recovers exactly once from %s without requiring a close event',
    async (failure) => {
      const state = makeClient({ handshakeTimeoutMs: 1_000, pongTimeoutMs: 1_000 });
      state.client.start();
      await flushPromises();
      const socket = state.sockets[0]!;
      if (failure === 'no-hello') socket.emit('open');
      else if (failure !== 'never-open') openStream(socket);
      if (failure === 'send-throws')
        socket.send.mockImplementation(() => {
          throw new Error('Send failed.');
        });
      if (failure === 'closed-without-event') socket.readyState = 3;
      await vi.advanceTimersByTimeAsync(failure === 'no-pong' ? 2_000 : 1_000);
      expect(socket.close).toHaveBeenCalledOnce();
      expect(socket.listenerCount).toBe(0);
      expect(state.errors).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(99);
      expect(state.sockets).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(state.sockets).toHaveLength(2);
      state.client.stop();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('does not duplicate listeners, keepalives or recovery on repeated open/close events', async () => {
    const state = makeClient();
    state.client.start();
    await flushPromises();
    const socket = state.sockets[0]!;
    const close = socket.capture('close')[0]!;
    openStream(socket);
    socket.emit('open');
    expect(state.statuses.filter((status) => status === 'open')).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(socket.sent).toHaveLength(1);
    expect(parseLivePing(socket.sent[0])).toMatchObject({ type: 'ping', requestId: 'ping-1' });
    close({});
    close({});
    expect(socket.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(state.sockets).toHaveLength(2);
  });

  it.each(['connecting', 'open', 'reconnect-scheduled', 'reconnect-fired'])(
    'releases all resources when a status observer stops during %s',
    async (stage) => {
      let reconnectStatuses = 0;
      const fetcher = vi.fn(async () => Response.json(snapshot()));
      const state = makeClient({
        fetcher,
        onStatus: (status) => {
          if (status === 'reconnecting') reconnectStatuses++;
          if (
            status === stage ||
            (status === 'reconnecting' &&
              ((stage === 'reconnect-scheduled' && reconnectStatuses === 1) ||
                (stage === 'reconnect-fired' && reconnectStatuses === 2)))
          )
            state.client.stop();
        },
      });
      state.client.start();
      await flushPromises();
      if (stage !== 'connecting') state.sockets[0]!.emit('open');
      if (stage.startsWith('reconnect')) {
        state.sockets[0]!.emit('close');
        await vi.advanceTimersByTimeAsync(100);
      }
      expect(state.sockets).toHaveLength(stage === 'connecting' ? 0 : 1);
      for (const socket of state.sockets) {
        expect(socket.close).toHaveBeenCalledOnce();
        expect(socket.listenerCount).toBe(0);
      }
      if (stage === 'connecting') expect(fetcher).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('keeps a responsive connection open during a five-minute wait for provider data', async () => {
    const state = makeClient({ keepaliveMs: 30_000 });
    state.client.start();
    await flushPromises();
    const socket = state.sockets[0]!;
    openStream(socket);
    socket.emit('message', {
      data: serverFrame({
        type: 'error',
        protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
        code: 'UPSTREAM_UNAVAILABLE',
        message: 'Waiting for the provider retry deadline.',
        recoverable: true,
        retryAt: new Date(Date.parse(NOW) + 300_000).toISOString(),
      }),
    });
    socket.send.mockImplementation((data) => {
      socket.sent.push(data);
      if (parseLivePing(data)) socket.emit('message', { data: pongForRequest(data) });
    });
    await vi.advanceTimersByTimeAsync(300_000);
    expect(socket.sent.filter((message) => parseLivePing(message))).toHaveLength(10);
    expect(socket.close).not.toHaveBeenCalled();
    expect(state.sockets).toHaveLength(1);
    expect(state.errors).toEqual([]);
    expect(vi.getTimerCount()).toBe(1);
  });

  it.each(['airspace.snapshot', 'feed.health', 'error'] as const)(
    'rejects %s before hello',
    async (type) => {
      const state = makeClient();
      state.client.start();
      await flushPromises();
      state.messages.length = 0;
      const socket = state.sockets[0]!;
      socket.emit('open');
      const message: LiveStreamMessage =
        type === 'airspace.snapshot'
          ? { type, protocolVersion: LIVE_STREAM_PROTOCOL_VERSION, snapshot: snapshot() }
          : type === 'feed.health'
            ? { type, protocolVersion: LIVE_STREAM_PROTOCOL_VERSION, health: healthFixture() }
            : {
                type,
                protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
                code: 'UPSTREAM_UNAVAILABLE',
                message: 'Unavailable.',
                recoverable: true,
              };
      socket.emit('message', { data: serverFrame(message) });
      expect(state.messages).toEqual([]);
      expect(state.protocolErrors).toEqual([['The live stream must send hello before data.']]);
      expect(socket.close).toHaveBeenCalledOnce();
    },
  );

  it.each(['hello', 'snapshot', 'health', 'bootstrap'])(
    'rejects the wrong region in %s before application delivery',
    async (kind) => {
      const regionId = 'savannah-statesboro';
      const state = makeClient(
        kind === 'bootstrap'
          ? { fetcher: vi.fn(async () => Response.json({ ...snapshot(), regionId })) }
          : {},
      );
      state.client.start();
      await flushPromises();
      if (kind !== 'bootstrap') {
        const socket = state.sockets[0]!;
        if (kind === 'hello') socket.emit('open');
        else openStream(socket);
        state.messages.length = 0;
        const message: LiveStreamMessage =
          kind === 'hello'
            ? hello(regionId)
            : kind === 'snapshot'
              ? {
                  type: 'airspace.snapshot',
                  protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
                  snapshot: { ...snapshot(), regionId },
                }
              : {
                  type: 'feed.health',
                  protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
                  health: healthFixture({ regionId }),
                };
        socket.emit('message', { data: serverFrame(message) });
      }
      expect(state.messages).toEqual([]);
      expect(state.protocolErrors).toHaveLength(1);
      if (kind === 'hello') expect(state.sockets[0]!.close).toHaveBeenCalledOnce();
    },
  );

  it('increases backoff across bare opens and resets it only after a valid hello', async () => {
    const state = makeClient({
      reconnect: { initialDelayMs: 100, maximumDelayMs: 400, jitterRatio: 0 },
    });
    state.client.start();
    await flushPromises();
    state.sockets[0]!.emit('open');
    state.sockets[0]!.emit('close');
    await vi.advanceTimersByTimeAsync(100);
    state.sockets[1]!.emit('open');
    state.sockets[1]!.emit('close');
    await vi.advanceTimersByTimeAsync(199);
    expect(state.sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    openStream(state.sockets[2]!);
    state.sockets[2]!.emit('close');
    await vi.advanceTimersByTimeAsync(100);
    expect(state.sockets).toHaveLength(4);
  });

  it('caps reconnect jitter at the configured maximum', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(1);
    const state = makeClient({
      reconnect: { initialDelayMs: 100, maximumDelayMs: 100, jitterRatio: 1 },
    });
    state.client.start();
    await flushPromises();
    state.sockets[0]!.emit('close');
    await vi.advanceTimersByTimeAsync(99);
    expect(state.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.sockets).toHaveLength(2);
  });

  it('closes a factory result superseded by a synchronous restart', async () => {
    const old = new FakeSocket();
    const current = new FakeSocket();
    let first = true;
    const state = makeClient({
      socketFactory: () => {
        if (!first) return current;
        first = false;
        state.client.stop();
        state.client.start();
        return old;
      },
    });
    state.client.start();
    await flushPromises();
    expect(old.close).toHaveBeenCalledOnce();
    expect(old.listenerCount).toBe(0);
    expect(current.close).not.toHaveBeenCalled();
    expect(current.listenerCount).toBe(4);
    state.client.stop();
    expect(current.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['factory', 'handshake'])(
    'preserves recovery when an error observer throws during %s failure',
    async (failure) => {
      const observer = vi.fn((): void => {
        throw new Error('Observer failed.');
      });
      const state = makeClient({
        handshakeTimeoutMs: 1_000,
        onError: observer,
        ...(failure === 'factory'
          ? {
              socketFactory: () => {
                throw new Error('Factory failed.');
              },
            }
          : {}),
      });
      if (failure === 'factory') expect(() => state.client.start()).toThrow('Observer failed.');
      else {
        state.client.start();
        await flushPromises();
        expect(() => vi.advanceTimersByTime(1_000)).toThrow('Observer failed.');
        expect(state.sockets[0]!.close).toHaveBeenCalledOnce();
        expect(state.sockets[0]!.listenerCount).toBe(0);
      }
      await flushPromises();
      expect(observer).toHaveBeenCalledOnce();
      expect(state.statuses.at(-1)).toBe('offline');
      expect(vi.getTimerCount()).toBe(1);
      observer.mockImplementation(() => undefined);
      await vi.advanceTimersByTimeAsync(100);
      expect(state.statuses.at(-1)).toBe(failure === 'factory' ? 'offline' : 'reconnecting');
    },
  );

  it.each(['keepaliveMs', 'bootstrapTimeoutMs', 'handshakeTimeoutMs', 'pongTimeoutMs'] as const)(
    'validates every unsafe %s timer value',
    (option) => {
      for (const value of [0, 999, 1_000.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
        expect(() => makeClient({ [option]: value })).toThrow(option);
      }
    },
  );

  it.each(['initialDelayMs', 'maximumDelayMs'] as const)(
    'validates unsafe reconnect %s',
    (option) => {
      for (const value of [0, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
        expect(() => makeClient({ reconnect: { [option]: value } })).toThrow(option);
      }
    },
  );

  it('rejects nonfinite and out-of-bounds reconnect factors', () => {
    for (const multiplier of [Number.NaN, Number.POSITIVE_INFINITY, 0.5]) {
      expect(() => makeClient({ reconnect: { multiplier } })).toThrow('multiplier');
    }
    for (const jitterRatio of [Number.NaN, Number.POSITIVE_INFINITY, -0.1, 1.1]) {
      expect(() => makeClient({ reconnect: { jitterRatio } })).toThrow('jitterRatio');
    }
  });

  it('still reconnects when the reconnect status observer throws', async () => {
    let shouldThrow = false;
    const state = makeClient({
      onStatus: (status) => {
        if (shouldThrow && status === 'reconnecting') throw new Error('Status observer failed.');
      },
    });
    state.client.start();
    await flushPromises();
    state.sockets[0]!.emit('close');
    shouldThrow = true;
    expect(() => vi.advanceTimersByTime(100)).toThrow('Status observer failed.');
    expect(state.sockets).toHaveLength(2);
    expect(state.sockets[1]!.listenerCount).toBe(4);
    expect(vi.getTimerCount()).toBe(1);
    shouldThrow = false;
  });

  it('cleans a partially attached socket and reports close failures while scheduling recovery', async () => {
    const socket = new FakeSocket();
    vi.spyOn(socket, 'addEventListener')
      .mockImplementationOnce((type, listener) => {
        FakeSocket.prototype.addEventListener.call(socket, type, listener);
      })
      .mockImplementationOnce(() => {
        throw new Error('Listener setup failed.');
      });
    socket.close.mockImplementation(() => {
      throw new Error('Close failed.');
    });
    const state = makeClient({ socketFactory: () => socket });
    state.client.start();
    await flushPromises();
    expect(socket.listenerCount).toBe(0);
    expect(socket.close).toHaveBeenCalledOnce();
    expect(state.errors).toEqual([
      'The previous live connection could not close normally.',
      'Listener setup failed.',
    ]);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('recognizes an already-open factory result and uses the browser WebSocket factory', async () => {
    class BrowserSocket extends FakeSocket {
      static urls: string[] = [];
      constructor(url: string) {
        super();
        this.readyState = 1;
        BrowserSocket.urls.push(url);
      }
    }
    vi.stubGlobal('WebSocket', BrowserSocket);
    const statuses: LiveTransportStatus[] = [];
    const client = new LiveAirspaceClient({
      regionId: 'atlanta',
      fetcher: vi.fn(async () => Response.json(snapshot())),
      onMessage: vi.fn(),
      onStatus: (status) => statuses.push(status),
    });
    activeClients.add(client);
    client.start();
    await flushPromises();
    expect(BrowserSocket.urls).toEqual(['ws://localhost/api/v1/airspace/atlanta/stream']);
    expect(statuses).toEqual(['connecting', 'open']);
    client.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
