import type { ClockReading, ServerTimeInterval } from './clock';
import {
  LiveHistoryBuffer,
  LIVE_HISTORY_MAX_AIRCRAFT,
  LIVE_HISTORY_MAX_QUALITY_EVENTS,
  LIVE_HISTORY_MAX_SAMPLES,
  type AircraftHistory,
  type TrailPoint,
} from './history';
import { LiveFeedOrder, sameLiveFeed } from './ordering';
import { DEFAULT_LIVE_PROVIDER_ID } from './types';
import type {
  AirspaceSnapshot,
  LiveFeedHealth,
  LiveFeedBinding,
  LiveFeedStatus,
  LiveQualityEvent,
  LiveTransportStatus,
} from './types';
import { isSafeInteger } from './validation';

export type LiveSessionPhase = 'loading' | LiveFeedStatus | 'error';

export type {
  AircraftHistory,
  AircraftHistorySample,
  MeasurementPoint,
  TrailPoint,
} from './history';

export interface LiveSessionState {
  regionId: string;
  phase: LiveSessionPhase;
  transport: LiveTransportStatus;
  binding?: Readonly<LiveFeedBinding> | undefined;
  time?: ServerTimeInterval | undefined;
  snapshot?: AirspaceSnapshot | undefined;
  health?: LiveFeedHealth | undefined;
  selectedAircraftId?: string | undefined;
  /** Exact retained receipt within the current feed. Undefined follows the latest receipt. */
  selectedHistorySequence?: number | undefined;
  histories: ReadonlyMap<string, AircraftHistory>;
  trails: ReadonlyMap<string, readonly TrailPoint[]>;
  qualityEvents: readonly LiveQualityEvent[];
  lastError?: string | undefined;
}

export interface LiveSessionOptions {
  // The shared sample budget includes independent position and measurement evidence.
  maximumTrailPoints: number;
  maximumAircraftTrails: number;
  maximumQualityEvents: number;
}

const DEFAULT_OPTIONS: LiveSessionOptions = {
  maximumTrailPoints: LIVE_HISTORY_MAX_SAMPLES,
  maximumAircraftTrails: LIVE_HISTORY_MAX_AIRCRAFT,
  maximumQualityEvents: LIVE_HISTORY_MAX_QUALITY_EVENTS,
};

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
        case 'time-uncertain':
          events.push({
            ...details,
            code: 'LIVE-DQ-006',
            kind: flag,
            message:
              'The provider clock is ahead of receipt time; observation freshness is uncertain.',
          });
          break;
      }
    }
  }
  return events;
}

export class LiveAirspaceSession {
  private readonly options: LiveSessionOptions;
  private readonly order: LiveFeedOrder;
  private readonly history: LiveHistoryBuffer;
  private stateValue: LiveSessionState;

  constructor(
    regionId: string,
    options: Partial<LiveSessionOptions> = {},
    providerId = DEFAULT_LIVE_PROVIDER_ID,
    private readonly readClock: () => ClockReading = () => ({
      monotonicMs: performance.now(),
      wallMs: Date.now(),
    }),
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    if (!regionId.trim()) throw new TypeError('regionId must be a non-empty string.');
    this.order = new LiveFeedOrder(regionId, providerId);
    if (
      !Number.isSafeInteger(this.options.maximumTrailPoints) ||
      this.options.maximumTrailPoints < 1 ||
      this.options.maximumTrailPoints > LIVE_HISTORY_MAX_SAMPLES
    ) {
      throw new RangeError('maximumTrailPoints must be an integer from 1 through 120.');
    }
    if (
      !Number.isSafeInteger(this.options.maximumAircraftTrails) ||
      this.options.maximumAircraftTrails < 1 ||
      this.options.maximumAircraftTrails > LIVE_HISTORY_MAX_AIRCRAFT
    ) {
      throw new RangeError('maximumAircraftTrails must be an integer from 1 through 500.');
    }
    if (
      !Number.isSafeInteger(this.options.maximumQualityEvents) ||
      this.options.maximumQualityEvents < 1
    ) {
      throw new RangeError('maximumQualityEvents must be a positive safe integer.');
    }
    this.history = new LiveHistoryBuffer(
      this.options.maximumTrailPoints,
      this.options.maximumAircraftTrails,
    );
    this.stateValue = {
      regionId,
      phase: 'loading',
      transport: 'stopped',
      histories: this.history.histories,
      trails: this.history.trails,
      qualityEvents: [],
    };
  }

  get state(): LiveSessionState {
    return this.stateValue;
  }

  clear(): LiveSessionState {
    this.order.reset();
    this.history.clear();
    this.stateValue = {
      regionId: this.stateValue.regionId,
      phase: 'loading',
      transport: 'stopped',
      histories: this.history.histories,
      trails: this.history.trails,
      qualityEvents: [],
    };
    return this.stateValue;
  }

  beginFeed(binding: LiveFeedBinding): boolean {
    if (!this.order.acceptHello(binding, true)) return false;
    return this.adoptBinding();
  }

  private adoptBinding(): boolean {
    if (sameLiveFeed(this.stateValue.binding, this.order.binding)) return false;
    this.history.clear();
    this.stateValue = {
      regionId: this.stateValue.regionId,
      binding: this.order.binding,
      phase: 'loading',
      transport: this.stateValue.transport,
      histories: this.history.histories,
      trails: this.history.trails,
      qualityEvents: [],
    };
    return true;
  }

  updateTime(time: ServerTimeInterval | undefined): LiveSessionState {
    this.history.maintain(this.readClock(), time);
    if (
      time === this.stateValue.time &&
      this.history.histories === this.stateValue.histories &&
      this.history.trails === this.stateValue.trails
    )
      return this.stateValue;
    this.stateValue = {
      ...this.stateValue,
      time,
      histories: this.history.histories,
      trails: this.history.trails,
    };
    return this.stateValue;
  }

  applySnapshot(snapshot: AirspaceSnapshot): LiveSessionState {
    if (snapshot.regionId !== this.stateValue.regionId) {
      throw new Error(
        `Snapshot region ${snapshot.regionId} does not match session ${this.stateValue.regionId}.`,
      );
    }
    if (!this.order.acceptSnapshot(snapshot)) return this.stateValue;
    this.adoptBinding();
    this.history.ingest(
      snapshot,
      this.readClock(),
      this.stateValue.time,
      this.stateValue.selectedAircraftId,
    );
    const events = [
      ...this.stateValue.qualityEvents,
      ...qualityEvents(snapshot, this.stateValue.snapshot),
    ].slice(-this.options.maximumQualityEvents);
    this.stateValue = {
      ...this.stateValue,
      phase: this.stateValue.health?.status ?? 'live',
      snapshot,
      histories: this.history.histories,
      trails: this.history.trails,
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
    if (!this.order.acceptHealth(health)) return this.stateValue;
    this.adoptBinding();
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
      transport: reconnecting ? 'reconnecting' : 'connecting',
      lastError: undefined,
    };
    return this.stateValue;
  }

  markConnected(): LiveSessionState {
    this.stateValue = {
      ...this.stateValue,
      phase: this.stateValue.health?.status ?? (this.stateValue.snapshot ? 'live' : 'connecting'),
      transport: 'open',
      lastError: undefined,
    };
    return this.stateValue;
  }

  markOffline(message: string): LiveSessionState {
    this.stateValue = {
      ...this.stateValue,
      phase: 'offline',
      transport: 'offline',
      lastError: message,
    };
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
      ...(aircraftId
        ? { selectedAircraftId: aircraftId, selectedHistorySequence: undefined }
        : { selectedAircraftId: undefined, selectedHistorySequence: undefined }),
    };
    return this.stateValue;
  }

  selectHistorySample(
    aircraftId: string,
    sequence: number,
    expectedBinding: Readonly<LiveFeedBinding>,
  ): LiveSessionState {
    if (
      !sameLiveFeed(this.stateValue.binding, expectedBinding) ||
      !isSafeInteger(sequence) ||
      !this.stateValue.histories
        .get(aircraftId)
        ?.samples.some((sample) => sample.sequence === sequence)
    ) {
      return this.stateValue;
    }
    if (
      this.stateValue.selectedAircraftId === aircraftId &&
      this.stateValue.selectedHistorySequence === sequence
    ) {
      return this.stateValue;
    }
    this.stateValue = {
      ...this.stateValue,
      selectedAircraftId: aircraftId,
      selectedHistorySequence: sequence,
    };
    return this.stateValue;
  }
}
