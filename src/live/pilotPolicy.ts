import {
  LIVE_PILOT_MAXIMUM_CONCURRENT_VIEWERS,
  LIVE_PILOT_POLL_INTERVAL_MS,
  LIVE_PILOT_REGION_ID,
} from './pilotEnvelope';

export const LIVE_PILOT_POLICY_SCHEMA_VERSION = 'live-pilot-policy.v1' as const;

/**
 * The conservative public-pilot envelope proposed to ADSB.lol. The provider's
 * 2026-08-30 reply supplied general operating guidance but did not approve these
 * exact values, so the production provider gate remains separately closed.
 */
export const LIVE_PILOT_POLICY = Object.freeze({
  schemaVersion: LIVE_PILOT_POLICY_SCHEMA_VERSION,
  providerId: 'adsb-lol',
  regionId: LIVE_PILOT_REGION_ID,
  endpointPath: '/v2/point/33.6407/-84.4277/100',
  pollIntervalMs: LIVE_PILOT_POLL_INTERVAL_MS,
  maximumConcurrentViewers: LIVE_PILOT_MAXIMUM_CONCURRENT_VIEWERS,
  userAgent: 'GeorgiaFlightOutlook/0.1 (+https://github.com/Kato-MT/Aviation-Dashboard-Project)',
  sourceUrl: 'https://www.adsb.lol/',
  licenseLabel: 'ODbL 1.0',
  licenseUrl: 'https://opendatacommons.org/licenses/odbl/1-0/',
} as const);
