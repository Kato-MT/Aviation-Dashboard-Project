import { createSeededRandom } from '../faults/prng';
import {
  MODEL_POLICY_IDS,
  type ConfidenceInterval,
  type DevelopmentSelection,
  type FinalPolicyDecision,
  type MissionAggregate,
  type MissionEvaluationResult,
  type MissionGroupSummary,
  type MissionPolicyResult,
  type ModelPolicyId,
  type PairedBootstrapEvidence,
  type PolicyComparison,
  type PolicyConstraints,
  type PolicyId,
} from './types';

const BASELINE = 'model-k1';
export const BOOTSTRAP_ITERATIONS = 1_000;
export const BOOTSTRAP_SEED = 22_074;
export const POLICY_LIMITS = {
  maximumOverallRecallDrop: 0.02,
  maximumFamilyRecallDrop: 0.05,
  maximumPairedP95AddedDelayMs: 5_000,
} as const;

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

/** Empirical nearest-rank percentile, also used for the conservative p95 delay guard. */
export function percentile(values: readonly number[], probability: number): number | null {
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new Error('Percentile probability must be between zero and one.');
  }
  if (values.some((value) => !Number.isFinite(value)))
    throw new Error('Percentiles require finite observations.');
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(probability * sorted.length) - 1)]!;
}

function metric(result: MissionEvaluationResult, policyId: PolicyId): MissionPolicyResult {
  const value = result.policies[policyId];
  if (value === undefined || value.policyId !== policyId) {
    throw new Error(`Mission '${result.caseId}' is missing policy '${policyId}'.`);
  }
  return value;
}

function validateResults(results: readonly MissionEvaluationResult[]): void {
  if (new Set(results.map((result) => result.caseId)).size !== results.length) {
    throw new Error('Mission aggregation rejects duplicate case IDs.');
  }
}

type CountField =
  | 'falseAlarmEpisodes'
  | 'preOnsetFalseAlarmEpisodes'
  | 'postRecoveryFalseAlarmEpisodes'
  | 'eligibleExposureMs'
  | 'faultFreeExposureMs'
  | 'warmupSamples'
  | 'eligibleSamples'
  | 'answeredSamples'
  | 'abstainedSamples'
  | 'unavailableSamples'
  | 'activeEligibleSamples'
  | 'activeAlarmSamples'
  | 'recoveryEligibleSamples'
  | 'recoveryAlarmSamples'
  | 'recoveryAlarmMs'
  | 'postRecoveryAlarmSamples'
  | 'postRecoveryAlarmMs'
  | 'carryoverAfterRecoveryMs';

function summarize(
  results: readonly MissionEvaluationResult[],
  policyId: PolicyId,
): MissionGroupSummary {
  const values = results.map((result) => metric(result, policyId));
  const count = (field: CountField) => values.reduce((total, value) => total + value[field], 0);
  const nominalMissions = results.filter((result) => result.faultTimeline === null).length;
  const observableFaultMissions = values.filter((value) => value.observableFault === true).length;
  const unobservableFaultMissions = values.filter(
    (value) => value.observableFault === false,
  ).length;
  const detectedFaultMissions = values.filter((value) => value.activeDetected === true).length;
  const nominalEvaluableMissions = values.filter((value) => value.nominalEvaluable === true).length;
  const nominalFalseAlarmMissions = values.filter(
    (value) => value.nominalFalseAlarm === true,
  ).length;
  const delays = values.flatMap((value) =>
    value.detectionDelayMs === null ? [] : [value.detectionDelayMs],
  );
  return {
    missions: results.length,
    faultMissions: results.length - nominalMissions,
    observableFaultMissions,
    unobservableFaultMissions,
    detectedFaultMissions,
    missedFaultMissions: observableFaultMissions - detectedFaultMissions,
    activeRecall: ratio(detectedFaultMissions, observableFaultMissions),
    nominalMissions,
    nominalEvaluableMissions,
    nominalUnavailableMissions: nominalMissions - nominalEvaluableMissions,
    nominalFalseAlarmMissions,
    nominalFalseAlarmRate: ratio(nominalFalseAlarmMissions, nominalEvaluableMissions),
    falseAlarmEpisodes: count('falseAlarmEpisodes'),
    preOnsetFalseAlarmEpisodes: count('preOnsetFalseAlarmEpisodes'),
    postRecoveryFalseAlarmEpisodes: count('postRecoveryFalseAlarmEpisodes'),
    eligibleExposureMs: count('eligibleExposureMs'),
    faultFreeExposureMs: count('faultFreeExposureMs'),
    falseAlarmsPerSyntheticHour: ratio(
      count('falseAlarmEpisodes') * 3_600_000,
      count('faultFreeExposureMs'),
    ),
    warmupSamples: count('warmupSamples'),
    eligibleSamples: count('eligibleSamples'),
    answeredSamples: count('answeredSamples'),
    abstainedSamples: count('abstainedSamples'),
    unavailableSamples: count('unavailableSamples'),
    abstentionFraction: ratio(
      count('abstainedSamples'),
      count('answeredSamples') + count('abstainedSamples'),
    ),
    activeEligibleSamples: count('activeEligibleSamples'),
    activeAlarmSamples: count('activeAlarmSamples'),
    activeCoverage: ratio(count('activeAlarmSamples'), count('activeEligibleSamples')),
    recoveryEligibleSamples: count('recoveryEligibleSamples'),
    recoveryAlarmSamples: count('recoveryAlarmSamples'),
    recoveryAlarmMs: count('recoveryAlarmMs'),
    postRecoveryAlarmSamples: count('postRecoveryAlarmSamples'),
    postRecoveryAlarmMs: count('postRecoveryAlarmMs'),
    carryoverAfterRecoveryMs: count('carryoverAfterRecoveryMs'),
    detectionDelayMs: {
      count: delays.length,
      mean: ratio(
        delays.reduce((total, delay) => total + delay, 0),
        delays.length,
      ),
      median: percentile(delays, 0.5),
      p95: percentile(delays, 0.95),
    },
  };
}

function groups(
  results: readonly MissionEvaluationResult[],
  field: 'family' | 'variantId',
  policyId: PolicyId,
) {
  const grouped = new Map<string, MissionEvaluationResult[]>();
  for (const result of results) {
    const group = grouped.get(result[field]) ?? [];
    group.push(result);
    grouped.set(result[field], group);
  }
  return Object.fromEntries(
    [...grouped]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, group]) => [name, summarize(group, policyId)]),
  );
}

export function aggregateMissions(
  results: readonly MissionEvaluationResult[],
  policyId: PolicyId,
): MissionAggregate {
  validateResults(results);
  return {
    policyId,
    ...summarize(results, policyId),
    byFamily: groups(results, 'family', policyId),
    byVariant: groups(results, 'variantId', policyId),
  };
}

function pairedDelays(
  results: readonly MissionEvaluationResult[],
  candidatePolicyId: ModelPolicyId,
): number[] {
  return results.flatMap((result) => {
    const baseline = metric(result, BASELINE);
    const candidate = metric(result, candidatePolicyId);
    return baseline.detectionDelayMs === null || candidate.detectionDelayMs === null
      ? []
      : [candidate.detectionDelayMs - baseline.detectionDelayMs];
  });
}

export function checkPolicyConstraints(
  results: readonly MissionEvaluationResult[],
  candidatePolicyId: ModelPolicyId,
): PolicyConstraints {
  const baseline = aggregateMissions(results, BASELINE);
  const candidate = aggregateMissions(results, candidatePolicyId);
  const overallRecallDrop =
    baseline.activeRecall === null || candidate.activeRecall === null
      ? null
      : baseline.activeRecall - candidate.activeRecall;
  const perFamilyRecallDrop = Object.fromEntries(
    Object.entries(baseline.byFamily)
      .filter(([, family]) => family.faultMissions > 0)
      .map(([name, family]) => {
        const other = candidate.byFamily[name]!;
        return [
          name,
          family.activeRecall === null || other.activeRecall === null
            ? null
            : family.activeRecall - other.activeRecall,
        ];
      }),
  );
  const familyDrops = Object.values(perFamilyRecallDrop);
  const maximumFamilyRecallDrop =
    familyDrops.length === 0 || familyDrops.some((value) => value === null)
      ? null
      : Math.max(...(familyDrops as number[]));
  const delays = pairedDelays(results, candidatePolicyId);
  const pairedP95AddedDelayMs = percentile(delays, 0.95);
  const reasons: string[] = [];
  if (baseline.nominalFalseAlarmRate === null || candidate.nominalFalseAlarmRate === null)
    reasons.push('Nominal false-alarm rate is undefined.');
  if (overallRecallDrop === null) reasons.push('Overall active-fault recall is undefined.');
  else if (overallRecallDrop > POLICY_LIMITS.maximumOverallRecallDrop + 1e-12)
    reasons.push('Overall active-fault recall drop exceeds two percentage points.');
  if (maximumFamilyRecallDrop === null)
    reasons.push('At least one required fault-family recall is undefined.');
  else if (maximumFamilyRecallDrop > POLICY_LIMITS.maximumFamilyRecallDrop + 1e-12)
    reasons.push('A fault-family recall drop exceeds five percentage points.');
  if (pairedP95AddedDelayMs === null) reasons.push('Paired detection delay is undefined.');
  else if (pairedP95AddedDelayMs > POLICY_LIMITS.maximumPairedP95AddedDelayMs)
    reasons.push('Paired p95 added delay exceeds five seconds.');
  return {
    passed: reasons.length === 0,
    overallRecallDrop,
    maximumFamilyRecallDrop,
    perFamilyRecallDrop,
    pairedDetections: delays.length,
    pairedP95AddedDelayMs,
    reasons,
  };
}

interface Cluster {
  baselineNominalCount: number;
  baselineNominalFalse: number;
  candidateNominalCount: number;
  candidateNominalFalse: number;
  baselineFaultCount: number;
  baselineDetected: number;
  candidateFaultCount: number;
  candidateDetected: number;
  delayCount: number;
  delaySum: number;
}

export interface BootstrapOptions {
  iterations?: number;
  seed?: number;
}

function interval(values: readonly number[]): ConfidenceInterval {
  return {
    lower: percentile(values, 0.025),
    upper: percentile(values, 0.975),
    validReplicates: values.length,
  };
}

export function pairedBootstrap(
  results: readonly MissionEvaluationResult[],
  candidatePolicyId: ModelPolicyId,
  options: BootstrapOptions = {},
): PairedBootstrapEvidence {
  validateResults(results);
  const iterations = options.iterations ?? BOOTSTRAP_ITERATIONS;
  const seed = options.seed ?? BOOTSTRAP_SEED;
  if (
    !Number.isInteger(iterations) ||
    iterations < 1 ||
    iterations > 10_000 ||
    !Number.isInteger(seed) ||
    seed < 1 ||
    seed > 2_147_483_647
  ) {
    throw new Error('Bootstrap requires 1 to 10000 iterations and a positive 32-bit seed.');
  }
  const grouped = new Map<number, Cluster>();
  for (const result of results) {
    const baseline = metric(result, BASELINE);
    const candidate = metric(result, candidatePolicyId);
    const cluster = grouped.get(result.seed) ?? {
      baselineNominalCount: 0,
      baselineNominalFalse: 0,
      candidateNominalCount: 0,
      candidateNominalFalse: 0,
      baselineFaultCount: 0,
      baselineDetected: 0,
      candidateFaultCount: 0,
      candidateDetected: 0,
      delayCount: 0,
      delaySum: 0,
    };
    cluster.baselineNominalCount += Number(baseline.nominalEvaluable === true);
    cluster.baselineNominalFalse += Number(baseline.nominalFalseAlarm === true);
    cluster.candidateNominalCount += Number(candidate.nominalEvaluable === true);
    cluster.candidateNominalFalse += Number(candidate.nominalFalseAlarm === true);
    cluster.baselineFaultCount += Number(baseline.observableFault === true);
    cluster.baselineDetected += Number(baseline.activeDetected === true);
    cluster.candidateFaultCount += Number(candidate.observableFault === true);
    cluster.candidateDetected += Number(candidate.activeDetected === true);
    if (baseline.detectionDelayMs !== null && candidate.detectionDelayMs !== null) {
      cluster.delayCount += 1;
      cluster.delaySum += candidate.detectionDelayMs - baseline.detectionDelayMs;
    }
    grouped.set(result.seed, cluster);
  }
  const clusters = [...grouped].sort(([a], [b]) => a - b).map(([, cluster]) => cluster);
  const distributions = {
    baselineNominalFalseAlarmRate: [] as number[],
    candidateNominalFalseAlarmRate: [] as number[],
    nominalFalseAlarmRateDelta: [] as number[],
    baselineActiveRecall: [] as number[],
    candidateActiveRecall: [] as number[],
    activeRecallDelta: [] as number[],
    pairedMeanAddedDelayMs: [] as number[],
  };
  const random = createSeededRandom(seed);
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const totals: Cluster = {
      baselineNominalCount: 0,
      baselineNominalFalse: 0,
      candidateNominalCount: 0,
      candidateNominalFalse: 0,
      baselineFaultCount: 0,
      baselineDetected: 0,
      candidateFaultCount: 0,
      candidateDetected: 0,
      delayCount: 0,
      delaySum: 0,
    };
    for (let index = 0; index < clusters.length; index += 1) {
      const cluster = clusters[Math.floor(random() * clusters.length)]!;
      for (const key of Object.keys(totals) as (keyof Cluster)[]) totals[key] += cluster[key];
    }
    const baselineFalse = ratio(totals.baselineNominalFalse, totals.baselineNominalCount);
    const candidateFalse = ratio(totals.candidateNominalFalse, totals.candidateNominalCount);
    const baselineRecall = ratio(totals.baselineDetected, totals.baselineFaultCount);
    const candidateRecall = ratio(totals.candidateDetected, totals.candidateFaultCount);
    const addedDelay = ratio(totals.delaySum, totals.delayCount);
    if (baselineFalse !== null) distributions.baselineNominalFalseAlarmRate.push(baselineFalse);
    if (candidateFalse !== null) distributions.candidateNominalFalseAlarmRate.push(candidateFalse);
    if (baselineFalse !== null && candidateFalse !== null)
      distributions.nominalFalseAlarmRateDelta.push(candidateFalse - baselineFalse);
    if (baselineRecall !== null) distributions.baselineActiveRecall.push(baselineRecall);
    if (candidateRecall !== null) distributions.candidateActiveRecall.push(candidateRecall);
    if (baselineRecall !== null && candidateRecall !== null)
      distributions.activeRecallDelta.push(candidateRecall - baselineRecall);
    if (addedDelay !== null) distributions.pairedMeanAddedDelayMs.push(addedDelay);
  }
  return {
    unit: 'mission-seed',
    iterations,
    seed,
    confidenceLevel: 0.95,
    seedCount: clusters.length,
    baselineNominalFalseAlarmRate: interval(distributions.baselineNominalFalseAlarmRate),
    candidateNominalFalseAlarmRate: interval(distributions.candidateNominalFalseAlarmRate),
    nominalFalseAlarmRateDelta: interval(distributions.nominalFalseAlarmRateDelta),
    baselineActiveRecall: interval(distributions.baselineActiveRecall),
    candidateActiveRecall: interval(distributions.candidateActiveRecall),
    activeRecallDelta: interval(distributions.activeRecallDelta),
    pairedMeanAddedDelayMs: interval(distributions.pairedMeanAddedDelayMs),
  };
}

export function comparePolicies(
  results: readonly MissionEvaluationResult[],
  candidatePolicyId: ModelPolicyId,
): PolicyComparison {
  if (!MODEL_POLICY_IDS.includes(candidatePolicyId))
    throw new Error('Candidate must be a declared model policy.');
  return {
    baselinePolicyId: BASELINE,
    candidatePolicyId,
    baseline: aggregateMissions(results, BASELINE),
    candidate: aggregateMissions(results, candidatePolicyId),
    constraints: checkPolicyConstraints(results, candidatePolicyId),
    confidence: pairedBootstrap(results, candidatePolicyId),
  };
}

export function selectDevelopmentPolicy(
  results: readonly MissionEvaluationResult[],
): DevelopmentSelection {
  const baseline = aggregateMissions(results, BASELINE);
  const comparisons = MODEL_POLICY_IDS.filter((id) => id !== BASELINE).map((id) =>
    comparePolicies(results, id),
  );
  let selectedPolicyId: ModelPolicyId = BASELINE;
  let bestRate = baseline.nominalFalseAlarmRate;
  for (const comparison of comparisons) {
    const rate = comparison.candidate.nominalFalseAlarmRate;
    // Ordered policies preserve the shorter-streak tie break, including the raw baseline.
    if (comparison.constraints.passed && rate !== null && bestRate !== null && rate < bestRate) {
      selectedPolicyId = comparison.candidatePolicyId;
      bestRate = rate;
    }
  }
  return {
    selectedPolicyId,
    reason:
      selectedPolicyId === BASELINE
        ? 'No admissible longer-streak policy reduced the development nominal-mission false-alarm rate.'
        : 'Selected the lowest development nominal-mission false-alarm rate within all frozen tradeoff limits; ties favor the shorter streak.',
    comparisons,
  };
}

export function evaluateFinalPolicy(
  results: readonly MissionEvaluationResult[],
  selectedPolicyId: ModelPolicyId,
): FinalPolicyDecision {
  const baseline = aggregateMissions(results, BASELINE);
  if (selectedPolicyId === BASELINE)
    return {
      selectedPolicyId,
      decision: 'no-improvement',
      reason: 'Development retained the original policy; no improved candidate was advanced.',
      baseline,
      comparison: null,
    };
  const comparison = comparePolicies(results, selectedPolicyId);
  if (!comparison.constraints.passed)
    return {
      selectedPolicyId,
      decision: 'rejected',
      reason:
        'The frozen candidate violated a final-evaluation tradeoff limit or lacked an identifiable required metric.',
      baseline,
      comparison,
    };
  const upper = comparison.confidence.nominalFalseAlarmRateDelta.upper;
  const improved = upper !== null && upper < 0;
  return {
    selectedPolicyId,
    decision: improved ? 'improved' : 'inconclusive',
    reason: improved
      ? 'All tradeoff limits passed and the paired 95% interval supports a lower nominal-mission false-alarm rate.'
      : 'Tradeoff limits passed, but the paired 95% interval does not establish a nominal-mission false-alarm reduction.',
    baseline,
    comparison,
  };
}
