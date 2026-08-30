import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LiveAirspaceClientOptions, LiveTransportStatus } from '../../src/live/client';
import { summarizeAirspace } from '../../src/live/presentation';
import { LIVE_STREAM_PROTOCOL_VERSION, type LiveStreamMessage } from '../../src/live/protocol';
import {
  LiveAirspaceRuntime,
  type LiveClientControl,
  type LiveClientFactory,
} from '../../src/live/runtime';
import { AIRSPACE_SCHEMA_VERSION, type AirspaceSnapshot } from '../../src/live/types';
import { LIVE_FIXTURE_EPOCH } from './fixtures';

const NOW = '2026-08-27T12:00:00.000Z';

function snapshot(regionId = 'atlanta'): AirspaceSnapshot {
  return {
    schemaVersion: AIRSPACE_SCHEMA_VERSION,
    providerId: 'adsb-lol',
    feedEpoch: LIVE_FIXTURE_EPOCH,
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
        lastPositionAt: NOW,
        contactAgeSeconds: 0,
        positionAgeSeconds: 0,
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

function harness(onCreate?: (client: FakeClient) => void) {
  const clients: FakeClient[] = [];
  const factory: LiveClientFactory = (options) => {
    const client = new FakeClient(options);
    clients.push(client);
    onCreate?.(client);
    return client;
  };
  const runtime = new LiveAirspaceRuntime({
    regionId: 'atlanta',
    clientFactory: factory,
    freshnessIntervalMs: 250,
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
        feedEpoch: LIVE_FIXTURE_EPOCH,
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
    const binding = runtime.state.binding!;
    runtime.selectHistorySample('a1b2c3', 1, binding);
    runtime.selectHistorySample('a1b2c3', 99, binding);
    const second = snapshot();
    const secondTime = '2026-08-27T12:00:10.000Z';
    second.sequence = 2;
    second.generatedAt = secondTime;
    second.providerGeneratedAt = secondTime;
    second.aircraft[0]!.observedAt = secondTime;
    second.aircraft[0]!.lastContactAt = secondTime;
    second.aircraft[0]!.lastPositionAt = secondTime;
    clients[0]!.message({
      type: 'airspace.snapshot',
      protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
      snapshot: second,
    });
    const beforeWrongBinding = runtime.state;
    runtime.selectHistorySample('a1b2c3', 2, {
      ...binding,
      feedEpoch: 'superseded-feed',
    });
    expect(runtime.state).toBe(beforeWrongBinding);
    expect(runtime.state.selectedHistorySequence).toBe(1);
    runtime.selectHistorySample('a1b2c3', 2, binding);
    expect(runtime.state.selectedHistorySequence).toBe(2);

    runtime.switchRegion('savannah-statesboro');
    expect(clients[0]!.stop).toHaveBeenCalledOnce();
    expect(clients[1]!.start).toHaveBeenCalledOnce();
    expect(runtime.state).toMatchObject({ regionId: 'savannah-statesboro', phase: 'loading' });
    expect(runtime.state.trails.size).toBe(0);
    expect(runtime.state.selectedAircraftId).toBeUndefined();
    expect(runtime.state.selectedHistorySequence).toBeUndefined();
    runtime.switchRegion('savannah-statesboro');
    expect(clients).toHaveLength(2);
    runtime.stop();
  });

  it('keeps transport and errors separate from observation freshness', async () => {
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
    expect(runtime.state.transport).toBe('offline');
    expect(runtime.state.time).toBeUndefined();
    expect(summarizeAirspace(runtime.state.snapshot!.aircraft, runtime.state.time)).toMatchObject({
      current: 0,
      positioned: 0,
      timeUncertain: 1,
    });
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
      feedEpoch: LIVE_FIXTURE_EPOCH,
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

  it.each(['switch', 'stop', 'restart', 'round-trip'])(
    'ignores every old activation callback after %s',
    (transition) => {
      const { runtime, clients } = harness();
      runtime.start();
      const old = clients[0]!;
      if (transition === 'switch' || transition === 'round-trip') {
        runtime.switchRegion('savannah-statesboro');
        if (transition === 'round-trip') runtime.switchRegion('atlanta');
      } else {
        runtime.stop();
        if (transition === 'restart') runtime.start();
      }
      const previous = runtime.state;
      const notify = vi.fn();
      const unsubscribe = runtime.subscribe(notify);
      notify.mockClear();
      old.message({
        type: 'airspace.snapshot',
        protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
        snapshot: snapshot(),
      });
      old.message({
        type: 'error',
        protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
        code: 'INTERNAL_ERROR',
        message: 'Obsolete failure.',
        recoverable: false,
      });
      for (const status of ['connecting', 'open', 'offline', 'reconnecting', 'stopped'] as const)
        old.status(status);
      old.options.onProtocolError?.(['Obsolete invalid message.'], {});
      old.options.onError?.('Obsolete request failure.');
      expect(runtime.state).toBe(previous);
      expect(notify).not.toHaveBeenCalled();
      unsubscribe();
      runtime.stop();
    },
  );

  it('constructs a fresh client without retaining previous live evidence', () => {
    const { runtime, clients } = harness();
    expect(clients).toHaveLength(0);
    runtime.start();
    clients[0]!.message({
      type: 'airspace.snapshot',
      protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
      snapshot: snapshot(),
    });
    const previous = runtime.state;
    runtime.stop();
    runtime.start();
    expect(clients).toHaveLength(2);
    expect(runtime.state).not.toBe(previous);
    expect(runtime.state.snapshot).toBeUndefined();
    expect(runtime.state.time).toBeUndefined();
    expect(runtime.state.selectedAircraftId).toBeUndefined();
    expect(runtime.state.trails.size).toBe(0);
    expect(clients[0]!.stop).toHaveBeenCalledOnce();
    expect(clients[1]!.start).toHaveBeenCalledOnce();
    runtime.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not leak a timer when a subscriber stops during synchronous client start', () => {
    const { runtime, clients } = harness((client) =>
      client.start.mockImplementation(() => client.status('connecting')),
    );
    runtime.subscribe((state) => {
      if (state.phase === 'connecting') runtime.stop();
    });
    runtime.start();
    expect(clients[0]!.start).toHaveBeenCalledOnce();
    expect(clients[0]!.stop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('honors a subscriber stop during region publication before starting a new transport', () => {
    const { runtime, clients } = harness();
    runtime.start();
    runtime.subscribe((state) => {
      if (state.regionId === 'savannah-statesboro') runtime.stop();
    });
    runtime.switchRegion('savannah-statesboro');
    expect(
      clients
        .filter((client) => client.options.regionId === 'savannah-statesboro')
        .every((client) => client.start.mock.calls.length === 0),
    ).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts only the latest region when a subscriber switches again during publication', () => {
    const { runtime, clients } = harness();
    runtime.start();
    runtime.subscribe((state) => {
      if (state.regionId === 'savannah-statesboro') runtime.switchRegion('central-georgia');
    });
    runtime.switchRegion('savannah-statesboro');
    expect(runtime.state.regionId).toBe('central-georgia');
    const central = clients.filter((client) => client.options.regionId === 'central-georgia');
    expect(central).toHaveLength(1);
    expect(central[0]!.start).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);
    runtime.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not construct or start a client for a stopped region switch', () => {
    const { runtime, clients } = harness();
    runtime.switchRegion('savannah-statesboro');
    expect(clients).toHaveLength(0);
    runtime.start();
    expect(clients[0]!.options.regionId).toBe('savannah-statesboro');
    runtime.stop();
  });

  it('recovers cleanly from client construction and start failures', () => {
    const factory = vi.fn((): LiveClientControl => {
      throw new Error('Factory failed.');
    });
    const runtime = new LiveAirspaceRuntime({ regionId: 'atlanta', clientFactory: factory });
    expect(() => runtime.start()).not.toThrow();
    expect(runtime.state).toMatchObject({ phase: 'error', lastError: 'Factory failed.' });
    expect(vi.getTimerCount()).toBe(0);

    const failed = harness((client) =>
      client.start.mockImplementation(() => {
        throw new Error('Start failed.');
      }),
    );
    failed.runtime.start();
    expect(failed.runtime.state).toMatchObject({ phase: 'error', lastError: 'Start failed.' });
    expect(failed.clients[0]!.stop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648, 250.5])(
    'rejects unsafe freshness timer %s',
    (freshnessIntervalMs) => {
      expect(() => new LiveAirspaceRuntime({ regionId: 'atlanta', freshnessIntervalMs })).toThrow(
        'freshnessIntervalMs',
      );
    },
  );

  it('releases a client returned after its factory synchronously stops the runtime', () => {
    const state = harness(() => state.runtime.stop());
    state.runtime.start();
    expect(state.clients[0]!.start).not.toHaveBeenCalled();
    expect(state.clients[0]!.stop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts only the current region when a factory changes regions synchronously', () => {
    const state = harness((client) => {
      if (client.options.regionId === 'atlanta') state.runtime.switchRegion('savannah-statesboro');
    });
    state.runtime.start();
    expect(state.runtime.state.regionId).toBe('savannah-statesboro');
    expect(state.clients).toHaveLength(2);
    expect(state.clients[0]!.start).not.toHaveBeenCalled();
    expect(state.clients[0]!.stop).toHaveBeenCalledOnce();
    expect(state.clients[1]!.start).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);
    state.runtime.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores callbacks emitted during construction before the activation owns the client', () => {
    const state = harness((client) => {
      client.status('offline');
      client.options.onError?.('Constructor callback.');
    });
    state.runtime.start();
    expect(state.runtime.state.phase).toBe('loading');
    expect(state.runtime.state.lastError).toBeUndefined();
    state.clients[0]!.status('open');
    expect(state.runtime.state.phase).toBe('connecting');
    state.runtime.stop();
  });

  it('clears timers and reports a current stop failure without repeating cleanup', () => {
    const state = harness();
    state.runtime.start();
    state.clients[0]!.stop.mockImplementation(() => {
      throw new Error('Stop failed.');
    });
    expect(() => state.runtime.stop()).not.toThrow();
    expect(state.runtime.state).toMatchObject({ phase: 'error', lastError: 'Stop failed.' });
    expect(vi.getTimerCount()).toBe(0);
    state.runtime.stop();
    expect(state.clients[0]!.stop).toHaveBeenCalledOnce();
  });

  it('fails closed on a region-change cleanup failure and can start the new region explicitly', () => {
    const state = harness();
    state.runtime.start();
    state.clients[0]!.stop.mockImplementation(() => {
      throw new Error('Stop failed.');
    });
    state.runtime.switchRegion('savannah-statesboro');
    expect(state.runtime.state).toMatchObject({ regionId: 'savannah-statesboro', phase: 'error' });
    expect(state.clients).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    state.runtime.start();
    expect(state.clients[1]!.options.regionId).toBe('savannah-statesboro');
    expect(state.clients[1]!.start).toHaveBeenCalledOnce();
    state.runtime.stop();
  });

  it('does not overwrite a restart with a superseded stop failure', () => {
    const state = harness();
    state.runtime.start();
    state.clients[0]!.stop.mockImplementation(() => {
      state.runtime.start();
      throw new Error('Obsolete cleanup failure.');
    });
    state.runtime.stop();
    expect(state.clients[1]!.start).toHaveBeenCalledOnce();
    expect(state.runtime.state.lastError).toBeUndefined();
    expect(vi.getTimerCount()).toBe(1);
    state.runtime.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('honors a nested region switch triggered during old-client cleanup', () => {
    const state = harness();
    state.runtime.start();
    state.clients[0]!.stop.mockImplementation(() => state.runtime.switchRegion('central-georgia'));
    state.runtime.switchRegion('savannah-statesboro');
    expect(state.runtime.state.regionId).toBe('central-georgia');
    expect(state.clients).toHaveLength(2);
    expect(state.clients[1]!.options.regionId).toBe('central-georgia');
    expect(state.clients[1]!.start).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);
    state.runtime.stop();
  });

  it('does not deliver an obsolete outer notification after a subscriber changes regions', () => {
    const state = harness();
    state.runtime.subscribe((snapshot) => {
      if (snapshot.phase === 'live') state.runtime.switchRegion('savannah-statesboro');
    });
    const notifiedRegions: string[] = [];
    state.runtime.subscribe((snapshot) => notifiedRegions.push(snapshot.regionId));
    notifiedRegions.length = 0;
    state.runtime.start();
    state.clients[0]!.message({
      type: 'airspace.snapshot',
      protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
      snapshot: snapshot(),
    });
    expect(notifiedRegions).toEqual(['savannah-statesboro']);
    state.runtime.stop();
  });

  it('reports a non-Error startup failure and a separate cleanup failure', () => {
    const state = harness((client) => {
      client.start.mockImplementation(() => {
        throw undefined;
      });
      client.stop.mockImplementation(() => {
        throw new Error('Cleanup failed.');
      });
    });
    state.runtime.start();
    expect(state.runtime.state.lastError).toBe(
      'The live transport lifecycle failed. The transport also failed to stop normally.',
    );
    expect(vi.getTimerCount()).toBe(0);
  });
});
