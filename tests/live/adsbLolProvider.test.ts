import { describe, expect, it, vi } from 'vitest';

import { LiveProviderError } from '../../src/live/provider';
import { getRegionConfig, REGION_CONFIGS } from '../../src/live/regions';
import {
  ADSB_LOL_USER_AGENT,
  createAdsbLolProvider,
  normalizeAdsbLolPayload,
} from '../../src/live/providers/adsbLol';

const region = REGION_CONFIGS[0];
const receivedAtMs = Date.parse('2026-08-27T12:00:10.000Z');
const providerNow = Date.parse('2026-08-27T12:00:08.000Z');

function aircraft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hex: 'a1b2c3',
    flight: ' DAL123 ',
    r: 'N123AB',
    t: 'B738',
    type: 'adsb_icao',
    lat: 33.64,
    lon: -84.43,
    alt_baro: 12_000,
    alt_geom: 12_275,
    gs: 320.5,
    track: 11,
    baro_rate: 1_200,
    seen: 2,
    seen_pos: 3,
    ...overrides,
  };
}

describe('ADSB.lol provider normalization', () => {
  it('resolves only declared region identifiers', () => {
    expect(getRegionConfig('atlanta')?.label).toBe('Atlanta');
    expect(getRegionConfig('worldwide')).toBeUndefined();
  });

  it('maps provider data into explicit surveillance units', () => {
    const snapshot = normalizeAdsbLolPayload(
      { now: providerNow, ac: [aircraft()] },
      region,
      receivedAtMs,
    );

    expect(snapshot.providerId).toBe('adsb-lol');
    expect(snapshot.regionId).toBe('atlanta');
    expect(snapshot.validation).toEqual({
      receivedAircraft: 1,
      acceptedAircraft: 1,
      rejectedAircraft: 0,
      duplicateAircraft: 0,
      invalidFields: 0,
    });
    expect(snapshot.aircraft[0]).toMatchObject({
      aircraftId: 'a1b2c3',
      callsign: 'DAL123',
      registration: 'N123AB',
      aircraftType: 'B738',
      position: { latitude: 33.64, longitude: -84.43 },
      barometricAltitudeFeet: 12_000,
      geometricAltitudeFeet: 12_275,
      groundSpeedKnots: 320.5,
      trackDegrees: 11,
      verticalRateFeetPerMinute: 1_200,
      verticalRateBasis: 'barometric',
      onGround: null,
      contactAgeSeconds: 4,
      positionAgeSeconds: 5,
      qualityFlags: [],
    });
  });

  it('retains positionless aircraft with an explicit quality flag', () => {
    const snapshot = normalizeAdsbLolPayload(
      { now: providerNow, ac: [aircraft({ lat: undefined, lon: undefined, seen_pos: undefined })] },
      region,
      receivedAtMs,
    );

    expect(snapshot.aircraft[0]).not.toHaveProperty('position');
    expect(snapshot.aircraft[0]?.qualityFlags).toContain('missing-position');
  });

  it('marks stale contact and position without calling them aircraft faults', () => {
    const snapshot = normalizeAdsbLolPayload(
      { now: providerNow, ac: [aircraft({ seen: 50, seen_pos: 61 })] },
      region,
      receivedAtMs,
    );

    expect(snapshot.aircraft[0]?.qualityFlags).toEqual(['stale-position', 'stale-contact']);
  });

  it('normalizes ground altitude and non-ICAO identifiers', () => {
    const snapshot = normalizeAdsbLolPayload(
      { now: providerNow, ac: [aircraft({ hex: '~abcdef', alt_baro: 'ground' })] },
      region,
      receivedAtMs,
    );

    expect(snapshot.aircraft[0]).toMatchObject({
      aircraftId: '~abcdef',
      identifierKind: 'other',
      onGround: true,
    });
    expect(snapshot.aircraft[0]).not.toHaveProperty('barometricAltitudeFeet');
  });

  it('rejects invalid identifiers and required freshness data', () => {
    const snapshot = normalizeAdsbLolPayload(
      {
        now: providerNow,
        ac: [aircraft({ hex: 'not-safe' }), aircraft({ hex: 'abcdef', seen: -1 })],
      },
      region,
      receivedAtMs,
    );

    expect(snapshot.aircraft).toEqual([]);
    expect(snapshot.validation.rejectedAircraft).toBe(2);
  });

  it('deduplicates by identifier and keeps the freshest contact', () => {
    const snapshot = normalizeAdsbLolPayload(
      {
        now: providerNow,
        ac: [aircraft({ seen: 10, flight: 'OLD' }), aircraft({ seen: 1, flight: 'NEW' })],
      },
      region,
      receivedAtMs,
    );

    expect(snapshot.aircraft).toHaveLength(1);
    expect(snapshot.aircraft[0]?.callsign).toBe('NEW');
    expect(snapshot.validation.duplicateAircraft).toBe(1);
  });

  it('counts invalid optional fields and does not preserve invalid coordinates', () => {
    const snapshot = normalizeAdsbLolPayload(
      {
        now: providerNow,
        ac: [aircraft({ lat: 200, lon: -84, gs: 'fast', baro_rate: null, geom_rate: 300 })],
      },
      region,
      receivedAtMs,
    );

    expect(snapshot.validation.invalidFields).toBe(2);
    expect(snapshot.aircraft[0]).not.toHaveProperty('position');
    expect(snapshot.aircraft[0]?.verticalRateFeetPerMinute).toBe(300);
  });

  it('blocks responses above the aircraft cap', () => {
    expect(() =>
      normalizeAdsbLolPayload(
        { now: providerNow, ac: [aircraft(), aircraft({ hex: 'd4e5f6' })] },
        region,
        receivedAtMs,
        1,
      ),
    ).toThrowError(LiveProviderError);
  });

  it('requires a numeric provider timestamp and aircraft array', () => {
    expect(() => normalizeAdsbLolPayload({ now: 'later', ac: {} }, region, receivedAtMs)).toThrow(
      'provider timestamp and an aircraft array',
    );
  });
});

describe('ADSB.lol HTTP adapter', () => {
  it('requests the fixed regional point endpoint and parses a successful response', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ now: providerNow, ac: [aircraft()] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const provider = createAdsbLolProvider({
      baseUrl: 'https://provider.test/',
      fetcher,
      now: () => receivedAtMs,
    });

    const snapshot = await provider.fetchRegion(region);

    expect(fetcher).toHaveBeenCalledWith(
      'https://provider.test/v2/point/33.6407/-84.4277/100',
      expect.objectContaining({
        method: 'GET',
        headers: { Accept: 'application/json', 'User-Agent': ADSB_LOL_USER_AGENT },
      }),
    );
    expect(snapshot.aircraft).toHaveLength(1);
  });

  it('surfaces rate-limit retry guidance', async () => {
    const provider = createAdsbLolProvider({
      fetcher: async () => new Response('', { status: 429, headers: { 'retry-after': '30' } }),
    });

    await expect(provider.fetchRegion(region)).rejects.toMatchObject({
      code: 'UPSTREAM_RATE_LIMITED',
      status: 429,
      retryAfterSeconds: 30,
    });
  });

  it.each([
    { status: 403, retryBlocked: true },
    { status: 408, retryBlocked: false },
  ])('classifies HTTP $status retry behavior conservatively', async ({ status, retryBlocked }) => {
    const provider = createAdsbLolProvider({
      fetcher: async () => new Response('', { status }),
    });

    await expect(provider.fetchRegion(region)).rejects.toMatchObject({
      code: 'UPSTREAM_HTTP_ERROR',
      status,
      retryBlocked,
    });
  });

  it('rejects malformed and oversized bodies', async () => {
    const malformed = createAdsbLolProvider({ fetcher: async () => new Response('{') });
    await expect(malformed.fetchRegion(region)).rejects.toMatchObject({ code: 'MALFORMED_JSON' });

    const oversized = createAdsbLolProvider({
      maxResponseBytes: 4,
      fetcher: async () => new Response('{"now":1,"ac":[]}'),
    });
    await expect(oversized.fetchRegion(region)).rejects.toMatchObject({
      code: 'PAYLOAD_TOO_LARGE',
    });
  });

  it('wraps network failures without exposing provider implementation details', async () => {
    const provider = createAdsbLolProvider({
      fetcher: async () => {
        throw new Error('socket details');
      },
    });

    await expect(provider.fetchRegion(region)).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
      message: 'The live aircraft provider request failed.',
    });
  });
});
