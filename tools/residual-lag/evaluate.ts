import { analyzeTemporalScenario } from '../../src/investigation/analyze';
import {
  evaluateMission,
  extractPredictions,
  type MissionEvaluationResult,
  type PredictionPoint,
} from '../../src/mission-evaluation';
import { generateTemporalScenario } from '../../src/temporal/generator';
import { casesForSeeds, hashObject, type MissionCase } from '../mission-evaluation/protocol';
import {
  scoreFeatures as incumbentScore,
  type Artifact as Incumbent,
} from '../full-mission-model/model';
import {
  compareSpecific,
  faultSpecific,
  type SpecificResult,
} from '../full-mission-model/specificity';
import { compareDetectors } from '../nominal-correction/compare';
import { currentNoiseCruiseLag, fullMissionFeatures } from './features';
import { score, type Artifact, type ModelId } from './model';
import { PROTOCOL } from './protocol';

export interface Setting {
  id: string;
  modelId: ModelId;
  threshold: number;
}
export interface ExperimentCase extends MissionCase {
  stream: 'primary' | 'current-noise';
}
export interface RecordResult {
  spec: ExperimentCase;
  scenarioSha256: string;
  predictionSha256: Record<string, string>;
  evaluations: Record<string, MissionEvaluationResult>;
  specific: Record<string, SpecificResult>;
}
export function cases(seeds: readonly number[]): ExperimentCase[] {
  return seeds.flatMap((seed) => {
    const primary = casesForSeeds([seed]).map((c) => ({ ...c, stream: 'primary' as const }));
    const lag = primary.find((c) => c.family === 'lag' && c.variantId === 'standard-cruise')!;
    return [
      ...primary,
      { ...lag, stream: 'current-noise' as const, caseId: `${lag.caseId}:current-noise` },
    ];
  });
}
export function settings(a: Artifact): Setting[] {
  return (['control', 'targeted'] as const).flatMap((modelId) =>
    a.models[modelId].thresholds.map((threshold, i) => ({
      id: `${modelId}-${i}`,
      modelId,
      threshold,
    })),
  );
}
export function predictions(
  points: readonly PredictionPoint[],
  values: readonly number[],
  threshold: number,
): PredictionPoint[] {
  if (
    points.length !== 180 ||
    values.length !== 141 ||
    values.some((v) => !Number.isFinite(v) || v < 0 || v > 1) ||
    !Number.isFinite(threshold) ||
    threshold < 0 ||
    threshold > 1
  )
    throw new Error('Invalid full-mission prediction input.');
  return points.map((p, i) => ({
    ...p,
    modelState: i < 39 ? 'warmup' : values[i - 39]! > threshold ? 'anomalous' : 'nominal',
  }));
}
export function infer(
  spec: ExperimentCase,
  artifact: Artifact,
  incumbent: Incumbent,
  choices: readonly Setting[],
) {
  const scenario =
    spec.stream === 'current-noise'
      ? currentNoiseCruiseLag(spec)
      : generateTemporalScenario(spec.options);
  const registered = extractPredictions(analyzeTemporalScenario(scenario, { modelEnabled: true }));
  const features = fullMissionFeatures(scenario);
  if (
    hashObject(features.names) !== hashObject(artifact.featureNames) ||
    hashObject(features.names.slice(0, 72)) !== hashObject(incumbent.featureNames)
  )
    throw new Error('Feature contract mismatch.');
  const scores: Record<string, number[]> = {
    incumbent: features.rows.map((row) => incumbentScore(row.slice(0, 72), incumbent, 'forest')),
  };
  for (const id of new Set(choices.map((c) => c.modelId)))
    scores[id] = features.rows.map((row) => score(row, artifact, id));
  const outputs: Record<string, PredictionPoint[]> = {
    registered,
    incumbent: predictions(registered, scores.incumbent!, 0.8),
  };
  for (const choice of choices)
    outputs[choice.id] = predictions(registered, scores[choice.modelId]!, choice.threshold);
  const evaluations = Object.fromEntries(
    Object.entries(outputs).map(([id, trace]) => [
      id,
      evaluateMission(
        {
          caseId: spec.caseId,
          seed: scenario.seed,
          family: spec.family,
          variantId: spec.variantId,
          cadenceMs: 1000,
          faultTimeline: scenario.faultTimeline,
          predictions: trace,
        },
        id === 'registered' ? ['model-k1', 'deterministic'] : ['model-k1'],
      ),
    ]),
  );
  const record: RecordResult = {
    spec,
    scenarioSha256: hashObject(scenario),
    predictionSha256: Object.fromEntries(
      Object.entries(outputs).map(([id, trace]) => [id, hashObject(trace)]),
    ),
    evaluations,
    specific: {},
  };
  return { record, predictions: outputs, scores };
}
export type Inference = ReturnType<typeof infer>;
export function addControl(result: Inference, control: Inference) {
  const timeline = result.record.evaluations.incumbent!.faultTimeline;
  if (!timeline) return;
  if (
    control.record.spec.family !== 'nominal' ||
    control.record.spec.options.seed !== result.record.spec.options.seed ||
    control.record.spec.options.startedAt !== result.record.spec.options.startedAt
  )
    throw new Error('Mismatched nominal control.');
  for (const [id, trace] of Object.entries(result.predictions))
    result.record.specific[id] = faultSpecific(trace, control.predictions[id]!, timeline);
}
function specific(rows: readonly RecordResult[], id: string, baselineId = 'incumbent') {
  const result = compareSpecific(
    rows
      .filter((r) => r.spec.family !== 'nominal')
      .map((r) => ({
        seed: r.spec.options.seed,
        family: r.spec.family,
        variantId: r.spec.variantId,
        baseline: r.specific[baselineId]!,
        candidate: r.specific[id]!,
      })),
  );
  // Reuse the paired statistics, not the previous experiment's five-point global-gain acceptance rule.
  return {
    baseline: result.baseline,
    candidate: result.candidate,
    recallGain: result.recallGain,
    perFamilyRecallGain: result.perFamilyRecallGain,
    recallGainInterval: result.recallGainInterval,
    pairedDetections: result.pairedDetections,
    p95AddedDelayMs: result.p95AddedDelayMs,
  };
}
export function compare(
  records: readonly RecordResult[],
  setting: Setting,
  baselineId = 'incumbent',
) {
  const primary = records.filter((r) => r.spec.stream === 'primary');
  const ordinary = compareDetectors(
    primary.map((r) => ({
      baseline: r.evaluations[baselineId]!,
      candidates: { [setting.id]: r.evaluations[setting.id]! },
    })),
    setting.id,
  );
  ordinary.baseline.detectorId =
    baselineId === 'incumbent' ? 'full-mission-incumbent-threshold0.8' : baselineId;
  const confirmed = specific(primary, setting.id, baselineId),
    cruise = specific(
      primary.filter((r) => r.spec.family === 'lag' && r.spec.variantId === 'standard-cruise'),
      setting.id,
      baselineId,
    ),
    challenge = specific(
      records.filter((r) => r.spec.stream === 'current-noise'),
      setting.id,
      baselineId,
    );
  const preservationReasons = [...ordinary.constraints.reasons];
  if (
    confirmed.recallGain === null ||
    confirmed.recallGain < -PROTOCOL.limits.specificRecallDrop - 1e-12
  )
    preservationReasons.push('Overall confirmed recall loss exceeds two points or is undefined.');
  if (
    Object.values(confirmed.perFamilyRecallGain).some(
      (v) => v === null || v < -PROTOCOL.limits.specificFamilyRecallDrop - 1e-12,
    )
  )
    preservationReasons.push('A confirmed family recall loss exceeds five points or is undefined.');
  if (
    confirmed.p95AddedDelayMs === null ||
    confirmed.p95AddedDelayMs > PROTOCOL.limits.specificP95AddedDelayMs
  )
    preservationReasons.push(
      'Paired confirmed p95 added delay exceeds five seconds or is undefined.',
    );
  const reasons = [...preservationReasons];
  if (
    ordinary.confidence.nominalFalseAlarmRateDelta!.upper === null ||
    ordinary.confidence.nominalFalseAlarmRateDelta!.upper >= 0
  )
    reasons.push('Nominal reduction lacks a strictly negative paired confidence bound.');
  for (const [name, result] of [
    ['primary cruise lag', cruise],
    ['current-noise cruise lag', challenge],
  ] as const) {
    if (
      result.recallGain === null ||
      result.recallGain < PROTOCOL.limits.cruiseSpecificGain - 1e-12
    )
      reasons.push(`${name}: confirmed gain below ten points or undefined.`);
    if (result.recallGainInterval.lower === null || result.recallGainInterval.lower <= 0)
      reasons.push(`${name}: confirmed gain lacks positive paired confidence bound.`);
  }
  return {
    setting,
    ordinary,
    confirmed,
    cruise,
    challenge,
    preservationReasons,
    reasons,
    passed: reasons.length === 0,
    decision: reasons.length ? 'rejected' : 'improved',
  };
}
export type Comparison = ReturnType<typeof compare>;
export function select(comparisons: readonly Comparison[], modelId: ModelId) {
  const matching = comparisons.filter((c) => c.setting.modelId === modelId),
    passing = matching.filter((c) => c.passed),
    preserving = matching.filter((c) => !c.preservationReasons.length);
  if (!matching.length) throw new Error('Missing model comparisons.');
  const pool = passing.length ? passing : preserving.length ? preserving : matching;
  return [...pool].sort((a, b) => {
    if (!passing.length) {
      const improvement = (b.cruise.candidate.recall ?? -1) - (a.cruise.candidate.recall ?? -1);
      if (improvement) return improvement;
    }
    return (
      (a.ordinary.candidate.nominalFalseAlarmRate ?? Infinity) -
        (b.ordinary.candidate.nominalFalseAlarmRate ?? Infinity) ||
      (b.cruise.candidate.recall ?? -1) - (a.cruise.candidate.recall ?? -1) ||
      (b.confirmed.candidate.recall ?? -1) - (a.confirmed.candidate.recall ?? -1) ||
      a.setting.threshold - b.setting.threshold
    );
  })[0]!;
}
