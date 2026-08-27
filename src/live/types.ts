export const AIRSPACE_SCHEMA_VERSION = 'airspace.v1' as const;

export type AirspaceSchemaVersion = typeof AIRSPACE_SCHEMA_VERSION;

export type LiveFeedStatus =
  'connecting' | 'live' | 'degraded' | 'stale' | 'reconnecting' | 'offline';

export type AircraftQualityFlag =
  'missing-position' | 'stale-position' | 'stale-contact' | 'provider-time-regression';

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
  identifierKind: 'icao24' | 'other';
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
  onGround: boolean;
  sourceType?: string | undefined;
  observedAt: string;
  lastContactAt: string;
  lastPositionAt?: string | undefined;
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

export interface AirspaceSnapshot {
  schemaVersion: AirspaceSchemaVersion;
  providerId: string;
  regionId: string;
  sequence: number;
  generatedAt: string;
  providerGeneratedAt: string;
  aircraft: AircraftState[];
  validation: SnapshotValidationSummary;
}

export interface LiveFeedHealth {
  schemaVersion: AirspaceSchemaVersion;
  regionId: string;
  providerId: string;
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
  'LIVE-DQ-001' | 'LIVE-DQ-002' | 'LIVE-DQ-003' | 'LIVE-DQ-004' | 'LIVE-DQ-005';

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
