import { describe, expect, it } from 'vitest';

import type { ServerTimeInterval } from '../../src/live/clock';
import {
  aircraftIdentifier,
  filterAircraft,
  formatAltitude,
  formatGroundSpeed,
  projectGeographicPoint,
  sortAircraft,
  summarizeAirspace,
  verticalState,
} from '../../src/live/presentation';
import type { AircraftState } from '../../src/live/types';

const NOW = '2026-08-27T12:00:00.000Z';
const TIME: ServerTimeInterval = {
  earliestMs: Date.parse(NOW),
  latestMs: Date.parse(NOW),
  referenceAgeMs: 0,
};

function aircraft(overrides: Partial<AircraftState> = {}): AircraftState {
  return {
    aircraftId: 'a1b2c3',
    identifierKind: 'icao24',
    callsign: 'DAL123',
    registration: 'N123AA',
    aircraftType: 'B738',
    position: { latitude: 33.6, longitude: -84.4 },
    barometricAltitudeFeet: 12_000,
    groundSpeedKnots: 320,
    verticalRateFeetPerMinute: 500,
    verticalRateBasis: 'barometric',
    onGround: false,
    observedAt: NOW,
    lastContactAt: NOW,
    lastPositionAt: NOW,
    contactAgeSeconds: 0,
    positionAgeSeconds: 0,
    qualityFlags: [],
    ...overrides,
  };
}

describe('live presentation model', () => {
  it('chooses a stable human-readable identifier', () => {
    expect(aircraftIdentifier(aircraft({ callsign: ' DAL123 ' }))).toBe('DAL123');
    expect(aircraftIdentifier(aircraft({ callsign: '', registration: ' N123AA ' }))).toBe('N123AA');
    expect(aircraftIdentifier(aircraft({ callsign: undefined, registration: undefined }))).toBe(
      'A1B2C3',
    );
  });

  it('classifies vertical movement with a deadband', () => {
    expect(verticalState(aircraft({ verticalRateFeetPerMinute: 500 }))).toBe('climbing');
    expect(verticalState(aircraft({ verticalRateFeetPerMinute: -500 }))).toBe('descending');
    expect(verticalState(aircraft({ verticalRateFeetPerMinute: 200 }))).toBe('level');
    expect(verticalState(aircraft({ verticalRateFeetPerMinute: undefined }))).toBe('unknown');
  });

  it('filters by search, position, altitude, and quality without mutating input', () => {
    const tracks = [
      aircraft(),
      aircraft({
        aircraftId: 'low',
        callsign: 'N721KT',
        aircraftType: 'C172',
        barometricAltitudeFeet: 4_600,
        lastPositionAt: new Date(Date.parse(NOW) - 20_000).toISOString(),
        positionAgeSeconds: 20,
        qualityFlags: ['stale-position'],
      }),
      aircraft({
        aircraftId: 'high',
        callsign: 'SWA418',
        barometricAltitudeFeet: 28_400,
      }),
      aircraft({
        aircraftId: 'ground',
        callsign: undefined,
        onGround: true,
        position: undefined,
        barometricAltitudeFeet: undefined,
        qualityFlags: ['missing-position'],
      }),
    ];

    expect(filterAircraft(tracks, { query: 'c172' }).map(({ aircraftId }) => aircraftId)).toEqual([
      'low',
    ]);
    expect(
      filterAircraft(tracks, { altitude: 'below-10000' }).map(({ aircraftId }) => aircraftId),
    ).toEqual(['low']);
    expect(filterAircraft(tracks, { altitude: '10000-25000' })).toEqual([tracks[0]]);
    expect(filterAircraft(tracks, { altitude: 'above-25000' })).toEqual([tracks[2]]);
    expect(filterAircraft(tracks, { altitude: 'ground' })).toEqual([tracks[3]]);
    expect(filterAircraft(tracks, { quality: 'delayed' }, TIME)).toEqual([tracks[1]]);
    expect(filterAircraft(tracks, { quality: 'missing-position' }, TIME)).toEqual([tracks[3]]);
    expect(filterAircraft(tracks, { quality: 'current', positionedOnly: true }, TIME)).toEqual([
      tracks[0],
      tracks[2],
    ]);
    expect(tracks).toHaveLength(4);
  });

  it('sorts tracks deterministically across display fields', () => {
    const tracks = [
      aircraft({
        aircraftId: 'b',
        callsign: 'BETA',
        contactAgeSeconds: 8,
        positionAgeSeconds: 8,
        lastContactAt: new Date(Date.parse(NOW) - 8_000).toISOString(),
        lastPositionAt: new Date(Date.parse(NOW) - 8_000).toISOString(),
      }),
      aircraft({
        aircraftId: 'a',
        callsign: 'ALPHA',
        barometricAltitudeFeet: undefined,
        groundSpeedKnots: undefined,
        contactAgeSeconds: 2,
        positionAgeSeconds: 2,
        lastContactAt: new Date(Date.parse(NOW) - 2_000).toISOString(),
        lastPositionAt: new Date(Date.parse(NOW) - 2_000).toISOString(),
      }),
      aircraft({
        aircraftId: 'c',
        callsign: 'CHARLIE',
        barometricAltitudeFeet: 30_000,
        contactAgeSeconds: 2,
        positionAgeSeconds: 2,
        lastContactAt: new Date(Date.parse(NOW) - 2_000).toISOString(),
        lastPositionAt: new Date(Date.parse(NOW) - 2_000).toISOString(),
      }),
    ];
    expect(sortAircraft(tracks, 'identifier').map(({ aircraftId }) => aircraftId)).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(sortAircraft(tracks, 'altitude', 'descending')[0]?.aircraftId).toBe('c');
    expect(sortAircraft(tracks, 'speed')[0]?.aircraftId).toBe('a');
    expect(
      sortAircraft(tracks, 'freshness', 'ascending', TIME).map(({ aircraftId }) => aircraftId),
    ).toEqual(['a', 'c', 'b']);
  });

  it('summarizes current, delayed, positioned, ground, and airborne tracks', () => {
    const summary = summarizeAirspace(
      [
        aircraft(),
        aircraft({
          aircraftId: 'delayed',
          lastPositionAt: new Date(Date.parse(NOW) - 20_000).toISOString(),
          positionAgeSeconds: 20,
          qualityFlags: ['stale-position'],
        }),
        aircraft({ aircraftId: 'ground', position: undefined, onGround: true }),
      ],
      TIME,
    );
    expect(summary).toEqual({
      observed: 3,
      positioned: 2,
      current: 1,
      delayed: 1,
      stale: 0,
      expiredPosition: 0,
      missingPosition: 1,
      airborne: 2,
      onGround: 1,
      unknownGround: 0,
      timeUncertain: 0,
    });
  });

  it('projects map coordinates, clamps outliers, and rejects inverted bounds', () => {
    const bounds = { south: 30, west: -90, north: 40, east: -80 };
    expect(projectGeographicPoint({ latitude: 35, longitude: -85 }, bounds)).toEqual({
      xPercent: 50,
      yPercent: 50,
      insideBounds: true,
    });
    expect(projectGeographicPoint({ latitude: 45, longitude: -95 }, bounds)).toEqual({
      xPercent: 0,
      yPercent: 0,
      insideBounds: false,
    });
    expect(() =>
      projectGeographicPoint(
        { latitude: 35, longitude: -85 },
        { south: 40, west: -80, north: 30, east: -90 },
      ),
    ).toThrow('positive area');
  });

  it('formats observed values without inventing missing measurements', () => {
    expect(formatAltitude(aircraft())).toBe('12,000 ft');
    expect(formatAltitude(aircraft({ onGround: true }))).toBe('Ground');
    expect(formatAltitude(aircraft({ barometricAltitudeFeet: undefined }))).toBe('Unknown');
    expect(formatGroundSpeed(aircraft())).toBe('320 kt');
    expect(formatGroundSpeed(aircraft({ groundSpeedKnots: undefined }))).toBe('Unknown');
  });

  it('keeps unknown ground state separate from both ground and airborne filters/counts', () => {
    const tracks = [
      aircraft({ onGround: true }),
      aircraft({ onGround: false }),
      aircraft({ onGround: null }),
    ];
    expect(filterAircraft(tracks, { groundState: 'ground' })).toEqual([tracks[0]]);
    expect(filterAircraft(tracks, { groundState: 'airborne' })).toEqual([tracks[1]]);
    expect(filterAircraft(tracks, { groundState: 'unknown' })).toEqual([tracks[2]]);
    expect(filterAircraft(tracks, { altitude: 'ground' })).toEqual([tracks[0]]);
    expect(summarizeAirspace(tracks)).toMatchObject({ onGround: 1, airborne: 1, unknownGround: 1 });
    expect(formatAltitude(aircraft({ onGround: null, barometricAltitudeFeet: undefined }))).toBe(
      'Unknown',
    );
  });

  it.each(['time-uncertain', 'provider-time-regression'] as const)(
    'never counts %s evidence as current',
    (flag) => {
      const track = aircraft({ qualityFlags: [flag] });
      expect(filterAircraft([track], { quality: 'current' }, TIME)).toEqual([]);
      expect(filterAircraft([track], { quality: 'delayed' }, TIME)).toEqual([]);
      expect(filterAircraft([track], { quality: 'time-uncertain' }, TIME)).toEqual([track]);
      expect(summarizeAirspace([track], TIME)).toMatchObject({
        current: 0,
        delayed: 0,
        timeUncertain: 1,
      });
    },
  );
});
