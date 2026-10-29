import type { PredictionPoint } from '../../src/mission-evaluation';

export interface Setting {
  id: string;
  generalThreshold: number;
  lagThreshold: number;
}
export const SETTINGS: readonly Setting[] = [0.9, 0.95].flatMap((generalThreshold) =>
  [0.65, 0.7].map((lagThreshold) => ({
    id: `adaptive-${generalThreshold}-${lagThreshold}`,
    generalThreshold,
    lagThreshold,
  })),
);
export interface LagSupport {
  value: number | null;
  validFraction: number;
}
export function validateSetting(setting: Setting) {
  if (
    !SETTINGS.some(
      (s) =>
        s.id === setting.id &&
        s.generalThreshold === setting.generalThreshold &&
        s.lagThreshold === setting.lagThreshold,
    )
  )
    throw new Error('Setting is outside the frozen four-policy grid.');
}
export function applyPolicy(
  points: readonly PredictionPoint[],
  scores: readonly number[],
  lag: readonly LagSupport[],
  setting: Setting,
): PredictionPoint[] {
  validateSetting(setting);
  if (
    points.length !== 180 ||
    scores.length !== 141 ||
    lag.length !== 141 ||
    scores.some((v) => !Number.isFinite(v) || v < 0 || v > 1) ||
    lag.some(
      (v) =>
        (v.value !== null && !Number.isFinite(v.value)) ||
        !Number.isFinite(v.validFraction) ||
        v.validFraction < 0 ||
        v.validFraction > 1,
    ) ||
    points.some(
      (p) => !['warmup', 'nominal', 'anomalous', 'abstained', 'unavailable'].includes(p.modelState),
    )
  )
    throw new Error('Invalid adaptive-policy input.');
  return points.map((p, i) => {
    if (i < 39) return { ...p, modelState: 'warmup' };
    if (['warmup', 'abstained', 'unavailable'].includes(p.modelState)) return { ...p };
    const score = scores[i - 39]!,
      evidence = lag[i - 39]!;
    const sensitive =
      evidence.value !== null && evidence.value > 0 && evidence.validFraction >= 8 / 17;
    const alert = score > setting.generalThreshold || (sensitive && score > setting.lagThreshold);
    return { ...p, modelState: alert ? 'anomalous' : 'nominal' };
  });
}
