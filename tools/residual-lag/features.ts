import type { TemporalMeasurements, TemporalScenario } from '../../src/temporal/types';
import { generateTemporalScenario } from '../../src/temporal/generator';
import type { MissionCase } from '../mission-evaluation/protocol';
import {
  fullMissionFeatures as originalFeatures,
  resolution as originalResolution,
} from '../full-mission-model/features';

const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const pairs = [
  ['barometricAltitude', 'gpsAltitude', 'altitude'],
  ['indicatedAirspeed', 'gpsGroundSpeed', 'speed'],
  ['inertialVerticalRate', 'barometricVerticalRate', 'rate'],
] as const;

/** Signed loss improvement on identical supports. Centered smoothing is wholly inside the causal window. */
export function lagEvidence(observed: readonly TemporalMeasurements[]) {
  if (observed.length !== 40) throw new Error('Lag evidence requires40 observations.');
  const smooth = observed.map((_, i) => {
    if (i < 3 || i > 36) return null;
    const values = observed.slice(i - 3, i + 4).map((m) => m.gpsGroundSpeed);
    return values.every(finite) ? values.reduce((s, v) => s + v, 0) / 7 : null;
  });
  let improvement = 0,
    energy = 0,
    valid = 0;
  for (let i = 20; i <= 36; i++) {
    const current = smooth[i],
      delayed = smooth[i - 3],
      airspeed = observed[i]!.indicatedAirspeed;
    if (!finite(current) || !finite(delayed) || !finite(airspeed)) continue;
    const delta = current - delayed,
      residual = airspeed - current;
    improvement += -2 * residual * delta - delta * delta;
    energy += delta * delta;
    valid++;
  }
  return {
    value: valid >= 8 ? improvement / Math.sqrt(Math.max(energy, 1e-9)) : 0,
    validFraction: valid / 17,
  };
}

export function contextFeatures(observed: readonly TemporalMeasurements[]) {
  if (observed.length !== 40) throw new Error('Context features require40 observations.');
  const names: string[] = [],
    values: number[] = [];
  for (const [a, b, label] of pairs) {
    const residuals = observed
      .slice(-15)
      .flatMap((m) => (finite(m[a]) && finite(m[b]) ? [m[a] - m[b]] : []));
    names.push(
      `${label}-disagreement.mean15`,
      `${label}-disagreement.rms15`,
      `${label}-disagreement.missing15`,
    );
    values.push(
      residuals.length ? residuals.reduce((s, x) => s + x, 0) / residuals.length : 0,
      residuals.length ? Math.sqrt(residuals.reduce((s, x) => s + x * x, 0) / residuals.length) : 0,
      1 - residuals.length / 15,
    );
  }
  const lag = lagEvidence(observed);
  names.push('speed-lag.signed-smoothed-evidence', 'speed-lag.valid-support-fraction');
  values.push(lag.value, lag.validFraction);
  return { names, values };
}

export function fullMissionFeatures(scenario: TemporalScenario) {
  const original = originalFeatures(scenario),
    observations = scenario.samples.map((s) => s.measurements);
  let addedNames: string[] = [];
  const rows = original.rows.map((row, i) => {
    const extra = contextFeatures(observations.slice(i, i + 40));
    addedNames = extra.names;
    const values = [...row, ...extra.values];
    if (values.some((v) => !finite(v))) throw new Error('Nonfinite context features.');
    return values;
  });
  return { names: [...original.names, ...addedNames], rows };
}

export function resolution(name: string) {
  if (name.endsWith('.missing15')) return 1 / 15;
  if (name.endsWith('.valid-support-fraction')) return 1 / 17;
  return originalResolution(name);
}

/** Evaluation-only injection removes historical-noise replay. Truth is used here, never by the encoder. */
export function currentNoiseCruiseLag(spec: MissionCase): TemporalScenario {
  if (
    spec.family !== 'lag' ||
    spec.variantId !== 'standard-cruise' ||
    spec.options.severityScale !== 1 ||
    spec.options.scenarioId !== 'lag' ||
    spec.options.durationScale !== 1 ||
    spec.options.onsetPhase !== 'cruise'
  )
    throw new Error('Challenge requires standard-cruise lag.');
  const fault = generateTemporalScenario(spec.options),
    nominal = generateTemporalScenario({
      seed: spec.options.seed,
      sampleCount: spec.options.sampleCount,
      cadenceMs: spec.options.cadenceMs,
      startedAt: spec.options.startedAt,
      scenarioId: 'nominal',
    });
  const timeline = fault.faultTimeline!;
  for (let i = timeline.onsetIndex; i <= timeline.recoveryEndIndex; i++) {
    const envelope =
      i <= timeline.activeEndIndex
        ? 1
        : Math.max(0, 1 - (i - timeline.activeEndIndex) / timeline.recoverySamples);
    const current = nominal.samples[i]!,
      previous = nominal.samples[i - 3]!;
    if (!finite(current.measurements.indicatedAirspeed))
      throw new Error('Missing challenge baseline.');
    fault.samples[i]!.measurements.indicatedAirspeed =
      current.measurements.indicatedAirspeed +
      envelope * (previous.truth.speed - current.truth.speed);
  }
  return fault;
}
