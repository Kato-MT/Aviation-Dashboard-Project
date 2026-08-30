import {
  LIVE_CLOCK_MAX_ELAPSED_DIVERGENCE_MS,
  type ClockReading,
  type ServerTimeInterval,
} from './clock';
import { ACTIVE_OBSERVATION_MS } from './freshness';
import { RUNTIME_POLICY_LIMITS } from './runtimePolicyLimits';
import type { AircraftState, AirspaceSnapshot, GeographicPoint, LiveFeedBinding } from './types';
import { isCanonicalTimestamp } from './validation';

export const LIVE_HISTORY_RETENTION_MS: number = RUNTIME_POLICY_LIMITS.history.retentionMs;
export const LIVE_HISTORY_MAX_SAMPLES: number =
  RUNTIME_POLICY_LIMITS.history.maximumSamplesPerAircraft;
export const LIVE_HISTORY_MAX_AIRCRAFT: number = RUNTIME_POLICY_LIMITS.history.maximumAircraft;
export const LIVE_HISTORY_MAX_QUALITY_EVENTS: number =
  RUNTIME_POLICY_LIMITS.history.maximumQualityEvents;

export interface TrailPoint extends GeographicPoint {
  observedAt: string;
  breakBefore: boolean;
  sourceType?: string | undefined;
}

const MEASUREMENT_FIELDS = [
  'barometricAltitudeFeet',
  'geometricAltitudeFeet',
  'groundSpeedKnots',
  'trackDegrees',
  'verticalRateFeetPerMinute',
  'verticalRateBasis',
  'onGround',
  'sourceType',
] as const;

export type MeasurementPoint = Pick<
  AircraftState,
  'observedAt' | (typeof MEASUREMENT_FIELDS)[number]
> & { breakBefore: boolean };

/** Associated by receipt, never a claim that position and measurements were simultaneous. */
export interface AircraftHistorySample {
  /** Stable only within the current provider, region, and feed epoch. */
  sequence: number;
  receivedAt: string;
  providerGeneratedAt: string;
  position?: TrailPoint | undefined;
  measurements?: MeasurementPoint | undefined;
}

export interface LiveReceiptKey extends LiveFeedBinding {
  aircraftId: string;
  sequence: number;
}

export type LiveEvidenceSelection =
  { mode: 'latest'; aircraftId: string } | { mode: 'exact'; key: LiveReceiptKey };

export type HistoryIssue =
  | 'sample-limit'
  | 'retention-limit'
  | 'missing-position'
  | 'time-uncertain'
  | 'regressed-time'
  | 'conflicting-observation'
  | 'feed-gap';

export interface AircraftHistory {
  samples: readonly AircraftHistorySample[];
  incompleteReasons: readonly HistoryIssue[];
}

interface RetainedSample {
  evidence: AircraftHistorySample;
  residenceExpiresAtMs: number;
}

interface HistoryControl {
  retained: readonly RetainedSample[];
  issues: readonly HistoryIssue[];
  positionGap: boolean;
  measurementGap: boolean;
  lastPositionMs?: number | undefined;
  lastMeasurementMs?: number | undefined;
}

interface HistoryEntry extends HistoryControl {
  history: AircraftHistory;
  trail: readonly TrailPoint[];
  earliestResidenceExpiryMs: number;
  earliestSourceExpiryMs: number;
}

function issue(issues: readonly HistoryIssue[], value: HistoryIssue): readonly HistoryIssue[] {
  return issues.includes(value) ? issues : [...issues, value];
}

function lastMeasurements(entry?: HistoryEntry): MeasurementPoint | undefined {
  if (!entry) return undefined;
  for (let index = entry.retained.length - 1; index >= 0; index -= 1) {
    const point = entry.retained[index]!.evidence.measurements;
    if (point) return point;
  }
  return undefined;
}

function measurements(aircraft: AircraftState, breakBefore: boolean): MeasurementPoint {
  return {
    observedAt: aircraft.observedAt,
    barometricAltitudeFeet: aircraft.barometricAltitudeFeet,
    geometricAltitudeFeet: aircraft.geometricAltitudeFeet,
    groundSpeedKnots: aircraft.groundSpeedKnots,
    trackDegrees: aircraft.trackDegrees,
    verticalRateFeetPerMinute: aircraft.verticalRateFeetPerMinute,
    verticalRateBasis: aircraft.verticalRateBasis,
    onGround: aircraft.onGround,
    sourceType: aircraft.sourceType,
    breakBefore,
  };
}

function createEntry(control: HistoryControl, previous?: HistoryEntry): HistoryEntry {
  if (
    previous &&
    control.retained === previous.retained &&
    control.issues === previous.issues &&
    control.positionGap === previous.positionGap &&
    control.measurementGap === previous.measurementGap &&
    control.lastPositionMs === previous.lastPositionMs &&
    control.lastMeasurementMs === previous.lastMeasurementMs
  )
    return previous;

  const samples =
    control.retained === previous?.retained
      ? previous.history.samples
      : control.retained.map(({ evidence }) => evidence);
  const history =
    samples === previous?.history.samples && control.issues === previous.issues
      ? previous.history
      : { samples, incompleteReasons: control.issues };
  const positions = samples.flatMap((sample) => (sample.position ? [sample.position] : []));
  const trail =
    previous &&
    positions.length === previous.trail.length &&
    positions.every((point, index) => point === previous.trail[index])
      ? previous.trail
      : positions;
  let earliestResidenceExpiryMs = Infinity;
  let earliestSourceExpiryMs = Infinity;
  for (const sample of control.retained) {
    earliestResidenceExpiryMs = Math.min(earliestResidenceExpiryMs, sample.residenceExpiresAtMs);
    for (const point of [sample.evidence.position, sample.evidence.measurements]) {
      if (point)
        earliestSourceExpiryMs = Math.min(
          earliestSourceExpiryMs,
          Date.parse(point.observedAt) + LIVE_HISTORY_RETENTION_MS,
        );
    }
  }
  return { ...control, history, trail, earliestResidenceExpiryMs, earliestSourceExpiryMs };
}

/** Owns bounded in-memory observations. No timer, transport, persistence or export. */
export class LiveHistoryBuffer {
  private readonly entries = new Map<string, HistoryEntry>();
  private historiesValue: ReadonlyMap<string, AircraftHistory> = new Map();
  private trailsValue: ReadonlyMap<string, readonly TrailPoint[]> = new Map();
  private previousReading?: ClockReading | undefined;
  private retentionOffsetUpperMs = -Infinity;
  private earliestResidenceExpiryMs = Infinity;
  private earliestSourceExpiryMs = Infinity;

  constructor(
    private readonly maximumSamples = LIVE_HISTORY_MAX_SAMPLES,
    private readonly maximumAircraft = LIVE_HISTORY_MAX_AIRCRAFT,
  ) {
    if (
      !Number.isSafeInteger(maximumSamples) ||
      maximumSamples < 1 ||
      maximumSamples > LIVE_HISTORY_MAX_SAMPLES ||
      !Number.isSafeInteger(maximumAircraft) ||
      maximumAircraft < 1 ||
      maximumAircraft > LIVE_HISTORY_MAX_AIRCRAFT
    )
      throw new RangeError('History limits exceed the bounded live-session contract.');
  }

  get histories(): ReadonlyMap<string, AircraftHistory> {
    return this.historiesValue;
  }

  get trails(): ReadonlyMap<string, readonly TrailPoint[]> {
    return this.trailsValue;
  }

  clear(): void {
    this.entries.clear();
    this.historiesValue = new Map();
    this.trailsValue = new Map();
    this.previousReading = undefined;
    this.retentionOffsetUpperMs = -Infinity;
    this.earliestResidenceExpiryMs = Infinity;
    this.earliestSourceExpiryMs = Infinity;
  }

  maintain(reading: ClockReading, time?: ServerTimeInterval): void {
    if (!this.advanceClock(reading, time)) return;
    this.prune(reading.monotonicMs);
  }

  ingest(
    snapshot: AirspaceSnapshot,
    reading: ClockReading,
    time?: ServerTimeInterval,
    selectedAircraftId?: string,
  ): void {
    if (
      !isCanonicalTimestamp(snapshot.generatedAt) ||
      !isCanonicalTimestamp(snapshot.providerGeneratedAt)
    )
      return;
    if (!this.advanceClock(reading, time)) return;
    this.retentionOffsetUpperMs = Math.max(
      this.retentionOffsetUpperMs,
      Date.parse(snapshot.generatedAt) - reading.monotonicMs,
    );
    this.prune(reading.monotonicMs);
    const changed = new Set<string>();
    const currentIds = new Set(snapshot.aircraft.map((aircraft) => aircraft.aircraftId));
    for (const [id, entry] of this.entries) {
      if (currentIds.has(id) || (entry.positionGap && entry.measurementGap)) continue;
      this.entries.set(
        id,
        createEntry(
          {
            ...entry,
            positionGap: true,
            measurementGap: true,
            issues: issue(entry.issues, 'feed-gap'),
          },
          entry,
        ),
      );
      changed.add(id);
    }
    for (const aircraft of snapshot.aircraft) {
      const previous = this.entries.get(aircraft.aircraftId);
      const next = this.observe(aircraft, snapshot, reading.monotonicMs, previous);
      if (next && next !== previous) {
        this.entries.set(aircraft.aircraftId, next);
        changed.add(aircraft.aircraftId);
      }
    }
    if (this.entries.size > this.maximumAircraft) {
      const candidates = [...this.entries].sort(([leftId, left], [rightId, right]) => {
        const priority = (id: string) =>
          id === selectedAircraftId ? 2 : currentIds.has(id) ? 1 : 0;
        return (
          priority(leftId) - priority(rightId) ||
          Math.max(left.lastPositionMs ?? -Infinity, left.lastMeasurementMs ?? -Infinity) -
            Math.max(right.lastPositionMs ?? -Infinity, right.lastMeasurementMs ?? -Infinity) ||
          (leftId < rightId ? -1 : leftId > rightId ? 1 : 0)
        );
      });
      for (const [id] of candidates) {
        if (this.entries.size <= this.maximumAircraft) break;
        this.entries.delete(id);
        changed.add(id);
      }
    }
    this.publish(changed);
  }

  private advanceClock(reading: ClockReading, time?: ServerTimeInterval): boolean {
    if (
      !Number.isFinite(reading.monotonicMs) ||
      reading.monotonicMs < 0 ||
      reading.monotonicMs > Number.MAX_SAFE_INTEGER ||
      !Number.isFinite(reading.wallMs) ||
      Math.abs(reading.wallMs) > Number.MAX_SAFE_INTEGER
    ) {
      if (this.entries.size > 0) this.clear();
      return false;
    }
    const previous = this.previousReading;
    if (
      previous &&
      (reading.monotonicMs < previous.monotonicMs ||
        Math.abs(reading.wallMs - previous.wallMs - (reading.monotonicMs - previous.monotonicMs)) >
          LIVE_CLOCK_MAX_ELAPSED_DIVERGENCE_MS)
    )
      this.clear();
    this.previousReading = { ...reading };
    // This nondecreasing offset is only an early-deletion bound. It must never
    // restore freshness after the independent synchronization reference expires.
    if (time && Number.isFinite(time.latestMs) && time.earliestMs <= time.latestMs)
      this.retentionOffsetUpperMs = Math.max(
        this.retentionOffsetUpperMs,
        time.latestMs - reading.monotonicMs,
      );
    return true;
  }

  private observe(
    aircraft: AircraftState,
    snapshot: AirspaceSnapshot,
    monotonicMs: number,
    previous?: HistoryEntry,
  ): HistoryEntry | undefined {
    let retained = previous?.retained ?? [];
    let issues = previous?.issues ?? [];
    let positionGap = previous?.positionGap ?? true;
    let measurementGap = previous?.measurementGap ?? true;
    let lastPositionMs = previous?.lastPositionMs;
    let lastMeasurementMs = previous?.lastMeasurementMs;
    let position: TrailPoint | undefined;
    let state: MeasurementPoint | undefined;
    const uncertain = aircraft.qualityFlags.includes('time-uncertain');
    const regressed = aircraft.qualityFlags.includes('provider-time-regression');
    const cutoff = monotonicMs + this.retentionOffsetUpperMs - LIVE_HISTORY_RETENTION_MS;
    const receiptMs = Date.parse(snapshot.generatedAt);
    if (uncertain || regressed) {
      issues = issue(issues, uncertain ? 'time-uncertain' : 'regressed-time');
      positionGap = measurementGap = true;
    } else {
      if (!aircraft.position || !isCanonicalTimestamp(aircraft.lastPositionAt)) {
        issues = issue(issues, 'missing-position');
        positionGap = true;
      } else {
        const observedMs = Date.parse(aircraft.lastPositionAt);
        const latest = previous?.trail.at(-1);
        if (observedMs > receiptMs) {
          issues = issue(issues, 'time-uncertain');
          positionGap = true;
        } else if (lastPositionMs !== undefined && observedMs < lastPositionMs) {
          issues = issue(issues, 'regressed-time');
          positionGap = true;
        } else if (observedMs === lastPositionMs) {
          if (
            latest?.observedAt === aircraft.lastPositionAt &&
            (latest.latitude !== aircraft.position.latitude ||
              latest.longitude !== aircraft.position.longitude)
          ) {
            issues = issue(issues, 'conflicting-observation');
            positionGap = true;
          }
        } else if (observedMs <= cutoff) {
          issues = issue(issues, 'retention-limit');
          positionGap = true;
        } else {
          if (lastPositionMs !== undefined && observedMs - lastPositionMs >= ACTIVE_OBSERVATION_MS)
            issues = issue(issues, 'feed-gap');
          position = {
            ...aircraft.position,
            observedAt: aircraft.lastPositionAt,
            sourceType: aircraft.sourceType,
            breakBefore:
              positionGap ||
              lastPositionMs === undefined ||
              observedMs - lastPositionMs >= ACTIVE_OBSERVATION_MS,
          };
          positionGap = false;
          lastPositionMs = observedMs;
        }
      }
      if (isCanonicalTimestamp(aircraft.observedAt)) {
        const observedMs = Date.parse(aircraft.observedAt);
        const latest = lastMeasurements(previous);
        if (observedMs > receiptMs) {
          issues = issue(issues, 'time-uncertain');
          measurementGap = true;
        } else if (lastMeasurementMs !== undefined && observedMs < lastMeasurementMs) {
          issues = issue(issues, 'regressed-time');
          measurementGap = true;
        } else if (observedMs === lastMeasurementMs) {
          if (
            latest?.observedAt === aircraft.observedAt &&
            MEASUREMENT_FIELDS.some((field) => latest[field] !== aircraft[field])
          ) {
            issues = issue(issues, 'conflicting-observation');
            measurementGap = true;
          }
        } else if (observedMs <= cutoff) {
          issues = issue(issues, 'retention-limit');
          measurementGap = true;
        } else {
          if (
            lastMeasurementMs !== undefined &&
            observedMs - lastMeasurementMs >= ACTIVE_OBSERVATION_MS
          )
            issues = issue(issues, 'feed-gap');
          state = measurements(
            aircraft,
            measurementGap ||
              lastMeasurementMs === undefined ||
              observedMs - lastMeasurementMs >= ACTIVE_OBSERVATION_MS,
          );
          measurementGap = false;
          lastMeasurementMs = observedMs;
        }
      } else {
        issues = issue(issues, 'time-uncertain');
        measurementGap = true;
      }
    }
    if (position || state) {
      retained = [
        ...retained,
        {
          evidence: {
            sequence: snapshot.sequence,
            receivedAt: snapshot.generatedAt,
            providerGeneratedAt: snapshot.providerGeneratedAt,
            position,
            measurements: state,
          },
          residenceExpiresAtMs: monotonicMs + LIVE_HISTORY_RETENTION_MS,
        },
      ];
      if (retained.length > this.maximumSamples) {
        retained = retained.slice(-this.maximumSamples);
        issues = issue(issues, 'sample-limit');
      }
    }
    if (retained.length === 0) return undefined;
    return createEntry(
      { retained, issues, positionGap, measurementGap, lastPositionMs, lastMeasurementMs },
      previous,
    );
  }

  private prune(monotonicMs: number): void {
    const serverUpperMs = monotonicMs + this.retentionOffsetUpperMs;
    if (monotonicMs < this.earliestResidenceExpiryMs && serverUpperMs < this.earliestSourceExpiryMs)
      return;
    const changed = new Set<string>();
    for (const [id, entry] of this.entries) {
      if (
        monotonicMs < entry.earliestResidenceExpiryMs &&
        serverUpperMs < entry.earliestSourceExpiryMs
      )
        continue;
      const retained: RetainedSample[] = [];
      for (const sample of entry.retained) {
        if (monotonicMs >= sample.residenceExpiresAtMs) continue;
        const alive = (point?: TrailPoint | MeasurementPoint) =>
          point && Date.parse(point.observedAt) + LIVE_HISTORY_RETENTION_MS > serverUpperMs
            ? point
            : undefined;
        const position = alive(sample.evidence.position) as TrailPoint | undefined;
        const state = alive(sample.evidence.measurements) as MeasurementPoint | undefined;
        if (!position && !state) continue;
        retained.push(
          position === sample.evidence.position && state === sample.evidence.measurements
            ? sample
            : { ...sample, evidence: { ...sample.evidence, position, measurements: state } },
        );
      }
      if (retained.length === 0) this.entries.delete(id);
      else
        this.entries.set(
          id,
          createEntry(
            {
              ...entry,
              retained,
              issues: issue(entry.issues, 'retention-limit'),
              positionGap:
                entry.positionGap || !retained.some((sample) => sample.evidence.position),
              measurementGap:
                entry.measurementGap || !retained.some((sample) => sample.evidence.measurements),
            },
            entry,
          ),
        );
      changed.add(id);
    }
    this.publish(changed);
  }

  private publish(changed: ReadonlySet<string>): void {
    if (changed.size === 0) return;
    let histories: Map<string, AircraftHistory> | undefined;
    let trails: Map<string, readonly TrailPoint[]> | undefined;
    for (const id of changed) {
      const entry = this.entries.get(id);
      if (entry?.history !== this.historiesValue.get(id)) {
        histories ??= new Map(this.historiesValue);
        if (entry) histories.set(id, entry.history);
        else histories.delete(id);
      }
      const trail = entry?.trail.length ? entry.trail : undefined;
      if (trail !== this.trailsValue.get(id)) {
        trails ??= new Map(this.trailsValue);
        if (trail) trails.set(id, trail);
        else trails.delete(id);
      }
    }
    this.historiesValue = histories ?? this.historiesValue;
    this.trailsValue = trails ?? this.trailsValue;
    this.earliestResidenceExpiryMs = Infinity;
    this.earliestSourceExpiryMs = Infinity;
    for (const entry of this.entries.values()) {
      this.earliestResidenceExpiryMs = Math.min(
        this.earliestResidenceExpiryMs,
        entry.earliestResidenceExpiryMs,
      );
      this.earliestSourceExpiryMs = Math.min(
        this.earliestSourceExpiryMs,
        entry.earliestSourceExpiryMs,
      );
    }
  }
}
