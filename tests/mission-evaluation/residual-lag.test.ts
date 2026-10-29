import { describe, expect, it } from 'vitest';
import { generateTemporalScenario } from '../../src/temporal/generator';
import type { TemporalMeasurements } from '../../src/temporal/types';
import { fullMissionFeatures as originalFeatures } from '../../tools/full-mission-model/features';
import { casesForSeeds } from '../../tools/mission-evaluation/protocol';
import {
  contextFeatures,
  currentNoiseCruiseLag,
  fullMissionFeatures,
  lagEvidence,
  resolution,
} from '../../tools/residual-lag/features';

function measurements(index: number): TemporalMeasurements {
  return {
    indicatedAirspeed: 10 + 2 * index,
    gpsGroundSpeed: 10 + 2 * index,
    barometricAltitude: 100,
    gpsAltitude: 100,
    inertialVerticalRate: 2,
    barometricVerticalRate: 2,
    fuelQuantity: 100,
    fuelFlow: 2,
    vibration: 0,
  };
}

const ramp = () => Array.from({ length: 40 }, (_, index) => measurements(index));

function mappedContext(observed: readonly TemporalMeasurements[]) {
  const { names, values } = contextFeatures(observed);
  return Object.fromEntries(names.map((name, index) => [name, values[index]!]));
}

describe('causal residual and signed lag features', () => {
  it('TC-RL-001 gives opposite equal lag evidence for synchronous and three-sample-delayed ramps', () => {
    const synchronous = ramp();
    const delayed = synchronous.map((sample) => ({
      ...sample,
      indicatedAirspeed: sample.indicatedAirspeed! - 6,
    }));
    // Each of 17 comparisons changes the GPS reference by 6. Loss change is +/-36.
    expect(lagEvidence(synchronous).value).toBeCloseTo(-6 * Math.sqrt(17), 12);
    expect(lagEvidence(delayed).value).toBeCloseTo(6 * Math.sqrt(17), 12);
    expect(lagEvidence(synchronous).validFraction).toBe(1);
    expect(lagEvidence(delayed).validFraction).toBe(1);
    const flat = synchronous.map((sample) => ({
      ...sample,
      indicatedAirspeed: 100,
      gpsGroundSpeed: 100,
    }));
    expect(lagEvidence(flat)).toEqual({ value: 0, validFraction: 1 });
    expect(() => lagEvidence(synchronous.slice(1))).toThrow(/40/);
    expect(() => lagEvidence([...synchronous, synchronous[0]!])).toThrow(/40/);
  });

  it('TC-RL-002 excludes both smoothing supports together and requires at least eight valid comparisons', () => {
    const eight = ramp();
    // Missing GPS22 invalidates comparison indices20..28; only29..36 remain.
    eight[22]!.gpsGroundSpeed = null;
    expect(lagEvidence(eight).validFraction).toBe(8 / 17);
    expect(lagEvidence(eight).value).toBeCloseTo(-6 * Math.sqrt(8), 12);
    const seven = ramp();
    // Missing GPS23 invalidates20..29, leaving seven comparisons.
    seven[23]!.gpsGroundSpeed = null;
    expect(lagEvidence(seven)).toEqual({ value: 0, validFraction: 7 / 17 });
    const missingCurrent = ramp();
    missingCurrent[20]!.indicatedAirspeed = Number.NaN;
    missingCurrent[36]!.indicatedAirspeed = null;
    expect(lagEvidence(missingCurrent).validFraction).toBe(15 / 17);
    expect(lagEvidence(missingCurrent).value).toBeCloseTo(-6 * Math.sqrt(15), 12);
    const missingReference = ramp().map((sample) => ({ ...sample, gpsGroundSpeed: null }));
    expect(lagEvidence(missingReference)).toEqual({ value: 0, validFraction: 0 });
  });

  it('TC-RL-003 uses GPS through the current endpoint without treating endpoint IAS as an earlier reading', () => {
    const observed = ramp();
    const irrelevant = structuredClone(observed);
    for (let i = 0; i < 14; i++) irrelevant[i]!.gpsGroundSpeed = Number.NaN;
    for (let i = 37; i < 40; i++) irrelevant[i]!.indicatedAirspeed = 100_000;
    expect(lagEvidence(irrelevant)).toEqual(lagEvidence(observed));
    observed[39]!.gpsGroundSpeed! += 7;
    // Only GPS centered at36 changes by1. Its loss change is -35, energy49;
    // the other16 comparisons retain loss change-36 and energy36.
    expect(lagEvidence(observed).value).toBeCloseTo((-36 * 16 - 35) / 25, 12);
    expect(lagEvidence(observed).validFraction).toBe(1);
    observed[39]!.gpsGroundSpeed = Number.POSITIVE_INFINITY;
    expect(lagEvidence(observed).validFraction).toBe(16 / 17);
    expect(lagEvidence(observed).value).toBeCloseTo(-6 * Math.sqrt(16), 12);
  });

  it('TC-RL-004 computes signed fifteen-sample residual summaries on valid sensor pairs', () => {
    const observed = ramp();
    for (let i = 0; i < 25; i++) observed[i]!.barometricAltitude = 100_000;
    for (let i = 25; i < 40; i++) {
      observed[i]!.barometricAltitude = 100 + i - 24;
      observed[i]!.inertialVerticalRate = 6;
      observed[i]!.barometricVerticalRate = 2;
      observed[i]!.indicatedAirspeed = observed[i]!.gpsGroundSpeed! - 2;
    }
    const before = structuredClone(observed);
    const encoded = contextFeatures(observed);
    expect(encoded.names).toHaveLength(11);
    expect(new Set(encoded.names).size).toBe(11);
    expect(encoded.values.every(Number.isFinite)).toBe(true);
    const values = mappedContext(observed);
    expect(values['altitude-disagreement.mean15']).toBe(8);
    expect(values['altitude-disagreement.rms15']).toBeCloseTo(Math.sqrt(248 / 3), 12);
    expect(values['altitude-disagreement.missing15']).toBe(0);
    expect(values['speed-disagreement.mean15']).toBe(-2);
    expect(values['speed-disagreement.rms15']).toBe(2);
    expect(values['rate-disagreement.mean15']).toBe(4);
    expect(values['rate-disagreement.rms15']).toBe(4);
    expect(observed).toEqual(before);
    observed[39]!.gpsAltitude = null;
    const partial = mappedContext(observed);
    expect(partial['altitude-disagreement.mean15']).toBe(7.5);
    expect(partial['altitude-disagreement.rms15']).toBeCloseTo(Math.sqrt(72.5), 12);
    expect(partial['altitude-disagreement.missing15']).toBeCloseTo(1 / 15, 12);
    const allMissing = observed.map((sample) => ({
      ...sample,
      indicatedAirspeed: null,
      gpsGroundSpeed: null,
      barometricAltitude: null,
      inertialVerticalRate: Number.NaN,
    }));
    const empty = mappedContext(allMissing);
    for (const pair of ['altitude', 'speed', 'rate']) {
      expect(empty[pair + '-disagreement.mean15']).toBe(0);
      expect(empty[pair + '-disagreement.rms15']).toBe(0);
      expect(empty[pair + '-disagreement.missing15']).toBe(1);
    }
    expect(empty['speed-lag.signed-smoothed-evidence']).toBe(0);
    expect(empty['speed-lag.valid-support-fraction']).toBe(0);
    expect(() => contextFeatures(observed.slice(1))).toThrow(/40/);
    expect(resolution('altitude-disagreement.missing15')).toBe(1 / 15);
    expect(resolution('speed-lag.valid-support-fraction')).toBe(1 / 17);
    expect(resolution('speed-lag.best-offset20')).toBe(1);
    expect(resolution('speed-lag.signed-smoothed-evidence')).toBe(0.001);
  });

  it('TC-RL-005 appends eleven finite features without letting truth labels or future observations enter inference', () => {
    const scenario = generateTemporalScenario({
      seed: 81_001,
      scenarioId: 'intermittent-dropout',
      sampleCount: 180,
    });
    const before = structuredClone(scenario);
    const encoded = fullMissionFeatures(scenario);
    const original = originalFeatures(scenario);
    expect(encoded.names).toHaveLength(83);
    expect(new Set(encoded.names).size).toBe(83);
    expect(encoded.rows).toHaveLength(141);
    expect(encoded.rows.every((row) => row.length === 83 && row.every(Number.isFinite))).toBe(true);
    expect(encoded.names.slice(0, 72)).toEqual(original.names);
    expect(encoded.rows.map((row) => row.slice(0, 72))).toEqual(original.rows);
    expect(encoded.rows[0]!.slice(72)).toEqual(
      contextFeatures(scenario.samples.slice(0, 40).map((sample) => sample.measurements)).values,
    );
    expect(encoded.rows[140]!.slice(72)).toEqual(
      contextFeatures(scenario.samples.slice(140, 180).map((sample) => sample.measurements)).values,
    );
    expect(scenario).toEqual(before);
    const relabeled = structuredClone(scenario);
    relabeled.scenarioId = 'nominal';
    relabeled.seed = 81_002;
    relabeled.faultTimeline = null;
    for (const sample of relabeled.samples) {
      sample.phaseTruth = 'landing';
      sample.faultLabels = [];
      sample.truth = {
        speed: 999,
        altitude: 999_999,
        verticalRate: 999,
        fuel: 999,
        fuelFlow: 999,
        vibration: 999,
      };
      for (const key of Object.keys(sample.quality) as (keyof TemporalMeasurements)[])
        sample.quality[key] = 'missing';
    }
    expect(fullMissionFeatures(relabeled)).toEqual(encoded);
    const future = structuredClone(scenario);
    for (const sample of future.samples.slice(100)) {
      sample.measurements.gpsGroundSpeed = 900;
      sample.measurements.indicatedAirspeed = null;
      sample.measurements.barometricAltitude = 100_000;
    }
    const changed = fullMissionFeatures(future);
    // Rows0..60 end at samples39..99. Centered GPS smoothing may use only those endpoints.
    expect(changed.rows.slice(0, 61)).toEqual(encoded.rows.slice(0, 61));
    expect(changed.rows[61]).not.toEqual(encoded.rows[61]);
  });
});

describe('evaluation-only current-noise cruise-lag challenge', () => {
  it('TC-RL-006 delays latent speed while preserving present measurement noise and the original generator', () => {
    const spec = casesForSeeds([81_003]).find(
      (candidate) => candidate.family === 'lag' && candidate.variantId === 'standard-cruise',
    )!;
    const input = structuredClone(spec);
    const original = generateTemporalScenario(spec.options);
    const nominal = generateTemporalScenario({
      seed: spec.options.seed,
      sampleCount: spec.options.sampleCount,
      cadenceMs: spec.options.cadenceMs,
      startedAt: spec.options.startedAt,
      scenarioId: 'nominal',
    });
    const challenge = currentNoiseCruiseLag(spec);
    const timeline = original.faultTimeline!;
    expect(challenge.faultTimeline).toEqual(timeline);
    expect(challenge.faultConfiguration).toEqual(original.faultConfiguration);
    expect(challenge.samples).toHaveLength(180);
    expect(challenge.cadenceMs).toBe(1000);
    let observedDifferentNoise = false;
    for (let index = 0; index < challenge.samples.length; index++) {
      const actual = challenge.samples[index]!;
      const baseline = nominal.samples[index]!;
      const primary = original.samples[index]!;
      expect({
        ...actual.measurements,
        indicatedAirspeed: primary.measurements.indicatedAirspeed,
      }).toEqual(primary.measurements);
      expect({ ...actual, measurements: primary.measurements }).toEqual(primary);
      if (index < timeline.onsetIndex || index > timeline.recoveryEndIndex) {
        expect(actual).toEqual(primary);
        continue;
      }
      const envelope =
        index <= timeline.activeEndIndex
          ? 1
          : 1 - (index - timeline.activeEndIndex) / timeline.recoverySamples;
      const shiftedLatent =
        baseline.truth.speed +
        envelope * (nominal.samples[index - 3]!.truth.speed - baseline.truth.speed);
      const presentNoise = baseline.measurements.indicatedAirspeed! - baseline.truth.speed;
      expect(actual.measurements.indicatedAirspeed! - shiftedLatent).toBeCloseTo(presentNoise, 10);
      if (index <= timeline.activeEndIndex) {
        // Primary lag replays the historical sensor noise as well as the latent delay.
        expect(primary.measurements.indicatedAirspeed).toBe(
          nominal.samples[index - 3]!.measurements.indicatedAirspeed,
        );
        if (
          Math.abs(
            actual.measurements.indicatedAirspeed! - primary.measurements.indicatedAirspeed!,
          ) > 1e-6
        )
          observedDifferentNoise = true;
      }
    }
    expect(observedDifferentNoise).toBe(true);
    expect(challenge.samples[timeline.recoveryEndIndex]!.measurements.indicatedAirspeed).toBe(
      nominal.samples[timeline.recoveryEndIndex]!.measurements.indicatedAirspeed,
    );
    expect(currentNoiseCruiseLag(spec)).toEqual(challenge);
    expect(generateTemporalScenario(spec.options)).toEqual(original);
    expect(spec).toEqual(input);
  });

  it('TC-RL-007 rejects a challenge whose declared variant disagrees with its generating options', () => {
    const spec = casesForSeeds([81_004]).find(
      (candidate) => candidate.family === 'lag' && candidate.variantId === 'standard-cruise',
    )!;
    expect(() => currentNoiseCruiseLag({ ...spec, family: 'nominal' })).toThrow();
    expect(() => currentNoiseCruiseLag({ ...spec, variantId: 'default' })).toThrow();
    for (const options of [
      { ...spec.options, scenarioId: 'nominal' as const },
      { ...spec.options, scenarioId: 'stuck-value' as const },
      { ...spec.options, onsetPhase: 'climb' as const },
      { ...spec.options, durationScale: 0.75 },
      { ...spec.options, severityScale: 0.65 },
    ])
      expect(() => currentNoiseCruiseLag({ ...spec, options })).toThrow();
  });
});
