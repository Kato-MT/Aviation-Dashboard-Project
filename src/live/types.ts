export const AIRSPACE_SCHEMA_VERSION = 'airspace.v1' as const;
export const DEFAULT_LIVE_PROVIDER_ID = 'adsb-lol';

export interface LiveFeedBinding {
  providerId: string;
  regionId: string;
  feedEpoch: string;
}

export type AirspaceSchemaVersion = typeof AIRSPACE_SCHEMA_VERSION;

export type LiveTransportStatus = 'connecting' | 'open' | 'reconnecting' | 'offline' | 'stopped';

export type LiveFeedStatus =
  'connecting' | 'live' | 'degraded' | 'stale' | 'reconnecting' | 'offline';

export type AircraftQualityFlag =
  | 'missing-position'
  | 'stale-position'
  | 'stale-contact'
  | 'provider-time-regression'
  | 'time-uncertain';

export type VerticalRateBasis = 'barometric' | 'geometric';

export interface GeographicPoint {
  latitude: number;
  longitude: number;
}

export interface GeographicBounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface RegionConfig {
  id: string;
  label: string;
  description: string;
  center: GeographicPoint;
  radiusNauticalMiles: number;
  bounds: GeographicBounds;
  defaultZoom: number;
}

export interface AircraftState {
  aircraftId: string;
  /** Live ingress accepts only icao24/other; synthetic is reserved for validated local replay. */
  identifierKind: 'icao24' | 'other' | 'synthetic';
  callsign?: string | undefined;
  registration?: string | undefined;
  aircraftType?: string | undefined;
  category?: string | undefined;
  position?: GeographicPoint | undefined;
  barometricAltitudeFeet?: number | undefined;
  geometricAltitudeFeet?: number | undefined;
  groundSpeedKnots?: number | undefined;
  trackDegrees?: number | undefined;
  verticalRateFeetPerMinute?: number | undefined;
  verticalRateBasis?: VerticalRateBasis | undefined;
  onGround: boolean | null;
  sourceType?: string | undefined;
  // Available state/contact time, not a claim of simultaneous field measurements.
  observedAt: string;
  lastContactAt: string;
  lastPositionAt?: string | undefined;
  // Ages are relative to the immutable server receipt time, not browser arrival.
  // A small negative age is permitted only with explicit time-uncertain evidence.
  contactAgeSeconds: number;
  positionAgeSeconds?: number | undefined;
  qualityFlags: AircraftQualityFlag[];
}

export interface SnapshotValidationSummary {
  receivedAircraft: number;
  acceptedAircraft: number;
  rejectedAircraft: number;
  duplicateAircraft: number;
  invalidFields: number;
}

export interface AirspaceSnapshot extends LiveFeedBinding {
  schemaVersion: AirspaceSchemaVersion;
  sequence: number;
  // Immutable server receipt/normalization time; cached deliveries must retain it.
  generatedAt: string;
  providerGeneratedAt: string;
  aircraft: AircraftState[];
  validation: SnapshotValidationSummary;
}

export interface LiveFeedHealth extends LiveFeedBinding {
  schemaVersion: AirspaceSchemaVersion;
  status: LiveFeedStatus;
  checkedAt: string;
  lastSuccessAt?: string | undefined;
  lastSnapshotAt?: string | undefined;
  upstreamLatencyMs?: number | undefined;
  consecutiveFailures: number;
  retryAt?: string | undefined;
  message: string;
}

export type LiveQualityEventCode =
  'LIVE-DQ-001' | 'LIVE-DQ-002' | 'LIVE-DQ-003' | 'LIVE-DQ-004' | 'LIVE-DQ-005' | 'LIVE-DQ-006';

export interface LiveQualityEvent {
  code: LiveQualityEventCode;
  regionId: string;
  aircraftId?: string | undefined;
  timestamp: string;
  message: string;
  kind:
    | 'stale-contact'
    | 'stale-position'
    | 'missing-position'
    | 'provider-time-regression'
    | 'time-uncertain'
    | 'upstream-degraded';
}

export interface ProviderSnapshot {
  providerId: string;
  regionId: string;
  receivedAt: string;
  providerGeneratedAt: string;
  aircraft: AircraftState[];
  validation: SnapshotValidationSummary;
}
