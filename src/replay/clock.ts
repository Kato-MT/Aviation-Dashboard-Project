import { REPLAY_SPEEDS } from './types';
import type {
  ReplayClockChange,
  ReplayClockChangeReason,
  ReplayClockState,
  ReplaySpeed,
} from './types';

export interface ReplayClockScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ReplayClockOptions {
  monotonicNow?: (() => number) | undefined;
  scheduler?: ReplayClockScheduler | undefined;
  tickIntervalMs?: number | undefined;
}

const defaultScheduler: ReplayClockScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Time-derived deterministic playback. Timer cadence affects publication only, never virtual time. */
export class ReplayVirtualClock {
  private readonly monotonicNow: () => number;
  private readonly scheduler: ReplayClockScheduler;
  private readonly tickIntervalMs: number;
  private readonly listeners = new Set<(change: ReplayClockChange) => void>();
  private timer: unknown | undefined;
  private generation = 0;
  private anchorPositionMs = 0;
  private anchorMonotonicMs = 0;
  private stateValue: ReplayClockState;

  constructor(durationMs: number, options: ReplayClockOptions = {}) {
    if (!Number.isSafeInteger(durationMs) || durationMs < 1) {
      throw new RangeError('Replay duration must be a positive safe integer.');
    }
    const tickIntervalMs = options.tickIntervalMs ?? 100;
    if (!Number.isSafeInteger(tickIntervalMs) || tickIntervalMs < 16 || tickIntervalMs > 1_000) {
      throw new RangeError(
        'Replay clock tick interval must be an integer from 16 through 1000 ms.',
      );
    }
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.tickIntervalMs = tickIntervalMs;
    this.stateValue = {
      positionMs: 0,
      durationMs,
      speed: 1,
      playing: false,
      disposed: false,
    };
  }

  readonly getState = (): ReplayClockState => this.stateValue;

  readonly subscribe = (listener: (change: ReplayClockChange) => void): (() => void) => {
    if (this.stateValue.disposed) return () => undefined;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  play(): void {
    if (
      this.stateValue.disposed ||
      this.stateValue.playing ||
      this.stateValue.positionMs >= this.stateValue.durationMs
    ) {
      return;
    }
    const now = this.readMonotonic();
    this.anchorPositionMs = this.stateValue.positionMs;
    this.anchorMonotonicMs = now;
    this.stateValue = { ...this.stateValue, playing: true };
    this.emit('play');
    this.schedule();
  }

  pause(): void {
    if (this.stateValue.disposed || !this.stateValue.playing) return;
    const positionMs = this.derivedPosition(this.readMonotonic());
    this.cancelTimer();
    this.anchorPositionMs = positionMs;
    this.stateValue = { ...this.stateValue, positionMs, playing: false };
    this.emit(positionMs >= this.stateValue.durationMs ? 'end' : 'pause');
  }

  seek(positionMs: number): void {
    if (this.stateValue.disposed) return;
    if (!Number.isFinite(positionMs)) throw new TypeError('Replay position must be finite.');
    const clamped = Math.max(0, Math.min(this.stateValue.durationMs, Math.floor(positionMs)));
    const now = this.readMonotonic();
    this.anchorPositionMs = clamped;
    this.anchorMonotonicMs = now;
    const playing = this.stateValue.playing && clamped < this.stateValue.durationMs;
    if (!playing) this.cancelTimer();
    this.stateValue = { ...this.stateValue, positionMs: clamped, playing };
    this.emit('seek');
    if (playing) this.schedule();
  }

  setSpeed(speed: ReplaySpeed): void {
    if (this.stateValue.disposed || speed === this.stateValue.speed) return;
    if (!(REPLAY_SPEEDS as readonly number[]).includes(speed)) {
      throw new RangeError('Replay speed must be 1, 2 or 4.');
    }
    const now = this.readMonotonic();
    const positionMs = this.derivedPosition(now);
    this.anchorPositionMs = positionMs;
    this.anchorMonotonicMs = now;
    const playing = this.stateValue.playing && positionMs < this.stateValue.durationMs;
    if (!playing) this.cancelTimer();
    this.stateValue = { ...this.stateValue, positionMs, speed, playing };
    this.emit(positionMs >= this.stateValue.durationMs ? 'end' : 'speed');
    if (playing) this.schedule();
  }

  dispose(): void {
    if (this.stateValue.disposed) return;
    this.generation += 1;
    this.cancelTimer();
    this.stateValue = { ...this.stateValue, playing: false, disposed: true };
    this.emit('dispose');
    this.listeners.clear();
  }

  private readMonotonic(): number {
    const value = this.monotonicNow();
    if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
      throw new RangeError('Replay monotonic time must be finite, non-negative and safe.');
    }
    return value;
  }

  private derivedPosition(now: number): number {
    if (!this.stateValue.playing) return this.stateValue.positionMs;
    const elapsed = Math.max(0, now - this.anchorMonotonicMs);
    return Math.min(
      this.stateValue.durationMs,
      Math.floor(this.anchorPositionMs + elapsed * this.stateValue.speed),
    );
  }

  private schedule(): void {
    if (this.timer !== undefined || !this.stateValue.playing || this.stateValue.disposed) return;
    const generation = this.generation;
    this.timer = this.scheduler.setTimeout(() => {
      this.timer = undefined;
      if (generation !== this.generation || this.stateValue.disposed || !this.stateValue.playing) {
        return;
      }
      const positionMs = this.derivedPosition(this.readMonotonic());
      if (positionMs >= this.stateValue.durationMs) {
        this.stateValue = { ...this.stateValue, positionMs, playing: false };
        this.anchorPositionMs = positionMs;
        this.emit('end');
        return;
      }
      this.stateValue = { ...this.stateValue, positionMs };
      this.emit('tick');
      this.schedule();
    }, this.tickIntervalMs);
  }

  private cancelTimer(): void {
    this.generation += 1;
    if (this.timer !== undefined) this.scheduler.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private emit(reason: ReplayClockChangeReason): void {
    const change = { state: this.stateValue, reason } as const;
    for (const listener of this.listeners) listener(change);
  }
}
