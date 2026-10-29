import { evaluateMission } from '../../src/mission-evaluation';
import { generateTemporalScenario } from '../../src/temporal/generator';
import { hashObject } from '../mission-evaluation/protocol';
import type { Artifact as Incumbent } from '../full-mission-model/model';
import type { Artifact } from '../residual-lag/model';
import { currentNoiseCruiseLag, lagEvidence } from '../residual-lag/features';
import {
  infer as parentInfer,
  compare as parentCompare,
  type RecordResult,
  type ExperimentCase,
} from '../residual-lag/evaluate';
import { applyPolicy, type Setting } from './policy';
import { PROTOCOL } from './protocol';
export { addControl, cases } from '../residual-lag/evaluate';
export type { RecordResult, ExperimentCase } from '../residual-lag/evaluate';

export function infer(
  spec: ExperimentCase,
  artifact: Artifact,
  incumbent: Incumbent,
  choices: readonly Setting[],
) {
  const result = parentInfer(spec, artifact, incumbent, [
    { id: 'lag-baseline', modelId: 'targeted', threshold: 0.7 },
    { id: 'strict-high', modelId: 'targeted', threshold: 0.95 },
  ]);
  const scenario =
    spec.stream === 'current-noise'
      ? currentNoiseCruiseLag(spec)
      : generateTemporalScenario(spec.options);
  if (hashObject(scenario) !== result.record.scenarioSha256)
    throw new Error('Scenario regeneration mismatch.');
  const measurements = scenario.samples.map((s) => s.measurements);
  const lag = result.scores.targeted!.map((_, i) => lagEvidence(measurements.slice(i, i + 40)));
  for (const setting of choices) {
    const trace = applyPolicy(
      result.predictions['lag-baseline']!,
      result.scores.targeted!,
      lag,
      setting,
    );
    result.predictions[setting.id] = trace;
    result.record.predictionSha256[setting.id] = hashObject(trace);
    result.record.evaluations[setting.id] = evaluateMission(
      {
        caseId: spec.caseId,
        seed: spec.options.seed,
        family: spec.family,
        variantId: spec.variantId,
        cadenceMs: 1000,
        faultTimeline: scenario.faultTimeline,
        predictions: trace,
      },
      ['model-k1'],
    );
  }
  return { ...result, lag };
}
export type Inference = ReturnType<typeof infer>;
function statistics(records: readonly RecordResult[], setting: Setting, baseline: string) {
  const { ordinary, confirmed, cruise, challenge } = parentCompare(
    records,
    { id: setting.id, modelId: 'targeted', threshold: setting.generalThreshold },
    baseline,
  );
  return { ordinary, confirmed, cruise, challenge };
}
export function compare(records: readonly RecordResult[], setting: Setting) {
  const versusTarget = statistics(records, setting, 'lag-baseline');
  const versusIncumbent = statistics(records, setting, 'incumbent');
  const preservationReasons: string[] = [];
  for (const [label, stats] of [
    ['lag-sensitive target', versusTarget],
    ['earlier forest', versusIncumbent],
  ] as const) {
    preservationReasons.push(...stats.ordinary.constraints.reasons.map((s) => `${label}: ${s}`));
    const c = stats.confirmed;
    if (c.recallGain === null || c.recallGain < -PROTOCOL.limits.overallRecallDrop - 1e-12)
      preservationReasons.push(
        `${label}: overall confirmed recall loss exceeds two points or is undefined.`,
      );
    if (
      Object.values(c.perFamilyRecallGain).some(
        (v) => v === null || v < -PROTOCOL.limits.familyRecallDrop - 1e-12,
      )
    )
      preservationReasons.push(
        `${label}: a confirmed family loss exceeds five points or is undefined.`,
      );
    if (c.p95AddedDelayMs === null || c.p95AddedDelayMs > PROTOCOL.limits.pairedP95AddedDelayMs)
      preservationReasons.push(
        `${label}: confirmed paired p95 added delay exceeds five seconds or is undefined.`,
      );
  }
  for (const key of ['cruise', 'challenge'] as const) {
    const target = versusTarget[key],
      previous = versusIncumbent[key];
    if (target.recallGain === null || target.recallGain < -1e-12)
      preservationReasons.push(
        `${key}: confirmed point recall falls below the lag-sensitive target or is undefined.`,
      );
    if (
      target.recallGainInterval.lower === null ||
      target.recallGainInterval.lower < PROTOCOL.limits.cruiseIntervalLowerBound - 1e-12
    )
      preservationReasons.push(
        `${key}: paired preservation lower bound is below minus five points or undefined.`,
      );
    if (
      target.p95AddedDelayMs === null ||
      target.p95AddedDelayMs > PROTOCOL.limits.pairedP95AddedDelayMs
    )
      preservationReasons.push(
        `${key}: confirmed paired p95 added delay exceeds five seconds or is undefined.`,
      );
    if (
      previous.recallGain === null ||
      previous.recallGain < PROTOCOL.limits.legacyCruiseGain - 1e-12 ||
      previous.recallGainInterval.lower === null ||
      previous.recallGainInterval.lower <= 0
    )
      preservationReasons.push(
        `${key}: ten-point gain over the earlier forest lacks positive paired support.`,
      );
  }
  const reasons = [...preservationReasons];
  const a = versusTarget.ordinary.baseline.nominalFalseAlarmRate,
    b = versusTarget.ordinary.candidate.nominalFalseAlarmRate;
  if (
    a === null ||
    b === null ||
    b >= a ||
    versusTarget.ordinary.confidence.nominalFalseAlarmRateDelta!.upper === null ||
    versusTarget.ordinary.confidence.nominalFalseAlarmRateDelta!.upper! >= 0
  )
    reasons.push(
      'Nominal reduction versus the lag-sensitive target lacks a strictly negative paired confidence bound.',
    );
  return {
    setting,
    versusTarget,
    versusIncumbent,
    preservationReasons,
    reasons,
    passed: reasons.length === 0,
    decision: reasons.length ? 'rejected' : 'improved',
  };
}
export type Comparison = ReturnType<typeof compare>;
export function select(comparisons: readonly Comparison[]) {
  if (!comparisons.length) throw new Error('No candidate comparisons.');
  const passing = comparisons.filter((c) => c.passed),
    preserving = comparisons.filter((c) => !c.preservationReasons.length);
  const pool = passing.length ? passing : preserving.length ? preserving : comparisons;
  const cruise = (c: Comparison) =>
    Math.min(
      c.versusTarget.cruise.candidate.recall ?? -1,
      c.versusTarget.challenge.candidate.recall ?? -1,
    );
  return [...pool].sort(
    (a, b) =>
      (a.versusTarget.ordinary.candidate.nominalFalseAlarmRate ?? Infinity) -
        (b.versusTarget.ordinary.candidate.nominalFalseAlarmRate ?? Infinity) ||
      cruise(b) - cruise(a) ||
      (b.versusTarget.confirmed.candidate.recall ?? -1) -
        (a.versusTarget.confirmed.candidate.recall ?? -1) ||
      b.setting.generalThreshold - a.setting.generalThreshold ||
      b.setting.lagThreshold - a.setting.lagThreshold,
  )[0]!;
}
