import type { AircraftState, GeographicBounds, GeographicPoint } from './types';

export type AltitudeFilter = 'all' | 'ground' | 'below-10000' | '10000-25000' | 'above-25000';
export type QualityFilter = 'all' | 'current' | 'delayed' | 'missing-position';
export type AircraftSortField = 'identifier' | 'altitude' | 'speed' | 'freshness';
export type SortDirection = 'ascending' | 'descending';

export interface AircraftFilters {
  query: string;
  altitude: AltitudeFilter;
  quality: QualityFilter;
  positionedOnly: boolean;
}

export interface AirspaceSummary {
  observed: number;
  positioned: number;
  current: number;
  delayed: number;
  missingPosition: number;
  airborne: number;
  onGround: number;
}

export interface ProjectedPoint {
  xPercent: number;
  yPercent: number;
  insideBounds: boolean;
}

export const DEFAULT_AIRCRAFT_FILTERS: AircraftFilters = {
  query: '',
  altitude: 'all',
  quality: 'all',
  positionedOnly: false,
};

function altitudeMatches(aircraft: AircraftState, filter: AltitudeFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'ground') return aircraft.onGround;
  if (aircraft.onGround || aircraft.barometricAltitudeFeet === undefined) return false;
  if (filter === 'below-10000') return aircraft.barometricAltitudeFeet < 10_000;
  if (filter === '10000-25000') {
    return aircraft.barometricAltitudeFeet >= 10_000 && aircraft.barometricAltitudeFeet <= 25_000;
  }
  return aircraft.barometricAltitudeFeet > 25_000;
}

function qualityMatches(aircraft: AircraftState, filter: QualityFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'missing-position') return !aircraft.position;
  const delayed = aircraft.qualityFlags.some(
    (flag) => flag === 'stale-contact' || flag === 'stale-position',
  );
  return filter === 'delayed' ? delayed : !delayed && Boolean(aircraft.position);
}

export function aircraftIdentifier(aircraft: AircraftState): string {
  return (
    aircraft.callsign?.trim() || aircraft.registration?.trim() || aircraft.aircraftId.toUpperCase()
  );
}

export function verticalState(
  aircraft: AircraftState,
): 'climbing' | 'level' | 'descending' | 'unknown' {
  const rate = aircraft.verticalRateFeetPerMinute;
  if (rate === undefined) return 'unknown';
  if (rate > 200) return 'climbing';
  if (rate < -200) return 'descending';
  return 'level';
}

export function filterAircraft(
  aircraft: readonly AircraftState[],
  filters: Partial<AircraftFilters> = {},
): AircraftState[] {
  const selected = { ...DEFAULT_AIRCRAFT_FILTERS, ...filters };
  const query = selected.query.trim().toLocaleLowerCase();
  return aircraft.filter((track) => {
    const searchable = [track.callsign, track.registration, track.aircraftId, track.aircraftType]
      .filter((value): value is string => Boolean(value))
      .join(' ')
      .toLocaleLowerCase();
    return (
      (!query || searchable.includes(query)) &&
      (!selected.positionedOnly || Boolean(track.position)) &&
      altitudeMatches(track, selected.altitude) &&
      qualityMatches(track, selected.quality)
    );
  });
}

function numericSortValue(aircraft: AircraftState, field: AircraftSortField): number {
  if (field === 'altitude') return aircraft.barometricAltitudeFeet ?? Number.NEGATIVE_INFINITY;
  if (field === 'speed') return aircraft.groundSpeedKnots ?? Number.NEGATIVE_INFINITY;
  return field === 'freshness' ? aircraft.contactAgeSeconds : 0;
}

export function sortAircraft(
  aircraft: readonly AircraftState[],
  field: AircraftSortField,
  direction: SortDirection = 'ascending',
): AircraftState[] {
  const multiplier = direction === 'ascending' ? 1 : -1;
  return [...aircraft].sort((left, right) => {
    const comparison =
      field === 'identifier'
        ? aircraftIdentifier(left).localeCompare(aircraftIdentifier(right))
        : numericSortValue(left, field) - numericSortValue(right, field);
    return (comparison || left.aircraftId.localeCompare(right.aircraftId)) * multiplier;
  });
}

export function summarizeAirspace(aircraft: readonly AircraftState[]): AirspaceSummary {
  const summary: AirspaceSummary = {
    observed: aircraft.length,
    positioned: 0,
    current: 0,
    delayed: 0,
    missingPosition: 0,
    airborne: 0,
    onGround: 0,
  };
  for (const track of aircraft) {
    if (track.position) summary.positioned += 1;
    else summary.missingPosition += 1;
    const delayed = track.qualityFlags.some(
      (flag) => flag === 'stale-contact' || flag === 'stale-position',
    );
    if (delayed) summary.delayed += 1;
    else if (track.position) summary.current += 1;
    if (track.onGround) summary.onGround += 1;
    else summary.airborne += 1;
  }
  return summary;
}

export function projectGeographicPoint(
  point: GeographicPoint,
  bounds: GeographicBounds,
): ProjectedPoint {
  const width = bounds.east - bounds.west;
  const height = bounds.north - bounds.south;
  if (width <= 0 || height <= 0) throw new RangeError('Geographic bounds must have positive area.');
  const rawX = ((point.longitude - bounds.west) / width) * 100;
  const rawY = ((bounds.north - point.latitude) / height) * 100;
  return {
    xPercent: Math.min(100, Math.max(0, rawX)),
    yPercent: Math.min(100, Math.max(0, rawY)),
    insideBounds: rawX >= 0 && rawX <= 100 && rawY >= 0 && rawY <= 100,
  };
}

export function formatAltitude(aircraft: AircraftState): string {
  if (aircraft.onGround) return 'Ground';
  return aircraft.barometricAltitudeFeet === undefined
    ? 'Unknown'
    : `${Math.round(aircraft.barometricAltitudeFeet).toLocaleString('en-US')} ft`;
}

export function formatGroundSpeed(aircraft: AircraftState): string {
  return aircraft.groundSpeedKnots === undefined
    ? 'Unknown'
    : `${Math.round(aircraft.groundSpeedKnots).toLocaleString('en-US')} kt`;
}
