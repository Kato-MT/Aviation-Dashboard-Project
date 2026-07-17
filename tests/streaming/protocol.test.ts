import { describe, expect, it } from 'vitest';

import {
  STREAM_PROTOCOL_VERSION,
  parseStreamMessage,
  serializeStreamMessage,
  type HelloMessage,
  type StreamMessage,
} from '../../src/streaming/protocol';

const hello: HelloMessage = {
  protocolVersion: STREAM_PROTOCOL_VERSION,
  type: 'hello',
  sourceId: 'synthetic-source-01',
  sequence: 0,
  timestamp: '2026-01-01T00:00:00.000Z',
  schemaVersion: 'telemetry.synthetic.v1',
  profileId: 'generic-fixed-wing.synthetic.v1',
  units: { airspeed: 'kn' },
  capabilities: ['heartbeat'],
};

describe('stream protocol validation', () => {
  it('accepts and round-trips a hello message', () => {
    const result = parseStreamMessage(serializeStreamMessage(hello));
    expect(result).toEqual({ ok: true, message: hello, errors: [] });
  });

  it.each<StreamMessage>([
    {
      protocolVersion: STREAM_PROTOCOL_VERSION,
      type: 'telemetry',
      sourceId: 'source-a',
      sequence: 1,
      timestamp: '2026-01-01T00:00:01.000Z',
      measurements: { airspeed: 120, optional: null },
      qualityFlags: ['synthetic'],
    },
    {
      protocolVersion: STREAM_PROTOCOL_VERSION,
      type: 'heartbeat',
      sourceId: 'source-a',
      sequence: 2,
      timestamp: '2026-01-01T00:00:02.000Z',
      status: 'nominal',
      uptimeMs: 2_000,
      queueDepth: 0,
      droppedMessages: 0,
    },
    {
      protocolVersion: STREAM_PROTOCOL_VERSION,
      type: 'end',
      sourceId: 'source-a',
      sequence: 3,
      timestamp: '2026-01-01T00:00:03.000Z',
      reason: 'complete',
      finalSequence: 3,
    },
  ])('accepts a valid $type message', (message) => {
    expect(parseStreamMessage(message).ok).toBe(true);
  });

  it('rejects malformed JSON', () => {
    expect(parseStreamMessage('{not json')).toEqual({
      ok: false,
      errors: ['Message is not valid JSON.'],
    });
  });

  it('rejects an unsupported protocol version', () => {
    const result = parseStreamMessage({ ...hello, protocolVersion: '99.0.0' });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('Unsupported protocolVersion');
  });

  it('rejects unsafe or hostile source IDs', () => {
    const result = parseStreamMessage({ ...hello, sourceId: '<img src=x onerror="alert(1)">' });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      'sourceId must be a safe identifier between 1 and 128 characters.',
    );
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, '120', {}, []])(
    'rejects invalid telemetry measurement %s',
    (measurement) => {
      const result = parseStreamMessage({
        ...hello,
        type: 'telemetry',
        measurements: { airspeed: measurement },
        qualityFlags: [],
      });
      expect(result.ok).toBe(false);
      expect(result.errors.join(' ')).toContain('measurements.airspeed must be finite or null');
    },
  );

  it('rejects an invalid timestamp and sequence', () => {
    const result = parseStreamMessage({ ...hello, timestamp: 'not-a-date', sequence: -1 });
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(2);
  });

  it('refuses to serialize a structurally invalid object', () => {
    expect(() => serializeStreamMessage({ ...hello, units: { airspeed: '' } })).toThrow(
      'Cannot serialize invalid stream message',
    );
  });
});
