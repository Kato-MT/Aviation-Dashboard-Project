import { projectInvestigationScenario } from '../../src/investigation/modelProjection';
import { extractTemporalFeatures } from '../../src/ml/temporalModel';
import type { TemporalMeasurements, TemporalScenario } from '../../src/temporal/types';

type Pair = readonly [keyof TemporalMeasurements, keyof TemporalMeasurements, string];
const PAIRS: Pair[] = [
  ['barometricAltitude', 'gpsAltitude', 'altitude-disagreement'],
  ['indicatedAirspeed', 'gpsGroundSpeed', 'speed-disagreement'],
  ['inertialVerticalRate', 'barometricVerticalRate', 'rate-disagreement'],
];
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const mean = (a: readonly number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const rms = (a: readonly number[]) => Math.sqrt(mean(a.map((v) => v * v)));
const std = (a: readonly number[]) => {
  const m = mean(a);
  return rms(a.map((v) => v - m));
};
const range = (a: readonly number[]) => (a.length ? Math.max(...a) - Math.min(...a) : 0);

/** Only observed values enter the supplemental encoder. No quality, truth, seed or phase. */
export function recentFeatures(observed: readonly TemporalMeasurements[]) {
  if (observed.length !== 40) throw new Error('Recent features require40 causal observations.');
  const recent = observed.slice(-5),
    names: string[] = [],
    values: number[] = [];
  for (const [left, right, name] of PAIRS) {
    const differences = recent.flatMap((m) =>
      finite(m[left]) && finite(m[right]) ? [m[left] - m[right]] : [],
    );
    const end = recent.at(-1)!;
    names.push(`${name}.current-absolute`, `${name}.mean5`, `${name}.rms5`, `${name}.missing5`);
    values.push(
      finite(end[left]) && finite(end[right]) ? Math.abs(end[left] - end[right]) : 0,
      mean(differences),
      rms(differences),
      1 - differences.length / 5,
    );
  }
  const flow = recent.flatMap((m) => (finite(m.fuelFlow) ? [m.fuelFlow] : []));
  const fuel = recent.map((m) => m.fuelQuantity);
  names.push(
    'fuel-flow.mean5',
    'fuel-flow.missing5',
    'fuel.decline5',
    'barometric-altitude.range5',
    'gps-altitude.range5',
    'vibration.std5',
  );
  values.push(
    mean(flow),
    1 - flow.length / 5,
    finite(fuel[0]) && finite(fuel[4]) ? (fuel[0] - fuel[4]) / 4 : 0,
    range(recent.flatMap((m) => (finite(m.barometricAltitude) ? [m.barometricAltitude] : []))),
    range(recent.flatMap((m) => (finite(m.gpsAltitude) ? [m.gpsAltitude] : []))),
    std(recent.flatMap((m) => (finite(m.vibration) ? [m.vibration] : []))),
  );
  // Compare raw redundant speed sensors over20 samples instead of the fused speed.
  const speed = observed.slice(-20);
  const zero = speed.flatMap((m) =>
    finite(m.indicatedAirspeed) && finite(m.gpsGroundSpeed)
      ? [m.indicatedAirspeed - m.gpsGroundSpeed]
      : [],
  );
  const lagErrors = Array.from({ length: 7 }, (_, j) => {
    const lag = j - 3;
    const differences = speed.flatMap((m, i) => {
      const other = speed[i + lag];
      return other && finite(m.indicatedAirspeed) && finite(other.gpsGroundSpeed)
        ? [m.indicatedAirspeed - other.gpsGroundSpeed]
        : [];
    });
    return differences.length >= 2 ? rms(differences) : Infinity;
  });
  const best = Math.min(...lagErrors);
  const bestOffset = Number.isFinite(best)
    ? lagErrors
        .map((error, i) => ({ error, offset: i - 3 }))
        .filter((v) => v.error === best)
        .sort((a, b) => Math.abs(a.offset) - Math.abs(b.offset) || a.offset - b.offset)[0]!.offset
    : 0;
  names.push('speed-disagreement.mean20', 'speed-lag.best-offset20', 'speed-lag.rms-improvement20');
  values.push(
    mean(zero),
    bestOffset,
    Number.isFinite(best) && zero.length >= 2 ? rms(zero) - best : 0,
  );
  return { names, values };
}

export function fullMissionFeatures(scenario: TemporalScenario) {
  const projected = projectInvestigationScenario(scenario).map((p) => p.modelSample);
  const measurements = scenario.samples.map((s) => s.measurements);
  let names: string[] = [];
  const rows = projected.slice(39).map((_, i) => {
    const original = extractTemporalFeatures(projected.slice(i, i + 40));
    const recent = recentFeatures(measurements.slice(i, i + 40));
    names = [...original.names, ...recent.names];
    const values = [...original.values, ...recent.values];
    if (values.some((v) => !finite(v))) throw new Error('Nonfinite full-mission features.');
    return values;
  });
  return { names, rows };
}

export function resolution(name: string): number {
  if (name.endsWith('.missing5')) return 1 / 5;
  if (name.endsWith('.missing-fraction')) return 1 / 40;
  if (name.endsWith('.freeze-ratio')) return 1 / 39;
  if (name.includes('best-lag') || name.includes('best-offset')) return 1;
  return 0.001;
}
