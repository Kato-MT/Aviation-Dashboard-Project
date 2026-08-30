import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';

import airspaceSchema from '../../schemas/airspace-v1.schema.json';
import streamSchema from '../../schemas/live-stream-v1.schema.json';
import {
  LIVE_STREAM_PROTOCOL_VERSION,
  parseLiveStreamMessage,
  serializeLiveStreamMessage,
  type LiveStreamMessage,
} from '../../src/live/protocol';
import { LIVE_FIXTURE_EPOCH, LIVE_FIXTURE_TIME, liveMessageFixtures } from './fixtures';

const ajv = new Ajv2020({ strict: true });
addFormats(ajv);
ajv.addSchema(airspaceSchema);
const schema = ajv.compile(streamSchema);
const messages: LiveStreamMessage[] = [
  ...liveMessageFixtures().filter((message) => message.type !== 'error'),
  {
    type: 'pong',
    protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
    providerId: 'adsb-lol',
    regionId: 'atlanta',
    feedEpoch: LIVE_FIXTURE_EPOCH,
    requestId: 'ping-1',
    generatedAt: LIVE_FIXTURE_TIME,
  },
];

function bindingOf(message: Record<string, unknown>): Record<string, unknown> {
  if (message.type === 'airspace.snapshot') return message.snapshot as Record<string, unknown>;
  if (message.type === 'feed.health') return message.health as Record<string, unknown>;
  return message;
}

describe.each(messages.map((message) => ({ type: message.type, message })))(
  '$type feed binding',
  ({ message }) => {
    it('preserves the complete binding through both validators and serialization', () => {
      expect(schema(message), JSON.stringify(schema.errors)).toBe(true);
      expect(parseLiveStreamMessage(serializeLiveStreamMessage(message))).toEqual({
        ok: true,
        message,
        errors: [],
      });
    });

    describe.each(['providerId', 'regionId', 'feedEpoch'])('%s', (field) => {
      it.each([undefined, null, 0, '', 'bad id', 'a'.repeat(65), 'feed-1\n'])(
        'rejects an absent or malformed identifier: %j',
        (value) => {
          const changed = structuredClone(message) as unknown as Record<string, unknown>;
          bindingOf(changed)[field] = value;
          const wire = JSON.stringify(changed);
          expect(schema(JSON.parse(wire))).toBe(false);
          expect(parseLiveStreamMessage(wire).ok).toBe(false);
        },
      );
    });
  },
);
