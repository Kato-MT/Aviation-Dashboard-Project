export const LIVE_PILOT_POLICY_SCHEMA_VERSION = 'live-pilot-policy.v1' as const;

/**
 * The conservative public-pilot envelope proposed to ADSB.lol. The provider's
 * 2026-08-30 reply supplied general operating guidance but did not approve these
 * exact values, so the production provider gate remains separately closed.
 */
export const LIVE_PILOT_POLICY = Object.freeze({
  schemaVersion: LIVE_PILOT_POLICY_SCHEMA_VERSION,
  providerId: 'adsb-lol',
  regionId: 'atlanta',
  endpointPath: '/v2/point/33.6407/-84.4277/100',
  pollIntervalMs: 20_000,
  maximumConcurrentViewers: 25,
  userAgent: 'GeorgiaFlightOutlook/0.1 (+https://github.com/Kato-MT/Aviation-Dashboard-Project)',
  sourceUrl: 'https://www.adsb.lol/',
  licenseLabel: 'ODbL 1.0',
  licenseUrl: 'https://opendatacommons.org/licenses/odbl/1-0/',
} as const);
