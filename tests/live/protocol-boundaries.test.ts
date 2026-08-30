import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';

import airspaceSchema from '../../schemas/airspace-v1.schema.json';
import streamSchema from '../../schemas/live-stream-v1.schema.json';
import {
  LIVE_STREAM_PROTOCOL_VERSION,
  parseLiveStreamMessage,
  serializeLiveStreamMessage,
} from '../../src/live/protocol';
import { aircraftIdentifier } from '../../src/live/presentation';
import { aircraftFixture, healthFixture, liveMessageFixtures, snapshotFixture } from './fixtures';

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
ajv.addSchema(airspaceSchema);
const validateSchema = ajv.compile(streamSchema);

function snapshotMessage(snapshot = snapshotFixture()): Record<string, unknown> {
  return { type: 'airspace.snapshot', protocolVersion: LIVE_STREAM_PROTOCOL_VERSION, snapshot };
}

function expectStructurallyRejected(message: unknown): void {
  expect(validateSchema(message), JSON.stringify(validateSchema.errors)).toBe(false);
  expect(parseLiveStreamMessage(message).ok).toBe(false);
}

describe('live wire-contract boundaries and schema parity', () => {
  it.each(['\n', '\r', '\r\n', '\u2028', '\u2029'])(
    'rejects a trailing line terminator in every identifier boundary: %j',
    (terminator) => {
      for (const providerId of ['adsb-lol' + terminator]) {
        expectStructurallyRejected(snapshotMessage(snapshotFixture({ providerId })));
        expectStructurallyRejected({
          ...liveMessageFixtures()[0],
          providerId,
        });
        expectStructurallyRejected({
          type: 'feed.health',
          protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
          health: healthFixture({ providerId }),
        });
      }
      expectStructurallyRejected(
        snapshotMessage(snapshotFixture({ regionId: 'atlanta' + terminator })),
      );
      for (const aircraftId of ['abcdef' + terminator, '~abcdef' + terminator]) {
        expectStructurallyRejected(
          snapshotMessage(
            snapshotFixture({
              aircraft: [
                aircraftFixture({
                  aircraftId,
                  identifierKind: aircraftId.startsWith('~') ? 'other' : 'icao24',
                }),
              ],
            }),
          ),
        );
      }
    },
  );

  it.each(liveMessageFixtures())(
    'accepts the complete $type fixture in both validators',
    (value) => {
      expect(validateSchema(value), JSON.stringify(validateSchema.errors)).toBe(true);
      expect(parseLiveStreamMessage(JSON.stringify(value)).ok).toBe(true);
    },
  );

  it.each([
    ['aircraftId', ''],
    ['aircraftId', 'not-an-icao'],
    ['identifierKind', 'owner'],
    ['callsign', 42],
    ['callsign', null],
    ['callsign', '   '],
    ['callsign', 'X'.repeat(17)],
    ['registration', []],
    ['aircraftType', {}],
    ['category', 'X'.repeat(17)],
    ['sourceType', 'X'.repeat(33)],
    ['onGround', 'yes'],
    ['barometricAltitudeFeet', '12000'],
    ['geometricAltitudeFeet', null],
    ['groundSpeedKnots', -1],
    ['trackDegrees', 360],
    ['trackDegrees', -1],
    ['verticalRateFeetPerMinute', false],
    ['verticalRateBasis', 'airspeed'],
    ['verticalRateBasis', null],
    ['lastPositionAt', 'yesterday'],
    ['lastContactAt', '2026-02-30T12:00:00.000Z'],
    ['observedAt', '2026-08-27'],
    ['contactAgeSeconds', -1],
    ['positionAgeSeconds', -1],
    ['qualityFlags', ['aircraft-fault']],
    ['qualityFlags', ['stale-position', 'stale-position']],
    ['position', { latitude: 999, longitude: -84 }],
    ['position', { latitude: 33, longitude: -181 }],
    ['position', { latitude: 33 }],
    ['position', { latitude: 33, longitude: -84, owner: 'unknown' }],
  ])('rejects the independently malformed aircraft field %s (%j)', (field, value) => {
    const snapshot = snapshotFixture();
    Reflect.set(snapshot.aircraft[0]!, field as string, value);
    expectStructurallyRejected(snapshotMessage(snapshot));
  });

  it.each([true, false, null])(
    'preserves explicit ground state %j through the wire',
    (onGround) => {
      const message = snapshotMessage(
        snapshotFixture({ aircraft: [aircraftFixture({ onGround })] }),
      );
      expect(validateSchema(message), JSON.stringify(validateSchema.errors)).toBe(true);
      const result = parseLiveStreamMessage(JSON.stringify(message));
      expect(result.ok).toBe(true);
      expect(result.message).toEqual(message);
    },
  );

  it.each([
    'position',
    'lastPositionAt',
    'positionAgeSeconds',
    'verticalRateFeetPerMinute',
    'verticalRateBasis',
  ])('rejects an incomplete paired observation when %s is removed', (field) => {
    const snapshot = snapshotFixture();
    Reflect.deleteProperty(snapshot.aircraft[0]!, field);
    expectStructurallyRejected(snapshotMessage(snapshot));
  });

  it('accepts contact-only observations and omitted vertical measurement pairs', () => {
    const track = aircraftFixture();
    for (const field of [
      'position',
      'lastPositionAt',
      'positionAgeSeconds',
      'verticalRateFeetPerMinute',
      'verticalRateBasis',
    ]) {
      Reflect.deleteProperty(track, field);
    }
    track.qualityFlags = ['missing-position'];
    const message = snapshotMessage(snapshotFixture({ aircraft: [track] }));
    expect(validateSchema(message)).toBe(true);
    expect(parseLiveStreamMessage(message).ok).toBe(true);
  });

  it.each(['barometric', 'geometric'] as const)(
    'preserves a zero %s vertical rate',
    (verticalRateBasis) => {
      const message = snapshotMessage(
        snapshotFixture({
          aircraft: [
            aircraftFixture({
              verticalRateFeetPerMinute: 0,
              verticalRateBasis,
            }),
          ],
        }),
      );
      expect(validateSchema(message)).toBe(true);
      expect(parseLiveStreamMessage(message)).toMatchObject({ ok: true, message });
    },
  );

  it('permits bounded negative ages only as explicitly uncertain evidence', () => {
    const future = '2026-08-27T12:00:05.000Z';
    const snapshot = snapshotFixture({
      providerGeneratedAt: future,
      aircraft: [
        aircraftFixture({
          observedAt: future,
          lastContactAt: future,
          lastPositionAt: future,
          contactAgeSeconds: -5,
          positionAgeSeconds: -5,
          qualityFlags: ['time-uncertain'],
        }),
      ],
    });
    expect(validateSchema(snapshotMessage(snapshot))).toBe(true);
    expect(parseLiveStreamMessage(snapshotMessage(snapshot)).ok).toBe(true);
    snapshot.aircraft[0]!.contactAgeSeconds = -5.001;
    expectStructurallyRejected(snapshotMessage(snapshot));
    snapshot.aircraft[0]!.contactAgeSeconds = -5;
    snapshot.aircraft[0]!.qualityFlags = [];
    expectStructurallyRejected(snapshotMessage(snapshot));
  });

  it.each([
    'aircraftId',
    'identifierKind',
    'onGround',
    'observedAt',
    'lastContactAt',
    'contactAgeSeconds',
    'qualityFlags',
  ])('rejects a missing required aircraft field: %s', (field) => {
    const snapshot = snapshotFixture();
    Reflect.deleteProperty(snapshot.aircraft[0]!, field);
    expectStructurallyRejected(snapshotMessage(snapshot));
  });

  it.each([
    ['providerId', ''],
    ['regionId', '   '],
    ['sequence', Number.MAX_SAFE_INTEGER + 1],
    ['sequence', 1.5],
    ['generatedAt', '2026-08-27T12:00:00+00:00'],
    ['providerGeneratedAt', '2026-02-30T12:00:00.000Z'],
    ['validation', {}],
  ])('rejects malformed snapshot metadata: %s', (field, value) => {
    const snapshot = snapshotFixture();
    Reflect.set(snapshot, field as string, value);
    expectStructurallyRejected(snapshotMessage(snapshot));
  });

  it.each([
    ['status', 'flight-safe'],
    ['message', ''],
    ['message', 'X'.repeat(513)],
    ['lastSuccessAt', 'later'],
    ['lastSnapshotAt', '2026-08-27'],
    ['retryAt', 'never'],
    ['upstreamLatencyMs', -1],
    ['consecutiveFailures', Number.MAX_SAFE_INTEGER + 1],
  ])('rejects malformed health metadata: %s', (field, value) => {
    const health = healthFixture();
    Reflect.set(health, field as string, value);
    expectStructurallyRejected({
      type: 'feed.health',
      protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
      health,
    });
  });

  it.each([
    'receivedAircraft',
    'acceptedAircraft',
    'rejectedAircraft',
    'duplicateAircraft',
    'invalidFields',
  ])('rejects invalid validation counters: %s', (field) => {
    const snapshot = snapshotFixture();
    Reflect.set(snapshot.validation, field, -1);
    expectStructurallyRejected(snapshotMessage(snapshot));
  });

  it('rejects non-finite numeric values before presentation or serialization', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      for (const field of ['contactAgeSeconds', 'groundSpeedKnots', 'barometricAltitudeFeet']) {
        const snapshot = snapshotFixture();
        Reflect.set(snapshot.aircraft[0]!, field, value);
        expectStructurallyRejected(snapshotMessage(snapshot));
      }
    }
  });

  it('rejects additional properties at every message boundary', () => {
    for (const message of liveMessageFixtures()) {
      expectStructurallyRejected({ ...message, unexpected: true });
    }
    const snapshot = snapshotFixture();
    Reflect.set(snapshot, 'owner', 'unexpected');
    expectStructurallyRejected(snapshotMessage(snapshot));
  });

  it('rejects a callsign that previously reached and crashed presentation', () => {
    const snapshot = snapshotFixture();
    Reflect.set(snapshot.aircraft[0]!, 'callsign', 42);
    const result = parseLiveStreamMessage(snapshotMessage(snapshot));
    expect(result.ok).toBe(false);
    expect(result.message).toBeUndefined();
    expect(() => aircraftIdentifier(aircraftFixture())).not.toThrow();
  });

  it('accepts 2000 records but rejects 2001 before visiting their fields', () => {
    const aircraft = Array.from({ length: 2000 }, (_, index) =>
      aircraftFixture({ aircraftId: index.toString(16).padStart(6, '0') }),
    );
    const allowed = snapshotMessage(snapshotFixture({ aircraft }));
    expect(validateSchema(allowed)).toBe(true);
    expect(parseLiveStreamMessage(allowed).ok).toBe(true);
    aircraft.push(aircraftFixture({ aircraftId: 'ffffff' }));
    expectStructurallyRejected(snapshotMessage(snapshotFixture({ aircraft })));
  });

  it('enforces the UTF-8 message byte limit before parsing JSON', () => {
    const valid = JSON.stringify(snapshotMessage());
    expect(parseLiveStreamMessage(valid.padEnd(2 * 1024 * 1024, ' ')).ok).toBe(true);
    expect(parseLiveStreamMessage(valid.padEnd(2 * 1024 * 1024 + 1, ' ')).ok).toBe(false);
    expect(parseLiveStreamMessage(JSON.stringify({ message: 'é'.repeat(1024 * 1024) })).ok).toBe(
      false,
    );
  });

  it('adds semantic consistency checks that standard JSON Schema cannot express', () => {
    const mismatched = snapshotFixture();
    mismatched.validation.acceptedAircraft = 0;
    expect(parseLiveStreamMessage(snapshotMessage(mismatched)).ok).toBe(false);

    const duplicate = snapshotFixture({
      aircraft: [aircraftFixture(), aircraftFixture({ callsign: 'OTHER' })],
    });
    expect(parseLiveStreamMessage(snapshotMessage(duplicate)).ok).toBe(false);
  });

  it('does not mutate caller-owned objects while validating or serializing', () => {
    const message = liveMessageFixtures()[1]!;
    const before = structuredClone(message);
    serializeLiveStreamMessage(message);
    expect(message).toEqual(before);
  });

  it('rejects sparse quality flags before serialization can turn holes into nulls', () => {
    const message = liveMessageFixtures()[1]!;
    if (message.type !== 'airspace.snapshot') throw new Error('Expected snapshot fixture.');
    message.snapshot.aircraft[0]!.qualityFlags = Array(1);
    expectStructurallyRejected(message);
    expect(() => serializeLiveStreamMessage(message)).toThrow('Cannot serialize');
  });

  it('rejects serialized output changed into an invalid payload by a toJSON hook', () => {
    const message = liveMessageFixtures()[1]!;
    if (message.type !== 'airspace.snapshot') throw new Error('Expected snapshot fixture.');
    Object.defineProperty(message.snapshot.aircraft, 'toJSON', {
      value: () => [{ aircraftId: 'invalid' }],
    });
    expect(parseLiveStreamMessage(message).ok).toBe(true);
    expect(() => serializeLiveStreamMessage(message)).toThrow('Cannot serialize');
  });

  it('rejects a serialization hook that removes the entire message', () => {
    const message = liveMessageFixtures()[0]!;
    Object.defineProperty(message, 'toJSON', { value: () => undefined });
    expect(() => serializeLiveStreamMessage(message)).toThrow('Cannot serialize');
  });

  it('bounds the bytes returned by a serialization hook', () => {
    const message = liveMessageFixtures()[0]!;
    Object.defineProperty(message, 'toJSON', { value: () => 'é'.repeat(1024 * 1024) });
    expect(() => serializeLiveStreamMessage(message)).toThrow('UTF-8 byte limit');
  });

  it.each(liveMessageFixtures())('round-trips the actual serialized $type output', (message) => {
    const wire = serializeLiveStreamMessage(message);
    expect(parseLiveStreamMessage(wire)).toMatchObject({ ok: true, message });
    expect(validateSchema(JSON.parse(wire)), JSON.stringify(validateSchema.errors)).toBe(true);
  });
});
