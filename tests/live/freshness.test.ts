import { describe, expect, it } from 'vitest';

import { LiveServerClock, type ServerTimeInterval } from '../../src/live/clock';
import { aircraftEvidence, observationEvidence } from '../../src/live/freshness';
import { aircraftFixture, LIVE_FIXTURE_TIME } from './fixtures';

const observedMs = Date.parse(LIVE_FIXTURE_TIME);
function time(ageMs: number, uncertaintyMs = 0): ServerTimeInterval {
  return {
    earliestMs: observedMs + ageMs,
    latestMs: observedMs + ageMs + uncertaintyMs,
    referenceAgeMs: 0,
  };
}

describe('observation freshness independent of transport', () => {
  it.each([
    [0, 'current'],
    [15_000, 'current'],
    [15_001, 'delayed'],
    [45_000, 'delayed'],
    [45_001, 'stale'],
    [119_999, 'stale'],
    [120_000, 'expired'],
    [300_000, 'expired'],
  ] as const)('classifies the exact %i ms boundary as %s', (age, freshness) => {
    expect(observationEvidence(LIVE_FIXTURE_TIME, time(age))).toEqual({
      freshness,
      age: { minimumMs: age, maximumMs: age },
    });
  });

  it('uses the conservative upper age, including delivery uncertainty', () => {
    expect(observationEvidence(LIVE_FIXTURE_TIME, time(14_000, 2_000))).toMatchObject({
      freshness: 'delayed',
      age: { minimumMs: 14_000, maximumMs: 16_000 },
    });
    expect(aircraftEvidence(aircraftFixture(), time(119_000, 1_000)).activePosition).toBe(false);
  });

  it.each([undefined, '', 'invalid'])(
    'treats missing or invalid position time as unavailable: %j',
    (stamp) => {
      expect(observationEvidence(stamp, time(0))).toEqual({ freshness: 'missing' });
    },
  );

  it('never creates a current marker without a trusted clock', () => {
    expect(aircraftEvidence(aircraftFixture(), undefined)).toMatchObject({
      contact: { freshness: 'time-uncertain' },
      position: { freshness: 'time-uncertain' },
      activePosition: false,
    });
  });

  it.each(['time-uncertain', 'provider-time-regression'] as const)(
    'never promotes %s source evidence into a current marker',
    (flag) => {
      expect(
        aircraftEvidence(aircraftFixture({ qualityFlags: [flag] }), time(1_000)),
      ).toMatchObject({
        position: { freshness: 'time-uncertain' },
        activePosition: false,
      });
    },
  );

  it('retains negative ages as uncertain rather than clamping future data to current', () => {
    expect(observationEvidence(LIVE_FIXTURE_TIME, time(-5_000))).toEqual({
      freshness: 'time-uncertain',
      age: { minimumMs: -5_000, maximumMs: -5_000 },
    });
  });

  it('retains recent contact independently of an expired or missing position', () => {
    const aircraft = aircraftFixture({
      lastContactAt: new Date(observedMs + 120_000).toISOString(),
    });
    expect(aircraftEvidence(aircraft, time(120_000))).toMatchObject({
      contact: { freshness: 'current' },
      position: { freshness: 'expired' },
      activeContact: true,
      activePosition: false,
    });
    expect(aircraftEvidence({ ...aircraft, position: undefined }, time(120_000))).toMatchObject({
      position: { freshness: 'missing' },
      activeContact: true,
      activePosition: false,
    });
  });

  it('keeps a one-minute cached observation stale after ten seconds in transit with a wrong device clock', () => {
    const clock = new LiveServerClock();
    clock.synchronize({
      sent: { monotonicMs: 0, wallMs: 0 },
      received: { monotonicMs: 10_000, wallMs: 10_000 },
      serverAt: new Date(observedMs + 60_000).toISOString(),
    });
    expect(
      aircraftEvidence(aircraftFixture(), clock.estimate({ monotonicMs: 10_000, wallMs: 10_000 })),
    ).toMatchObject({
      position: { freshness: 'stale', age: { minimumMs: 59_999, maximumMs: 70_001 } },
      activePosition: true,
    });
  });
  it.each([
    [0, 'current'],
    [15_000, 'delayed'],
    [45_000, 'stale'],
    [120_000, 'expired'],
  ] as const)(
    'classifies %i ms plus a fractional boundary after server timestamp rounding',
    (age, freshness) => {
      const clock = new LiveServerClock();
      clock.synchronize({
        sent: { monotonicMs: 1_000.1, wallMs: 1_000 },
        received: { monotonicMs: 1_000.2, wallMs: 1_000 },
        serverAt: new Date(observedMs + 1_000).toISOString(),
      });
      const evidence = observationEvidence(
        new Date(observedMs + 1_001 - age).toISOString(),
        clock.estimate({ monotonicMs: 1_001.05, wallMs: 1_001 }),
      );
      expect(evidence.freshness).toBe(freshness);
      expect(evidence.age?.minimumMs).toBeLessThanOrEqual(age + 0.05);
      expect(evidence.age?.maximumMs).toBeGreaterThanOrEqual(age + 0.05);
    },
  );
});
