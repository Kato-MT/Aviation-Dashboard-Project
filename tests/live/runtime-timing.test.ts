import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LiveAirspaceClientOptions } from '../../src/live/client';
import { LiveServerClock, type ServerTimeSample } from '../../src/live/clock';
import { aircraftEvidence } from '../../src/live/freshness';
import { filterAircraft, summarizeAirspace } from '../../src/live/presentation';
import { LIVE_STREAM_PROTOCOL_VERSION } from '../../src/live/protocol';
import { LiveAirspaceRuntime } from '../../src/live/runtime';
import {
  aircraftFixture,
  healthFixture,
  LIVE_FIXTURE_EPOCH,
  LIVE_FIXTURE_TIME,
  liveMessageFixtures,
  snapshotFixture,
} from './fixtures';

const BASE = Date.parse(LIVE_FIXTURE_TIME);
const runtimes: LiveAirspaceRuntime[] = [];

function harness() {
  let elapsed = 0;
  let wallJump = 0;
  const clients: LiveAirspaceClientOptions[] = [];
  const clock = new LiveServerClock({
    monotonicNow: () => elapsed,
    wallNow: () => BASE + 7 * 86_400_000 + elapsed + wallJump,
  });
  const runtime = new LiveAirspaceRuntime({
    regionId: 'atlanta',
    clock,
    freshnessIntervalMs: 250,
    clientFactory: (options) => {
      clients.push(options);
      return {
        start: () => {
          options.onFeedBinding?.({
            providerId: 'adsb-lol',
            regionId: options.regionId,
            feedEpoch: LIVE_FIXTURE_EPOCH,
          });
          options.onStatus('open');
        },
        stop: vi.fn(),
      };
    },
  });
  runtimes.push(runtime);
  const active = () => clients.at(-1)!;
  const sample = (): ServerTimeSample => ({
    sent: clock.read(),
    received: clock.read(),
    serverAt: new Date(BASE + elapsed).toISOString(),
  });
  return {
    runtime,
    clients,
    sample,
    synchronize: () => active().onTimeSample?.(sample()),
    observe: () =>
      active().onMessage({
        type: 'airspace.snapshot',
        protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
        snapshot: snapshotFixture({ regionId: runtime.state.regionId }),
      }),
    async advanceTo(next: number) {
      const delta = next - elapsed;
      elapsed = next;
      await vi.advanceTimersByTimeAsync(delta);
    },
    jumpWall: () => {
      wallJump += 60_000;
    },
    active,
  };
}

function projection(runtime: LiveAirspaceRuntime) {
  const { snapshot, time } = runtime.state;
  const aircraft = snapshot?.aircraft ?? [];
  return {
    summary: summarizeAirspace(aircraft, time),
    positioned: filterAircraft(aircraft, { positionedOnly: true }, time),
    current: filterAircraft(aircraft, { quality: 'current' }, time),
    uncertain: filterAircraft(aircraft, { quality: 'time-uncertain' }, time),
  };
}

describe('live runtime evidence time integration', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    for (const runtime of runtimes.splice(0)) runtime.stop();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it('withholds current positions until measured synchronization, ignoring wall-clock offset', () => {
    const state = harness();
    state.runtime.start();
    state.observe();
    expect(state.runtime.state.transport).toBe('open');
    expect(projection(state.runtime)).toMatchObject({
      summary: { current: 0, positioned: 0, timeUncertain: 1 },
      positioned: [],
      current: [],
    });
    expect(projection(state.runtime).uncertain).toHaveLength(1);
    state.synchronize();
    expect(projection(state.runtime).summary).toMatchObject({
      current: 1,
      positioned: 1,
      timeUncertain: 0,
    });
    expect(projection(state.runtime).current).toHaveLength(1);
  });

  it('ages the same snapshot through conservative boundaries without copying its history', async () => {
    const state = harness();
    state.runtime.start();
    state.observe();
    state.synchronize();
    const snapshot = state.runtime.state.snapshot!;
    const trails = state.runtime.state.trails;
    const cases = [
      [14_750, 'current'],
      [15_000, 'delayed'],
      [30_000, 'delayed'],
      [44_750, 'delayed'],
      [45_000, 'stale'],
      [60_000, 'stale'],
      [90_000, 'stale'],
      [119_750, 'stale'],
      [120_000, 'expired'],
    ] as const;
    for (const [elapsed, expected] of cases) {
      await state.advanceTo(elapsed);
      if (elapsed % 30_000 === 0) state.synchronize();
      const evidence = aircraftEvidence(snapshot.aircraft[0]!, state.runtime.state.time);
      expect(evidence.position.freshness, String(elapsed)).toBe(expected);
      expect(state.runtime.state.snapshot).toBe(snapshot);
      expect(state.runtime.state.trails).toBe(trails);
      expect(state.runtime.state.transport).toBe('open');
      const displayed = projection(state.runtime);
      expect(displayed.positioned).toHaveLength(expected === 'expired' ? 0 : 1);
      expect(displayed.summary.current).toBe(expected === 'current' ? 1 : 0);
      expect(displayed.summary.delayed).toBe(expected === 'delayed' ? 1 : 0);
      expect(displayed.summary.stale).toBe(expected === 'stale' ? 1 : 0);
    }
    expect(projection(state.runtime).summary.observed).toBe(0);
  });

  it('expires synchronization even while the transport remains open', async () => {
    const state = harness();
    state.runtime.start();
    state.observe();
    state.synchronize();
    await state.advanceTo(60_000);
    expect(state.runtime.state.time).toBeUndefined();
    expect(state.runtime.state.transport).toBe('open');
    expect(projection(state.runtime).summary).toMatchObject({
      current: 0,
      positioned: 0,
      timeUncertain: 1,
    });
    state.synchronize();
    expect(projection(state.runtime).summary).toMatchObject({
      current: 0,
      stale: 1,
      timeUncertain: 0,
    });
  });

  it('expires departed session history during an outage after synchronization has expired', async () => {
    const state = harness();
    state.runtime.start();
    state.observe();
    state.synchronize();
    state.runtime.selectAircraft('a1b2c3');
    const history = state.runtime.state.histories;
    state.active().onMessage({
      type: 'airspace.snapshot',
      protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
      snapshot: snapshotFixture({ sequence: 2, aircraft: [] }),
    });
    expect(state.runtime.state.histories.size).toBe(1);
    await state.advanceTo(60_000);
    expect(state.runtime.state.time).toBeUndefined();
    expect(state.runtime.state.histories.size).toBe(1);
    await state.advanceTo(15 * 60_000);
    expect(state.runtime.state.time).toBeUndefined();
    expect(state.runtime.state.transport).toBe('open');
    expect(state.runtime.state.histories.size).toBe(0);
    expect(state.runtime.state.trails.size).toBe(0);
    expect(history.size).toBe(1);
    const expired = state.runtime.state;
    await state.advanceTo(15 * 60_000 + 1_000);
    expect(state.runtime.state).toBe(expired);
  });

  it('requires resynchronization after a wall/monotonic discontinuity', async () => {
    const state = harness();
    state.runtime.start();
    state.observe();
    state.synchronize();
    state.jumpWall();
    await state.advanceTo(250);
    expect(state.runtime.state.time).toBeUndefined();
    expect(state.runtime.state.histories.size).toBe(0);
    expect(state.runtime.state.trails.size).toBe(0);
    expect(projection(state.runtime).positioned).toEqual([]);
    state.synchronize();
    expect(projection(state.runtime).summary.current).toBe(1);
  });

  it.each(['restart', 'region'] as const)(
    'clears evidence and rejects obsolete timing after %s',
    (transition) => {
      const state = harness();
      state.runtime.start();
      state.observe();
      state.synchronize();
      state.runtime.selectAircraft('a1b2c3');
      const old = state.active();
      const oldSample = state.sample();
      if (transition === 'restart') {
        state.runtime.stop();
        state.runtime.start();
      } else state.runtime.switchRegion('savannah-statesboro');
      expect(state.runtime.state.snapshot).toBeUndefined();
      expect(state.runtime.state.time).toBeUndefined();
      expect(state.runtime.state.selectedAircraftId).toBeUndefined();
      expect(state.runtime.state.trails.size).toBe(0);
      old.onTimeSample?.(oldSample);
      expect(state.runtime.state.time).toBeUndefined();
      state.observe();
      expect(projection(state.runtime).summary.current).toBe(0);
      state.synchronize();
      expect(projection(state.runtime).summary.current).toBe(1);
    },
  );

  it('retains a current-contact row but excludes its expired position', async () => {
    const state = harness();
    state.runtime.start();
    await state.advanceTo(120_000);
    state.synchronize();
    const now = new Date(BASE + 120_000).toISOString();
    const track = aircraftFixture({ observedAt: now, lastContactAt: now, positionAgeSeconds: 120 });
    state.active().onMessage({
      type: 'airspace.snapshot',
      protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
      snapshot: snapshotFixture({ generatedAt: now, providerGeneratedAt: now, aircraft: [track] }),
    });
    expect(projection(state.runtime).summary).toMatchObject({
      observed: 1,
      positioned: 0,
      current: 0,
      expiredPosition: 1,
    });
    expect(filterAircraft([track], { quality: 'expired' }, state.runtime.state.time)).toEqual([
      track,
    ]);
    expect(projection(state.runtime).positioned).toEqual([]);
  });

  it('clears the old epoch before synchronizing the new hello and accepting its sequence reset', () => {
    const state = harness();
    state.runtime.start();
    state.observe();
    state.synchronize();
    state.runtime.selectAircraft('a1b2c3');
    state.active().onMessage({
      type: 'feed.health',
      protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
      health: healthFixture({ status: 'degraded' }),
    });
    state.active().onError?.('An earlier connection error.');
    expect(state.runtime.state.time).toBeDefined();
    expect(state.runtime.state.trails.size).toBe(1);
    expect(state.runtime.state.qualityEvents.length).toBeGreaterThan(0);

    const binding = { providerId: 'adsb-lol', regionId: 'atlanta', feedEpoch: 'test-feed-2' };
    state.active().onFeedBinding?.(binding);
    expect(state.runtime.state.binding).toEqual(binding);
    expect(state.runtime.state.snapshot).toBeUndefined();
    expect(state.runtime.state.health).toBeUndefined();
    expect(state.runtime.state.time).toBeUndefined();
    expect(state.runtime.state.selectedAircraftId).toBeUndefined();
    expect(state.runtime.state.lastError).toBeUndefined();
    expect(state.runtime.state.trails.size).toBe(0);
    expect(state.runtime.state.qualityEvents).toEqual([]);
    expect(state.runtime.state.transport).toBe('open');

    state.synchronize();
    const synchronizedTime = state.runtime.state.time;
    const hello = liveMessageFixtures().find((message) => message.type === 'hello')!;
    state.active().onMessage({ ...hello, ...binding });
    expect(state.runtime.state.time).toBe(synchronizedTime);
    state.active().onMessage({
      type: 'airspace.snapshot',
      protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
      snapshot: snapshotFixture({ ...binding, sequence: 0 }),
    });
    expect(projection(state.runtime).summary.current).toBe(1);
    const accepted = state.runtime.state;
    state.active().onMessage({
      type: 'airspace.snapshot',
      protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
      snapshot: snapshotFixture({ sequence: 100 }),
    });
    state.active().onMessage({
      type: 'feed.health',
      protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
      health: healthFixture({ checkedAt: '2026-08-27T12:01:00.000Z', status: 'offline' }),
    });
    expect(state.runtime.state).toBe(accepted);
  });

  it('retains accepted evidence and timing for a repeated hello or rejected feed binding', () => {
    const state = harness();
    state.runtime.start();
    state.observe();
    state.synchronize();
    const accepted = state.runtime.state;
    state.active().onMessage(liveMessageFixtures().find((message) => message.type === 'hello')!);
    for (const change of [
      { providerId: 'another-provider' },
      { regionId: 'savannah-statesboro' },
      { feedEpoch: '' },
    ]) {
      state.active().onFeedBinding?.({ ...accepted.binding!, ...change });
      expect(state.runtime.state).toBe(accepted);
    }
  });
});
