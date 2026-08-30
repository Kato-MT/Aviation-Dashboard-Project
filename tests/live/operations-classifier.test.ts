import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  classifyAdmissionOperations,
  classifyApplicationOperations,
  classifyDeliveryOperations,
  classifyFreshnessOperations,
  classifyProviderOperations,
  classifyRegionOperations,
  type DeliveryOperationalSignal,
  type ProviderOperationalSignal,
} from '../../src/operations/classifier';
import { MAX_OPERATIONS_COUNTER, OperationsContractError } from '../../src/operations/contract';

const CHECKED_AT = '2026-08-29T16:30:00.000Z';

function provider(
  overrides: Partial<Extract<ProviderOperationalSignal, { available: true }>> = {},
): Extract<ProviderOperationalSignal, { available: true }> {
  return {
    available: true,
    enabled: true,
    connected: true,
    acceptedSnapshot: true,
    rateLimited: false,
    retrying: false,
    degraded: false,
    ...overrides,
  };
}

function delivery(
  overrides: Partial<Extract<DeliveryOperationalSignal, { available: true }>> = {},
): Extract<DeliveryOperationalSignal, { available: true }> {
  return {
    available: true,
    acknowledgmentCount: 10,
    timeoutCount: 0,
    sendFailureCount: 0,
    invalidControlCount: 0,
    hibernationLossCount: 0,
    ...overrides,
  };
}

function liveRegion(regionId: 'atlanta' | 'savannah-statesboro' | 'central-georgia') {
  return classifyRegionOperations(
    {
      regionId,
      readAvailable: true,
      provider: provider(),
      delivery: delivery(),
      lastObservationAt: '2026-08-29T16:29:50.000Z',
    },
    CHECKED_AT,
  );
}

describe('operations provider classifier', () => {
  it.each([
    [{ available: false }, 'unavailable', 'PROVIDER_UNAVAILABLE'],
    [provider({ enabled: false }), 'disabled', 'PROVIDER_DISABLED'],
    [provider({ rateLimited: true }), 'rate-limited', 'PROVIDER_RATE_LIMITED'],
    [provider({ retrying: true }), 'retrying', 'PROVIDER_RETRYING'],
    [provider({ connected: false }), 'connecting', 'PROVIDER_CONNECTING'],
    [provider({ acceptedSnapshot: false }), 'empty', 'PROVIDER_EMPTY'],
    [provider({ degraded: true }), 'degraded', 'PROVIDER_DEGRADED'],
    [provider(), 'live', 'PROVIDER_LIVE'],
  ] as const)('classifies independent provider signal %# as %s', (signal, state, reason) => {
    const result = classifyProviderOperations(signal);
    expect(result).toEqual({ state, reasonCodes: [reason] });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.reasonCodes)).toBe(true);
  });

  it('uses stable fail-first precedence for overlapping rate-limit and retry evidence', () => {
    expect(classifyProviderOperations(provider({ rateLimited: true, retrying: true }))).toEqual({
      state: 'rate-limited',
      reasonCodes: ['PROVIDER_RATE_LIMITED'],
    });
  });
});

describe('operations delivery and admission classifiers', () => {
  it('keeps delivery outcomes independent and orders every degraded reason canonically', () => {
    const result = classifyDeliveryOperations(
      delivery({
        timeoutCount: 1,
        sendFailureCount: 2,
        invalidControlCount: 3,
        hibernationLossCount: 1,
      }),
    );
    expect(result).toEqual({
      state: 'degraded',
      reasonCodes: [
        'DELIVERY_DEGRADED_TIMEOUTS',
        'DELIVERY_DEGRADED_SEND_FAILURES',
        'DELIVERY_DEGRADED_INVALID_CONTROLS',
        'DELIVERY_HIBERNATION_LOSS_POSSIBLE',
      ],
    });
    expect(Object.isFrozen(result.reasonCodes)).toBe(true);
  });

  it('classifies healthy and unavailable delivery without using acknowledgment volume as health', () => {
    expect(classifyDeliveryOperations(delivery({ acknowledgmentCount: 0 }))).toEqual({
      state: 'healthy',
      reasonCodes: ['DELIVERY_HEALTHY'],
    });
    expect(classifyDeliveryOperations({ available: false })).toEqual({
      state: 'unavailable',
      reasonCodes: ['DELIVERY_UNAVAILABLE'],
    });
  });

  it('keeps admission Worker-local and independently classifies both rejection causes', () => {
    expect(
      classifyAdmissionOperations({
        available: true,
        acceptedCount: 20,
        rateLimitRejectionCount: 1,
        capacityRejectionCount: 2,
      }),
    ).toEqual({
      state: 'limited',
      reasonCodes: ['ADMISSION_LIMITED_RATE', 'ADMISSION_LIMITED_CAPACITY'],
    });
    expect(
      classifyAdmissionOperations({
        available: true,
        acceptedCount: 0,
        rateLimitRejectionCount: 0,
        capacityRejectionCount: 0,
      }),
    ).toEqual({ state: 'accepting', reasonCodes: ['ADMISSION_ACCEPTING'] });
    expect(classifyAdmissionOperations({ available: false })).toEqual({
      state: 'unavailable',
      reasonCodes: ['ADMISSION_UNAVAILABLE'],
    });
  });

  it('rejects negative, fractional, non-finite, individual overflow, and aggregate overflow', () => {
    for (const invalid of [
      -1,
      0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      MAX_OPERATIONS_COUNTER + 1,
    ]) {
      expect(() => classifyDeliveryOperations(delivery({ timeoutCount: invalid }))).toThrow(
        OperationsContractError,
      );
    }
    expect(() =>
      classifyDeliveryOperations(
        delivery({ acknowledgmentCount: MAX_OPERATIONS_COUNTER, timeoutCount: 1 }),
      ),
    ).toThrow(OperationsContractError);
  });
});

describe('operations freshness classifier', () => {
  it.each([
    [0, 'current', 'FRESHNESS_CURRENT'],
    [15, 'current', 'FRESHNESS_CURRENT'],
    [16, 'delayed', 'FRESHNESS_DELAYED'],
    [45, 'delayed', 'FRESHNESS_DELAYED'],
    [46, 'stale', 'FRESHNESS_STALE'],
    [119, 'stale', 'FRESHNESS_STALE'],
    [120, 'expired', 'FRESHNESS_EXPIRED'],
  ] as const)('classifies the fixed %i-second boundary as %s', (seconds, state, reason) => {
    const observedAt = new Date(Date.parse(CHECKED_AT) - seconds * 1_000).toISOString();
    expect(classifyFreshnessOperations(CHECKED_AT, observedAt)).toEqual({
      state,
      reasonCodes: [reason],
      observationAgeSeconds: seconds,
    });
  });

  it('rounds fractional evidence age upward so a boundary cannot look fresher', () => {
    expect(classifyFreshnessOperations(CHECKED_AT, '2026-08-29T16:29:44.999Z')).toEqual({
      state: 'delayed',
      reasonCodes: ['FRESHNESS_DELAYED'],
      observationAgeSeconds: 16,
    });
  });

  it('distinguishes empty and region-unavailable evidence with explicit null age', () => {
    expect(classifyFreshnessOperations(CHECKED_AT, null)).toEqual({
      state: 'empty',
      reasonCodes: ['FRESHNESS_EMPTY'],
      observationAgeSeconds: null,
    });
    expect(classifyFreshnessOperations(CHECKED_AT, null, false)).toEqual({
      state: 'unavailable',
      reasonCodes: ['FRESHNESS_UNAVAILABLE'],
      observationAgeSeconds: null,
    });
  });

  it.each([
    ['noncanonical checked-at', '2026-08-29T16:30:00Z', null],
    ['noncanonical observation', CHECKED_AT, '2026-08-29T16:29:50Z'],
    ['future observation', CHECKED_AT, '2026-08-29T16:30:00.001Z'],
  ])('rejects %s evidence', (_label, checkedAt, observedAt) => {
    expect(() => classifyFreshnessOperations(checkedAt, observedAt)).toThrow(
      OperationsContractError,
    );
  });

  it('rejects a representable timestamp whose age exceeds the bounded contract', () => {
    expect(() =>
      classifyFreshnessOperations('2026-08-29T16:30:00.000Z', '1800-01-01T00:00:00.000Z'),
    ).toThrow(OperationsContractError);
  });
});

describe('regional and application operations classification', () => {
  it('classifies one failed read as partial while retaining other regional states', () => {
    const regions = [
      liveRegion('atlanta'),
      classifyRegionOperations(
        { regionId: 'savannah-statesboro', readAvailable: false },
        CHECKED_AT,
      ),
      liveRegion('central-georgia'),
    ] as const;
    expect(classifyApplicationOperations(regions)).toEqual({
      state: 'partial',
      reasonCodes: ['APPLICATION_PARTIAL_REGIONS'],
    });
    expect(regions[0].provider.state).toBe('live');
    expect(regions[1]).toMatchObject({
      availability: { state: 'unavailable' },
      provider: { state: 'unavailable' },
      delivery: { state: 'unavailable' },
      freshness: { state: 'unavailable', observationAgeSeconds: null },
    });
    expect(regions[2].freshness.state).toBe('current');
  });

  it('classifies exactly two failed reads as partial while preserving the remaining region', () => {
    const remainingRegion = liveRegion('central-georgia');
    const regions = [
      classifyRegionOperations({ regionId: 'atlanta', readAvailable: false }, CHECKED_AT),
      classifyRegionOperations(
        { regionId: 'savannah-statesboro', readAvailable: false },
        CHECKED_AT,
      ),
      remainingRegion,
    ] as const;

    expect(classifyApplicationOperations(regions)).toEqual({
      state: 'partial',
      reasonCodes: ['APPLICATION_PARTIAL_REGIONS'],
    });
    expect(regions.slice(0, 2)).toEqual([
      expect.objectContaining({
        regionId: 'atlanta',
        availability: { state: 'unavailable', reasonCodes: ['REGION_READ_UNAVAILABLE'] },
      }),
      expect.objectContaining({
        regionId: 'savannah-statesboro',
        availability: { state: 'unavailable', reasonCodes: ['REGION_READ_UNAVAILABLE'] },
      }),
    ]);
    expect(regions[2]).toBe(remainingRegion);
    expect(regions[2]).toMatchObject({
      regionId: 'central-georgia',
      availability: { state: 'available', reasonCodes: ['REGION_AVAILABLE'] },
      provider: { state: 'live', reasonCodes: ['PROVIDER_LIVE'] },
      delivery: { state: 'healthy', reasonCodes: ['DELIVERY_HEALTHY'] },
      freshness: { state: 'current', reasonCodes: ['FRESHNESS_CURRENT'] },
    });
  });

  it('keeps provider, delivery, and freshness independent after a successful region read', () => {
    const region = classifyRegionOperations(
      {
        regionId: 'atlanta',
        readAvailable: true,
        provider: provider({ rateLimited: true }),
        delivery: delivery({ timeoutCount: 1 }),
        lastObservationAt: '2026-08-29T16:27:00.000Z',
      },
      CHECKED_AT,
    );
    expect(region).toMatchObject({
      availability: { state: 'available' },
      provider: { state: 'rate-limited' },
      delivery: { state: 'degraded' },
      freshness: { state: 'expired' },
    });
  });

  it('requires the exact ordered three-region set for application classification', () => {
    const regions = [
      liveRegion('atlanta'),
      liveRegion('savannah-statesboro'),
      liveRegion('central-georgia'),
    ] as const;
    expect(classifyApplicationOperations(regions)).toEqual({
      state: 'available',
      reasonCodes: ['APPLICATION_AVAILABLE'],
    });
    expect(() => classifyApplicationOperations(regions.slice(0, 2))).toThrow(
      OperationsContractError,
    );
    expect(() => classifyApplicationOperations([regions[1], regions[0], regions[2]])).toThrow(
      OperationsContractError,
    );
  });

  it('classifies three failed regional reads as application unavailable', () => {
    const regions = [
      classifyRegionOperations({ regionId: 'atlanta', readAvailable: false }, CHECKED_AT),
      classifyRegionOperations(
        { regionId: 'savannah-statesboro', readAvailable: false },
        CHECKED_AT,
      ),
      classifyRegionOperations({ regionId: 'central-georgia', readAvailable: false }, CHECKED_AT),
    ] as const;
    expect(classifyApplicationOperations(regions)).toEqual({
      state: 'unavailable',
      reasonCodes: ['APPLICATION_UNAVAILABLE'],
    });
  });

  it('rejects an unknown region and a noncanonical read timestamp', () => {
    expect(() =>
      classifyRegionOperations(
        { regionId: 'unknown' as 'atlanta', readAvailable: false },
        CHECKED_AT,
      ),
    ).toThrow(OperationsContractError);
    expect(() =>
      classifyRegionOperations(
        {
          regionId: 'atlanta',
          readAvailable: true,
          provider: provider(),
          delivery: delivery(),
          lastObservationAt: null,
        },
        '2026-08-29T16:30:00Z',
      ),
    ).toThrow(OperationsContractError);
  });
});

describe('cross-runtime operations foundation', () => {
  it.each(['contract.ts', 'classifier.ts'])(
    'has no Node, DOM, or Cloudflare runtime import in %s',
    (file) => {
      const source = readFileSync(new URL(`../../src/operations/${file}`, import.meta.url), 'utf8');
      expect(source).not.toMatch(/from ['"](?:node:|cloudflare:|@cloudflare\/)/u);
      expect(source).not.toMatch(/from ['"][^'"]*(?:document|window|dom)[^'"]*['"]/iu);
    },
  );
});
