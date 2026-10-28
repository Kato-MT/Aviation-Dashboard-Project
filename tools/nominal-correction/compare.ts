import { createSeededRandom } from '../../src/faults/prng';
import {
  aggregateMissions,
  percentile,
  type MissionEvaluationResult,
} from '../../src/mission-evaluation';
import { PROTOCOL } from './protocol';

export interface PairedCase {
  baseline: MissionEvaluationResult;
  candidates: Record<string, MissionEvaluationResult>;
}

export function compareDetectors(
  cases: readonly PairedCase[],
  candidateId: string,
  bootstrap = true,
) {
  if (!cases.length || new Set(cases.map((c) => c.baseline.caseId)).size !== cases.length)
    throw new Error('Empty or duplicate paired cases.');
  const candidate = cases.map((c) => {
    const other = c.candidates[candidateId];
    if (
      !other ||
      other.caseId !== c.baseline.caseId ||
      other.seed !== c.baseline.seed ||
      other.family !== c.baseline.family ||
      other.variantId !== c.baseline.variantId ||
      other.sampleCount !== c.baseline.sampleCount ||
      other.cadenceMs !== c.baseline.cadenceMs ||
      JSON.stringify(other.faultTimeline) !== JSON.stringify(c.baseline.faultTimeline)
    )
      throw new Error('Unmatched detector cases.');
    const a = c.baseline.policies['model-k1']!;
    const b = other.policies['model-k1']!;
    if (
      a.eligibleSamples !== b.eligibleSamples ||
      a.unavailableSamples !== b.unavailableSamples ||
      a.observableFault !== b.observableFault ||
      a.nominalEvaluable !== b.nominalEvaluable
    )
      throw new Error('Detector coverage mismatch.');
    return other;
  });
  const summarize = (results: readonly MissionEvaluationResult[], detectorId: string) => {
    const { policyId: _policyId, ...metrics } = aggregateMissions(results, 'model-k1');
    if (_policyId !== 'model-k1') throw new Error('Unexpected alert policy.');
    return { detectorId, ...metrics };
  };
  const baseline = summarize(
    cases.map((c) => c.baseline),
    'registered-v2',
  );
  const corrected = summarize(candidate, candidateId);
  const drop = (a: number | null, b: number | null) => (a === null || b === null ? null : a - b);
  const perFamilyRecallDrop = Object.fromEntries(
    Object.entries(baseline.byFamily)
      .filter(([, g]) => g.faultMissions > 0)
      .map(([name, g]) => [name, drop(g.activeRecall, corrected.byFamily[name]!.activeRecall)]),
  );
  const delays = cases.flatMap((c, i) => {
    const a = c.baseline.policies['model-k1']!.detectionDelayMs;
    const b = candidate[i]!.policies['model-k1']!.detectionDelayMs;
    return a === null || b === null ? [] : [b - a];
  });
  const overallRecallDrop = drop(baseline.activeRecall, corrected.activeRecall);
  const pairedP95AddedDelayMs = percentile(delays, 0.95);
  const reasons: string[] = [];
  if (overallRecallDrop === null || overallRecallDrop > 0.02 + 1e-12)
    reasons.push('Overall recall loss exceeds two points or is undefined.');
  if (Object.values(perFamilyRecallDrop).some((v) => v === null || v > 0.05 + 1e-12))
    reasons.push('A family recall loss exceeds five points or is undefined.');
  if (pairedP95AddedDelayMs === null || pairedP95AddedDelayMs > 5000)
    reasons.push('Paired p95 added delay exceeds five seconds or is undefined.');
  if (baseline.nominalFalseAlarmRate === null || corrected.nominalFalseAlarmRate === null)
    reasons.push('Nominal rate is undefined.');
  const clusters = new Map<
    number,
    {
      aNominal: number;
      bNominal: number;
      nNominal: number;
      aDetect: number;
      bDetect: number;
      nFault: number;
      delaySum: number;
      delayCount: number;
    }
  >();
  cases.forEach((c, i) => {
    const a = c.baseline.policies['model-k1']!,
      b = candidate[i]!.policies['model-k1']!;
    const row = clusters.get(c.baseline.seed) ?? {
      aNominal: 0,
      bNominal: 0,
      nNominal: 0,
      aDetect: 0,
      bDetect: 0,
      nFault: 0,
      delaySum: 0,
      delayCount: 0,
    };
    row.aNominal += Number(a.nominalFalseAlarm === true);
    row.bNominal += Number(b.nominalFalseAlarm === true);
    row.nNominal += Number(a.nominalEvaluable === true);
    row.aDetect += Number(a.activeDetected === true);
    row.bDetect += Number(b.activeDetected === true);
    row.nFault += Number(a.observableFault === true);
    if (a.detectionDelayMs !== null && b.detectionDelayMs !== null) {
      row.delaySum += b.detectionDelayMs - a.detectionDelayMs;
      row.delayCount++;
    }
    clusters.set(c.baseline.seed, row);
  });
  const values = [...clusters.entries()].sort(([a], [b]) => a - b).map(([, r]) => r);
  const rng = createSeededRandom(PROTOCOL.bootstrap.seed);
  const samples: Record<string, number[]> = {
    nominalFalseAlarmRateDelta: [],
    activeRecallDelta: [],
    pairedMeanAddedDelayMs: [],
  };
  if (bootstrap)
    for (let n = 0; n < PROTOCOL.bootstrap.iterations; n++) {
      const sum = {
        aNominal: 0,
        bNominal: 0,
        nNominal: 0,
        aDetect: 0,
        bDetect: 0,
        nFault: 0,
        delaySum: 0,
        delayCount: 0,
      };
      for (let i = 0; i < values.length; i++) {
        const row = values[Math.floor(rng() * values.length)]!;
        for (const key of Object.keys(sum) as (keyof typeof sum)[]) sum[key] += row[key];
      }
      if (sum.nNominal)
        samples.nominalFalseAlarmRateDelta!.push((sum.bNominal - sum.aNominal) / sum.nNominal);
      if (sum.nFault) samples.activeRecallDelta!.push((sum.bDetect - sum.aDetect) / sum.nFault);
      if (sum.delayCount) samples.pairedMeanAddedDelayMs!.push(sum.delaySum / sum.delayCount);
    }
  const confidence = Object.fromEntries(
    Object.entries(samples).map(([key, arr]) => [
      key,
      { lower: percentile(arr, 0.025), upper: percentile(arr, 0.975), validReplicates: arr.length },
    ]),
  );
  const improved =
    corrected.nominalFalseAlarmRate !== null &&
    baseline.nominalFalseAlarmRate !== null &&
    corrected.nominalFalseAlarmRate < baseline.nominalFalseAlarmRate;
  return {
    candidateId,
    baseline,
    candidate: corrected,
    constraints: {
      passed: reasons.length === 0,
      reasons,
      overallRecallDrop,
      perFamilyRecallDrop,
      pairedP95AddedDelayMs,
      pairedDetections: delays.length,
    },
    confidence,
    bootstrap: { ...PROTOCOL.bootstrap, seedCount: values.length },
    decision: reasons.length
      ? 'rejected'
      : improved &&
          confidence.nominalFalseAlarmRateDelta!.upper !== null &&
          confidence.nominalFalseAlarmRateDelta!.upper < 0
        ? 'improved'
        : 'inconclusive',
  };
}
