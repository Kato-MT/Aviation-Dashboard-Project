import { describe, expect, it } from 'vitest';
import { normalizeAdsbLolPayload } from '../../src/live/providers/adsbLol';
import { REGION_CONFIGS } from '../../src/live/regions';

const receipt = Date.parse('2026-08-27T12:00:10.000Z');
const providerTime = receipt - 2_000;

function rawAircraft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hex: 'a1b2c3',
    seen: 2,
    seen_pos: 3,
    lat: 33.64,
    lon: -84.43,
    alt_baro: 12_000,
    gs: 320,
    track: 180,
    baro_rate: 500,
    ...overrides,
  };
}

function normalize(overrides: Record<string, unknown> = {}, now = providerTime) {
  return normalizeAdsbLolPayload({ now, ac: [rawAircraft(overrides)] }, REGION_CONFIGS[0], receipt);
}

describe('provider observation semantics', () => {
  it('preserves provider milliseconds and includes delivery delay in receipt-relative ages', () => {
    const result = normalize();
    expect(result.providerGeneratedAt).toBe('2026-08-27T12:00:08.000Z');
    expect(result.receivedAt).toBe('2026-08-27T12:00:10.000Z');
    expect(result.aircraft[0]).toMatchObject({
      observedAt: '2026-08-27T12:00:06.000Z',
      lastContactAt: '2026-08-27T12:00:06.000Z',
      lastPositionAt: '2026-08-27T12:00:05.000Z',
      contactAgeSeconds: 4,
      positionAgeSeconds: 5,
    });
  });

  it('does not make a cached provider payload current merely because it arrived now', () => {
    expect(normalize({}, receipt - 300_000).aircraft[0]).toMatchObject({
      contactAgeSeconds: 302,
      positionAgeSeconds: 303,
      qualityFlags: ['stale-position', 'stale-contact'],
    });
  });

  it.each([0, 12_000, undefined, null, 'unknown', false])(
    'does not infer airborne state from barometric altitude %j',
    (alt_baro) => {
      expect(normalize({ alt_baro }).aircraft[0]).toHaveProperty('onGround', null);
    },
  );

  it('accepts only the documented ground sentinel as explicit ground evidence', () => {
    const track = normalize({ alt_baro: 'ground' }).aircraft[0];
    expect(track).toHaveProperty('onGround', true);
    expect(track).not.toHaveProperty('barometricAltitudeFeet');
    expect(normalize({ ground: false }).aircraft[0]).toHaveProperty('onGround', null);
  });

  it.each([
    { baro_rate: 0, geom_rate: 300, rate: 0, basis: 'barometric' },
    { baro_rate: -500, geom_rate: 300, rate: -500, basis: 'barometric' },
    { baro_rate: undefined, geom_rate: 0, rate: 0, basis: 'geometric' },
    { baro_rate: null, geom_rate: 300, rate: 300, basis: 'geometric' },
    { baro_rate: 'invalid', geom_rate: -300, rate: -300, basis: 'geometric' },
  ])('preserves vertical rate and basis: $basis $rate', ({ baro_rate, geom_rate, rate, basis }) => {
    expect(normalize({ baro_rate, geom_rate }).aircraft[0]).toMatchObject({
      verticalRateFeetPerMinute: rate,
      verticalRateBasis: basis,
    });
  });

  it('omits both vertical fields when neither rate is usable', () => {
    const track = normalize({ baro_rate: null, geom_rate: 'invalid' }).aircraft[0];
    expect(track).not.toHaveProperty('verticalRateFeetPerMinute');
    expect(track).not.toHaveProperty('verticalRateBasis');
  });

  it.each([undefined, null, -1, '3', Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_VALUE])(
    'does not expose a partial position tuple for invalid/missing seen_pos %j',
    (seen_pos) => {
      const track = normalize({ seen_pos }).aircraft[0];
      expect(track).not.toHaveProperty('position');
      expect(track).not.toHaveProperty('lastPositionAt');
      expect(track).not.toHaveProperty('positionAgeSeconds');
      expect(track?.qualityFlags).toContain('missing-position');
    },
  );

  it.each([{ lat: undefined }, { lon: null }, { lat: 91 }, { lon: -181 }, { lat: '33' }])(
    'omits position time/age when coordinates are unusable: %j',
    (fields) => {
      const track = normalize(fields).aircraft[0];
      expect(track).not.toHaveProperty('position');
      expect(track).not.toHaveProperty('lastPositionAt');
      expect(track).not.toHaveProperty('positionAgeSeconds');
    },
  );

  it('retains valid zeros and does not wrap invalid directions', () => {
    expect(
      normalize({ lat: 0, lon: 0, seen: 0, seen_pos: 0, gs: 0, track: 0 }).aircraft[0],
    ).toMatchObject({
      position: { latitude: 0, longitude: 0 },
      groundSpeedKnots: 0,
      trackDegrees: 0,
    });
    for (const track of [-1, 360, 371]) {
      const result = normalize({ track });
      expect(result.aircraft[0]).not.toHaveProperty('trackDegrees');
      expect(result.validation.invalidFields).toBe(1);
    }
    expect(normalize({ gs: -1 }).aircraft[0]).not.toHaveProperty('groundSpeedKnots');
  });

  it.each([
    '~abcdef-extra',
    'abcdef0',
    ' abcdef',
    'abcdef ',
    '~abcde',
    'demo:one',
    'abcdef\n',
    '~abcdef\r',
    'abcdef\r\n',
    'abcdef\u2028',
    '~abcdef\u2029',
  ])('validates the entire identity before any normalization: %s', (hex) => {
    expect(normalize({ hex }).validation).toMatchObject({
      acceptedAircraft: 0,
      rejectedAircraft: 1,
    });
  });

  it('normalizes case without changing valid identity content', () => {
    expect(normalize({ hex: '~ABCDEF' }).aircraft[0]).toMatchObject({
      aircraftId: '~abcdef',
      identifierKind: 'other',
    });
  });

  it.each([
    { field: 'flight', value: 42, output: 'callsign' },
    { field: 'flight', value: 'X'.repeat(17), output: 'callsign' },
    { field: 'r', value: 'A\u0000B', output: 'registration' },
    { field: 't', value: '\nB738', output: 'aircraftType' },
    { field: 'category', value: {}, output: 'category' },
    { field: 'type', value: 'X'.repeat(33), output: 'sourceType' },
  ])('drops and counts an invalid optional text field: $field', ({ field, value, output }) => {
    const result = normalize({ [field]: value });
    expect(result.aircraft[0]).not.toHaveProperty(output);
    expect(result.validation.invalidFields).toBe(1);
  });

  it('accepts padded callsigns and bounded Unicode without truncation', () => {
    expect(normalize({ flight: ' TEST123 ', r: '🚁'.repeat(16) }).aircraft[0]).toMatchObject({
      callsign: 'TEST123',
      registration: '🚁'.repeat(16),
    });
    expect(normalize({ flight: '   ' }).aircraft[0]).not.toHaveProperty('callsign');
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_VALUE, 253402300800000])(
    'rejects unusable provider timestamps without throwing a raw date error: %j',
    (now) => {
      expect(() => normalize({}, now)).toThrowError(/provider timestamp/i);
    },
  );

  it('rejects impossible required contact time and quarantines impossible optional position time', () => {
    expect(normalize({ seen: Number.MAX_VALUE }).validation.rejectedAircraft).toBe(1);
    expect(normalize({ seen: providerTime / 1_000 + 1 }).validation.rejectedAircraft).toBe(1);
    expect(normalize({ seen_pos: providerTime / 1_000 + 1 }).aircraft[0]).not.toHaveProperty(
      'position',
    );
  });

  it('retains small future offsets explicitly as uncertain, without clamping age to zero', () => {
    expect(normalize({ seen: 0, seen_pos: 0 }, receipt + 5_000).aircraft[0]).toMatchObject({
      contactAgeSeconds: -5,
      positionAgeSeconds: -5,
      qualityFlags: ['time-uncertain'],
    });
    expect(() => normalize({}, receipt + 5_001)).toThrowError(/provider timestamp/i);
  });

  it.each([0, -1, 2_001, Number.NaN, Number.POSITIVE_INFINITY, 1.5])(
    'validates the public normalizer record cap: %j',
    (cap) => {
      expect(() =>
        normalizeAdsbLolPayload({ now: providerTime, ac: [] }, REGION_CONFIGS[0], receipt, cap),
      ).toThrowError(/maxAircraft/);
    },
  );

  it('does not mutate the provider object', () => {
    const payload = { now: providerTime, ac: [rawAircraft({ flight: ' TEST ' })] };
    const before = structuredClone(payload);
    normalizeAdsbLolPayload(payload, REGION_CONFIGS[0], receipt);
    expect(payload).toEqual(before);
  });
});
