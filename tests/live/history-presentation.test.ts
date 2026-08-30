import { describe, expect, it } from 'vitest';

import type { AircraftHistory, AircraftHistorySample, HistoryIssue } from '../../src/live/history';
import {
  buildHistoryReceiptRows,
  buildSessionSeries,
  buildSessionTrailSegments,
  describeHistoryIssues,
  resolveHistorySample,
} from '../../src/live/historyPresentation';

const stamp = (second: number) => `2026-08-27T12:00:${second.toString().padStart(2, '0')}.000Z`;

function sample(
  sequence: number,
  overrides: Partial<AircraftHistorySample> = {},
): AircraftHistorySample {
  return {
    sequence,
    receivedAt: stamp(sequence),
    providerGeneratedAt: stamp(sequence),
    position: {
      latitude: 33.6 + sequence / 100,
      longitude: -84.4,
      observedAt: stamp(sequence),
      breakBefore: sequence === 1,
      sourceType: 'adsb',
    },
    measurements: {
      observedAt: stamp(sequence),
      barometricAltitudeFeet: sequence * 1_000,
      groundSpeedKnots: sequence * 10,
      verticalRateFeetPerMinute: 0,
      onGround: false,
      breakBefore: sequence === 1,
    },
    ...overrides,
  };
}

function history(samples: readonly AircraftHistorySample[]): AircraftHistory {
  return { samples, incompleteReasons: [] };
}

describe('live history presentation projections', () => {
  it('resolves latest or exact retained receipts without inventing a fallback', () => {
    const retained = history([sample(1), sample(2)]);
    expect(resolveHistorySample(retained, undefined)?.sequence).toBe(2);
    expect(resolveHistorySample(retained, 1)?.sequence).toBe(1);
    expect(resolveHistorySample(retained, 99)).toBeUndefined();
    expect(resolveHistorySample(undefined, 1)).toBeUndefined();
  });

  it('projects independent receipt, position, and measurement evidence with zero preserved', () => {
    const retained = history([
      sample(1, {
        position: {
          latitude: 33.61,
          longitude: -84.4,
          observedAt: stamp(0),
          breakBefore: true,
        },
        measurements: {
          observedAt: stamp(1),
          barometricAltitudeFeet: 0,
          groundSpeedKnots: 0,
          verticalRateFeetPerMinute: 0,
          onGround: true,
          breakBefore: true,
        },
      }),
      sample(2, { position: undefined, measurements: undefined }),
    ]);
    expect(buildHistoryReceiptRows(retained)).toEqual([
      {
        sequence: 1,
        receivedAt: stamp(1),
        providerGeneratedAt: stamp(1),
        positionObservedAt: stamp(0),
        measurementObservedAt: stamp(1),
        latitude: 33.61,
        longitude: -84.4,
        barometricAltitudeFeet: 0,
        groundSpeedKnots: 0,
        verticalRateFeetPerMinute: 0,
        positionBreakBefore: true,
        measurementBreakBefore: true,
      },
      {
        sequence: 2,
        receivedAt: stamp(2),
        providerGeneratedAt: stamp(2),
        positionObservedAt: undefined,
        measurementObservedAt: undefined,
        latitude: undefined,
        longitude: undefined,
        barometricAltitudeFeet: undefined,
        groundSpeedKnots: undefined,
        verticalRateFeetPerMinute: undefined,
        positionBreakBefore: false,
        measurementBreakBefore: false,
      },
    ]);
  });

  it('splits each measurement channel at its own missing values and evidence gaps', () => {
    const retained = history([
      sample(1, {
        measurements: {
          observedAt: stamp(1),
          barometricAltitudeFeet: 0,
          groundSpeedKnots: 100,
          onGround: false,
          breakBefore: true,
        },
      }),
      sample(2, { position: undefined, measurements: undefined }),
      sample(3, {
        measurements: {
          observedAt: stamp(3),
          barometricAltitudeFeet: 1_000,
          groundSpeedKnots: undefined,
          onGround: false,
          breakBefore: false,
        },
      }),
      sample(4, {
        measurements: {
          observedAt: stamp(4),
          barometricAltitudeFeet: 2_000,
          groundSpeedKnots: 120,
          onGround: false,
          breakBefore: false,
        },
      }),
      sample(5, {
        measurements: {
          observedAt: stamp(5),
          barometricAltitudeFeet: 3_000,
          groundSpeedKnots: 130,
          onGround: false,
          breakBefore: true,
        },
      }),
    ]);
    const altitude = buildSessionSeries(retained, 'barometricAltitudeFeet');
    expect(altitude).toMatchObject({ label: 'Barometric altitude', unit: 'ft', pointCount: 4 });
    expect(altitude.segments.map((segment) => segment.map(({ sequence }) => sequence))).toEqual([
      [1, 3, 4],
      [5],
    ]);
    expect(altitude.segments[0]![0]!.value).toBe(0);

    const speed = buildSessionSeries(retained, 'groundSpeedKnots');
    expect(speed).toMatchObject({ label: 'Ground speed', unit: 'kt', pointCount: 3 });
    expect(speed.segments.map((segment) => segment.map(({ sequence }) => sequence))).toEqual([
      [1],
      [4],
      [5],
    ]);
  });

  it('uses authoritative position breaks without treating state-only receipts as trail gaps', () => {
    const retained = history([
      sample(1),
      sample(2, { position: undefined }),
      sample(3, { position: { ...sample(3).position!, breakBefore: false } }),
      sample(4, { position: { ...sample(4).position!, breakBefore: true } }),
    ]);
    expect(
      buildSessionTrailSegments(retained).map((segment) => segment.map(({ sequence }) => sequence)),
    ).toEqual([[1, 3], [4]]);
  });

  it('provides readable text for every incomplete-history reason', () => {
    const issues: HistoryIssue[] = [
      'sample-limit',
      'retention-limit',
      'missing-position',
      'time-uncertain',
      'regressed-time',
      'conflicting-observation',
      'feed-gap',
    ];
    const described = describeHistoryIssues(issues);
    expect(described.map(({ code }) => code)).toEqual(issues);
    expect(described.every(({ message }) => message.endsWith('.'))).toBe(true);
  });
});
