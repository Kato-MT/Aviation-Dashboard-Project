import { describe, expect, it } from 'vitest';

import { LiveAirspaceSession } from '../../src/live/session';
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
    status,
    checkedAt: BASE_TIME,
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
    expect(trail?.[0]?.altitudeFeet).toBe(12_200);
    expect(trail?.[1]).toEqual(expect.objectContaining({ latitude: 33.63, altitudeFeet: 12_300 }));
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
    second.aircraft[0]!.observedAt = first.aircraft[0]!.observedAt;
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
    session.applyHealth({ ...health('degraded'), checkedAt: '2026-08-27T12:00:10.000Z' });
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
    expect(session.applyHealth(health('offline'))).toMatchObject({
      phase: 'offline',
      lastError: 'Upstream is delayed.',
    });
  });

  it('moves current snapshots through stale and offline freshness states', () => {
    const session = new LiveAirspaceSession('atlanta', {
      staleAfterMs: 20_000,
      offlineAfterMs: 60_000,
    });
    const current = snapshot(1);
    session.applySnapshot(current);
    expect(session.evaluateFreshness(Date.parse(current.generatedAt) + 19_999).phase).toBe('live');
    expect(session.evaluateFreshness(Date.parse(current.generatedAt) + 20_000).phase).toBe('stale');
    expect(session.evaluateFreshness(Date.parse(current.generatedAt) + 60_000).phase).toBe(
      'offline',
    );
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
    expect(
      () => new LiveAirspaceSession('atlanta', { staleAfterMs: 100, offlineAfterMs: 100 }),
    ).toThrow('offlineAfterMs');

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
});
