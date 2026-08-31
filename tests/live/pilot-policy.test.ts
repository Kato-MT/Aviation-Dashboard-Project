import { describe, expect, it } from 'vitest';

import { LIVE_PILOT_POLICY } from '../../src/live/pilotPolicy';
import {
  LIVE_PILOT_MAXIMUM_CONCURRENT_VIEWERS,
  LIVE_PILOT_POLL_INTERVAL_MS,
  LIVE_PILOT_REGION_ID,
} from '../../src/live/pilotEnvelope';
import { regionConfigsForLiveSource } from '../../src/live/sourceRegions';
import { RUNTIME_POLICY_LIMITS } from '../../src/live/runtimePolicyLimits';
import { describeLiveSource } from '../../src/live/source';

describe('ADSB.lol public-pilot policy', () => {
  it('binds one Atlanta endpoint to the 20-second and 25-viewer envelope', () => {
    const liveRegions = regionConfigsForLiveSource(describeLiveSource('production', 'live'));
    expect(liveRegions.map(({ id }) => id)).toEqual([LIVE_PILOT_REGION_ID]);
    const region = liveRegions[0]!;
    expect(
      `/v2/point/${region.center.latitude}/${region.center.longitude}/${region.radiusNauticalMiles}`,
    ).toBe(LIVE_PILOT_POLICY.endpointPath);
    expect(LIVE_PILOT_POLICY.pollIntervalMs).toBe(LIVE_PILOT_POLL_INTERVAL_MS);
    expect(LIVE_PILOT_POLICY.maximumConcurrentViewers).toBe(LIVE_PILOT_MAXIMUM_CONCURRENT_VIEWERS);
    expect(RUNTIME_POLICY_LIMITS.provider.pollIntervalMs).toBe(LIVE_PILOT_POLL_INTERVAL_MS);
    expect(RUNTIME_POLICY_LIMITS.delivery.maximumRegionalViewers).toBe(
      LIVE_PILOT_MAXIMUM_CONCURRENT_VIEWERS,
    );
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
