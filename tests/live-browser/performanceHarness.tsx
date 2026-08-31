import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-600.css';
import '../../src/features/live/live.css';

import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { AirspaceView } from '../../src/features/live/AirspaceView';
import { DEFAULT_AIRCRAFT_FILTERS, type AircraftSortField } from '../../src/live/presentation';
import {
  LIVE_HISTORY_MAX_AIRCRAFT,
  LIVE_HISTORY_MAX_QUALITY_EVENTS,
  LIVE_HISTORY_MAX_SAMPLES,
} from '../../src/live/history';
import {
  LIVE_STREAM_PROTOCOL_VERSION,
  parseLiveStreamMessage,
  serializeLiveStreamMessage,
} from '../../src/live/protocol';
import { LiveAirspaceSession, type LiveSessionState } from '../../src/live/session';
import { AIRSPACE_SCHEMA_VERSION, type AircraftState } from '../../src/live/types';
import { MAX_LIVE_MESSAGE_BYTES } from '../../src/live/validation';

const BASE_TIME_MS = Date.parse('2026-08-30T12:00:00.000Z');
const BINDING = Object.freeze({
  providerId: 'local-performance-fixture',
  regionId: 'atlanta',
  feedEpoch: 'synthetic-performance-1',
});

interface PaintResult {
  readonly recordCount: number;
  readonly sequence: number;
  readonly durationMs: number;
  readonly domStableDurationMs: number;
  readonly mapStableDurationMs: number;
  readonly validationDurationMs: number;
  readonly wireBytes: number;
  readonly visualFixtureKey: string;
  readonly historyAircraft: number;
  readonly minimumHistorySamples: number;
  readonly maximumHistorySamples: number;
  readonly historiesAtMaximum: number;
  readonly qualityEvents: number;
}

interface AgeTickResult {
  readonly durationMs: number;
  readonly jsHeapDeltaBytes: number;
  readonly historiesMapPreserved: boolean;
  readonly trailsMapPreserved: boolean;
  readonly historyObjectsPreserved: boolean;
  readonly sampleArraysPreserved: boolean;
  readonly historyAircraft: number;
  readonly historySamples: number;
}

interface PendingPaint {
  readonly sequence: number;
  readonly recordCount: number;
  readonly startedAt: number;
  readonly validationDurationMs: number;
  readonly wireBytes: number;
  readonly visualFixtureKey: string;
  domStable: boolean;
  mapStable: boolean;
  domStableDurationMs?: number;
  mapStableDurationMs?: number;
  resolve(result: PaintResult): void;
  reject(error: Error): void;
}

interface PendingAgeTick extends Omit<AgeTickResult, 'durationMs' | 'jsHeapDeltaBytes'> {
  readonly time: LiveSessionState['time'];
  readonly startedAt: number;
  readonly jsHeapBeforeBytes: number;
  resolve(result: AgeTickResult): void;
  reject(error: Error): void;
}

interface PerformanceHarness {
  prepareMaximumHistory(): Promise<{
    qualityReceipts: number;
    qualityEventsGenerated: number;
    qualityTailWindowVerified: boolean;
    historyReceipts: number;
    totalReceipts: number;
    durationMs: number;
    historyAircraft: number;
    minimumHistorySamples: number;
    maximumHistorySamples: number;
    historiesAtMaximum: number;
    qualityEvents: number;
  }>;
  ageTick(): Promise<AgeTickResult>;
  renderSnapshot(recordCount: 500 | 2_000): Promise<PaintResult>;
  limits(): Omit<
    PaintResult,
    | 'recordCount'
    | 'sequence'
    | 'durationMs'
    | 'domStableDurationMs'
    | 'mapStableDurationMs'
    | 'validationDurationMs'
    | 'wireBytes'
    | 'visualFixtureKey'
  >;
}

declare global {
  interface Window {
    flightPerformanceHarness?: PerformanceHarness;
  }
}

let wallNowMs = BASE_TIME_MS;
let sequence = 0;
let pendingPaint: PendingPaint | undefined;
let pendingAgeTick: PendingAgeTick | undefined;
const session = new LiveAirspaceSession(
  BINDING.regionId,
  {
    maximumAircraftTrails: LIVE_HISTORY_MAX_AIRCRAFT,
    maximumTrailPoints: LIVE_HISTORY_MAX_SAMPLES,
    maximumQualityEvents: LIVE_HISTORY_MAX_QUALITY_EVENTS,
  },
  BINDING.providerId,
  () => ({ monotonicMs: Math.max(0, wallNowMs - BASE_TIME_MS), wallMs: wallNowMs }),
);
session.beginFeed(BINDING);
session.markConnected();

function aircraft(index: number, observedAt: string, motionStep = 0): AircraftState {
  const aircraftId = (0x100000 + index).toString(16).padStart(6, '0');
  const motion = (motionStep % 32) * 0.000_05;
  return {
    aircraftId,
    identifierKind: 'icao24',
    callsign: `PX${String(index).padStart(4, '0')}`,
    registration: `PERF-${String(index).padStart(4, '0')}`,
    aircraftType: 'TEST',
    category: 'A3',
    position: {
      latitude: 33.2 + (index % 50) * 0.012 + motion,
      longitude:
        -84.95 + (Math.floor(index / 50) % 40) * 0.012 + (index % 2 === 0 ? motion : -motion),
    },
    barometricAltitudeFeet: 4_000 + (index % 300) * 100,
    geometricAltitudeFeet: 4_125 + (index % 300) * 100,
    groundSpeedKnots: 120 + (index % 420),
    trackDegrees: (index + motionStep) % 360,
    verticalRateFeetPerMinute: (index % 17) * 100 - 800,
    verticalRateBasis: 'barometric',
    onGround: false,
    sourceType: 'synthetic_performance_fixture',
    observedAt,
    lastContactAt: observedAt,
    lastPositionAt: observedAt,
    contactAgeSeconds: 0,
    positionAgeSeconds: 0,
    qualityFlags: [],
  };
}

function currentLimits(state: LiveSessionState) {
  const sampleCounts = [...state.histories.values()].map((history) => history.samples.length);
  const minimumHistorySamples = sampleCounts.length === 0 ? 0 : Math.min(...sampleCounts);
  let maximumHistorySamples = 0;
  for (const history of state.histories.values()) {
    maximumHistorySamples = Math.max(maximumHistorySamples, history.samples.length);
  }
  return {
    historyAircraft: state.histories.size,
    minimumHistorySamples,
    maximumHistorySamples,
    historiesAtMaximum: sampleCounts.filter((samples) => samples === 120).length,
    qualityEvents: state.qualityEvents.length,
  };
}

function jsHeapBytes(): number {
  return (
    (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory
      ?.usedJSHeapSize ?? 0
  );
}

function validatedSnapshot(
  records: AircraftState[],
  generatedAt: string,
  currentSequence: number,
  minimumWireBytes = 0,
) {
  const validationStartedAt = performance.now();
  let wire = serializeLiveStreamMessage({
    type: 'airspace.snapshot',
    protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
    snapshot: {
      schemaVersion: AIRSPACE_SCHEMA_VERSION,
      ...BINDING,
      sequence: currentSequence,
      generatedAt,
      providerGeneratedAt: generatedAt,
      aircraft: records,
      validation: {
        receivedAircraft: records.length,
        acceptedAircraft: records.length,
        rejectedAircraft: 0,
        duplicateAircraft: 0,
        invalidFields: 0,
      },
    },
  });
  const encodedBytes = new TextEncoder().encode(wire).byteLength;
  if (encodedBytes > minimumWireBytes && minimumWireBytes > 0) {
    throw new Error('Synthetic maximum fixture already exceeds its near-limit wire target.');
  }
  if (minimumWireBytes > encodedBytes) wire += ' '.repeat(minimumWireBytes - encodedBytes);
  const parsed = parseLiveStreamMessage(wire);
  if (!parsed.ok || parsed.message?.type !== 'airspace.snapshot') {
    throw new Error('Synthetic performance fixture failed Live protocol validation.');
  }
  return {
    snapshot: parsed.message.snapshot,
    validationDurationMs: performance.now() - validationStartedAt,
    wireBytes: new TextEncoder().encode(wire).byteLength,
  };
}

function finishPaint(pending: PendingPaint): void {
  if (pendingPaint !== pending || !pending.domStable || !pending.mapStable) return;
  if (pending.domStableDurationMs === undefined || pending.mapStableDurationMs === undefined)
    return;
  pendingPaint = undefined;
  pending.resolve({
    recordCount: pending.recordCount,
    sequence: pending.sequence,
    durationMs: performance.now() - pending.startedAt,
    domStableDurationMs: pending.domStableDurationMs,
    mapStableDurationMs: pending.mapStableDurationMs,
    validationDurationMs: pending.validationDurationMs,
    wireBytes: pending.wireBytes,
    visualFixtureKey: pending.visualFixtureKey,
    ...currentLimits(session.state),
  });
}

function PerformanceApplication() {
  const [state, setState] = useState(session.state);
  const [filters, setFilters] = useState(() => ({ ...DEFAULT_AIRCRAFT_FILTERS }));
  const [sortField, setSortField] = useState<AircraftSortField>('identifier');
  const [sortDirection, setSortDirection] = useState<'ascending' | 'descending'>('ascending');
  const [paused, setPaused] = useState(false);
  const recordStableMapPaint = useCallback((paintedSequence: number) => {
    const pending = pendingPaint;
    if (!pending || paintedSequence !== pending.sequence) return;
    pending.mapStable = true;
    pending.mapStableDurationMs = performance.now() - pending.startedAt;
    finishPaint(pending);
  }, []);

  useLayoutEffect(() => {
    const paintedSequence = state.snapshot?.sequence;
    const pending = pendingPaint;
    if (pending === undefined || paintedSequence !== pending.sequence) return;
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        if (pendingPaint !== pending) return;
        pending.domStable = true;
        pending.domStableDurationMs = performance.now() - pending.startedAt;
        finishPaint(pending);
      });
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
    };
  }, [state.snapshot?.sequence]);

  useLayoutEffect(() => {
    const pending = pendingAgeTick;
    if (pending === undefined || state.time !== pending.time) return;
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        if (pendingAgeTick !== pending) return;
        pendingAgeTick = undefined;
        pending.resolve({
          durationMs: performance.now() - pending.startedAt,
          jsHeapDeltaBytes: jsHeapBytes() - pending.jsHeapBeforeBytes,
          historiesMapPreserved: pending.historiesMapPreserved,
          trailsMapPreserved: pending.trailsMapPreserved,
          historyObjectsPreserved: pending.historyObjectsPreserved,
          sampleArraysPreserved: pending.sampleArraysPreserved,
          historyAircraft: pending.historyAircraft,
          historySamples: pending.historySamples,
        });
      });
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
    };
  }, [state.time]);

  useEffect(() => {
    window.flightPerformanceHarness = {
      async prepareMaximumHistory() {
        if (pendingPaint !== undefined || pendingAgeTick !== undefined) {
          throw new Error('A synthetic paint measurement is already active.');
        }
        const startedAt = performance.now();
        for (let receipt = 0; receipt < 100; receipt += 1) {
          sequence += 1;
          wallNowMs = BASE_TIME_MS + sequence * 1_000;
          const generatedAt = new Date(wallNowMs).toISOString();
          const records = Array.from({ length: 4 }, (_, offset) => {
            const record = aircraft(2_100 + offset, generatedAt);
            return receipt % 2 === 0
              ? {
                  ...record,
                  qualityFlags:
                    offset === 0
                      ? ['provider-time-regression' as const, 'stale-position' as const]
                      : ['provider-time-regression' as const],
                }
              : record;
          });
          const validated = validatedSnapshot(records, generatedAt, sequence);
          session.updateTime({
            earliestMs: wallNowMs,
            latestMs: wallNowMs + 2,
            referenceAgeMs: 0,
          });
          session.applySnapshot(validated.snapshot);
        }
        for (let receipt = 0; receipt < LIVE_HISTORY_MAX_SAMPLES; receipt += 1) {
          sequence += 1;
          wallNowMs = BASE_TIME_MS + sequence * 1_000;
          const generatedAt = new Date(wallNowMs).toISOString();
          const records = Array.from({ length: LIVE_HISTORY_MAX_AIRCRAFT }, (_, offset) =>
            aircraft(1_500 + offset, generatedAt),
          );
          const validated = validatedSnapshot(records, generatedAt, sequence);
          session.updateTime({
            earliestMs: wallNowMs,
            latestMs: wallNowMs + 2,
            referenceAgeMs: 0,
          });
          session.applySnapshot(validated.snapshot);
        }
        await new Promise<PaintResult>((resolve, reject) => {
          const current = session.state;
          if (current.snapshot === undefined) {
            reject(new Error('Synthetic maximum preparation has no snapshot to present.'));
            return;
          }
          pendingPaint = {
            sequence: current.snapshot.sequence,
            recordCount: current.snapshot.aircraft.length,
            startedAt: performance.now(),
            validationDurationMs: 0,
            wireBytes: 0,
            visualFixtureKey: 'maximum-preparation',
            domStable: false,
            mapStable: false,
            resolve,
            reject,
          };
          setState(current);
        });
        return {
          qualityReceipts: 100,
          qualityEventsGenerated: 250,
          qualityTailWindowVerified:
            session.state.qualityEvents[0]?.timestamp ===
              new Date(BASE_TIME_MS + 21_000).toISOString() &&
            session.state.qualityEvents.at(-1)?.timestamp ===
              new Date(BASE_TIME_MS + 99_000).toISOString(),
          historyReceipts: LIVE_HISTORY_MAX_SAMPLES,
          totalReceipts: 100 + LIVE_HISTORY_MAX_SAMPLES,
          durationMs: performance.now() - startedAt,
          ...currentLimits(session.state),
        };
      },
      ageTick() {
        if (pendingPaint !== undefined || pendingAgeTick !== undefined) {
          return Promise.reject(
            new Error('A synthetic performance measurement is already active.'),
          );
        }
        const before = session.state;
        const beforeEntries = [...before.histories.entries()];
        const startedAt = performance.now();
        const jsHeapBeforeBytes = jsHeapBytes();
        wallNowMs += 1_000;
        const time = {
          earliestMs: wallNowMs,
          latestMs: wallNowMs + 2,
          referenceAgeMs: 0,
        };
        const next = session.updateTime(time);
        const historyObjectsPreserved = beforeEntries.every(
          ([aircraftId, history]) => next.histories.get(aircraftId) === history,
        );
        const sampleArraysPreserved = beforeEntries.every(
          ([aircraftId, history]) => next.histories.get(aircraftId)?.samples === history.samples,
        );
        return new Promise<AgeTickResult>((resolve, reject) => {
          pendingAgeTick = {
            time,
            startedAt,
            jsHeapBeforeBytes,
            historiesMapPreserved: next.histories === before.histories,
            trailsMapPreserved: next.trails === before.trails,
            historyObjectsPreserved,
            sampleArraysPreserved,
            historyAircraft: next.histories.size,
            historySamples: [...next.histories.values()].reduce(
              (sum, history) => sum + history.samples.length,
              0,
            ),
            resolve,
            reject,
          };
          setState(next);
        });
      },
      renderSnapshot(recordCount) {
        if (pendingPaint !== undefined || pendingAgeTick !== undefined) {
          return Promise.reject(new Error('A synthetic paint measurement is already active.'));
        }
        sequence += 1;
        wallNowMs = BASE_TIME_MS + sequence * 1_000;
        const generatedAt = new Date(wallNowMs).toISOString();
        const records = Array.from({ length: recordCount }, (_, index) =>
          aircraft(index, generatedAt, sequence),
        );
        const validated = validatedSnapshot(
          records,
          generatedAt,
          sequence,
          recordCount === 2_000 ? Math.floor(MAX_LIVE_MESSAGE_BYTES * 0.96) : 0,
        );
        return new Promise<PaintResult>((resolve, reject) => {
          pendingPaint = {
            sequence,
            recordCount,
            startedAt: performance.now(),
            validationDurationMs: validated.validationDurationMs,
            wireBytes: validated.wireBytes,
            visualFixtureKey: `${records[0]!.position!.latitude}:${records[0]!.position!.longitude}:${records[0]!.trackDegrees}`,
            domStable: false,
            mapStable: false,
            resolve,
            reject,
          };
          session.updateTime({
            earliestMs: wallNowMs,
            latestMs: wallNowMs + 2,
            referenceAgeMs: 0,
          });
          const next = session.applySnapshot(validated.snapshot);
          setState(next);
        });
      },
      limits: () => currentLimits(session.state),
    };
    return () => {
      pendingPaint?.reject(new Error('Synthetic performance harness was unmounted.'));
      pendingPaint = undefined;
      pendingAgeTick?.reject(new Error('Synthetic performance harness was unmounted.'));
      pendingAgeTick = undefined;
      delete window.flightPerformanceHarness;
    };
  }, []);

  return (
    <main id="performance-main">
      <p className="source-banner" role="note">
        Local synthetic performance fixture. No provider request is permitted.
      </p>
      <AirspaceView
        state={state}
        filters={filters}
        sortField={sortField}
        sortDirection={sortDirection}
        paused={paused}
        onFilters={setFilters}
        onSort={(field) => {
          if (field === sortField) {
            setSortDirection((direction) =>
              direction === 'ascending' ? 'descending' : 'ascending',
            );
          } else {
            setSortField(field);
            setSortDirection('ascending');
          }
        }}
        onSelect={(selection) => {
          if (selection?.mode === 'exact') {
            setState(
              session.selectHistorySample(
                selection.key.aircraftId,
                selection.key.sequence,
                selection.key,
              ),
            );
          } else {
            setState(
              session.selectAircraft(
                selection?.mode === 'latest' ? selection.aircraftId : undefined,
              ),
            );
          }
        }}
        onStableMapPaint={recordStableMapPaint}
        onRegion={() => undefined}
        onPause={() => setPaused((value) => !value)}
        onReconnect={() => undefined}
      />
    </main>
  );
}

const root = createRoot(document.getElementById('performance-root')!);
root.render(<PerformanceApplication />);
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    pendingPaint?.reject(new Error('Synthetic performance harness was reloaded.'));
    pendingPaint = undefined;
    pendingAgeTick?.reject(new Error('Synthetic performance harness was reloaded.'));
    pendingAgeTick = undefined;
    delete window.flightPerformanceHarness;
    root.unmount();
  });
}
