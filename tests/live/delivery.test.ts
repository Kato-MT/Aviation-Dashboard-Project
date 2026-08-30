import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import airspaceSchema from '../../schemas/airspace-v1.schema.json';
import deliverySchema from '../../schemas/live-delivery-v1.schema.json';
import streamSchema from '../../schemas/live-stream-v1.schema.json';
import {
  MAX_LIVE_CONTROL_BYTES,
  MAX_LIVE_HANDSHAKE_BYTES,
  encodeLiveDelivery,
  liveDeliveryBytes,
  prepareLivePayload,
  parseLiveAcknowledgment,
  parseLiveServerFrame,
  serializeLiveAcknowledgment,
  serializeLiveServerFrame,
  type LiveDeliveryMessage,
  type PreparedLivePayload,
} from '../../src/live/delivery';
import { LIVE_STREAM_PROTOCOL_VERSION } from '../../src/live/protocol';
import { MAX_LIVE_AIRCRAFT, MAX_LIVE_MESSAGE_BYTES } from '../../src/live/validation';
import {
  aircraftFixture,
  healthFixture,
  LIVE_FIXTURE_EPOCH,
  LIVE_FIXTURE_TIME,
  liveMessageFixtures,
  snapshotFixture,
} from './fixtures';

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
ajv.addSchema(airspaceSchema);
ajv.addSchema(streamSchema);
const validateFrame = ajv.compile(deliverySchema);
const validateAck = ajv.compile({ $ref: deliverySchema.$id + '#/$defs/ack' });

function delivery(overrides: Partial<LiveDeliveryMessage> = {}): LiveDeliveryMessage {
  return {
    type: 'delivery',
    protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
    providerId: 'adsb-lol',
    regionId: 'atlanta',
    feedEpoch: LIVE_FIXTURE_EPOCH,
    deliveryId: 'delivery-1',
    messages: [
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
    ],
    ...overrides,
  };
}

function expectRejected(value: unknown): void {
  expect(validateFrame(value), JSON.stringify(validateFrame.errors)).toBe(false);
  expect(parseLiveServerFrame(JSON.stringify(value)).ok).toBe(false);
}

describe('bounded live delivery wire contract', () => {
  it('prepares immutable shared payloads and measures the exact encoded envelope', () => {
    const value = delivery();
    const source = value.messages[0]!;
    const prepared = value.messages.map(prepareLivePayload);
    const before = prepared[0]!.wire;
    if (source.type === 'airspace.snapshot') source.snapshot.sequence += 1;
    expect(prepared[0]!.wire).toBe(before);
    expect(Object.isFrozen(prepared[0])).toBe(true);
    expect(Object.isFrozen(prepared[0]!.binding)).toBe(true);
    const encoded = encodeLiveDelivery(value, value.deliveryId, prepared);
    expect(encoded.bytes).toBe(new TextEncoder().encode(encoded.wire).byteLength);
    expect(liveDeliveryBytes(value, value.deliveryId, prepared)).toBe(encoded.bytes);
    expect(parseLiveServerFrame(encoded.wire).ok).toBe(true);
  });

  it('rejects forged prepared fragments, repeated types, and a different binding', () => {
    const value = delivery();
    const prepared = prepareLivePayload(value.messages[0]!);
    expect(() =>
      encodeLiveDelivery(value, value.deliveryId, [{ ...prepared } as PreparedLivePayload]),
    ).toThrow('validated payloads');
    expect(() => encodeLiveDelivery(value, value.deliveryId, [prepared, prepared])).toThrow(
      'unique',
    );
    expect(() =>
      encodeLiveDelivery({ ...value, feedEpoch: 'other' }, value.deliveryId, [prepared]),
    ).toThrow('matching feed bindings');
    expect(() => encodeLiveDelivery(value, value.deliveryId, [])).toThrow('invalid');
  });

  it('accepts one hello and a complete bounded delivery in the schema and parser', () => {
    const hello = liveMessageFixtures()[0]!;
    const frame = delivery({
      messages: [
        ...delivery().messages,
        {
          type: 'error',
          protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
          code: 'UPSTREAM_UNAVAILABLE',
          message: 'Unavailable.',
          recoverable: true,
        },
        {
          type: 'pong',
          protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
          providerId: 'adsb-lol',
          regionId: 'atlanta',
          feedEpoch: LIVE_FIXTURE_EPOCH,
          requestId: 'ping-1',
          generatedAt: LIVE_FIXTURE_TIME,
        },
      ],
    });
    for (const value of [hello, frame]) {
      expect(validateFrame(value), JSON.stringify(validateFrame.errors)).toBe(true);
      expect(parseLiveServerFrame(JSON.stringify(value))).toMatchObject({
        ok: true,
        message: value,
      });
    }
    expect(parseLiveServerFrame(serializeLiveServerFrame(frame)).ok).toBe(true);
  });

  it.each(['protocolVersion', 'providerId', 'regionId', 'feedEpoch', 'deliveryId', 'messages'])(
    'requires %s',
    (field) => {
      const value = { ...delivery() } as Record<string, unknown>;
      delete value[field];
      expectRejected(value);
    },
  );

  it.each(['providerId', 'regionId', 'feedEpoch', 'deliveryId'])(
    'bounds and validates %s',
    (field) => {
      for (const value of ['', 'x'.repeat(65), 'valid\n', 1, null])
        expectRejected({ ...delivery(), [field]: value });
    },
  );

  it('rejects extra keys, unsupported versions and unwrapped payloads', () => {
    expectRejected({ ...delivery(), payload: [] });
    expectRejected({ ...delivery(), protocolVersion: '2.0.0' });
    for (const value of liveMessageFixtures().filter((message) => message.type !== 'hello'))
      expectRejected(value);
  });

  it('rejects empty, oversized, nested, encoded and hello-containing batches', () => {
    for (const messages of [
      [],
      Array(5).fill(delivery().messages[0]),
      [delivery()],
      [liveMessageFixtures()[0]],
      [JSON.stringify(delivery().messages[0])],
      [null],
    ])
      expectRejected({ ...delivery(), messages });
    const sparse = new Array(1) as LiveDeliveryMessage['messages'];
    expect(parseLiveServerFrame(delivery({ messages: sparse })).ok).toBe(false);
  });

  it('enforces semantic uniqueness and complete inner/outer binding before dispatch', () => {
    const sameType = delivery({ messages: [delivery().messages[0]!, delivery().messages[0]!] });
    expect(validateFrame(sameType)).toBe(true);
    expect(parseLiveServerFrame(sameType).ok).toBe(false);
    for (const field of ['providerId', 'regionId', 'feedEpoch']) {
      const value = delivery({
        messages: [
          delivery().messages[0]!,
          {
            type: 'feed.health',
            protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
            health: healthFixture({ [field]: 'other' }),
          },
        ],
      });
      expect(validateFrame(value)).toBe(true);
      const parsed = parseLiveServerFrame(value);
      expect(parsed.ok).toBe(false);
      expect(parsed.message).toBeUndefined();
    }
  });

  it('validates a later payload without accepting a partial batch', () => {
    const value = delivery();
    const raw = JSON.parse(JSON.stringify(value)) as {
      messages: Array<{ health?: Record<string, unknown> }>;
    };
    raw.messages[1]!.health!.status = 'invented';
    expectRejected(raw);
    expect(parseLiveServerFrame(raw).message).toBeUndefined();
  });

  it('includes every envelope byte and UTF-8 byte in the wire limit', () => {
    const wire = serializeLiveServerFrame(delivery());
    const size = new TextEncoder().encode(wire).byteLength;
    expect(parseLiveServerFrame(wire + ' '.repeat(MAX_LIVE_MESSAGE_BYTES - size)).ok).toBe(true);
    expect(parseLiveServerFrame(wire + ' '.repeat(MAX_LIVE_MESSAGE_BYTES - size + 1)).ok).toBe(
      false,
    );
    expect(parseLiveServerFrame('"' + '🛩'.repeat(MAX_LIVE_MESSAGE_BYTES / 3) + '"').ok).toBe(false);
    expect(
      parseLiveServerFrame(
        JSON.stringify(liveMessageFixtures()[0]) + ' '.repeat(MAX_LIVE_HANDSHAKE_BYTES),
      ).ok,
    ).toBe(false);
  });

  it('accepts the actual 2000-record limit and rejects 2001', () => {
    const aircraft = Array.from({ length: MAX_LIVE_AIRCRAFT }, (_, index) =>
      aircraftFixture({ aircraftId: index.toString(16).padStart(6, '0') }),
    );
    const value = delivery({
      messages: [
        {
          type: 'airspace.snapshot',
          protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
          snapshot: snapshotFixture({ aircraft }),
        },
      ],
    });
    expect(parseLiveServerFrame(serializeLiveServerFrame(value)).ok).toBe(true);
    aircraft.push(aircraftFixture({ aircraftId: 'ffffff' }));
    const tooMany = delivery({
      messages: [
        {
          type: 'airspace.snapshot',
          protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
          snapshot: snapshotFixture({ aircraft }),
        },
      ],
    });
    expectRejected(tooMany);
  });

  it('revalidates serialized output instead of trusting a toJSON hook', () => {
    const value = delivery();
    Object.defineProperty(value.messages, 'toJSON', { value: () => [liveMessageFixtures()[0]] });
    expect(parseLiveServerFrame(value).ok).toBe(true);
    expect(() => serializeLiveServerFrame(value)).toThrow(/output/);
  });

  it.each([undefined, null, 1, [], '{', Object.create({ type: 'delivery' })])(
    'rejects non-JSON or non-record input %j',
    (value) => expect(parseLiveServerFrame(value).ok).toBe(false),
  );
});

describe('feed-bound receipt acknowledgment', () => {
  it('contains only the delivery token and full feed binding, with no clock fields', () => {
    const wire = serializeLiveAcknowledgment(delivery());
    const value = JSON.parse(wire) as unknown;
    expect(validateAck(value), JSON.stringify(validateAck.errors)).toBe(true);
    expect(parseLiveAcknowledgment(wire)).toEqual({
      type: 'ack',
      protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
      providerId: 'adsb-lol',
      regionId: 'atlanta',
      feedEpoch: LIVE_FIXTURE_EPOCH,
      deliveryId: 'delivery-1',
    });
    expect(parseLiveAcknowledgment(value)).toBeUndefined();
  });

  it('bounds text controls and rejects additional data, bad identifiers and wrong versions', () => {
    const wire = serializeLiveAcknowledgment(delivery());
    expect(
      parseLiveAcknowledgment(wire + ' '.repeat(MAX_LIVE_CONTROL_BYTES - wire.length)),
    ).toBeDefined();
    expect(parseLiveAcknowledgment(wire + ' '.repeat(MAX_LIVE_CONTROL_BYTES))).toBeUndefined();
    for (const change of [
      { generatedAt: LIVE_FIXTURE_TIME },
      { deliveryId: '' },
      { regionId: 'atlanta\n' },
      { protocolVersion: '2' },
      { type: 'ping' },
    ]) {
      const value = { ...(JSON.parse(wire) as object), ...change };
      expect(validateAck(value)).toBe(false);
      expect(parseLiveAcknowledgment(JSON.stringify(value))).toBeUndefined();
    }
    expect(parseLiveAcknowledgment('{')).toBeUndefined();
    expect(parseLiveAcknowledgment('null')).toBeUndefined();
    expect(() => serializeLiveAcknowledgment(delivery({ deliveryId: '' }))).toThrow();
  });
});
