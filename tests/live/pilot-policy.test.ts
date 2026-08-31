import { describe, expect, it } from 'vitest';

import { LIVE_PILOT_POLICY } from '../../src/live/pilotPolicy';
import { regionConfigsForLiveSource } from '../../src/live/regions';
import { RUNTIME_POLICY_LIMITS } from '../../src/live/runtimePolicyLimits';
import { describeLiveSource } from '../../src/live/source';

describe('ADSB.lol public-pilot policy', () => {
  it('binds one Atlanta endpoint to the 20-second and 25-viewer envelope', () => {
    const liveRegions = regionConfigsForLiveSource(describeLiveSource('production', 'live'));
    expect(liveRegions.map(({ id }) => id)).toEqual(['atlanta']);
    const region = liveRegions[0]!;
    expect(
      `/v2/point/${region.center.latitude}/${region.center.longitude}/${region.radiusNauticalMiles}`,
    ).toBe(LIVE_PILOT_POLICY.endpointPath);
    expect(RUNTIME_POLICY_LIMITS.provider.pollIntervalMs).toBe(20_000);
    expect(RUNTIME_POLICY_LIMITS.delivery.maximumRegionalViewers).toBe(25);
  });

  it('retains all three fixed presets only for synthetic assurance', () => {
    expect(
      regionConfigsForLiveSource(describeLiveSource('mock-staging', 'mock')).map(({ id }) => id),
    ).toEqual(['atlanta', 'savannah-statesboro', 'central-georgia']);
  });

  it('uses an identifiable product User-Agent with a project contact URL', () => {
    expect(LIVE_PILOT_POLICY.userAgent).toBe(
      'GeorgiaFlightOutlook/0.1 (+https://github.com/Kato-MT/Aviation-Dashboard-Project)',
    );
    expect(LIVE_PILOT_POLICY.userAgent).not.toMatch(/mozilla|undici|cloudflare|generic/iu);
  });
});
