import { describe, expect, it } from 'vitest';

import {
  CommunicationFaultInjector,
  DECLARED_COMMUNICATION_FAULTS,
  type CommunicationFaultId,
} from '../../src/streaming/faultInjection';
import {
  STREAM_PROTOCOL_VERSION,
  type HeartbeatMessage,
  type HelloMessage,
  type TelemetryMessage,
} from '../../src/streaming/protocol';

function telemetry(sequence: number): TelemetryMessage {
  return {
    protocolVersion: STREAM_PROTOCOL_VERSION,
    type: 'telemetry',
    sourceId: 'source-a',
    sequence,
    timestamp: new Date(Date.parse('2026-01-01T00:00:00Z') + sequence * 1_000).toISOString(),
    measurements: { airspeed: 120 + sequence },
    qualityFlags: ['synthetic'],
  };
}

function injector(id: CommunicationFaultId, value?: number): CommunicationFaultInjector {
  return new CommunicationFaultInjector({
    seed: 42,
    scenarios: [
      {
        id,
        enabled: true,
        startAtMessage: 0,
        every: 1,
        ...(value === undefined ? {} : { value }),
      },
    ],
  });
}

describe('declared communication fault injection', () => {
  it('declares all nine required scenarios', () => {
    expect(DECLARED_COMMUNICATION_FAULTS).toEqual([
      'disconnect',
      'latency',
      'jitter',
      'dropped-packet',
      'duplicate',
      'reorder',
      'stale-heartbeat',
      'schema-mismatch',
      'queue-pressure',
    ]);
  });

  it('injects a one-time disconnect', () => {
    const fault = injector('disconnect');
    expect(fault.transform(telemetry(1)).disconnect).toBe(true);
    expect(fault.transform(telemetry(2)).disconnect).toBe(false);
  });

  it('injects deterministic latency', () => {
    expect(injector('latency', 625).transform(telemetry(1)).deliveries[0]?.delayMs).toBe(625);
  });

  it('injects seeded bounded jitter', () => {
    const delay = injector('jitter', 250).transform(telemetry(1)).deliveries[0]?.delayMs;
    expect(delay).toBeGreaterThanOrEqual(0);
    expect(delay).toBeLessThanOrEqual(250);
  });

  it('drops a telemetry packet', () => {
    expect(injector('dropped-packet').transform(telemetry(1)).deliveries).toEqual([]);
  });

  it('duplicates a telemetry packet without changing its sequence', () => {
    const deliveries = injector('duplicate').transform(telemetry(3)).deliveries;
    expect(deliveries).toHaveLength(2);
    expect(deliveries.map((entry) => entry.message.sequence)).toEqual([3, 3]);
  });

  it('reorders a pair deterministically', () => {
    const fault = injector('reorder');
    expect(fault.transform(telemetry(1)).deliveries).toEqual([]);
    expect(fault.transform(telemetry(2)).deliveries.map((entry) => entry.message.sequence)).toEqual(
      [2, 1],
    );
  });

  it('suppresses heartbeats to produce a stale feed', () => {
    const heartbeat: HeartbeatMessage = {
      protocolVersion: STREAM_PROTOCOL_VERSION,
      type: 'heartbeat',
      sourceId: 'source-a',
      sequence: 1,
      timestamp: '2026-01-01T00:00:01.000Z',
      status: 'nominal',
      uptimeMs: 1_000,
      queueDepth: 0,
      droppedMessages: 0,
    };
    expect(injector('stale-heartbeat').transform(heartbeat).deliveries).toEqual([]);
  });

  it('injects a declared schema mismatch into hello', () => {
    const hello: HelloMessage = {
      protocolVersion: STREAM_PROTOCOL_VERSION,
      type: 'hello',
      sourceId: 'source-a',
      sequence: 0,
      timestamp: '2026-01-01T00:00:00.000Z',
      schemaVersion: 'telemetry.synthetic.v1',
      profileId: 'generic.synthetic.v1',
      units: { airspeed: 'kn' },
      capabilities: [],
    };
    const message = injector('schema-mismatch').transform(hello).deliveries[0]?.message;
    expect(message?.type).toBe('hello');
    if (message?.type === 'hello') {
      expect(message.schemaVersion).toBe('unsupported.synthetic.v999');
    }
  });

  it('creates a declared queue-pressure burst', () => {
    const deliveries = injector('queue-pressure', 12).transform(telemetry(1)).deliveries;
    expect(deliveries).toHaveLength(12);
    expect(deliveries.every((entry) => entry.injectedFaults.includes('queue-pressure'))).toBe(true);
  });
});
