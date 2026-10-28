import { describe, expect, it } from 'vitest';

import { analyzeTemporalScenario } from '../../src/investigation/analyze';
import {
  aggregateMissions,
  checkPolicyConstraints,
  comparePolicies,
  evaluateFinalPolicy,
  evaluateMission,
  extractPredictions,
  pairedBootstrap,
  percentile,
  selectDevelopmentPolicy,
  type MissionEvaluationInput,
  type MissionEvaluationResult,
  type ModelState,
  type PredictionPoint,
} from '../../src/mission-evaluation';
import { generateTemporalScenario } from '../../src/temporal/generator';

const range = (first: number, last: number) =>
  Array.from({ length: last - first + 1 }, (_, index) => first + index);

function fixture(
  overrides: Partial<MissionEvaluationInput> = {},
  anomalous: readonly number[] = [],
): MissionEvaluationInput {
  const predictions: PredictionPoint[] = Array.from({ length: 90 }, (_, sampleIndex) => ({
    sampleIndex,
    timestampMs: sampleIndex * 1_000,
    phase: 'cruise',
    modelState:
      sampleIndex < 39 ? 'warmup' : anomalous.includes(sampleIndex) ? 'anomalous' : 'nominal',
    deterministic: anomalous.includes(sampleIndex),
  }));
  return {
    caseId: 'case',
    seed: 1,
    family: 'gradual-drift',
    variantId: 'default',
    cadenceMs: 1_000,
    faultTimeline: { onsetIndex: 50, activeEndIndex: 55, recoveryEndIndex: 60 },
    predictions,
    ...overrides,
  };
}

function benchmarkRows(
  options: { nominalPersistent?: boolean; faultShort?: boolean; seeds?: number } = {},
): MissionEvaluationResult[] {
  return range(1, options.seeds ?? 20).flatMap((seed) => [
    evaluateMission(
      fixture(
        { caseId: `nominal-${seed}`, seed, family: 'nominal', faultTimeline: null },
        options.nominalPersistent && seed % 2 === 0 ? range(45, 50) : [45],
      ),
    ),
    evaluateMission(
      fixture(
        {
          caseId: `fault-${seed}`,
          seed,
          faultTimeline: { onsetIndex: 50, activeEndIndex: 70, recoveryEndIndex: 75 },
        },
        options.faultShort ? [50] : range(50, 70),
      ),
    ),
  ]);
}

describe('full-mission interval scoring', () => {
  it('TC-FM-001 scores inclusive active boundaries, false starts, recovery, and causal streaks by hand', () => {
    const result = evaluateMission(fixture({}, [45, 46, 50, 51, 52, ...range(57, 62), 70]));
    const raw = result.policies['model-k1']!;
    expect(raw.intervals.map(({ startIndex, endIndex }) => [startIndex, endIndex])).toEqual([
      [45, 46],
      [50, 52],
      [57, 62],
      [70, 70],
    ]);
    expect(raw).toMatchObject({
      warmupSamples: 39,
      eligibleSamples: 51,
      answeredSamples: 51,
      eligibleExposureMs: 50_000,
      faultFreeExposureMs: 39_000,
      activeEligibleSamples: 6,
      activeAlarmSamples: 3,
      activeDetected: true,
      detectionIndex: 50,
      detectionDelayMs: 0,
      falseAlarmEpisodes: 2,
      preOnsetFalseAlarmEpisodes: 1,
      postRecoveryFalseAlarmEpisodes: 1,
      recoveryAlarmSamples: 4,
      recoveryAlarmMs: 4_000,
      postRecoveryAlarmSamples: 3,
      postRecoveryAlarmMs: 3_000,
      carryoverAfterRecoveryMs: 2_000,
      missReason: null,
    });
    expect(result.policies['model-k3']).toMatchObject({
      detectionIndex: 52,
      detectionDelayMs: 2_000,
      activeAlarmSamples: 1,
      falseAlarmEpisodes: 0,
      recoveryAlarmSamples: 2,
      postRecoveryAlarmSamples: 2,
      carryoverAfterRecoveryMs: 2_000,
    });
    expect(result.policies['deterministic']!.authority).toBe('deterministic-rules');
  });

  it('TC-FM-002 does not credit a persistent pre-onset alert or recovery-only alert as active detection', () => {
    const persistent = evaluateMission(fixture({}, range(45, 70))).policies['model-k1']!;
    expect(persistent).toMatchObject({
      activeDetected: false,
      activeAlarmSamples: 6,
      detectionDelayMs: null,
      preOnsetFalseAlarmEpisodes: 1,
      missReason: 'no-new-alert-during-active',
    });
    const recovery = evaluateMission(fixture({}, range(56, 60))).policies['model-k1']!;
    expect(recovery).toMatchObject({
      activeDetected: false,
      recoveryAlarmSamples: 5,
      falseAlarmEpisodes: 0,
    });
    expect(evaluateMission(fixture({}, [55])).policies['model-k1']!.activeDetected).toBe(true);
    expect(evaluateMission(fixture({}, [56])).policies['model-k1']!.activeDetected).toBe(false);
  });

  it('TC-FM-003 retains unobservable faults and true onset delay through model warmup', () => {
    const early = fixture(
      { faultTimeline: { onsetIndex: 10, activeEndIndex: 20, recoveryEndIndex: 25 } },
      [39],
    );
    const result = evaluateMission(early);
    expect(result.policies['model-k1']).toMatchObject({
      observableFault: false,
      activeDetected: null,
      detectionDelayMs: null,
      missReason: 'no-eligible-active-samples',
      postRecoveryFalseAlarmEpisodes: 1,
    });
    expect(aggregateMissions([result], 'model-k1')).toMatchObject({
      faultMissions: 1,
      observableFaultMissions: 0,
      unobservableFaultMissions: 1,
      missedFaultMissions: 0,
      activeRecall: null,
    });
    expect(
      evaluateMission(
        fixture(
          { faultTimeline: { onsetIndex: 35, activeEndIndex: 40, recoveryEndIndex: 45 } },
          [39],
        ),
      ).policies['model-k1'],
    ).toMatchObject({ detectionIndex: 39, detectionDelayMs: 4_000 });
  });

  it('TC-FM-004 abstention and unavailable samples reset streaks without removing fault denominators', () => {
    const input = fixture({}, range(50, 55));
    input.predictions = input.predictions.map((point) => ({
      ...point,
      modelState:
        point.sampleIndex === 51
          ? 'abstained'
          : point.sampleIndex === 53
            ? 'unavailable'
            : point.modelState,
    }));
    const result = evaluateMission(input);
    expect(result.policies['model-k2']).toMatchObject({
      detectionIndex: 55,
      detectionDelayMs: 5_000,
      abstainedSamples: 1,
      unavailableSamples: 1,
      activeEligibleSamples: 6,
      answeredSamples: 49,
    });
    expect(result.policies['model-k3']).toMatchObject({
      activeDetected: false,
      activeEligibleSamples: 6,
    });
    expect(result.policies['deterministic']).toMatchObject({
      detectionIndex: 50,
      answeredSamples: 51,
      unavailableSamples: 0,
      abstainedSamples: 0,
    });
  });

  it('TC-FM-005 unavailable nominal data is explicit rather than a successful true negative', () => {
    const input = fixture({ family: 'nominal', faultTimeline: null });
    input.predictions = input.predictions.map((point) => ({
      ...point,
      modelState: point.sampleIndex < 39 ? 'warmup' : 'unavailable',
    }));
    const summary = aggregateMissions([evaluateMission(input)], 'model-k1');
    expect(summary).toMatchObject({
      nominalMissions: 1,
      nominalUnavailableMissions: 1,
      nominalEvaluableMissions: 0,
      nominalFalseAlarmRate: null,
      faultFreeExposureMs: 0,
      falseAlarmsPerSyntheticHour: null,
      abstentionFraction: null,
    });
    const empty = aggregateMissions([], 'model-k1');
    expect(empty.activeRecall).toBeNull();
    expect(empty.detectionDelayMs).toEqual({ count: 0, mean: null, median: null, p95: null });
  });

  it('TC-FM-006 deterministic alerts carried through warmup do not become new interval starts', () => {
    const input = fixture({
      faultTimeline: { onsetIndex: 35, activeEndIndex: 50, recoveryEndIndex: 55 },
    });
    input.predictions = input.predictions.map((point) => ({
      ...point,
      deterministic: point.sampleIndex >= 20 && point.sampleIndex <= 60,
    }));
    const rule = evaluateMission(input).policies['deterministic']!;
    expect(rule.intervals[0]).toMatchObject({ startIndex: 20, endIndex: 60 });
    expect(rule).toMatchObject({
      activeDetected: false,
      falseAlarmEpisodes: 0,
      activeAlarmSamples: 12,
    });
  });

  it('TC-FM-007 final instantaneous alerts have no fabricated following exposure', () => {
    const result = evaluateMission(fixture({ family: 'nominal', faultTimeline: null }, [89]));
    expect(result.policies['model-k1']).toMatchObject({
      nominalFalseAlarm: true,
      falseAlarmEpisodes: 1,
      eligibleExposureMs: 50_000,
      faultFreeExposureMs: 50_000,
    });
    const summary = aggregateMissions([result], 'model-k1');
    expect(summary.falseAlarmsPerSyntheticHour).toBe(72);
  });

  it('TC-FM-008 rejects malformed identity, cadence, predictions, truth, and policies', () => {
    const invalid: Partial<MissionEvaluationInput>[] = [
      { caseId: '' },
      { family: '' },
      { variantId: 'x'.repeat(201) },
      { seed: 0 },
      { seed: 2 ** 31 },
      { cadenceMs: 0 },
      { cadenceMs: Number.NaN },
      { predictions: [] },
      { faultTimeline: undefined as never },
      { family: 'nominal' },
      { faultTimeline: null },
      { faultTimeline: { onsetIndex: -1, activeEndIndex: 50, recoveryEndIndex: 55 } },
      { faultTimeline: { onsetIndex: 50, activeEndIndex: 49, recoveryEndIndex: 55 } },
      { faultTimeline: { onsetIndex: 50, activeEndIndex: 55, recoveryEndIndex: 90 } },
      { faultTimeline: { onsetIndex: 50.5, activeEndIndex: 55, recoveryEndIndex: 60 } },
    ];
    for (const override of invalid) expect(() => evaluateMission(fixture(override))).toThrow();
    for (const override of [
      { sampleIndex: 9 },
      { timestampMs: 4 },
      { modelState: 'bad' },
      { deterministic: null },
      { phase: '' },
      { modelState: 'nominal' },
    ]) {
      const input = fixture();
      input.predictions = input.predictions.map((point, index) =>
        index === 0 ? ({ ...point, ...override } as PredictionPoint) : point,
      );
      expect(() => evaluateMission(input)).toThrow();
    }
    expect(() => evaluateMission(fixture(), [])).toThrow(/unique policies/);
    expect(() => evaluateMission(fixture(), ['model-k1', 'model-k1'])).toThrow(/unique policies/);
    expect(() => evaluateMission(fixture(), ['bad' as never])).toThrow(/Unsupported/);
    const result = evaluateMission(fixture(), ['model-k1']);
    expect(() => aggregateMissions([result], 'model-k2')).toThrow(/missing policy/);
    expect(() => aggregateMissions([result, result], 'model-k1')).toThrow(/duplicate/);
  });
});

describe('frozen policy selection and paired uncertainty', () => {
  it('TC-FM-009 selects the shortest tied admissible improvement and supports a paired final reduction', () => {
    const rows = benchmarkRows();
    const selected = selectDevelopmentPolicy(rows);
    expect(selected.selectedPolicyId).toBe('model-k2');
    expect(selected.comparisons[0]!.constraints).toMatchObject({
      passed: true,
      overallRecallDrop: 0,
      maximumFamilyRecallDrop: 0,
      pairedP95AddedDelayMs: 1_000,
    });
    const final = evaluateFinalPolicy(rows, 'model-k2');
    expect(final.decision).toBe('improved');
    expect(final.comparison!.confidence.nominalFalseAlarmRateDelta).toEqual({
      lower: -1,
      upper: -1,
      validReplicates: 1_000,
    });
    expect(final.comparison!.candidate.byFamily['gradual-drift']!.activeRecall).toBe(1);
    expect(final.comparison!.candidate.byVariant.default!.missions).toBe(40);
  });

  it('TC-FM-010 retains baseline for ties and rejects missed faults or excessive paired delays', () => {
    const rows = benchmarkRows({ nominalPersistent: true });
    const equal = rows.filter((row) => row.seed % 2 === 0);
    expect(selectDevelopmentPolicy(equal).selectedPolicyId).toBe('model-k1');
    expect(evaluateFinalPolicy(equal, 'model-k1')).toMatchObject({
      decision: 'no-improvement',
      comparison: null,
    });
    expect(evaluateFinalPolicy(equal, 'model-k2').decision).toBe('inconclusive');
    const missed = benchmarkRows({ faultShort: true });
    expect(evaluateFinalPolicy(missed, 'model-k2').decision).toBe('rejected');
    expect(selectDevelopmentPolicy(missed).selectedPolicyId).toBe('model-k1');
    const delayed = [
      evaluateMission(fixture({ family: 'nominal', faultTimeline: null, caseId: 'n' }, [45])),
      evaluateMission(
        fixture(
          { faultTimeline: { onsetIndex: 50, activeEndIndex: 70, recoveryEndIndex: 75 } },
          [50, 60, 61, 62],
        ),
      ),
    ];
    expect(checkPolicyConstraints(delayed, 'model-k2')).toMatchObject({
      passed: false,
      pairedP95AddedDelayMs: 11_000,
    });
  });

  it('TC-FM-011 family recall guard prevents a small fault family being hidden in aggregate', () => {
    const rows = benchmarkRows({ seeds: 100 });
    const altered = rows.map((row) =>
      row.caseId === 'fault-1'
        ? evaluateMission(fixture({ caseId: row.caseId, seed: 1, family: 'fuel-leak' }, [50]))
        : row,
    );
    const constraints = checkPolicyConstraints(altered, 'model-k2');
    expect(constraints.overallRecallDrop).toBeCloseTo(0.01);
    expect(constraints.maximumFamilyRecallDrop).toBe(1);
    expect(constraints.passed).toBe(false);
  });

  it('TC-FM-012 paired bootstrap is seed-grouped, reproducible, and preserves related variants', () => {
    const rows = benchmarkRows({ nominalPersistent: true });
    const evidence = pairedBootstrap(rows, 'model-k2');
    expect(evidence).toEqual(pairedBootstrap(rows, 'model-k2'));
    const duplicatedVariants = rows.flatMap((row) => [
      row,
      { ...row, caseId: `${row.caseId}-variant`, variantId: 'duplicate-variant' },
    ]);
    expect(pairedBootstrap(duplicatedVariants, 'model-k2')).toEqual(evidence);
    expect(evidence).toMatchObject({
      seedCount: 20,
      iterations: 1_000,
      seed: 22_074,
      unit: 'mission-seed',
    });
    expect(evidence.pairedMeanAddedDelayMs).toEqual({
      lower: 1_000,
      upper: 1_000,
      validReplicates: 1_000,
    });
    const none = pairedBootstrap([], 'model-k2');
    expect(none.nominalFalseAlarmRateDelta).toEqual({
      lower: null,
      upper: null,
      validReplicates: 0,
    });
    for (const options of [{ iterations: 0 }, { iterations: 10_001 }, { seed: 0 }]) {
      expect(() => pairedBootstrap(rows, 'model-k2', options)).toThrow(/Bootstrap/);
    }
  });

  it('TC-FM-013 undefined guards are not silently passed and percentile rules are explicit', () => {
    const early = evaluateMission(
      fixture({ faultTimeline: { onsetIndex: 1, activeEndIndex: 10, recoveryEndIndex: 20 } }),
    );
    const comparison = comparePolicies([early], 'model-k2');
    expect(comparison.constraints).toMatchObject({
      passed: false,
      overallRecallDrop: null,
      maximumFamilyRecallDrop: null,
      pairedP95AddedDelayMs: null,
    });
    expect(comparison.constraints.reasons).toHaveLength(4);
    expect(() => comparePolicies([], 'deterministic' as never)).toThrow(/Candidate/);
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2);
    expect(percentile([1, 2, 3, 4], 0)).toBe(1);
    expect(percentile([1, 2, 3, 4], 1)).toBe(4);
    expect(() => percentile([1], -1)).toThrow(/probability/);
    expect(() => percentile([Number.NaN], 0.5)).toThrow(/finite/);
  });
});

describe('actual Investigation prediction boundary', () => {
  it('TC-FM-014 prediction extraction excludes ground truth and preserves all observed states', () => {
    const scenario = generateTemporalScenario({
      seed: 12_101,
      scenarioId: 'gradual-drift',
      sampleCount: 180,
    });
    const original = analyzeTemporalScenario(scenario, { modelEnabled: true });
    const changed = structuredClone(scenario);
    changed.faultTimeline = null;
    changed.scenarioId = 'nominal';
    for (const sample of changed.samples) {
      sample.faultLabels = [];
      sample.phaseTruth = 'ground';
      sample.truth = {
        altitude: 999_999,
        speed: 999,
        verticalRate: 999,
        fuel: 999,
        fuelFlow: 999,
        vibration: 999,
      };
    }
    expect(extractPredictions(analyzeTemporalScenario(changed, { modelEnabled: true }))).toEqual(
      extractPredictions(original),
    );
    const disabled = extractPredictions(analyzeTemporalScenario(scenario, { modelEnabled: false }));
    expect(disabled.slice(0, 39).every((point) => point.modelState === 'warmup')).toBe(true);
    expect(disabled.slice(39).every((point) => point.modelState === 'unavailable')).toBe(true);
    const stateFixture = structuredClone(original);
    const score = stateFixture.points[40]!.model.score!;
    const mutations = [
      null,
      { ...score, activation: { ...score.activation, active: false } },
      { ...score, abstained: true },
      { ...score, abstained: false, predictedLabel: 'unknown' as const },
      { ...score, abstained: false, predictedLabel: 'nominal' as const, anomalous: false },
      { ...score, abstained: false, predictedLabel: 'gradual-drift' as const, anomalous: true },
    ];
    const expected: ModelState[] = [
      'unavailable',
      'unavailable',
      'abstained',
      'abstained',
      'nominal',
      'anomalous',
    ];
    for (const [index, mutatedScore] of mutations.entries()) {
      const altered = {
        ...original,
        points: original.points.map((point, i) =>
          i === 40 ? { ...point, model: { ...point.model, score: mutatedScore } } : point,
        ),
      };
      expect(extractPredictions(altered)[40]!.modelState).toBe(expected[index]);
    }
  });

  it('TC-FM-015 future measurement changes cannot affect earlier predictions, and replay is exact', () => {
    const scenario = generateTemporalScenario({
      seed: 12_102,
      scenarioId: 'cross-sensor-decoupling',
      sampleCount: 180,
    });
    const predict = () =>
      extractPredictions(analyzeTemporalScenario(scenario, { modelEnabled: true }));
    const before = predict();
    expect(predict()).toEqual(before);
    const changed = structuredClone(scenario);
    for (const sample of changed.samples.slice(100)) {
      sample.measurements.barometricAltitude = 100_000;
      sample.measurements.gpsGroundSpeed = null;
      sample.measurements.vibration = 900;
    }
    const after = extractPredictions(analyzeTemporalScenario(changed, { modelEnabled: true }));
    expect(after.slice(0, 100)).toEqual(before.slice(0, 100));
  });
});
