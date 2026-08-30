import type { AircraftState, GeographicBounds, GeographicPoint } from './types';
import type { ServerTimeInterval } from './clock';
import { aircraftEvidence, type AircraftEvidence } from './freshness';

export type AltitudeFilter = 'all' | 'ground' | 'below-10000' | '10000-25000' | 'above-25000';
export type QualityFilter =
  'all' | 'current' | 'delayed' | 'stale' | 'expired' | 'missing-position' | 'time-uncertain';
export type GroundStateFilter = 'all' | 'ground' | 'airborne' | 'unknown';
export type AircraftSortField = 'identifier' | 'altitude' | 'speed' | 'freshness';
export type SortDirection = 'ascending' | 'descending';

export interface AircraftFilters {
  query: string;
  altitude: AltitudeFilter;
  quality: QualityFilter;
  positionedOnly: boolean;
  groundState: GroundStateFilter;
}

export interface AirspaceSummary {
  observed: number;
  positioned: number;
  current: number;
  delayed: number;
  stale: number;
  expiredPosition: number;
  missingPosition: number;
  airborne: number;
  onGround: number;
  unknownGround: number;
  timeUncertain: number;
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
  groundState: 'all',
};

function altitudeMatches(aircraft: AircraftState, filter: AltitudeFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'ground') return aircraft.onGround === true;
  if (aircraft.onGround || aircraft.barometricAltitudeFeet === undefined) return false;
  if (filter === 'below-10000') return aircraft.barometricAltitudeFeet < 10_000;
  if (filter === '10000-25000') {
    return aircraft.barometricAltitudeFeet >= 10_000 && aircraft.barometricAltitudeFeet <= 25_000;
  }
  return aircraft.barometricAltitudeFeet > 25_000;
}

function qualityMatches(evidence: AircraftEvidence, filter: QualityFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'missing-position') return evidence.position.freshness === 'missing';
  if (filter === 'time-uncertain') {
    return (
      evidence.contact.freshness === 'time-uncertain' ||
      evidence.position.freshness === 'time-uncertain'
    );
  }
  return evidence.position.freshness === filter;
}

export function aircraftTimeIsUncertain(
  aircraft: AircraftState,
  time?: ServerTimeInterval,
): boolean {
  return qualityMatches(aircraftEvidence(aircraft, time), 'time-uncertain');
}

function groundStateMatches(aircraft: AircraftState, filter: GroundStateFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'unknown') return aircraft.onGround === null;
  return aircraft.onGround === (filter === 'ground');
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
  time?: ServerTimeInterval,
): AircraftState[] {
  const selected = { ...DEFAULT_AIRCRAFT_FILTERS, ...filters };
  const query = selected.query.trim().toLocaleLowerCase();
  return aircraft.filter((track) => {
    const evidence = aircraftEvidence(track, time);
    const searchable = [track.callsign, track.registration, track.aircraftId, track.aircraftType]
      .filter((value): value is string => Boolean(value))
      .join(' ')
      .toLocaleLowerCase();
    return (
      evidence.activeContact &&
      (!query || searchable.includes(query)) &&
      (!selected.positionedOnly || evidence.activePosition) &&
      altitudeMatches(track, selected.altitude) &&
      groundStateMatches(track, selected.groundState) &&
      qualityMatches(evidence, selected.quality)
    );
  });
}

function numericSortValue(
  aircraft: AircraftState,
  field: AircraftSortField,
  time?: ServerTimeInterval,
): number {
  if (field === 'altitude') return aircraft.barometricAltitudeFeet ?? Number.NEGATIVE_INFINITY;
  if (field === 'speed') return aircraft.groundSpeedKnots ?? Number.NEGATIVE_INFINITY;
  if (field !== 'freshness') return 0;
  const evidence = aircraftEvidence(aircraft, time);
  return (
    evidence.position.age?.maximumMs ?? evidence.contact.age?.maximumMs ?? Number.POSITIVE_INFINITY
  );
}

export function sortAircraft(
  aircraft: readonly AircraftState[],
  field: AircraftSortField,
  direction: SortDirection = 'ascending',
  time?: ServerTimeInterval,
): AircraftState[] {
  const multiplier = direction === 'ascending' ? 1 : -1;
  return [...aircraft].sort((left, right) => {
    const comparison =
      field === 'identifier'
        ? aircraftIdentifier(left).localeCompare(aircraftIdentifier(right))
        : numericSortValue(left, field, time) - numericSortValue(right, field, time);
    return (comparison || left.aircraftId.localeCompare(right.aircraftId)) * multiplier;
  });
}

export function summarizeAirspace(
  aircraft: readonly AircraftState[],
  time?: ServerTimeInterval,
): AirspaceSummary {
  const summary: AirspaceSummary = {
    observed: 0,
    positioned: 0,
    current: 0,
    delayed: 0,
    stale: 0,
    expiredPosition: 0,
    missingPosition: 0,
    airborne: 0,
    onGround: 0,
    unknownGround: 0,
    timeUncertain: 0,
  };
  for (const track of aircraft) {
    const evidence = aircraftEvidence(track, time);
    if (!evidence.activeContact) continue;
    summary.observed += 1;
    if (evidence.activePosition) summary.positioned += 1;
    if (evidence.position.freshness === 'missing') summary.missingPosition += 1;
    if (qualityMatches(evidence, 'time-uncertain')) summary.timeUncertain += 1;
    if (evidence.position.freshness === 'current') summary.current += 1;
    if (evidence.position.freshness === 'delayed') summary.delayed += 1;
    if (evidence.position.freshness === 'stale') summary.stale += 1;
    if (evidence.position.freshness === 'expired') summary.expiredPosition += 1;
    if (track.onGround === true) summary.onGround += 1;
    else if (track.onGround === false) summary.airborne += 1;
    else summary.unknownGround += 1;
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
