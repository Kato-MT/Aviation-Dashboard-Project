import { describe, expect, it } from 'vitest';

import {
  LIVE_STREAM_PROTOCOL_VERSION,
  parseLiveStreamMessage,
  serializeLiveStreamMessage,
  type LiveStreamMessage,
} from '../../src/live/protocol';
import { AIRSPACE_SCHEMA_VERSION } from '../../src/live/types';

const generatedAt = '2026-08-27T12:00:00.000Z';

function messageFixtures(): LiveStreamMessage[] {
  return [
    {
      type: 'hello',
      protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
      schemaVersion: AIRSPACE_SCHEMA_VERSION,
      regionId: 'atlanta',
      providerId: 'adsb-lol',
      pollIntervalMs: 10_000,
      generatedAt,
    },
    {
      type: 'airspace.snapshot',
      protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
      snapshot: {
        schemaVersion: AIRSPACE_SCHEMA_VERSION,
        providerId: 'adsb-lol',
        regionId: 'atlanta',
        sequence: 1,
        generatedAt,
        providerGeneratedAt: generatedAt,
        aircraft: [
          {
            aircraftId: 'a1b2c3',
            identifierKind: 'icao24',
            position: { latitude: 33.6, longitude: -84.4 },
            onGround: false,
            observedAt: generatedAt,
            lastContactAt: generatedAt,
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
      },
    },
    {
      type: 'feed.health',
      protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
      health: {
        schemaVersion: AIRSPACE_SCHEMA_VERSION,
        regionId: 'atlanta',
        providerId: 'adsb-lol',
        status: 'live',
        checkedAt: generatedAt,
        lastSuccessAt: generatedAt,
        consecutiveFailures: 0,
        message: 'Live feed is current.',
      },
    },
    {
      type: 'error',
      protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
      code: 'UPSTREAM_UNAVAILABLE',
      message: 'The provider is temporarily unavailable.',
      recoverable: true,
      retryAt: '2026-08-27T12:01:00.000Z',
    },
  ];
}

describe('live stream protocol', () => {
  it.each(messageFixtures())('round-trips $type messages', (message) => {
    const serialized = serializeLiveStreamMessage(message);
    expect(parseLiveStreamMessage(serialized)).toEqual({ ok: true, message, errors: [] });
  });

  it('rejects malformed JSON and non-object messages', () => {
    expect(parseLiveStreamMessage('{')).toEqual({
      ok: false,
      errors: ['Message is not valid JSON.'],
    });
    expect(parseLiveStreamMessage([])).toEqual({
      ok: false,
      errors: ['Message must be a JSON object.'],
    });
  });

  it('rejects unsupported envelopes', () => {
    const result = parseLiveStreamMessage({ protocolVersion: '9', type: 'flight-fault' });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain(`protocolVersion must be ${LIVE_STREAM_PROTOCOL_VERSION}.`);
    expect(result.errors).toContain(
      'type must be hello, airspace.snapshot, feed.health, or error.',
    );
  });

  it('rejects unsafe snapshot shapes at the network boundary', () => {
    const message = messageFixtures()[1] as Extract<
      LiveStreamMessage,
      { type: 'airspace.snapshot' }
    >;
    const result = parseLiveStreamMessage({
      ...message,
      snapshot: {
        ...message.snapshot,
        sequence: -1,
        aircraft: [{ aircraftId: '', position: { latitude: 'north' } }],
      },
    });

    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(4);
  });

  it('will not serialize invalid messages', () => {
    expect(() =>
      serializeLiveStreamMessage({
        type: 'hello',
        protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
        schemaVersion: AIRSPACE_SCHEMA_VERSION,
        regionId: '',
        providerId: '',
        pollIntervalMs: -1,
        generatedAt: 'later',
      }),
    ).toThrow('Cannot serialize invalid live stream message');
  });
});
