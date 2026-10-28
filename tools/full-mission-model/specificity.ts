import { createSeededRandom } from '../../src/faults/prng';
import {
  percentile,
  type MissionTimeline,
  type PredictionPoint,
} from '../../src/mission-evaluation';
import { PROTOCOL } from './protocol';

export interface SpecificResult {
  observable: boolean;
  detected: boolean;
  detectionIndex: number | null;
  delayMs: number | null;
  reason: string;
  faultOnlySamples: number;
  controlOnlySamples: number;
  bothAlarmSamples: number;
  neitherAlarmSamples: number;
  unresolvedControlSamples: number;
}
/** Controls are evaluation-only, after independent inference. An episode cannot qualify by waiting for a control to clear. */
export function faultSpecific(
  fault: readonly PredictionPoint[],
  control: readonly PredictionPoint[],
  timeline: MissionTimeline,
): SpecificResult {
  if (
    fault.length !== control.length ||
    !fault.length ||
    fault.some(
      (p, i) =>
        p.sampleIndex !== i ||
        !Number.isFinite(p.timestampMs) ||
        p.timestampMs !== control[i]!.timestampMs ||
        control[i]!.sampleIndex !== i ||
        (i > 0 && p.timestampMs <= fault[i - 1]!.timestampMs) ||
        ![p.modelState, control[i]!.modelState].every((s) =>
          ['warmup', 'unavailable', 'abstained', 'nominal', 'anomalous'].includes(s),
        ),
    )
  )
    throw new Error('Fault/control predictions are not aligned.');
  if (
    ![timeline.onsetIndex, timeline.activeEndIndex, timeline.recoveryEndIndex].every(
      Number.isInteger,
    ) ||
    timeline.onsetIndex < 0 ||
    timeline.activeEndIndex < timeline.onsetIndex ||
    timeline.recoveryEndIndex < timeline.activeEndIndex ||
    timeline.recoveryEndIndex >= fault.length
  )
    throw new Error('Invalid fault-specific timeline.');
  const result: SpecificResult = {
    observable: false,
    detected: false,
    detectionIndex: null,
    delayMs: null,
    reason: 'no-new-active-alert',
    faultOnlySamples: 0,
    controlOnlySamples: 0,
    bothAlarmSamples: 0,
    neitherAlarmSamples: 0,
    unresolvedControlSamples: 0,
  };
  let run = 0,
    allowed = false;
  for (let i = 0; i < fault.length; i++) {
    const f = fault[i]!,
      c = control[i]!;
    const active = i >= timeline.onsetIndex && i <= timeline.activeEndIndex;
    if (active && f.modelState !== 'warmup') {
      result.observable = true;
      const fa = f.modelState === 'anomalous',
        ca = c.modelState === 'anomalous';
      if (c.modelState !== 'anomalous' && c.modelState !== 'nominal')
        result.unresolvedControlSamples++;
      else if (fa && ca) result.bothAlarmSamples++;
      else if (fa) result.faultOnlySamples++;
      else if (ca) result.controlOnlySamples++;
      else result.neitherAlarmSamples++;
    }
    if (f.modelState !== 'anomalous') {
      run = 0;
      allowed = false;
      continue;
    }
    const start = i === 0 || fault[i - 1]!.modelState !== 'anomalous';
    if (start) {
      allowed = active && c.modelState === 'nominal';
      run = 0;
      if (active && !result.detected)
        result.reason =
          c.modelState === 'anomalous'
            ? 'coincident-control-alarm'
            : c.modelState !== 'nominal'
              ? 'unresolved-control'
              : 'interrupted-confirmation';
    }
    if (!active || c.modelState !== 'nominal') {
      allowed = false;
      run = 0;
      continue;
    }
    if (allowed) {
      run++;
      if (run === PROTOCOL.faultSpecific.confirmationSamples && !result.detected) {
        result.detected = true;
        result.detectionIndex = i;
        result.delayMs = f.timestampMs - fault[timeline.onsetIndex]!.timestampMs;
        result.reason = 'confirmed-fault-only-alarm';
      } else if (!result.detected && i === timeline.activeEndIndex)
        result.reason = 'insufficient-active-confirmation';
    }
  }
  if (!result.observable) result.reason = 'no-eligible-active-samples';
  return result;
}

export interface SpecificCase {
  seed: number;
  family: string;
  variantId: string;
  baseline: SpecificResult;
  candidate: SpecificResult;
}
export function summarizeSpecific(cases: readonly SpecificCase[], key: 'baseline' | 'candidate') {
  const summarize = (rows: readonly SpecificCase[]) => {
    const observable = rows.filter((r) => r[key].observable),
      detected = observable.filter((r) => r[key].detected);
    const delays = detected.map((r) => r[key].delayMs!);
    return {
      observable: observable.length,
      detected: detected.length,
      missed: observable.length - detected.length,
      recall: observable.length ? detected.length / observable.length : null,
      medianDelayMs: percentile(delays, 0.5),
      p95DelayMs: percentile(delays, 0.95),
      reasons: Object.fromEntries(
        [...new Set(rows.map((r) => r[key].reason))].map((reason) => [
          reason,
          rows.filter((r) => r[key].reason === reason).length,
        ]),
      ),
      faultOnlySamples: rows.reduce((n, r) => n + r[key].faultOnlySamples, 0),
      bothAlarmSamples: rows.reduce((n, r) => n + r[key].bothAlarmSamples, 0),
      controlOnlySamples: rows.reduce((n, r) => n + r[key].controlOnlySamples, 0),
      unresolvedControlSamples: rows.reduce((n, r) => n + r[key].unresolvedControlSamples, 0),
    };
  };
  return {
    ...summarize(cases),
    byFamily: Object.fromEntries(
      [...new Set(cases.map((c) => c.family))]
        .sort()
        .map((f) => [f, summarize(cases.filter((c) => c.family === f))]),
    ),
    byVariant: Object.fromEntries(
      [...new Set(cases.map((c) => c.variantId))]
        .sort()
        .map((v) => [v, summarize(cases.filter((c) => c.variantId === v))]),
    ),
  };
}
export function compareSpecific(cases: readonly SpecificCase[]) {
  if (!cases.length) throw new Error('Empty fault-specific comparison.');
  if (
    new Set(cases.map((c) => `${c.seed}:${c.family}:${c.variantId}`)).size !== cases.length ||
    cases.some(
      (c) =>
        c.baseline.observable !== c.candidate.observable ||
        [c.baseline, c.candidate].some(
          (r) =>
            r.detected &&
            (!r.observable || r.delayMs === null || !Number.isFinite(r.delayMs) || r.delayMs < 0),
        ),
    )
  )
    throw new Error('Duplicate or unmatched fault-specific cases.');
  const baseline = summarizeSpecific(cases, 'baseline'),
    candidate = summarizeSpecific(cases, 'candidate');
  const gains = Object.fromEntries(
    Object.keys(baseline.byFamily).map((f) => {
      const a = baseline.byFamily[f]!.recall,
        b = candidate.byFamily[f]!.recall;
      return [f, a === null || b === null ? null : b - a];
    }),
  );
  const paired = cases.filter((c) => c.baseline.detected && c.candidate.detected),
    delays = paired.map((c) => c.candidate.delayMs! - c.baseline.delayMs!);
  const p95AddedDelayMs = percentile(delays, 0.95);
  const seeds = [...new Set(cases.map((c) => c.seed))].sort((a, b) => a - b);
  const clusters = seeds.map((seed) => cases.filter((c) => c.seed === seed));
  const counts = clusters.map((rows) => ({
    n: rows.filter((r) => r.baseline.observable).length,
    delta: rows.reduce((n, r) => n + Number(r.candidate.detected) - Number(r.baseline.detected), 0),
  }));
  const rng = createSeededRandom(PROTOCOL.bootstrap.seed),
    samples: number[] = [];
  for (let j = 0; j < PROTOCOL.bootstrap.iterations; j++) {
    let n = 0,
      delta = 0;
    for (let i = 0; i < seeds.length; i++) {
      const r = counts[Math.floor(rng() * counts.length)]!;
      n += r.n;
      delta += r.delta;
    }
    if (n) samples.push(delta / n);
  }
  const interval = {
    lower: percentile(samples, 0.025),
    upper: percentile(samples, 0.975),
    validReplicates: samples.length,
  };
  const gain =
    baseline.recall === null || candidate.recall === null
      ? null
      : candidate.recall - baseline.recall;
  const reasons: string[] = [];
  if (gain === null || gain < 0.05 - 1e-12)
    reasons.push('Fault-specific recall gain below five points or undefined.');
  if (interval.lower === null || interval.lower <= 0)
    reasons.push('Fault-specific improvement lacks positive paired confidence bound.');
  if (Object.values(gains).some((g) => g === null || g < -0.05 - 1e-12))
    reasons.push('Fault-specific family recall loss exceeds five points or is undefined.');
  if (p95AddedDelayMs === null || p95AddedDelayMs > 5000)
    reasons.push('Paired fault-specific p95 delay exceeds five seconds or is undefined.');
  return {
    baseline,
    candidate,
    recallGain: gain,
    perFamilyRecallGain: gains,
    recallGainInterval: interval,
    pairedDetections: paired.length,
    p95AddedDelayMs,
    passed: reasons.length === 0,
    reasons,
  };
}
