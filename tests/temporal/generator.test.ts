import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  DECLARED_TEMPORAL_FAULTS,
  generateTemporalScenario,
  getTemporalFaultDefinition,
} from '../../src/temporal/generator';
import type { TemporalFaultId, TemporalSensorId } from '../../src/temporal/types';

const EXPECTED_FAULTS: TemporalFaultId[] = [
  'gradual-drift',
  'noise-growth',
  'oscillation',
  'lag',
  'intermittent-dropout',
  'stuck-value',
  'gain-error',
  'fuel-leak',
  'cross-sensor-decoupling',
  'simultaneous-faults',
];

function expectNoNonfinite(value: unknown): void {
  if (typeof value === 'number') {
    expect(Number.isFinite(value)).toBe(true);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(expectNoNonfinite);
    return;
  }
  if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach(expectNoNonfinite);
  }
}

describe('seeded generic fixed-wing temporal scenarios', () => {
  it('declares every required fault with onset, duration, recovery, and target metadata', () => {
    expect(DECLARED_TEMPORAL_FAULTS.map(({ id }) => id)).toEqual(EXPECTED_FAULTS);
    for (const definition of DECLARED_TEMPORAL_FAULTS) {
      expect(definition.onsetFraction).toBeGreaterThan(0);
      expect(definition.durationFraction).toBeGreaterThan(0);
      expect(definition.recoveryFraction).toBeGreaterThan(0);
      expect(definition.targetSensors.length).toBeGreaterThan(0);
      expect(getTemporalFaultDefinition(definition.id)).toEqual(definition);
    }
    expect(getTemporalFaultDefinition('not-declared')).toBeUndefined();
  });

  it('is repeatable for the same seed and changes for a different seed', () => {
    const first = generateTemporalScenario({ seed: 42, scenarioId: 'gradual-drift' });
    const second = generateTemporalScenario({ seed: 42, scenarioId: 'gradual-drift' });
    const different = generateTemporalScenario({ seed: 43, scenarioId: 'gradual-drift' });
    expect(second).toEqual(first);
    expect(different.samples).not.toEqual(first.samples);
  });

  it('applies declared severity, duration, and onset-phase variation to generated data', () => {
    const nominal = generateTemporalScenario({ seed: 52, scenarioId: 'nominal' });
    const low = generateTemporalScenario({
      seed: 52,
      scenarioId: 'gradual-drift',
      severityScale: 0.65,
      durationScale: 0.75,
      onsetPhase: 'climb',
    });
    const high = generateTemporalScenario({
      seed: 52,
      scenarioId: 'gradual-drift',
      severityScale: 1.35,
      durationScale: 1.25,
      onsetPhase: 'descent',
    });

    expect(low.faultConfiguration).toEqual({
      severityScale: 0.65,
      durationScale: 0.75,
      onsetPhase: 'climb',
    });
    expect(high.faultConfiguration).toEqual({
      severityScale: 1.35,
      durationScale: 1.25,
      onsetPhase: 'descent',
    });
    expect(low.samples[low.faultTimeline!.onsetIndex]?.phaseTruth).toBe('climb');
    expect(high.samples[high.faultTimeline!.onsetIndex]?.phaseTruth).toBe('descent');
    expect(high.faultTimeline!.durationSamples).toBeGreaterThan(low.faultTimeline!.durationSamples);

    const maximumInjectedBias = (scenario: typeof low): number =>
      Math.max(
        ...scenario.samples.map((sample) => {
          const observed = sample.measurements.barometricAltitude;
          const baseline = nominal.samples[sample.sampleIndex]!.measurements.barometricAltitude;
          return observed === null || baseline === null ? 0 : Math.abs(observed - baseline);
        }),
      );
    expect(maximumInjectedBias(high)).toBeGreaterThan(maximumInjectedBias(low));
    expect(
      generateTemporalScenario({
        seed: 52,
        scenarioId: 'gradual-drift',
        severityScale: 1.35,
        durationScale: 1.25,
        onsetPhase: 'descent',
      }),
    ).toEqual(high);
  });

  it('keeps the original default fault behavior when no variation is requested', () => {
    const implicit = generateTemporalScenario({ seed: 61, scenarioId: 'oscillation' });
    const explicit = generateTemporalScenario({
      seed: 61,
      scenarioId: 'oscillation',
      severityScale: 1,
      durationScale: 1,
    });
    expect(explicit.samples).toEqual(implicit.samples);
    expect(explicit.faultTimeline).toEqual(implicit.faultTimeline);
    expect(implicit.faultConfiguration).toBeUndefined();
  });

  it('produces a fully labeled nominal mission without injected faults', () => {
    const scenario = generateTemporalScenario({ seed: 7, scenarioId: 'nominal' });
    expect(scenario.faultTimeline).toBeNull();
    expect(scenario.samples.every((sample) => sample.faultLabels.length === 0)).toBe(true);
    expect(new Set(scenario.samples.map(({ phaseTruth }) => phaseTruth))).toEqual(
      new Set(['ground', 'takeoff', 'climb', 'cruise', 'descent', 'landing']),
    );
    expect(scenario).toMatchObject({
      schemaVersion: 'temporal-synthetic.v1',
      profileId: 'generic-fixed-wing',
      synthetic: true,
      dataClassification: 'SYNTHETIC_UNCLASSIFIED',
    });
  });

  it.each(DECLARED_TEMPORAL_FAULTS)(
    'scenario $id labels its expected fault only and changes a target channel',
    (definition) => {
      const nominal = generateTemporalScenario({ seed: 91, scenarioId: 'nominal' });
      const scenario = generateTemporalScenario({ seed: 91, scenarioId: definition.id });
      const timeline = scenario.faultTimeline;
      expect(timeline).not.toBeNull();
      if (timeline === null) return;

      const labeled = scenario.samples.filter((sample) => sample.faultLabels.length > 0);
      const active = labeled.filter((sample) => sample.faultLabels[0]?.lifecycle === 'active');
      const recovering = labeled.filter(
        (sample) => sample.faultLabels[0]?.lifecycle === 'recovering',
      );
      expect(active).toHaveLength(timeline.durationSamples);
      expect(recovering).toHaveLength(timeline.recoverySamples);
      expect(
        new Set(labeled.flatMap((sample) => sample.faultLabels.map(({ faultId }) => faultId))),
      ).toEqual(new Set([definition.id]));
      expect(
        labeled.every((sample) =>
          sample.faultLabels.every(
            (label) =>
              label.onsetIndex === timeline.onsetIndex &&
              label.durationSamples === timeline.durationSamples &&
              label.recoverySamples === timeline.recoverySamples,
          ),
        ),
      ).toBe(true);

      const targets = new Set<TemporalSensorId>(definition.targetSensors);
      for (const sample of labeled) {
        for (const [sensorId, quality] of Object.entries(sample.quality)) {
          if (!targets.has(sensorId as TemporalSensorId)) expect(quality).toBe('nominal');
        }
      }

      const changedTarget = active.some((sample) => {
        const baseline = nominal.samples[sample.sampleIndex]!;
        return definition.targetSensors.some(
          (sensorId) => sample.measurements[sensorId] !== baseline.measurements[sensorId],
        );
      });
      expect(changedTarget).toBe(true);
    },
  );

  it.each(['nominal', ...EXPECTED_FAULTS] as const)(
    'scenario %s emits no nonfinite numeric output',
    (scenarioId) => {
      expectNoNonfinite(generateTemporalScenario({ seed: 13, scenarioId }));
    },
  );

  it('represents intermittent missing values with null and an explicit missing quality', () => {
    const scenario = generateTemporalScenario({ seed: 5, scenarioId: 'intermittent-dropout' });
    const missing = scenario.samples.filter((sample) => sample.measurements.gpsAltitude === null);
    expect(missing.length).toBeGreaterThan(0);
    expect(missing.every((sample) => sample.quality.gpsAltitude === 'missing')).toBe(true);
  });

  it('validates seed, sample count, cadence, time, and scenario ID', () => {
    expect(() => generateTemporalScenario({ seed: 1.5 })).toThrow('integer');
    expect(() => generateTemporalScenario({ seed: 0 })).toThrow('positive integer');
    expect(() => generateTemporalScenario({ seed: -1 })).toThrow('positive integer');
    expect(() => generateTemporalScenario({ seed: 2_147_483_648 })).toThrow('positive integer');
    expect(() => generateTemporalScenario({ seed: 1, sampleCount: 59 })).toThrow('60 samples');
    expect(() => generateTemporalScenario({ seed: 1, cadenceMs: 99 })).toThrow('at least 100');
    expect(() => generateTemporalScenario({ seed: 1, startedAt: 'invalid' })).toThrow('valid');
    expect(() =>
      generateTemporalScenario({ seed: 1, scenarioId: 'not-declared' as TemporalFaultId }),
    ).toThrow('Unknown temporal fault');
    expect(() =>
      generateTemporalScenario({ seed: 1, scenarioId: 'gradual-drift', severityScale: 0.49 }),
    ).toThrow('severityScale');
    expect(() =>
      generateTemporalScenario({
        seed: 1,
        scenarioId: 'gradual-drift',
        severityScale: Number.NaN,
      }),
    ).toThrow('severityScale');
    expect(() =>
      generateTemporalScenario({ seed: 1, scenarioId: 'gradual-drift', durationScale: 1.51 }),
    ).toThrow('durationScale');
    expect(() =>
      generateTemporalScenario({
        seed: 1,
        scenarioId: 'gradual-drift',
        onsetPhase: 'unsupported' as never,
      }),
    ).toThrow('onset phase');
    expect(() => generateTemporalScenario({ seed: 1, severityScale: 1 })).toThrow(
      'Nominal temporal scenarios',
    );
  });

  it('preserves deterministic timing and finite-output invariants across randomized valid faults', () => {
    fc.assert(
      fc.property(
        fc.record({
          seed: fc.integer({ min: 1, max: 2_147_483_647 }),
          scenarioId: fc.constantFrom(...EXPECTED_FAULTS),
          severityScale: fc.double({ min: 0.5, max: 1.5, noNaN: true }),
          durationScale: fc.double({ min: 0.5, max: 1.5, noNaN: true }),
          onsetPhase: fc.constantFrom('climb', 'cruise', 'descent'),
        }),
        (configuration) => {
          const scenario = generateTemporalScenario({
            ...configuration,
            sampleCount: 180,
            cadenceMs: 1_000,
            startedAt: '2026-07-17T00:00:00.000Z',
          });
          const repeated = generateTemporalScenario({
            ...configuration,
            sampleCount: 180,
            cadenceMs: 1_000,
            startedAt: '2026-07-17T00:00:00.000Z',
          });

          expect(repeated).toEqual(scenario);
          expect(scenario.samples).toHaveLength(180);
          expect(scenario.faultTimeline).not.toBeNull();
          expect(scenario.samples[scenario.faultTimeline!.onsetIndex]?.phaseTruth).toBe(
            configuration.onsetPhase,
          );
          expect(scenario.faultTimeline!.recoveryEndIndex).toBeLessThan(scenario.samples.length);
          for (let index = 1; index < scenario.samples.length; index += 1) {
            expect(
              scenario.samples[index]!.timestampMs - scenario.samples[index - 1]!.timestampMs,
            ).toBe(1_000);
          }
          expectNoNonfinite(scenario);
        },
      ),
      { numRuns: 40, seed: 20_260_717 },
    );
  });
});
