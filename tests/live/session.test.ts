import { describe, expect, it } from 'vitest';

import { LIVE_HISTORY_RETENTION_MS } from '../../src/live/history';
import { LiveAirspaceSession } from '../../src/live/session';
import { LIVE_FIXTURE_EPOCH } from './fixtures';
import {
  AIRSPACE_SCHEMA_VERSION,
  type AirspaceSnapshot,
  type LiveFeedHealth,
} from '../../src/live/types';

const BASE_TIME = '2026-08-27T12:00:00.000Z';

function snapshot(sequence: number, overrides: Partial<AirspaceSnapshot> = {}): AirspaceSnapshot {
  return {
    schemaVersion: AIRSPACE_SCHEMA_VERSION,
    providerId: 'adsb-lol',
    feedEpoch: LIVE_FIXTURE_EPOCH,
    regionId: 'atlanta',
    sequence,
    generatedAt: new Date(Date.parse(BASE_TIME) + sequence * 10_000).toISOString(),
    providerGeneratedAt: new Date(Date.parse(BASE_TIME) + sequence * 10_000).toISOString(),
    aircraft: [
      {
        aircraftId: 'a1b2c3',
        identifierKind: 'icao24',
        callsign: 'DAL123',
        position: { latitude: 33.6 + sequence / 100, longitude: -84.4 },
        barometricAltitudeFeet: 12_000 + sequence * 100,
        onGround: false,
        observedAt: new Date(Date.parse(BASE_TIME) + sequence * 10_000).toISOString(),
        lastContactAt: new Date(Date.parse(BASE_TIME) + sequence * 10_000).toISOString(),
        lastPositionAt: new Date(Date.parse(BASE_TIME) + sequence * 10_000).toISOString(),
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
    ...overrides,
  };
}

function health(status: LiveFeedHealth['status']): LiveFeedHealth {
  return {
    schemaVersion: AIRSPACE_SCHEMA_VERSION,
    regionId: 'atlanta',
    providerId: 'adsb-lol',
    feedEpoch: LIVE_FIXTURE_EPOCH,
    status,
    checkedAt: '2026-08-27T12:01:00.000Z',
    consecutiveFailures: status === 'live' ? 0 : 1,
    message: status === 'live' ? 'Live feed is current.' : 'Upstream is delayed.',
  };
}

describe('LiveAirspaceSession', () => {
  it('starts loading and keeps bounded, session-only trails', () => {
    const session = new LiveAirspaceSession('atlanta', { maximumTrailPoints: 2 });
    expect(session.state).toMatchObject({ regionId: 'atlanta', phase: 'loading' });

    session.applySnapshot(snapshot(1));
    session.applySnapshot(snapshot(2));
    const result = session.applySnapshot(snapshot(3));

    expect(result.phase).toBe('live');
    const trail = result.trails.get('a1b2c3');
    expect(trail).toHaveLength(2);
    expect(trail?.[0]?.latitude).toBeCloseTo(33.62);
    expect(trail?.[1]).toEqual(expect.objectContaining({ latitude: 33.63 }));
    const history = result.histories.get('a1b2c3')!;
    expect(history.samples.map((sample) => sample.measurements?.barometricAltitudeFeet)).toEqual([
      12_200, 12_300,
    ]);
    expect(history.samples.map((sample) => sample.sequence)).toEqual([2, 3]);
    expect(history.incompleteReasons).toContain('sample-limit');
  });

  it('ignores duplicate and out-of-order snapshots and trail points', () => {
    const session = new LiveAirspaceSession('atlanta');
    const current = snapshot(2);
    session.applySnapshot(current);
    expect(session.applySnapshot(current)).toBe(session.state);
    session.applySnapshot(snapshot(1));
    expect(session.state.snapshot?.sequence).toBe(2);
    expect(session.state.trails.get('a1b2c3')).toHaveLength(1);
  });

  it('does not repeat an unchanged position in a newer snapshot', () => {
    const session = new LiveAirspaceSession('atlanta');
    const first = snapshot(1);
    session.applySnapshot(first);
    const second = snapshot(2);
    second.aircraft[0]!.lastPositionAt = first.aircraft[0]!.lastPositionAt;
    second.aircraft[0]!.position = first.aircraft[0]!.position;
    session.applySnapshot(second);
    expect(session.state.trails.get('a1b2c3')).toHaveLength(1);
  });

  it('turns aircraft quality flags into a bounded evidence ledger', () => {
    const session = new LiveAirspaceSession('atlanta', { maximumQualityEvents: 3 });
    const flagged = snapshot(1);
    flagged.aircraft[0]!.qualityFlags = [
      'stale-contact',
      'stale-position',
      'missing-position',
      'provider-time-regression',
    ];
    const state = session.applySnapshot(flagged);
    expect(state.qualityEvents).toHaveLength(3);
    expect(state.qualityEvents.map(({ code }) => code)).toEqual([
      'LIVE-DQ-002',
      'LIVE-DQ-003',
      'LIVE-DQ-004',
    ]);
  });

  it('records quality-state transitions without repeating an unchanged warning', () => {
    const session = new LiveAirspaceSession('atlanta');
    const first = snapshot(1);
    first.aircraft[0]!.qualityFlags = ['stale-position'];
    session.applySnapshot(first);
    const second = snapshot(2);
    second.aircraft[0]!.qualityFlags = ['stale-position'];
    expect(session.applySnapshot(second).qualityEvents).toHaveLength(1);

    session.applyHealth(health('degraded'));
    session.applyHealth({ ...health('degraded'), checkedAt: '2026-08-27T12:01:01.000Z' });
    expect(session.state.qualityEvents.filter(({ code }) => code === 'LIVE-DQ-005')).toHaveLength(
      1,
    );
  });

  it('bounds total aircraft trails and evicts tracks absent from the current picture first', () => {
    const session = new LiveAirspaceSession('atlanta', { maximumAircraftTrails: 2 });
    const first = snapshot(1);
    first.aircraft = [
      first.aircraft[0]!,
      {
        ...first.aircraft[0]!,
        aircraftId: 'old-track',
        position: { latitude: 33, longitude: -84 },
      },
    ];
    session.applySnapshot(first);
    const second = snapshot(2);
    second.aircraft = [
      second.aircraft[0]!,
      {
        ...second.aircraft[0]!,
        aircraftId: 'new-track',
        position: { latitude: 34, longitude: -84 },
      },
    ];
    const trails = session.applySnapshot(second).trails;
    expect([...trails.keys()]).toEqual(['a1b2c3', 'new-track']);
  });

  it('tracks feed health, upstream evidence, selection, and errors', () => {
    const session = new LiveAirspaceSession('atlanta');
    expect(session.markConnecting().phase).toBe('connecting');
    expect(session.markConnecting(true).phase).toBe('reconnecting');
    expect(session.markConnected().phase).toBe('connecting');
    expect(session.recordError('Snapshot failed.').lastError).toBe('Snapshot failed.');
    expect(session.markOffline('Stream offline.')).toMatchObject({
      phase: 'offline',
      lastError: 'Stream offline.',
    });
    expect(session.applyHealth(health('degraded')).qualityEvents.at(-1)).toMatchObject({
      code: 'LIVE-DQ-005',
      kind: 'upstream-degraded',
    });
    expect(session.selectAircraft('a1b2c3').selectedAircraftId).toBe('a1b2c3');
    expect(session.selectAircraft().selectedAircraftId).toBeUndefined();
    expect(session.markError('Network unavailable')).toMatchObject({
      phase: 'error',
      lastError: 'Network unavailable',
    });
    expect(
      session.applyHealth({ ...health('offline'), checkedAt: '2026-08-27T12:01:01.000Z' }),
    ).toMatchObject({
      phase: 'offline',
      lastError: 'Upstream is delayed.',
    });
  });

  it('selects an exact retained receipt without keeping the sample alive', () => {
    const session = new LiveAirspaceSession('atlanta', { maximumTrailPoints: 1 });
    session.applySnapshot(snapshot(1));
    const binding = session.state.binding!;
    const selected = session.selectHistorySample('a1b2c3', 1, binding);
    expect(selected).toMatchObject({
      selectedAircraftId: 'a1b2c3',
      selectedHistorySequence: 1,
    });
    expect(session.selectHistorySample('a1b2c3', 99, binding)).toBe(selected);
    expect(session.selectHistorySample('unknown', 1, binding)).toBe(selected);

    session.applySnapshot(snapshot(2));
    expect(session.state.histories.get('a1b2c3')!.samples.map(({ sequence }) => sequence)).toEqual([
      2,
    ]);
    expect(session.state.selectedHistorySequence).toBe(1);
    const afterPrune = session.state;
    expect(
      session.selectHistorySample('a1b2c3', 2, {
        ...binding,
        feedEpoch: 'superseded-feed',
      }),
    ).toBe(afterPrune);
    expect(session.state.selectedHistorySequence).toBe(1);

    expect(session.selectAircraft('a1b2c3')).toMatchObject({
      selectedAircraftId: 'a1b2c3',
      selectedHistorySequence: undefined,
    });
    session.selectHistorySample('a1b2c3', 2, binding);
    expect(session.clear().selectedHistorySequence).toBeUndefined();
  });

  it('rejects an old receipt key when a new feed epoch reuses its aircraft and sequence', () => {
    const session = new LiveAirspaceSession('atlanta');
    session.applySnapshot(snapshot(1));
    const oldBinding = session.state.binding!;
    session.selectHistorySample('a1b2c3', 1, oldBinding);

    const newBinding = { ...oldBinding, feedEpoch: 'test-feed-2' };
    expect(session.beginFeed(newBinding)).toBe(true);
    session.applySnapshot(snapshot(1, { feedEpoch: newBinding.feedEpoch }));
    expect(session.state.binding).toEqual(newBinding);
    expect(session.state.selectedAircraftId).toBeUndefined();
    expect(session.state.selectedHistorySequence).toBeUndefined();

    const current = session.state;
    expect(session.selectHistorySample('a1b2c3', 1, oldBinding)).toBe(current);
    expect(session.selectHistorySample('a1b2c3', 1, newBinding)).toMatchObject({
      selectedAircraftId: 'a1b2c3',
      selectedHistorySequence: 1,
    });
  });

  it('keeps only the exact-selection scalar through partial and final 15-minute expiry', () => {
    let elapsed = 0;
    const session = new LiveAirspaceSession('atlanta', {}, undefined, () => ({
      monotonicMs: elapsed,
      wallMs: Date.parse(BASE_TIME) + 86_400_000 + elapsed,
    }));
    const first = snapshot(0);
    first.aircraft[0]!.lastPositionAt = new Date(Date.parse(BASE_TIME) - 10_000).toISOString();
    session.applySnapshot(first);
    const binding = session.state.binding!;
    session.selectHistorySample('a1b2c3', 0, binding);

    const synchronize = (nextElapsed: number) => {
      elapsed = nextElapsed;
      const serverMs = Date.parse(BASE_TIME) + elapsed;
      session.updateTime({ earliestMs: serverMs, latestMs: serverMs, referenceAgeMs: 0 });
    };
    synchronize(LIVE_HISTORY_RETENTION_MS - 10_001);
    expect(session.state.histories.get('a1b2c3')?.samples[0]?.position).toBeDefined();

    synchronize(LIVE_HISTORY_RETENTION_MS - 10_000);
    const partial = session.state.histories.get('a1b2c3')?.samples[0];
    expect(partial).toMatchObject({ sequence: 0, position: undefined });
    expect(partial?.measurements).toBeDefined();
    expect(session.state.selectedHistorySequence).toBe(0);

    synchronize(LIVE_HISTORY_RETENTION_MS);
    expect(session.state.histories.has('a1b2c3')).toBe(false);
    expect(session.state.selectedAircraftId).toBe('a1b2c3');
    expect(session.state.selectedHistorySequence).toBe(0);
  });

  it('updates the time reference without changing feed state or copying evidence', () => {
    const session = new LiveAirspaceSession('atlanta');
    const current = snapshot(1);
    session.applySnapshot(current);
    session.applyHealth(health('live'));
    session.markConnected();
    const before = session.state;
    const time = {
      earliestMs: Date.parse(BASE_TIME),
      latestMs: Date.parse(BASE_TIME) + 10,
      referenceAgeMs: 0,
    };
    const updated = session.updateTime(time);
    expect(updated.time).toBe(time);
    expect(updated.phase).toBe(before.phase);
    expect(updated.transport).toBe('open');
    expect(updated.snapshot).toBe(current);
    expect(updated.health).toBe(before.health);
    expect(updated.trails).toBe(before.trails);
    expect(updated.qualityEvents).toBe(before.qualityEvents);
    const uncertain = session.updateTime(undefined);
    expect(uncertain.time).toBeUndefined();
    expect(uncertain.trails).toBe(before.trails);
    expect(session.updateTime(undefined)).toBe(uncertain);
  });

  it('clears all live evidence and preserves only the region on disposal', () => {
    const session = new LiveAirspaceSession('atlanta');
    session.applySnapshot(snapshot(1));
    session.applyHealth(health('degraded'));
    session.selectAircraft('a1b2c3');
    session.updateTime({ earliestMs: 0, latestMs: 1, referenceAgeMs: 0 });
    session.markError('Test failure.');
    const expected = {
      regionId: 'atlanta',
      phase: 'loading',
      transport: 'stopped',
      histories: new Map(),
      trails: new Map(),
      qualityEvents: [],
    };
    expect(session.clear()).toEqual(expected);
    expect(session.clear()).toEqual(expected);
  });

  it('rejects invalid configuration and cross-region evidence', () => {
    expect(() => new LiveAirspaceSession('')).toThrow('regionId');
    expect(() => new LiveAirspaceSession('atlanta', { maximumTrailPoints: 0 })).toThrow(
      'maximumTrailPoints',
    );
    expect(() => new LiveAirspaceSession('atlanta', { maximumQualityEvents: 0 })).toThrow(
      'maximumQualityEvents',
    );
    expect(() => new LiveAirspaceSession('atlanta', { maximumAircraftTrails: 0 })).toThrow(
      'maximumAircraftTrails',
    );
    expect(() => new LiveAirspaceSession('atlanta', { maximumTrailPoints: 121 })).toThrow(
      'maximumTrailPoints',
    );
    expect(() => new LiveAirspaceSession('atlanta', { maximumAircraftTrails: 501 })).toThrow(
      'maximumAircraftTrails',
    );
    const session = new LiveAirspaceSession('atlanta');
    expect(() => session.applySnapshot(snapshot(1, { regionId: 'savannah-statesboro' }))).toThrow(
      'does not match',
    );
    expect(() => session.applyHealth({ ...health('live'), regionId: 'central-georgia' })).toThrow(
      'does not match',
    );
  });

  it('does not create trails for aircraft without positions', () => {
    const session = new LiveAirspaceSession('atlanta');
    const noPosition = snapshot(1);
    noPosition.aircraft[0]!.position = undefined;
    expect(session.applySnapshot(noPosition).trails.size).toBe(0);
  });

  it('timestamps trail points using position time, not a later contact', () => {
    const session = new LiveAirspaceSession('atlanta');
    const current = snapshot(1);
    current.aircraft[0]!.lastPositionAt = BASE_TIME;
    session.applySnapshot(current);
    expect(session.state.trails.get('a1b2c3')?.[0]?.observedAt).toBe(BASE_TIME);
  });

  it.each(['time-uncertain', 'provider-time-regression'] as const)(
    'does not add a trail from %s observations',
    (flag) => {
      const session = new LiveAirspaceSession('atlanta');
      const current = snapshot(1);
      current.aircraft[0]!.qualityFlags = [flag];
      session.applySnapshot(current);
      expect(session.state.trails.size).toBe(0);
      expect(session.state.qualityEvents[0]?.kind).toBe(flag);
    },
  );
});
