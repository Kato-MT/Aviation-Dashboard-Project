import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';

import airspaceSchema from '../../schemas/airspace-v1.schema.json';
import { LIVE_STREAM_PROTOCOL_VERSION, parseLiveStreamMessage } from '../../src/live/protocol';
import type { AirspaceSnapshot } from '../../src/live/types';
import { aircraftFixture, snapshotFixture } from './fixtures';

const ajv = new Ajv2020({ strict: true });
addFormats(ajv);
const structurallyValid = ajv.compile(airspaceSchema);
const receipt = '2026-08-27T12:00:10.000Z';
const providerTime = '2026-08-27T12:00:08.000Z';
const contactTime = '2026-08-27T12:00:06.000Z';
const positionTime = '2026-08-27T12:00:05.000Z';

function snapshot(): AirspaceSnapshot {
  return snapshotFixture({
    generatedAt: receipt,
    providerGeneratedAt: providerTime,
    aircraft: [
      aircraftFixture({
        observedAt: contactTime,
        lastContactAt: contactTime,
        lastPositionAt: positionTime,
        contactAgeSeconds: 4,
        positionAgeSeconds: 5,
      }),
    ],
  });
}

function parse(value: AirspaceSnapshot) {
  return parseLiveStreamMessage({
    type: 'airspace.snapshot',
    protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
    snapshot: value,
  });
}

function expectTemporalRejection(value: AirspaceSnapshot): void {
  // Cross-field time agreement is a runtime rule, not a JSON Schema assertion.
  expect(structurallyValid(value), JSON.stringify(structurallyValid.errors)).toBe(true);
  expect(parse(value).ok).toBe(false);
}

describe('live observation time contract', () => {
  it('accepts distinct provider, receipt, contact and position times with matching ages', () => {
    const value = snapshot();
    expect(parse(value)).toMatchObject({ ok: true, message: { snapshot: value } });
  });

  it.each(['contactAgeSeconds', 'positionAgeSeconds'] as const)(
    'rejects a plausible but contradictory %s',
    (field) => {
      const value = snapshot();
      value.aircraft[0]![field] = 0;
      expectTemporalRejection(value);
    },
  );

  it('rejects a state timestamp that silently differs from its contact-time basis', () => {
    const value = snapshot();
    value.aircraft[0]!.observedAt = positionTime;
    expectTemporalRejection(value);
  });

  it('rejects contact reported after the provider snapshot, even with a matching receipt age', () => {
    const value = snapshot();
    const contact = '2026-08-27T12:00:09.000Z';
    Object.assign(value.aircraft[0]!, {
      observedAt: contact,
      lastContactAt: contact,
      contactAgeSeconds: 1,
    });
    expectTemporalRejection(value);
  });

  it('rejects position reported after the provider snapshot, even with a matching receipt age', () => {
    const value = snapshot();
    Object.assign(value.aircraft[0]!, {
      lastPositionAt: '2026-08-27T12:00:09.000Z',
      positionAgeSeconds: 1,
    });
    expectTemporalRejection(value);
  });

  it('does not let a cached resend change receipt time without changing the declared ages', () => {
    const value = snapshot();
    value.generatedAt = '2026-08-27T12:05:10.000Z';
    expectTemporalRejection(value);
  });

  it('rejects provider clock offsets outside the tolerance even for empty snapshots', () => {
    const value = snapshotFixture({
      generatedAt: receipt,
      providerGeneratedAt: '2026-08-27T12:00:15.001Z',
      aircraft: [],
    });
    expectTemporalRejection(value);
  });

  it('requires explicit uncertainty for a slightly future provider clock even with old observations', () => {
    const value = snapshot();
    value.providerGeneratedAt = '2026-08-27T12:00:15.000Z';
    expectTemporalRejection(value);
    value.aircraft[0]!.qualityFlags = ['time-uncertain'];
    expect(parse(value).ok).toBe(true);
  });

  it('accepts exact millisecond-relative ages without rounding them to seconds', () => {
    const value = snapshot();
    Object.assign(value.aircraft[0]!, {
      observedAt: '2026-08-27T12:00:06.999Z',
      lastContactAt: '2026-08-27T12:00:06.999Z',
      contactAgeSeconds: 3.001,
      lastPositionAt: '2026-08-27T12:00:05.123Z',
      positionAgeSeconds: 4.877,
    });
    expect(parse(value).ok).toBe(true);
  });
});
