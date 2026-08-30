import { describe, expect, it } from 'vitest';

import { LiveServerClock, type ClockReading, type ServerTimeSample } from '../../src/live/clock';

const serverAt = '2026-08-27T12:00:00.000Z';
const serverMs = Date.parse(serverAt);
const wrongWall = Date.parse('1980-01-01T00:00:00.000Z');

function reading(monotonicMs: number, wallOffset = 0): ClockReading {
  return { monotonicMs, wallMs: wrongWall + monotonicMs + wallOffset };
}

function sample(overrides: Partial<ServerTimeSample> = {}): ServerTimeSample {
  return { sent: reading(1_000), received: reading(1_100), serverAt, ...overrides };
}

describe('bounded live server clock', () => {
  it('has no trusted time before a measured server exchange', () => {
    expect(new LiveServerClock().estimate(reading(1_000))).toBeUndefined();
  });

  it('uses the complete round-trip bound, not local wall time or half the latency', () => {
    const clock = new LiveServerClock();
    expect(clock.synchronize(sample())).toBe(true);
    expect(clock.estimate(reading(1_100))).toEqual({
      earliestMs: serverMs - 1,
      latestMs: serverMs + 101,
      referenceAgeMs: 0,
    });
    expect(clock.estimate(reading(11_100))).toEqual({
      earliestMs: serverMs + 9_999,
      latestMs: serverMs + 10_101,
      referenceAgeMs: 10_000,
    });
  });

  it('expires at sixty seconds, even if no new data arrives', () => {
    const clock = new LiveServerClock();
    clock.synchronize(sample());
    expect(clock.estimate(reading(61_099))).toBeDefined();
    expect(clock.estimate(reading(61_100))).toBeUndefined();
    expect(clock.estimate(reading(61_101))).toBeUndefined();
  });

  it('refreshes from a consistent new measured exchange', () => {
    const clock = new LiveServerClock();
    clock.synchronize(sample());
    expect(
      clock.synchronize({
        sent: reading(31_000),
        received: reading(31_200),
        serverAt: '2026-08-27T12:00:30.050Z',
      }),
    ).toBe(true);
    expect(clock.estimate(reading(31_200))).toEqual({
      earliestMs: serverMs + 30_049,
      latestMs: serverMs + 30_251,
      referenceAgeMs: 0,
    });
    expect(clock.estimate(reading(80_000))).toBeDefined();
  });

  it.each([-120_000, 120_000])('invalidates a contradictory server clock jump of %i ms', (jump) => {
    const clock = new LiveServerClock();
    clock.synchronize(sample());
    const next = {
      sent: reading(31_000),
      received: reading(31_100),
      serverAt: new Date(serverMs + 30_000 + jump).toISOString(),
    };
    expect(clock.synchronize(next)).toBe(false);
    expect(clock.estimate(reading(31_100))).toBeUndefined();
    expect(clock.synchronize(next)).toBe(true);
  });

  it.each([-2_000, 2_000, 300_000])(
    'invalidates a local wall-clock discontinuity of %i ms',
    (jump) => {
      const clock = new LiveServerClock();
      clock.synchronize(sample());
      expect(clock.estimate(reading(1_200, jump))).toBeUndefined();
    },
  );

  it('detects accumulated divergence rather than allowing repeated small clock slips', () => {
    const clock = new LiveServerClock();
    clock.synchronize(sample());
    expect(clock.estimate(reading(2_100, 600))).toBeDefined();
    expect(clock.estimate(reading(3_100, 1_200))).toBeUndefined();
  });

  it('invalidates backward monotonic time after a successful estimate', () => {
    const clock = new LiveServerClock();
    clock.synchronize(sample());
    expect(clock.estimate(reading(5_000))).toBeDefined();
    expect(clock.estimate(reading(4_000))).toBeUndefined();
  });

  it('rejects an exchange spanning sleep when the monotonic clock did not advance', () => {
    const clock = new LiveServerClock();
    expect(clock.synchronize(sample({ received: reading(1_100, 300_000) }))).toBe(false);
  });

  it.each([
    { serverAt: 'invalid' },
    { serverAt: '2026-02-30T12:00:00.000Z' },
    { sent: reading(-1) },
    { sent: reading(Number.NaN) },
    { received: reading(Number.POSITIVE_INFINITY) },
    { received: reading(Number.MAX_VALUE) },
    { received: { monotonicMs: 1_100, wallMs: Number.MAX_VALUE } },
    { received: reading(999) },
    { received: reading(11_001) },
    { received: { monotonicMs: 1_100, wallMs: Number.NaN } },
  ])('rejects an unusable exchange and invalidates its old reference: %j', (overrides) => {
    const clock = new LiveServerClock();
    clock.synchronize(sample());
    expect(clock.synchronize(sample(overrides))).toBe(false);
    expect(clock.estimate(reading(1_100))).toBeUndefined();
  });

  it('accepts a ten-second exchange at the maximum bound', () => {
    const clock = new LiveServerClock();
    expect(clock.synchronize(sample({ received: reading(11_000) }))).toBe(true);
    expect(clock.estimate(reading(11_000))?.latestMs).toBe(serverMs + 10_001);
  });

  it('retains copies of readings rather than externally mutable reference objects', () => {
    const clock = new LiveServerClock();
    const value = sample();
    clock.synchronize(value);
    value.received.monotonicMs = 99_000;
    expect(clock.estimate(reading(1_100))?.earliestMs).toBe(serverMs - 1);
  });

  it('supports explicit invalidation on reconnect, visibility change or mode change', () => {
    const clock = new LiveServerClock();
    clock.synchronize(sample());
    clock.invalidate();
    clock.invalidate();
    expect(clock.estimate(reading(1_100))).toBeUndefined();
  });

  it('reads the supplied clocks independently', () => {
    const clock = new LiveServerClock({ monotonicNow: () => 25, wallNow: () => wrongWall });
    expect(clock.read()).toEqual({ monotonicMs: 25, wallMs: wrongWall });
  });

  it('accepts consecutive fractional exchanges despite millisecond timestamp quantization', () => {
    const clock = new LiveServerClock();
    expect(
      clock.synchronize({
        sent: reading(1_000.1),
        received: reading(1_000.2),
        serverAt: new Date(serverMs + 1_000).toISOString(),
      }),
    ).toBe(true);
    const first = clock.estimate(reading(1_000.2))!;
    expect(first.earliestMs).toBeLessThanOrEqual(serverMs + 1_000.2);
    expect(first.latestMs).toBeGreaterThanOrEqual(serverMs + 1_000.2);
    expect(
      clock.synchronize({
        sent: reading(1_001.7),
        received: reading(1_001.8),
        serverAt: new Date(serverMs + 1_001).toISOString(),
      }),
    ).toBe(true);
  });

  it('bounds a known server clock across fractional phases and short round trips', () => {
    for (const phase of [0.01, 0.1, 0.49, 0.9, 0.99]) {
      for (const roundTrip of [0.05, 0.1, 0.5, 1]) {
        const clock = new LiveServerClock();
        const sent = 1_000 + phase;
        const received = sent + roundTrip;
        expect(
          clock.synchronize({
            sent: reading(sent),
            received: reading(received),
            serverAt: new Date(serverMs + Math.floor(sent + roundTrip / 2)).toISOString(),
          }),
        ).toBe(true);
        const interval = clock.estimate(reading(received))!;
        expect(interval.earliestMs).toBeLessThanOrEqual(serverMs + received);
        expect(interval.latestMs).toBeGreaterThanOrEqual(serverMs + received);
      }
    }
  });
});
