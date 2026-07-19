import { describe, expect, it } from 'vitest';

import { KinematicFusionEstimator } from '../../src/temporal/estimator';
import type { FusionEstimate, FusionInput } from '../../src/temporal/types';

function input(sampleIndex: number, measurements: FusionInput['measurements']): FusionInput {
  return {
    sourceId: 'synthetic-source',
    sampleIndex,
    timestampMs: Date.parse('2026-01-01T00:00:00.000Z') + sampleIndex * 1_000,
    measurements,
  };
}

function expectFiniteTree(value: unknown): void {
  if (typeof value === 'number') {
    expect(Number.isFinite(value)).toBe(true);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(expectFiniteTree);
    return;
  }
  if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach(expectFiniteTree);
  }
}

describe('redundant sensor fusion estimator', () => {
  it('converges on a stable hidden altitude and reduces uncertainty', () => {
    const estimator = new KinematicFusionEstimator();
    let first: FusionEstimate | undefined;
    let latest: FusionEstimate | undefined;
    for (let index = 0; index < 50; index += 1) {
      latest = estimator.update(
        input(index, {
          barometricAltitude: index % 2 === 0 ? 1_004 : 996,
          gpsAltitude: index % 2 === 0 ? 990 : 1_010,
          inertialVerticalRate: 0,
          barometricVerticalRate: 0,
        }),
      );
      first ??= latest;
    }

    expect(latest?.estimated.altitude).toBeCloseTo(1_000, 0);
    expect(Math.abs(latest?.estimated.verticalRate ?? 1)).toBeLessThan(1);
    expect(latest?.uncertainty.altitudeStandardDeviation).toBeLessThan(
      first?.uncertainty.altitudeStandardDeviation ?? 0,
    );
    expect(latest?.evidence).toMatchObject({
      ruleId: 'temporal.sensor-fusion.innovation',
      synthetic: true,
      dataClassification: 'SYNTHETIC_UNCLASSIFIED',
    });
    expectFiniteTree(latest);
  });

  it('predicts through missing measurements and grows uncertainty', () => {
    const estimator = new KinematicFusionEstimator({ initialAltitude: 1_000 });
    const measured = estimator.update(
      input(0, {
        barometricAltitude: 1_000,
        gpsAltitude: 1_000,
        inertialVerticalRate: 10,
        barometricVerticalRate: 10,
      }),
    );
    const missing = estimator.update(
      input(1, {
        barometricAltitude: null,
        gpsAltitude: null,
        inertialVerticalRate: null,
        barometricVerticalRate: null,
      }),
    );

    expect(missing.innovations).toEqual([]);
    expect(missing.missingSensors).toEqual([
      'barometricAltitude',
      'gpsAltitude',
      'inertialVerticalRate',
      'barometricVerticalRate',
    ]);
    expect(missing.estimated).toEqual(missing.predicted);
    expect(missing.estimated.altitude).toBeGreaterThan(measured.estimated.altitude);
    expect(missing.uncertainty.altitudeStandardDeviation).toBeGreaterThan(
      measured.uncertainty.altitudeStandardDeviation,
    );
    expect(missing.evidence.observed).toEqual({ altitude: null, verticalRate: null });
    expectFiniteTree(missing);
  });

  it('records predicted, observed, innovation, and uncertainty evidence for an outlier', () => {
    const estimator = new KinematicFusionEstimator({ initialAltitude: 1_000 });
    const estimate = estimator.update(
      input(0, {
        barometricAltitude: 1_000,
        gpsAltitude: 5_000,
        inertialVerticalRate: 0,
        barometricVerticalRate: 0,
      }),
    );

    expect(estimate.innovations).toHaveLength(4);
    expect(estimate.innovations.find(({ sensorId }) => sensorId === 'gpsAltitude')).toMatchObject({
      observedValue: 5_000,
    });
    expect(estimate.evidence.maximumAbsoluteNormalizedInnovation).toBeGreaterThan(3);
    expect(estimate.evidence.message).toContain('three-sigma');
    expect(estimate.uncertainty.altitude95[0]).toBeLessThan(estimate.estimated.altitude);
    expect(estimate.uncertainty.altitude95[1]).toBeGreaterThan(estimate.estimated.altitude);
  });

  it('rejects nonfinite measurements and non-increasing timestamps', () => {
    const estimator = new KinematicFusionEstimator();
    expect(() =>
      estimator.update(input(0, { barometricAltitude: Number.POSITIVE_INFINITY })),
    ).toThrow('must be finite');

    const ordered = new KinematicFusionEstimator();
    ordered.update(input(0, { barometricAltitude: 1_000 }));
    expect(() => ordered.update(input(0, { barometricAltitude: 1_001 }))).toThrow(
      'increase strictly',
    );
  });
});
