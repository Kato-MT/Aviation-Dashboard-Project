import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LiveAirspaceClientOptions, LiveTransportStatus } from '../../src/live/client';
import { LIVE_STREAM_PROTOCOL_VERSION, type LiveStreamMessage } from '../../src/live/protocol';
import {
  LiveAirspaceRuntime,
  type LiveClientControl,
  type LiveClientFactory,
} from '../../src/live/runtime';
import { AIRSPACE_SCHEMA_VERSION, type AirspaceSnapshot } from '../../src/live/types';

const NOW = '2026-08-27T12:00:00.000Z';

function snapshot(regionId = 'atlanta'): AirspaceSnapshot {
  return {
    schemaVersion: AIRSPACE_SCHEMA_VERSION,
    providerId: 'adsb-lol',
    regionId,
    sequence: 1,
    generatedAt: NOW,
    providerGeneratedAt: NOW,
    aircraft: [
      {
        aircraftId: 'a1b2c3',
        identifierKind: 'icao24',
        position: { latitude: 33.6, longitude: -84.4 },
        onGround: false,
        observedAt: NOW,
        lastContactAt: NOW,
        contactAgeSeconds: 0,
        qualityFlags: [],
      },
    ],
    validation: {
      receivedAircraft: 1,
      acceptedAircraft: 1,
      rejectedAircraft: 0,
      duplicateAircraft: 0,
      invalidFields: 0,
    },
  };
}

class FakeClient implements LiveClientControl {
  readonly start = vi.fn();
  readonly stop = vi.fn();

  constructor(readonly options: LiveAirspaceClientOptions) {}

  message(message: LiveStreamMessage): void {
    this.options.onMessage(message);
  }

  status(status: LiveTransportStatus): void {
    this.options.onStatus(status);
  }
}

function harness() {
  const clients: FakeClient[] = [];
  const factory: LiveClientFactory = (options) => {
    const client = new FakeClient(options);
    clients.push(client);
    return client;
  };
  const runtime = new LiveAirspaceRuntime({
    regionId: 'atlanta',
    clientFactory: factory,
    freshnessIntervalMs: 250,
    now: () => Date.parse(NOW) + 100_000,
  });
  return { runtime, clients };
}

describe('LiveAirspaceRuntime', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('starts, stops, and publishes transport and snapshot state', () => {
    const { runtime, clients } = harness();
    const phases: string[] = [];
    const unsubscribe = runtime.subscribe((state) => phases.push(state.phase));
    runtime.start();
    runtime.start();
    expect(clients[0]!.start).toHaveBeenCalledTimes(1);

    clients[0]!.status('connecting');
    clients[0]!.status('open');
    clients[0]!.message({
      type: 'airspace.snapshot',
      protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
      snapshot: snapshot(),
    });
    expect(runtime.state).toMatchObject({ phase: 'live', snapshot: { sequence: 1 } });

    unsubscribe();
    runtime.stop();
    runtime.stop();
    expect(clients[0]!.stop).toHaveBeenCalledTimes(1);
    expect(phases).toEqual(['loading', 'connecting', 'connecting', 'live']);
  });

  it('applies health and stream errors without hiding the last valid snapshot', () => {
    const { runtime, clients } = harness();
    runtime.start();
    clients[0]!.message({
      type: 'airspace.snapshot',
      protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
      snapshot: snapshot(),
    });
    clients[0]!.message({
      type: 'feed.health',
      protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
      health: {
        schemaVersion: AIRSPACE_SCHEMA_VERSION,
        regionId: 'atlanta',
        providerId: 'adsb-lol',
        status: 'degraded',
        checkedAt: NOW,
        consecutiveFailures: 1,
        message: 'Provider delayed.',
      },
    });
    expect(runtime.state.phase).toBe('degraded');

    clients[0]!.message({
      type: 'error',
      protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
      code: 'UPSTREAM_UNAVAILABLE',
      message: 'Retrying provider.',
      recoverable: true,
    });
    expect(runtime.state).toMatchObject({ phase: 'degraded', lastError: 'Retrying provider.' });
    expect(runtime.state.snapshot).toBeDefined();

    clients[0]!.message({
      type: 'error',
      protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
      code: 'INTERNAL_ERROR',
      message: 'Unrecoverable stream error.',
      recoverable: false,
    });
    expect(runtime.state).toMatchObject({
      phase: 'error',
      lastError: 'Unrecoverable stream error.',
    });
    runtime.stop();
  });

  it('switches fixed regions without retaining aircraft or trails', () => {
    const { runtime, clients } = harness();
    runtime.start();
    clients[0]!.message({
      type: 'airspace.snapshot',
      protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
      snapshot: snapshot(),
    });
    runtime.selectAircraft('a1b2c3');
    runtime.selectAircraft('unknown');
    expect(runtime.state.selectedAircraftId).toBe('a1b2c3');

    runtime.switchRegion('savannah-statesboro');
    expect(clients[0]!.stop).toHaveBeenCalledOnce();
    expect(clients[1]!.start).toHaveBeenCalledOnce();
    expect(runtime.state).toMatchObject({ regionId: 'savannah-statesboro', phase: 'loading' });
    expect(runtime.state.trails.size).toBe(0);
    expect(runtime.state.selectedAircraftId).toBeUndefined();
    runtime.switchRegion('savannah-statesboro');
    expect(clients).toHaveLength(2);
    runtime.stop();
  });

  it('publishes reconnect, offline, protocol, client, and freshness transitions', async () => {
    const { runtime, clients } = harness();
    runtime.start();
    clients[0]!.status('reconnecting');
    expect(runtime.state.phase).toBe('reconnecting');
    clients[0]!.status('offline');
    expect(runtime.state).toMatchObject({
      phase: 'offline',
      lastError: 'The live stream is temporarily offline.',
    });
    clients[0]!.options.onProtocolError?.(['bad schema'], {});
    expect(runtime.state.lastError).toContain('Rejected live message');
    clients[0]!.options.onError?.('Initial snapshot failed.');
    expect(runtime.state.lastError).toBe('Initial snapshot failed.');

    clients[0]!.message({
      type: 'airspace.snapshot',
      protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
      snapshot: snapshot(),
    });
    await vi.advanceTimersByTimeAsync(250);
    expect(runtime.state.phase).toBe('offline');
    runtime.stop();
  });

  it('accepts hello messages without changing aircraft evidence', () => {
    const { runtime, clients } = harness();
    runtime.start();
    clients[0]!.message({
      type: 'hello',
      protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
      schemaVersion: AIRSPACE_SCHEMA_VERSION,
      regionId: 'atlanta',
      providerId: 'adsb-lol',
      pollIntervalMs: 10_000,
      generatedAt: NOW,
    });
    expect(runtime.state.snapshot).toBeUndefined();
    runtime.stop();
  });

  it('validates fixed regions and freshness cadence', () => {
    expect(() => new LiveAirspaceRuntime({ regionId: 'worldwide' })).toThrow('Unknown');
    expect(
      () => new LiveAirspaceRuntime({ regionId: 'atlanta', freshnessIntervalMs: 249 }),
    ).toThrow('freshnessIntervalMs');
    const { runtime } = harness();
    expect(() => runtime.switchRegion('worldwide')).toThrow('Unknown');
  });
});
