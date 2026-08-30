import type { ClockReading, ServerTimeInterval } from '../live/clock';
import { LiveAirspaceSession } from '../live/session';
import type { LiveFeedBinding } from '../live/types';
import { ReplayVirtualClock } from './clock';
import type { ReplayClockOptions } from './clock';
import { AIRSPACE_REPLAY_SCHEMA_VERSION, REPLAY_PROVIDER_ID } from './types';
import type {
  ReadonlyReplayEvent,
  ReplayRuntimeState,
  ReplaySpeed,
  ReplayTranscriptEntry,
  ValidatedReplayManifest,
} from './types';
import {
  isValidatedReplayManifest,
  normalizeReplayHealth,
  normalizeReplaySnapshot,
  replayEventBinding,
} from './validation';

export type ReplayRuntimeOptions = ReplayClockOptions;

interface ReplaySelection {
  aircraftId: string;
  sequence?: number | undefined;
}

function exactTime(startAt: string, positionMs: number): ServerTimeInterval {
  const time = Date.parse(startAt) + positionMs;
  return { earliestMs: time, latestMs: time, referenceAgeMs: 0 };
}

/** Owns one no-network virtual clock and one normalized airspace session. */
export class ReplayRuntime {
  private readonly clock: ReplayVirtualClock;
  private readonly listeners = new Set<() => void>();
  private readonly binding: Readonly<LiveFeedBinding>;
  private readonly regionId: string;
  private sessionValue!: LiveAirspaceSession;
  private transcriptValue: ReplayTranscriptEntry[] = [];
  private nextEventIndex = 0;
  private disposed = false;
  private reading: ClockReading;
  private stateValue!: ReplayRuntimeState;
  private readonly unsubscribeClock: () => void;

  constructor(
    readonly manifest: ValidatedReplayManifest,
    options: ReplayRuntimeOptions = {},
  ) {
    if (
      manifest.schemaVersion !== AIRSPACE_REPLAY_SCHEMA_VERSION ||
      manifest.synthetic !== true ||
      !isValidatedReplayManifest(manifest)
    ) {
      throw new TypeError('ReplayRuntime requires a parsed, frozen airspace-replay.v1 manifest.');
    }
    const firstEvent = manifest.events[0];
    if (!firstEvent) throw new TypeError('ReplayRuntime requires at least one validated event.');
    this.binding = Object.freeze(replayEventBinding(firstEvent));
    if (this.binding.providerId !== REPLAY_PROVIDER_ID) {
      throw new TypeError('ReplayRuntime accepts only the reserved synthetic replay provider.');
    }
    this.regionId = this.binding.regionId;
    this.reading = { monotonicMs: 0, wallMs: Date.parse(manifest.startAt) };
    this.clock = new ReplayVirtualClock(manifest.durationMs, options);
    this.rebuild(0);
    this.stateValue = this.composeState();
    this.unsubscribeClock = this.clock.subscribe(({ state, reason }) => {
      if (this.disposed || reason === 'dispose') return;
      const selection = this.captureSelection();
      if (reason === 'seek' || state.positionMs < this.stateValue.positionMs) {
        this.rebuild(state.positionMs, selection);
      } else {
        this.applyThrough(state.positionMs);
      }
      this.stateValue = this.composeState();
      this.emit();
    });
  }

  readonly getState = (): ReplayRuntimeState => this.stateValue;

  readonly subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  play(): void {
    if (!this.disposed) this.clock.play();
  }

  pause(): void {
    if (!this.disposed) this.clock.pause();
  }

  seek(positionMs: number): void {
    if (!this.disposed) this.clock.seek(positionMs);
  }

  seekEvent(eventIndex: number): void {
    if (!Number.isSafeInteger(eventIndex))
      throw new TypeError('Replay event index must be an integer.');
    const event = this.manifest.events[eventIndex];
    if (!event) throw new RangeError('Replay event index is outside the manifest.');
    this.seek(event.offsetMs);
  }

  setSpeed(speed: ReplaySpeed): void {
    if (!this.disposed) this.clock.setSpeed(speed);
  }

  selectAircraft(aircraftId?: string): void {
    if (this.disposed) return;
    const previous = this.sessionValue.state;
    this.sessionValue.selectAircraft(aircraftId);
    if (this.sessionValue.state !== previous) {
      this.stateValue = this.composeState();
      this.emit();
    }
  }

  selectHistorySample(
    aircraftId: string,
    sequence: number,
    expectedBinding: Readonly<LiveFeedBinding> = this.binding,
  ): void {
    if (this.disposed) return;
    const previous = this.sessionValue.state;
    this.sessionValue.selectHistorySample(aircraftId, sequence, expectedBinding);
    if (this.sessionValue.state !== previous) {
      this.stateValue = this.composeState();
      this.emit();
    }
  }

  stop(): void {
    this.pause();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeClock();
    this.clock.dispose();
    this.listeners.clear();
  }

  private captureSelection(): ReplaySelection | undefined {
    const state = this.sessionValue.state;
    return state.selectedAircraftId
      ? {
          aircraftId: state.selectedAircraftId,
          ...(state.selectedHistorySequence === undefined
            ? {}
            : { sequence: state.selectedHistorySequence }),
        }
      : undefined;
  }

  private restoreSelection(selection?: ReplaySelection): void {
    if (!selection) return;
    const state = this.sessionValue.state;
    if (
      !state.histories.has(selection.aircraftId) &&
      !state.snapshot?.aircraft.some((aircraft) => aircraft.aircraftId === selection.aircraftId)
    ) {
      return;
    }
    this.sessionValue.selectAircraft(selection.aircraftId);
    if (selection.sequence !== undefined && state.binding) {
      this.sessionValue.selectHistorySample(
        selection.aircraftId,
        selection.sequence,
        state.binding,
      );
    }
  }

  private rebuild(positionMs: number, selection?: ReplaySelection): void {
    this.reading = { monotonicMs: 0, wallMs: Date.parse(this.manifest.startAt) };
    this.sessionValue = new LiveAirspaceSession(
      this.regionId,
      {},
      REPLAY_PROVIDER_ID,
      () => this.reading,
    );
    this.transcriptValue = [];
    this.nextEventIndex = 0;
    this.applyThrough(positionMs);
    this.restoreSelection(selection);
  }

  private applyThrough(positionMs: number): void {
    while (
      this.nextEventIndex < this.manifest.events.length &&
      this.manifest.events[this.nextEventIndex]!.offsetMs <= positionMs
    ) {
      const event = this.manifest.events[this.nextEventIndex]!;
      this.setReading(event.offsetMs);
      this.sessionValue.updateTime(exactTime(this.manifest.startAt, event.offsetMs));
      this.applyEvent(event);
      this.nextEventIndex += 1;
    }
    this.setReading(positionMs);
    this.sessionValue.updateTime(exactTime(this.manifest.startAt, positionMs));
  }

  private setReading(positionMs: number): void {
    this.reading = {
      monotonicMs: positionMs,
      wallMs: Date.parse(this.manifest.startAt) + positionMs,
    };
  }

  private applyEvent(event: ReadonlyReplayEvent): void {
    const before = this.sessionValue.state;
    if (event.kind === 'snapshot') {
      this.sessionValue.applySnapshot(normalizeReplaySnapshot(event.snapshot));
    } else {
      this.sessionValue.applyHealth(normalizeReplayHealth(event.health));
    }
    const outcome =
      event.kind === 'snapshot'
        ? this.sessionValue.state.snapshot === before.snapshot
          ? 'rejected'
          : 'accepted'
        : this.sessionValue.state.health === before.health
          ? 'rejected'
          : 'accepted';
    const entry: ReplayTranscriptEntry = {
      eventIndex: event.index,
      offsetMs: event.offsetMs,
      kind: event.kind,
      label: event.label,
      description: event.description,
      expectedDisposition: event.expectedDisposition,
      outcome,
      matchesExpectation: outcome === event.expectedDisposition,
      phaseAfter: this.sessionValue.state.phase,
      ...(event.kind === 'snapshot' ? { snapshotSequence: event.snapshot.sequence } : {}),
    };
    if (!entry.matchesExpectation) {
      throw new Error(
        `Validated replay transition ${event.index} violated its expected disposition.`,
      );
    }
    this.transcriptValue = [...this.transcriptValue, entry];
  }

  private composeState(): ReplayRuntimeState {
    const clock = this.clock.getState();
    return {
      manifest: this.manifest,
      positionMs: clock.positionMs,
      speed: clock.speed,
      playing: clock.playing,
      ended: clock.positionMs >= clock.durationMs,
      session: this.sessionValue.state,
      transcript: this.transcriptValue,
      currentEvent: this.transcriptValue.at(-1),
    };
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
