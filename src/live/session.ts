import type {
  AircraftState,
  AirspaceSnapshot,
  GeographicPoint,
  LiveFeedHealth,
  LiveFeedStatus,
  LiveQualityEvent,
} from './types';

export type LiveSessionPhase = 'loading' | LiveFeedStatus | 'error';

export interface TrailPoint extends GeographicPoint {
  observedAt: string;
  altitudeFeet?: number | undefined;
}

export interface LiveSessionState {
  regionId: string;
  phase: LiveSessionPhase;
  snapshot?: AirspaceSnapshot | undefined;
  health?: LiveFeedHealth | undefined;
  selectedAircraftId?: string | undefined;
  trails: ReadonlyMap<string, readonly TrailPoint[]>;
  qualityEvents: readonly LiveQualityEvent[];
  lastError?: string | undefined;
}

export interface LiveSessionOptions {
  maximumTrailPoints: number;
  maximumAircraftTrails: number;
  maximumQualityEvents: number;
  staleAfterMs: number;
  offlineAfterMs: number;
}

const DEFAULT_OPTIONS: LiveSessionOptions = {
  maximumTrailPoints: 180,
  maximumAircraftTrails: 500,
  maximumQualityEvents: 200,
  staleAfterMs: 25_000,
  offlineAfterMs: 90_000,
};

function cloneTrails(
  trails: ReadonlyMap<string, readonly TrailPoint[]>,
): Map<string, TrailPoint[]> {
  return new Map([...trails].map(([aircraftId, points]) => [aircraftId, [...points]]));
}

function qualityEvents(
  snapshot: AirspaceSnapshot,
  previousSnapshot?: AirspaceSnapshot,
): LiveQualityEvent[] {
  const events: LiveQualityEvent[] = [];
  const previousFlags = new Map(
    previousSnapshot?.aircraft.map((aircraft) => [
      aircraft.aircraftId,
      new Set(aircraft.qualityFlags),
    ]) ?? [],
  );
  for (const aircraft of snapshot.aircraft) {
    for (const flag of aircraft.qualityFlags) {
      if (previousFlags.get(aircraft.aircraftId)?.has(flag)) continue;
      const details = {
        regionId: snapshot.regionId,
        aircraftId: aircraft.aircraftId,
        timestamp: snapshot.generatedAt,
      };
      switch (flag) {
        case 'stale-contact':
          events.push({
            ...details,
            code: 'LIVE-DQ-001',
            kind: flag,
            message: 'Aircraft contact is older than the current-feed threshold.',
          });
          break;
        case 'stale-position':
          events.push({
            ...details,
            code: 'LIVE-DQ-002',
            kind: flag,
            message: 'Aircraft position is older than the current-position threshold.',
          });
          break;
        case 'missing-position':
          events.push({
            ...details,
            code: 'LIVE-DQ-003',
            kind: flag,
            message: 'Aircraft is present in the feed without a usable position.',
          });
          break;
        case 'provider-time-regression':
          events.push({
            ...details,
            code: 'LIVE-DQ-004',
            kind: flag,
            message: 'Provider time moved backward relative to the previous snapshot.',
          });
          break;
      }
    }
  }
  return events;
}

function boundAircraftTrails(
  trails: Map<string, TrailPoint[]>,
  currentAircraftIds: ReadonlySet<string>,
  maximumAircraftTrails: number,
): void {
  if (trails.size <= maximumAircraftTrails) return;
  const expired = [...trails.keys()].filter((aircraftId) => !currentAircraftIds.has(aircraftId));
  const candidates = [...expired, ...trails.keys()].filter(
    (aircraftId, index, all) => all.indexOf(aircraftId) === index,
  );
  for (const aircraftId of candidates) {
    if (trails.size <= maximumAircraftTrails) break;
    trails.delete(aircraftId);
  }
}

function addTrailPoint(
  trails: Map<string, TrailPoint[]>,
  aircraft: AircraftState,
  maximumTrailPoints: number,
): void {
  if (!aircraft.position) return;
  const existing = trails.get(aircraft.aircraftId) ?? [];
  const latest = existing.at(-1);
  if (
    latest?.observedAt === aircraft.observedAt &&
    latest.latitude === aircraft.position.latitude &&
    latest.longitude === aircraft.position.longitude
  ) {
    return;
  }
  existing.push({
    ...aircraft.position,
    observedAt: aircraft.observedAt,
    ...(aircraft.barometricAltitudeFeet === undefined
      ? {}
      : { altitudeFeet: aircraft.barometricAltitudeFeet }),
  });
  if (existing.length > maximumTrailPoints) {
    existing.splice(0, existing.length - maximumTrailPoints);
  }
  trails.set(aircraft.aircraftId, existing);
}

export class LiveAirspaceSession {
  private readonly options: LiveSessionOptions;
  private stateValue: LiveSessionState;

  constructor(regionId: string, options: Partial<LiveSessionOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    if (!regionId.trim()) throw new TypeError('regionId must be a non-empty string.');
    if (
      !Number.isSafeInteger(this.options.maximumTrailPoints) ||
      this.options.maximumTrailPoints < 1
    ) {
      throw new RangeError('maximumTrailPoints must be a positive safe integer.');
    }
    if (
      !Number.isSafeInteger(this.options.maximumAircraftTrails) ||
      this.options.maximumAircraftTrails < 1
    ) {
      throw new RangeError('maximumAircraftTrails must be a positive safe integer.');
    }
    if (
      !Number.isSafeInteger(this.options.maximumQualityEvents) ||
      this.options.maximumQualityEvents < 1
    ) {
      throw new RangeError('maximumQualityEvents must be a positive safe integer.');
    }
    if (
      this.options.staleAfterMs <= 0 ||
      this.options.offlineAfterMs <= this.options.staleAfterMs
    ) {
      throw new RangeError(
        'offlineAfterMs must be greater than staleAfterMs and both must be positive.',
      );
    }
    this.stateValue = { regionId, phase: 'loading', trails: new Map(), qualityEvents: [] };
  }

  get state(): LiveSessionState {
    return this.stateValue;
  }

  applySnapshot(snapshot: AirspaceSnapshot): LiveSessionState {
    if (snapshot.regionId !== this.stateValue.regionId) {
      throw new Error(
        `Snapshot region ${snapshot.regionId} does not match session ${this.stateValue.regionId}.`,
      );
    }
    if (this.stateValue.snapshot && snapshot.sequence <= this.stateValue.snapshot.sequence) {
      return this.stateValue;
    }
    const trails = cloneTrails(this.stateValue.trails);
    for (const aircraft of snapshot.aircraft) {
      addTrailPoint(trails, aircraft, this.options.maximumTrailPoints);
    }
    boundAircraftTrails(
      trails,
      new Set(snapshot.aircraft.map(({ aircraftId }) => aircraftId)),
      this.options.maximumAircraftTrails,
    );
    const events = [
      ...this.stateValue.qualityEvents,
      ...qualityEvents(snapshot, this.stateValue.snapshot),
    ].slice(-this.options.maximumQualityEvents);
    this.stateValue = {
      ...this.stateValue,
      phase: this.stateValue.health?.status ?? 'live',
      snapshot,
      trails,
      qualityEvents: events,
      lastError: undefined,
    };
    return this.stateValue;
  }

  applyHealth(health: LiveFeedHealth): LiveSessionState {
    if (health.regionId !== this.stateValue.regionId) {
      throw new Error(
        `Health region ${health.regionId} does not match session ${this.stateValue.regionId}.`,
      );
    }
    const events =
      health.status === 'degraded' && this.stateValue.health?.status !== 'degraded'
        ? [
            ...this.stateValue.qualityEvents,
            {
              code: 'LIVE-DQ-005' as const,
              kind: 'upstream-degraded' as const,
              regionId: health.regionId,
              timestamp: health.checkedAt,
              message: health.message,
            },
          ].slice(-this.options.maximumQualityEvents)
        : this.stateValue.qualityEvents;
    this.stateValue = {
      ...this.stateValue,
      phase: health.status,
      health,
      qualityEvents: events,
      ...(health.status === 'offline' ? { lastError: health.message } : {}),
    };
    return this.stateValue;
  }

  markConnecting(reconnecting = false): LiveSessionState {
    this.stateValue = {
      ...this.stateValue,
      phase: reconnecting ? 'reconnecting' : 'connecting',
      lastError: undefined,
    };
    return this.stateValue;
  }

  markConnected(): LiveSessionState {
    this.stateValue = {
      ...this.stateValue,
      phase: this.stateValue.health?.status ?? (this.stateValue.snapshot ? 'live' : 'connecting'),
      lastError: undefined,
    };
    return this.stateValue;
  }

  markOffline(message: string): LiveSessionState {
    this.stateValue = { ...this.stateValue, phase: 'offline', lastError: message };
    return this.stateValue;
  }

  recordError(message: string): LiveSessionState {
    this.stateValue = { ...this.stateValue, lastError: message };
    return this.stateValue;
  }

  markError(message: string): LiveSessionState {
    this.stateValue = { ...this.stateValue, phase: 'error', lastError: message };
    return this.stateValue;
  }

  selectAircraft(aircraftId?: string): LiveSessionState {
    this.stateValue = {
      ...this.stateValue,
      ...(aircraftId ? { selectedAircraftId: aircraftId } : { selectedAircraftId: undefined }),
    };
    return this.stateValue;
  }

  evaluateFreshness(now = Date.now()): LiveSessionState {
    const timestamp = this.stateValue.snapshot?.generatedAt;
    if (!timestamp) return this.stateValue;
    const age = now - Date.parse(timestamp);
    if (age >= this.options.offlineAfterMs && this.stateValue.phase !== 'offline') {
      this.stateValue = { ...this.stateValue, phase: 'offline' };
    } else if (
      age >= this.options.staleAfterMs &&
      this.stateValue.phase !== 'stale' &&
      this.stateValue.phase !== 'offline'
    ) {
      this.stateValue = { ...this.stateValue, phase: 'stale' };
    }
    return this.stateValue;
  }
}
