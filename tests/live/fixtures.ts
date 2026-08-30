import { LIVE_STREAM_PROTOCOL_VERSION, type LiveStreamMessage } from '../../src/live/protocol';
import {
  AIRSPACE_SCHEMA_VERSION,
  type AircraftState,
  type AirspaceSnapshot,
  type LiveFeedHealth,
} from '../../src/live/types';

export const LIVE_FIXTURE_TIME = '2026-08-27T12:00:00.000Z';
export const LIVE_FIXTURE_EPOCH = 'test-feed-1';

export function aircraftFixture(overrides: Partial<AircraftState> = {}): AircraftState {
  return {
    aircraftId: 'a1b2c3',
    identifierKind: 'icao24',
    callsign: 'TEST123',
    registration: 'TEST-01',
    aircraftType: 'B738',
    category: 'A3',
    position: { latitude: 33.64, longitude: -84.43 },
    barometricAltitudeFeet: 12_000,
    geometricAltitudeFeet: 12_275,
    groundSpeedKnots: 320,
    trackDegrees: 180,
    verticalRateFeetPerMinute: 500,
    verticalRateBasis: 'barometric',
    onGround: false,
    sourceType: 'adsb_icao',
    observedAt: LIVE_FIXTURE_TIME,
    lastContactAt: LIVE_FIXTURE_TIME,
    lastPositionAt: LIVE_FIXTURE_TIME,
    contactAgeSeconds: 0,
    positionAgeSeconds: 0,
    qualityFlags: [],
    ...overrides,
  };
}

export function snapshotFixture(overrides: Partial<AirspaceSnapshot> = {}): AirspaceSnapshot {
  const aircraft = overrides.aircraft ?? [aircraftFixture()];
  return {
    schemaVersion: AIRSPACE_SCHEMA_VERSION,
    providerId: 'adsb-lol',
    feedEpoch: LIVE_FIXTURE_EPOCH,
    regionId: 'atlanta',
    sequence: 1,
    generatedAt: LIVE_FIXTURE_TIME,
    providerGeneratedAt: LIVE_FIXTURE_TIME,
    aircraft,
    validation: {
      receivedAircraft: aircraft.length,
      acceptedAircraft: aircraft.length,
      rejectedAircraft: 0,
      duplicateAircraft: 0,
      invalidFields: 0,
    },
    ...overrides,
  };
}

export function healthFixture(overrides: Partial<LiveFeedHealth> = {}): LiveFeedHealth {
  return {
    schemaVersion: AIRSPACE_SCHEMA_VERSION,
    providerId: 'adsb-lol',
    feedEpoch: LIVE_FIXTURE_EPOCH,
    regionId: 'atlanta',
    status: 'live',
    checkedAt: LIVE_FIXTURE_TIME,
    lastSuccessAt: LIVE_FIXTURE_TIME,
    lastSnapshotAt: LIVE_FIXTURE_TIME,
    upstreamLatencyMs: 100,
    consecutiveFailures: 0,
    message: 'The provider responded.',
    ...overrides,
  };
}

export function liveMessageFixtures(): LiveStreamMessage[] {
  return [
    {
      type: 'hello',
      protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
      schemaVersion: AIRSPACE_SCHEMA_VERSION,
      providerId: 'adsb-lol',
      feedEpoch: LIVE_FIXTURE_EPOCH,
      regionId: 'atlanta',
      pollIntervalMs: 10_000,
      generatedAt: LIVE_FIXTURE_TIME,
    },
    {
      type: 'airspace.snapshot',
      protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
      snapshot: snapshotFixture(),
    },
    {
      type: 'feed.health',
      protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
      health: healthFixture(),
    },
    {
      type: 'error',
      protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
      code: 'UPSTREAM_UNAVAILABLE',
      message: 'The provider is temporarily unavailable.',
      recoverable: true,
      retryAt: LIVE_FIXTURE_TIME,
    },
  ];
}
