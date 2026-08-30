import type { ServerTimeInterval } from './clock';
import type { AircraftState } from './types';
import { isCanonicalTimestamp } from './validation';

export const CURRENT_OBSERVATION_MS = 15_000;
export const DELAYED_OBSERVATION_MS = 45_000;
export const ACTIVE_OBSERVATION_MS = 120_000;

export type ObservationFreshness =
  'current' | 'delayed' | 'stale' | 'expired' | 'missing' | 'time-uncertain';

export interface ObservationEvidence {
  freshness: ObservationFreshness;
  age?: { minimumMs: number; maximumMs: number } | undefined;
}

export interface AircraftEvidence {
  contact: ObservationEvidence;
  position: ObservationEvidence;
  activePosition: boolean;
  activeContact: boolean;
}

export function observationEvidence(
  observedAt: string | undefined,
  time: ServerTimeInterval | undefined,
  sourceTimeUncertain = false,
): ObservationEvidence {
  if (!isCanonicalTimestamp(observedAt)) return { freshness: 'missing' };
  if (!time) return { freshness: 'time-uncertain' };
  const observedMs = Date.parse(observedAt);
  const age = {
    minimumMs: time.earliestMs - observedMs,
    maximumMs: time.latestMs - observedMs,
  };
  if (sourceTimeUncertain || age.maximumMs < 0) return { freshness: 'time-uncertain', age };
  const freshness =
    age.maximumMs <= CURRENT_OBSERVATION_MS
      ? 'current'
      : age.maximumMs <= DELAYED_OBSERVATION_MS
        ? 'delayed'
        : age.maximumMs < ACTIVE_OBSERVATION_MS
          ? 'stale'
          : 'expired';
  return { freshness, age };
}

export function aircraftEvidence(
  aircraft: AircraftState,
  time: ServerTimeInterval | undefined,
): AircraftEvidence {
  const uncertain = aircraft.qualityFlags.some(
    (flag) => flag === 'time-uncertain' || flag === 'provider-time-regression',
  );
  const contact = observationEvidence(aircraft.lastContactAt, time, uncertain);
  const position = observationEvidence(
    aircraft.position ? aircraft.lastPositionAt : undefined,
    time,
    uncertain,
  );
  return {
    contact,
    position,
    activePosition:
      position.freshness === 'current' ||
      position.freshness === 'delayed' ||
      position.freshness === 'stale',
    activeContact:
      contact.freshness !== 'missing' &&
      contact.freshness !== 'expired' &&
      (contact.age === undefined || contact.age.maximumMs < ACTIVE_OBSERVATION_MS),
  };
}
