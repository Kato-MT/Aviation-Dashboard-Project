import { isCanonicalTimestamp, isFiniteNumber } from './validation';

export const LIVE_CLOCK_REFERENCE_TTL_MS = 60_000;
export const LIVE_CLOCK_MAX_ROUND_TRIP_MS = 10_000;
export const LIVE_CLOCK_MAX_ELAPSED_DIVERGENCE_MS = 1_000;
export const LIVE_CLOCK_TIMESTAMP_UNCERTAINTY_MS = 1;

export interface ClockReading {
  monotonicMs: number;
  wallMs: number;
}

export interface ServerTimeSample {
  sent: ClockReading;
  received: ClockReading;
  serverAt: string;
}

export interface ServerTimeInterval {
  earliestMs: number;
  latestMs: number;
  referenceAgeMs: number;
}

export interface LiveClockOptions {
  monotonicNow?: () => number;
  wallNow?: () => number;
}

interface ClockReference {
  lowerOffsetMs: number;
  upperOffsetMs: number;
  acquired: ClockReading;
  lastReading: ClockReading;
}

function validReading(value: ClockReading): boolean {
  return (
    isFiniteNumber(value.monotonicMs, 0, Number.MAX_SAFE_INTEGER) &&
    isFiniteNumber(value.wallMs, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)
  );
}

function consistentElapsed(start: ClockReading, end: ClockReading): boolean {
  const monotonicElapsed = end.monotonicMs - start.monotonicMs;
  const wallElapsed = end.wallMs - start.wallMs;
  return (
    validReading(start) &&
    validReading(end) &&
    monotonicElapsed >= 0 &&
    Number.isFinite(monotonicElapsed) &&
    Math.abs(wallElapsed - monotonicElapsed) <= LIVE_CLOCK_MAX_ELAPSED_DIVERGENCE_MS
  );
}

/** A short-lived server-time bound; local wall time is only a discontinuity detector. */
export class LiveServerClock {
  private reference?: ClockReference | undefined;
  private readonly monotonicNow: () => number;
  private readonly wallNow: () => number;

  constructor(options: LiveClockOptions = {}) {
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.wallNow = options.wallNow ?? (() => Date.now());
  }

  read(): ClockReading {
    return { monotonicMs: this.monotonicNow(), wallMs: this.wallNow() };
  }

  invalidate(): void {
    this.reference = undefined;
  }

  synchronize(sample: ServerTimeSample): boolean {
    if (
      !isCanonicalTimestamp(sample.serverAt) ||
      !consistentElapsed(sample.sent, sample.received) ||
      sample.received.monotonicMs - sample.sent.monotonicMs > LIVE_CLOCK_MAX_ROUND_TRIP_MS
    ) {
      this.invalidate();
      return false;
    }
    const serverAtMs = Date.parse(sample.serverAt);
    // Server dates have millisecond resolution while performance.now() can be fractional.
    const lowerOffsetMs =
      serverAtMs - sample.received.monotonicMs - LIVE_CLOCK_TIMESTAMP_UNCERTAINTY_MS;
    const upperOffsetMs =
      serverAtMs - sample.sent.monotonicMs + LIVE_CLOCK_TIMESTAMP_UNCERTAINTY_MS;
    const previous = this.estimate(sample.received);
    const candidateEarliestMs = serverAtMs - LIVE_CLOCK_TIMESTAMP_UNCERTAINTY_MS;
    const candidateLatestMs =
      serverAtMs +
      (sample.received.monotonicMs - sample.sent.monotonicMs) +
      LIVE_CLOCK_TIMESTAMP_UNCERTAINTY_MS;
    if (
      previous &&
      (candidateLatestMs < previous.earliestMs || candidateEarliestMs > previous.latestMs)
    ) {
      // Contradictory server samples need a fresh exchange, not a silently shifted clock.
      this.invalidate();
      return false;
    }
    this.reference = {
      lowerOffsetMs,
      upperOffsetMs,
      acquired: { ...sample.received },
      lastReading: { ...sample.received },
    };
    return true;
  }

  estimate(reading = this.read()): ServerTimeInterval | undefined {
    const reference = this.reference;
    if (!reference) return undefined;
    const age = reading.monotonicMs - reference.acquired.monotonicMs;
    if (
      !consistentElapsed(reference.acquired, reading) ||
      !consistentElapsed(reference.lastReading, reading) ||
      age >= LIVE_CLOCK_REFERENCE_TTL_MS
    ) {
      this.invalidate();
      return undefined;
    }
    reference.lastReading = { ...reading };
    return {
      earliestMs: reading.monotonicMs + reference.lowerOffsetMs,
      latestMs: reading.monotonicMs + reference.upperOffsetMs,
      referenceAgeMs: age,
    };
  }
}
