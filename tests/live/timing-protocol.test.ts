import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';

import airspaceSchema from '../../schemas/airspace-v1.schema.json';
import streamSchema from '../../schemas/live-stream-v1.schema.json';
import { LIVE_FIXTURE_EPOCH } from './fixtures';
import {
  LIVE_STREAM_PROTOCOL_VERSION,
  parseLivePing,
  parseLiveStreamMessage,
  serializeLiveStreamMessage,
  type LivePongMessage,
} from '../../src/live/protocol';

const ping = { type: 'ping', protocolVersion: LIVE_STREAM_PROTOCOL_VERSION, requestId: 'ping-1' };
const pong: LivePongMessage = {
  type: 'pong',
  providerId: 'adsb-lol',
  feedEpoch: LIVE_FIXTURE_EPOCH,
  regionId: 'atlanta',
  protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
  requestId: 'ping-1',
  generatedAt: '2026-08-27T12:00:00.000Z',
};
const ajv = new Ajv2020({ strict: true });
addFormats(ajv);
ajv.addSchema(airspaceSchema);
const schema = ajv.compile(streamSchema);

describe('timestamped live keepalive protocol', () => {
  it('accepts only the bounded versioned request', () => {
    expect(parseLivePing(JSON.stringify(ping))).toEqual(ping);
  });

  it.each([
    'ping',
    'null',
    '[]',
    '{}',
    null,
    new ArrayBuffer(8),
    JSON.stringify({ ...ping, protocolVersion: '2.0.0' }),
    JSON.stringify({ ...ping, type: 'subscribe' }),
    JSON.stringify({ ...ping, requestId: '' }),
    JSON.stringify({ ...ping, requestId: 'a'.repeat(65) }),
    JSON.stringify({ ...ping, requestId: 'ping-1\n' }),
    JSON.stringify({ ...ping, region: 'worldwide' }),
    JSON.stringify(ping) + ' '.repeat(512),
  ])('rejects an invalid keepalive without forwarding anything: %j', (value) => {
    expect(parseLivePing(value)).toBeUndefined();
  });

  it('preserves request identity and server time through schema and runtime validation', () => {
    expect(schema(pong), JSON.stringify(schema.errors)).toBe(true);
    expect(parseLiveStreamMessage(serializeLiveStreamMessage(pong))).toMatchObject({
      ok: true,
      message: pong,
    });
  });

  it.each([
    { ...pong, requestId: undefined },
    { ...pong, requestId: '' },
    { ...pong, requestId: 'bad id' },
    { ...pong, generatedAt: undefined },
    { ...pong, generatedAt: '2026-02-30T12:00:00.000Z' },
    { ...pong, generatedAt: 'invalid' },
    { ...pong, extra: true },
  ])('rejects malformed server timing in both validators: %j', (value) => {
    expect(schema(value)).toBe(false);
    expect(parseLiveStreamMessage(value).ok).toBe(false);
  });
});
