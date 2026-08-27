import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  LiveAirspaceClient,
  type LiveSocket,
  type LiveSocketEvent,
  type LiveTransportStatus,
} from '../../src/live/client';
import {
  LIVE_STREAM_PROTOCOL_VERSION,
  serializeLiveStreamMessage,
  type LiveStreamMessage,
} from '../../src/live/protocol';
import { AIRSPACE_SCHEMA_VERSION, type AirspaceSnapshot } from '../../src/live/types';

const NOW = '2026-08-27T12:00:00.000Z';

function snapshot(): AirspaceSnapshot {
  return {
    schemaVersion: AIRSPACE_SCHEMA_VERSION,
    providerId: 'adsb-lol',
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

  send(data: string): void {
    this.sent.push(data);
  }

  emit(type: string, event: LiveSocketEvent = {}): void {
    if (type === 'open') this.readyState = 1;
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
  return { client, messages, statuses, errors, protocolErrors, sockets };
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

describe('LiveAirspaceClient', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('loads the initial snapshot, opens a stream, and sends keepalives', async () => {
    const state = makeClient();
    state.client.start();
    await flushPromises();
    expect(state.messages[0]).toMatchObject({ type: 'airspace.snapshot' });
    expect(state.statuses).toEqual(['connecting']);

    state.sockets[0]!.emit('open');
    expect(state.statuses.at(-1)).toBe('open');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(state.sockets[0]!.sent).toEqual(['ping']);

    state.sockets[0]!.emit('message', { data: 'pong' });
    state.client.stop();
    expect(state.statuses.at(-1)).toBe('stopped');
    expect(state.sockets[0]!.close).toHaveBeenCalledWith(1000, 'client stop');
  });

  it('delivers valid stream messages and rejects malformed payloads', async () => {
    const state = makeClient();
    state.client.start();
    await flushPromises();
    state.sockets[0]!.emit('open');

    state.sockets[0]!.emit('message', {
      data: serializeLiveStreamMessage({
        type: 'hello',
        protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
        schemaVersion: AIRSPACE_SCHEMA_VERSION,
        regionId: 'atlanta',
        providerId: 'adsb-lol',
        pollIntervalMs: 10_000,
        generatedAt: NOW,
      }),
    });
    state.sockets[0]!.emit('message', { data: '{' });
    state.sockets[0]!.emit('message', { data: new Uint8Array() });

    expect(state.messages.some(({ type }) => type === 'hello')).toBe(true);
    expect(state.protocolErrors).toEqual([
      ['Message is not valid JSON.'],
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

  it('normalizes custom API roots and safely encodes the region path', async () => {
    const fetcher = vi.fn(async () => Response.json({ ...snapshot(), regionId: 'north test' }));
    const socketFactory = vi.fn(() => new FakeSocket());
    const state = makeClient({
      regionId: 'north test',
      apiBaseUrl: 'https://example.test/custom/',
      fetcher,
      socketFactory,
    });
    state.client.start();
    await flushPromises();
    expect(fetcher).toHaveBeenCalledWith(
      'https://example.test/custom/airspace/north%20test/snapshot',
      expect.anything(),
    );
    expect(socketFactory).toHaveBeenCalledWith(
      'wss://example.test/custom/airspace/north%20test/stream',
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
});
