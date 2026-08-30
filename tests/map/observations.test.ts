import { describe, expect, it } from 'vitest';
import type { ServerTimeInterval } from '../../src/live/clock';
import type { AircraftHistory } from '../../src/live/history';
import { observationFeatures, selectedTrailFeatures } from '../../src/map/observations';
import { aircraftFixture, LIVE_FIXTURE_EPOCH, LIVE_FIXTURE_TIME } from '../live/fixtures';

const observedMs = Date.parse(LIVE_FIXTURE_TIME);
const binding = {
  providerId: 'adsb-lol',
  regionId: 'atlanta',
  feedEpoch: LIVE_FIXTURE_EPOCH,
} as const;
function time(ageMs: number, uncertaintyMs = 0): ServerTimeInterval {
  return {
    earliestMs: observedMs + ageMs,
    latestMs: observedMs + ageMs + uncertaintyMs,
    referenceAgeMs: 0,
  };
}

describe('map observation projection', () => {
  it('preserves observed coordinates, stable identity and reported track without prediction', () => {
    const aircraft = aircraftFixture();
    const result = observationFeatures([aircraft], time(10_000));
    expect(result).toEqual({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          id: 'a1b2c3',
          geometry: { type: 'Point', coordinates: [-84.43, 33.64] },
          properties: {
            aircraftId: 'a1b2c3',
            label: 'TEST123',
            track: 180,
            freshness: 'current',
          },
        },
      ],
    });
    result.features[0]!.geometry.coordinates[0] = 0;
    expect(aircraft.position?.longitude).toBe(-84.43);
    expect(observationFeatures([aircraft], time(45_001)).features[0]?.geometry.coordinates).toEqual(
      [-84.43, 33.64],
    );
  });

  it.each([
    [15_000, 'current'],
    [15_001, 'delayed'],
    [45_000, 'delayed'],
    [45_001, 'stale'],
    [119_999, 'stale'],
  ] as const)('matches table freshness at %i milliseconds', (age, expected) => {
    expect(
      observationFeatures([aircraftFixture()], time(age)).features[0]?.properties.freshness,
    ).toBe(expected);
  });

  it('uses conservative measured age, including clock uncertainty', () => {
    expect(
      observationFeatures([aircraftFixture()], time(14_000, 2_000)).features[0]?.properties
        .freshness,
    ).toBe('delayed');
  });

  it.each([
    ['absent position', aircraftFixture({ position: undefined }), time(0)],
    ['absent timestamp', aircraftFixture({ lastPositionAt: undefined }), time(0)],
    ['unmeasured clock', aircraftFixture(), undefined],
    ['future observation', aircraftFixture(), time(-1)],
    ['uncertain source', aircraftFixture({ qualityFlags: ['time-uncertain'] }), time(0)],
    ['regressed source', aircraftFixture({ qualityFlags: ['provider-time-regression'] }), time(0)],
    ['expired contact', aircraftFixture(), time(120_000)],
    [
      'expired position with recent contact',
      aircraftFixture({ lastContactAt: new Date(observedMs + 120_000).toISOString() }),
      time(120_000),
    ],
  ] as const)('does not invent a marker for %s', (_description, aircraft, reference) => {
    expect(observationFeatures([aircraft], reference).features).toEqual([]);
  });

  it('keeps an unknown track distinct from a reported due-north track', () => {
    const result = observationFeatures(
      [
        aircraftFixture({ trackDegrees: undefined, callsign: undefined, registration: undefined }),
        aircraftFixture({ aircraftId: 'a1b2c4', trackDegrees: 0 }),
      ],
      time(0),
    );
    expect(result.features[0]?.properties.track).toBeNull();
    expect(result.features[0]?.properties.label).toBe('A1B2C3');
    expect(result.features[1]?.properties.track).toBe(0);
  });

  it('does not clamp an observation to a map or region boundary', () => {
    const aircraft = aircraftFixture({ position: { latitude: 40, longitude: -100 } });
    expect(observationFeatures([aircraft], time(0)).features[0]?.geometry.coordinates).toEqual([
      -100, 40,
    ]);
  });

  it('projects only received selected-track points and splits lines at explicit gaps', () => {
    const history: AircraftHistory = {
      samples: [
        {
          sequence: 1,
          receivedAt: LIVE_FIXTURE_TIME,
          providerGeneratedAt: LIVE_FIXTURE_TIME,
          position: {
            latitude: 33.6,
            longitude: -84.4,
            observedAt: LIVE_FIXTURE_TIME,
            breakBefore: true,
            sourceType: 'adsb',
          },
        },
        {
          sequence: 2,
          receivedAt: LIVE_FIXTURE_TIME,
          providerGeneratedAt: LIVE_FIXTURE_TIME,
          measurements: { observedAt: LIVE_FIXTURE_TIME, onGround: null, breakBefore: false },
        },
        {
          sequence: 3,
          receivedAt: LIVE_FIXTURE_TIME,
          providerGeneratedAt: LIVE_FIXTURE_TIME,
          position: {
            latitude: 33.7,
            longitude: -84.3,
            observedAt: LIVE_FIXTURE_TIME,
            breakBefore: false,
          },
        },
        {
          sequence: 4,
          receivedAt: LIVE_FIXTURE_TIME,
          providerGeneratedAt: LIVE_FIXTURE_TIME,
          position: {
            latitude: 34,
            longitude: -84,
            observedAt: LIVE_FIXTURE_TIME,
            breakBefore: true,
          },
        },
      ],
      incompleteReasons: ['feed-gap'],
    };
    const result = selectedTrailFeatures('a1b2c3', history, binding);
    expect(result.features).toEqual([
      expect.objectContaining({
        id: 'a1b2c3:1-3',
        geometry: {
          type: 'LineString',
          coordinates: [
            [-84.4, 33.6],
            [-84.3, 33.7],
          ],
        },
      }),
      expect.objectContaining({
        id: 'a1b2c3:1',
        geometry: { type: 'Point', coordinates: [-84.4, 33.6] },
        properties: expect.objectContaining({
          historySequence: 1,
          sourceType: 'adsb',
          ...binding,
        }),
      }),
      expect.objectContaining({
        id: 'a1b2c3:3',
        geometry: expect.objectContaining({ type: 'Point' }),
      }),
      expect.objectContaining({
        id: 'a1b2c3:4',
        geometry: expect.objectContaining({ type: 'Point' }),
      }),
    ]);
    expect(selectedTrailFeatures(undefined, history, binding).features).toEqual([]);
    expect(selectedTrailFeatures('a1b2c3', undefined, binding).features).toEqual([]);
    expect(selectedTrailFeatures('a1b2c3', history, undefined).features).toEqual([]);
  });
});
