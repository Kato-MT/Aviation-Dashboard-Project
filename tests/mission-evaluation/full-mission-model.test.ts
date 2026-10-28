import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { identity } from '../../tools/full-mission-model/protocol';
import {
  parseArguments,
  predict,
  run,
  select,
  settings,
  type Comparison,
} from '../../tools/full-mission-model/run';
import { REPOSITORY_ROOT } from '../../tools/mission-evaluation/protocol';
import { seal } from '../../tools/nominal-correction/run';

import type { MissionTimeline, ModelState, PredictionPoint } from '../../src/mission-evaluation';
import { generateTemporalScenario } from '../../src/temporal/generator';
import type { TemporalMeasurements } from '../../src/temporal/types';
import {
  fullMissionFeatures,
  recentFeatures,
  resolution,
} from '../../tools/full-mission-model/features';
import {
  scaleFeatures,
  scoreFeatures,
  validateArtifact,
  verifyParity,
  type Artifact,
  type Tree,
} from '../../tools/full-mission-model/model';
import {
  compareSpecific,
  faultSpecific,
  summarizeSpecific,
  type SpecificCase,
  type SpecificResult,
} from '../../tools/full-mission-model/specificity';
import { PROTOCOL, validateSeeds } from '../../tools/full-mission-model/protocol';

const sourceSha256 = 'a'.repeat(64);
const timeline: MissionTimeline = { onsetIndex: 50, activeEndIndex: 55, recoveryEndIndex: 60 };

describe('supervised experiment orchestration', () => {
  it('TC-SM-016 validates stage arguments and keeps strict threshold and warmup semantics', () => {
    expect(parseArguments(['--stage', 'train', '--python', 'python']).stage).toBe('train');
    for (const args of [
      [],
      ['--stage', 'train'],
      ['--stage', 'bad'],
      ['--stage', 'final', '--python', 'python'],
      ['--stage', 'replay'],
      ['--stage', 'development', '--case-id', 'x'],
      ['--stage', 'final', '--stage', 'final'],
    ])
      expect(() => parseArguments(args)).toThrow();
    const a = artifact(),
      choice = settings(a)[0]!;
    const baseline = Array.from({ length: 180 }, (_, i) => ({
      sampleIndex: i,
      timestampMs: i * 1000,
      phase: 'cruise',
      modelState: 'nominal' as const,
      deterministic: i % 2 === 0,
    }));
    const original = structuredClone(baseline);
    const rows = Array.from({ length: 141 }, () => [0, 0, 0]),
      scores = Array<number>(141).fill(0.5);
    scores[1] = 0.5001;
    const result = predict(rows, baseline, a, choice, scores);
    expect(result.slice(0, 39).every((p) => p.modelState === 'warmup')).toBe(true);
    expect(result[39]!.modelState).toBe('nominal');
    expect(result[40]!.modelState).toBe('anomalous');
    expect(result.map((p) => p.deterministic)).toEqual(baseline.map((p) => p.deterministic));
    expect(baseline).toEqual(original);
    expect(() => predict(rows.slice(1), baseline, a, choice)).toThrow();
    expect(() => predict(rows, baseline, a, choice, Array<number>(141).fill(NaN))).toThrow();
  });

  it('TC-SM-017 selects a passing candidate before rejected alternatives and freezes a declared diagnostic fallback', () => {
    const item = (
      modelId: string,
      passed: boolean,
      fa: number,
      recall: number,
      specific: number,
    ): Comparison =>
      ({
        setting: { id: modelId, modelId, threshold: 0.5 },
        passed,
        ordinary: {
          candidate: { nominalFalseAlarmRate: fa, activeRecall: recall },
          baseline: { nominalFalseAlarmRate: 1 },
        },
        specific: { candidate: { recall: specific } },
      }) as unknown as Comparison;
    expect(
      select([item('forest', false, 0, 1, 1), item('linear', true, 0.1, 0.9, 0.8)]).setting.modelId,
    ).toBe('linear');
    expect(
      select([item('forest', true, 0.1, 0.9, 0.8), item('linear', true, 0.1, 0.9, 0.8)]).setting
        .modelId,
    ).toBe('linear');
    expect(
      select([item('forest', false, 0.1, 0.8, 0.7), item('linear', false, 0.5, 0.9, 0.8)]).setting
        .modelId,
    ).toBe('linear');
  });

  it('TC-SM-018 fails on missing selection, source drift and corrupt cached batches, then locks training and development', async () => {
    const parent = resolve(REPOSITORY_ROOT, '.tmp-tests');
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(resolve(parent, 'trained-model-'));
    if (!resolve(directory).startsWith(parent + sep)) throw new Error('Unsafe test cleanup path.');
    const write = (name: string, value: unknown) =>
      writeFile(resolve(directory, name), JSON.stringify(value));
    try {
      const source = await identity(),
        model = artifact();
      model.sourceSha256 = source.sha256;
      const manifest = {
        schemaVersion: 'full-mission-training-manifest.v1',
        protocol: PROTOCOL,
        source,
        createdAt: 'test',
      };
      await write('manifest.json', seal(manifest));
      await write('model.json', model);
      await expect(run('final', directory)).rejects.toThrow(/ENOENT/);
      await write('manifest.json', seal({ ...manifest, source: { ...source, sha256: 'changed' } }));
      await expect(run('development', directory)).rejects.toThrow(/source\/protocol changed/);
      await write('manifest.json', seal(manifest));
      await mkdir(resolve(directory, 'development/batches'), { recursive: true });
      await write('development/batches/0.json', { contentSha256: 'broken', records: [] });
      await expect(run('development', directory)).rejects.toThrow(/checksum/);
      expect(
        JSON.parse(await readFile(resolve(directory, 'development/status.json'), 'utf8')).status,
      ).toBe('failed');
      await write('selection.json', {});
      await expect(run('train', directory, 'python')).rejects.toThrow(/frozen/);
      await expect(run('development', directory)).rejects.toThrow(/frozen/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function measurements(index = 0): TemporalMeasurements {
  return {
    indicatedAirspeed: index * 2 + 10,
    gpsGroundSpeed: index * 2 + 10,
    barometricAltitude: 100,
    gpsAltitude: 100,
    inertialVerticalRate: 6,
    barometricVerticalRate: 2,
    fuelQuantity: 100,
    fuelFlow: 2,
    vibration: 0,
  };
}

function mappedRecent(observed: readonly TemporalMeasurements[]) {
  const result = recentFeatures(observed);
  return Object.fromEntries(result.names.map((name, index) => [name, result.values[index]!]));
}

function points(
  from = -1,
  through = -1,
  overrides: Readonly<Record<number, ModelState>> = {},
): PredictionPoint[] {
  return Array.from({ length: 90 }, (_, sampleIndex) => ({
    sampleIndex,
    timestampMs: sampleIndex * 1_000,
    phase: 'cruise',
    modelState:
      overrides[sampleIndex] ??
      (sampleIndex < 39
        ? 'warmup'
        : sampleIndex >= from && sampleIndex <= through
          ? 'anomalous'
          : 'nominal'),
    deterministic: false,
  }));
}

function artifact(): Artifact {
  const tree: Tree = {
    left: [1, -1, -1],
    right: [2, -1, -1],
    feature: [0, -2, -2],
    threshold: [1, -2, -2],
    positive: [0.5, 0.25, 0.75],
  };
  return {
    schemaVersion: 'full-mission-supervised-model.v1',
    sourceSha256,
    fitManifestSha256: 'b'.repeat(64),
    calibrationManifestSha256: 'c'.repeat(64),
    protocol: PROTOCOL,
    featureNames: ['x', 'masked', 'z'],
    scaler: {
      center: [10, 0, -5],
      scale: [2, 1, 0.5],
      constantMask: [false, true, false],
      clip: 50,
    },
    models: {
      linear: { type: 'logistic', coefficients: [2, -1, 3], intercept: -1, thresholds: [0.5] },
      forest: {
        type: 'random-forest',
        trees: Array.from({ length: 64 }, () => structuredClone(tree)),
        thresholds: [0.5],
        featureImportances: [1, 0, 0],
      },
    },
    parity: [
      { features: [12, 999, -4.5], linear: 1 / (1 + Math.exp(-4)), forest: 0.25 },
      { features: [10, 0, -5], linear: Math.exp(-1) / (1 + Math.exp(-1)), forest: 0.25 },
      { features: [14, 0, -5], linear: 1 / (1 + Math.exp(-3)), forest: 0.75 },
    ],
    fitSummary: {
      missions: 1,
      windows: 1,
      positiveWindows: 1,
      constantFeatureCount: 1,
      minimumScale: 0.5,
      clippedFraction: 0,
    },
    environment: { purpose: 'hand-calculated test fixture' },
    scoreMeaning: 'synthetic test score',
  };
}

function specificResult(detected: boolean, delayMs = 2_000): SpecificResult {
  return {
    observable: true,
    detected,
    detectionIndex: detected ? 50 + delayMs / 1_000 : null,
    delayMs: detected ? delayMs : null,
    reason: detected ? 'confirmed-fault-only-alarm' : 'no-new-active-alert',
    faultOnlySamples: detected ? 3 : 0,
    controlOnlySamples: 0,
    bothAlarmSamples: 0,
    neitherAlarmSamples: detected ? 3 : 6,
    unresolvedControlSamples: 0,
  };
}

function comparisonCases(): SpecificCase[] {
  return Array.from({ length: 20 }, (_, index) => index + 1).flatMap((seed) => [
    {
      seed,
      family: 'gradual-drift',
      variantId: 'paired',
      baseline: specificResult(true, 2_000),
      candidate: specificResult(true, 3_000),
    },
    {
      seed,
      family: 'gradual-drift',
      variantId: 'gained',
      baseline: specificResult(false),
      candidate: specificResult(true, 2_000),
    },
  ]);
}

describe('observed 72-feature encoder', () => {
  it('TC-SM-001 computes recent disagreement, missingness, fuel, range, and vibration features by hand', () => {
    const observed = Array.from({ length: 40 }, (_, index) => measurements(index));
    for (let index = 0; index < 5; index += 1) {
      const sample = observed[35 + index]!;
      sample.barometricAltitude = 100 + 2 * index;
      sample.gpsAltitude = 98 + index;
      sample.fuelFlow = 2 + 2 * index;
      sample.fuelQuantity = 100 - 2 * index;
      sample.vibration = 1 + index;
    }
    const result = mappedRecent(observed);
    expect(Object.keys(result)).toHaveLength(21);
    expect(result['altitude-disagreement.current-absolute']).toBe(6);
    expect(result['altitude-disagreement.mean5']).toBe(4);
    expect(result['altitude-disagreement.rms5']).toBeCloseTo(Math.sqrt(18), 12);
    expect(result['altitude-disagreement.missing5']).toBe(0);
    expect(result['rate-disagreement.current-absolute']).toBe(4);
    expect(result['rate-disagreement.mean5']).toBe(4);
    expect(result['rate-disagreement.rms5']).toBe(4);
    expect(result['fuel-flow.mean5']).toBe(6);
    expect(result['fuel-flow.missing5']).toBe(0);
    expect(result['fuel.decline5']).toBe(2);
    expect(result['barometric-altitude.range5']).toBe(8);
    expect(result['gps-altitude.range5']).toBe(4);
    expect(result['vibration.std5']).toBeCloseTo(Math.sqrt(2), 12);
    expect(result['speed-lag.best-offset20']).toBe(0);
    expect(result['speed-lag.rms-improvement20']).toBe(0);
    observed[39]!.gpsAltitude = null;
    const missing = mappedRecent(observed);
    expect(missing['altitude-disagreement.current-absolute']).toBe(0);
    expect(missing['altitude-disagreement.mean5']).toBe(3.5);
    expect(missing['altitude-disagreement.missing5']).toBeCloseTo(0.2, 12);
    expect(() => recentFeatures(observed.slice(1))).toThrow();
  });

  it('TC-SM-002 distinguishes measured speed lag from ties or missing alignments', () => {
    const lagged = Array.from({ length: 40 }, (_, index) => ({
      ...measurements(index),
      indicatedAirspeed: index - 2,
      gpsGroundSpeed: index,
    }));
    const measured = mappedRecent(lagged);
    expect(measured['speed-disagreement.mean20']).toBe(-2);
    expect(measured['speed-lag.best-offset20']).toBe(-2);
    expect(measured['speed-lag.rms-improvement20']).toBe(2);
    const constant = Array.from({ length: 40 }, () => ({
      ...measurements(),
      indicatedAirspeed: 100,
      gpsGroundSpeed: 100,
    }));
    expect(mappedRecent(constant)['speed-lag.best-offset20']).toBe(0);
    const missing = Array.from({ length: 40 }, () => ({
      ...measurements(),
      indicatedAirspeed: null,
      gpsGroundSpeed: null,
    }));
    expect(mappedRecent(missing)['speed-lag.best-offset20']).toBe(0);
    expect(mappedRecent(missing)['speed-lag.rms-improvement20']).toBe(0);
    expect(mappedRecent(missing)['speed-disagreement.missing5']).toBe(1);
    const sparse: TemporalMeasurements[] = missing.map((row) => ({ ...row }));
    sparse[20]!.indicatedAirspeed = 5;
    sparse[20]!.gpsGroundSpeed = 10;
    expect(mappedRecent(sparse)['speed-lag.best-offset20']).toBe(0);
    expect(mappedRecent(sparse)['speed-lag.rms-improvement20']).toBe(0);
  });

  it('TC-SM-003 produces 72 finite observed-only features and ignores truth and quality metadata', () => {
    const scenario = generateTemporalScenario({
      seed: 80_011,
      scenarioId: 'intermittent-dropout',
      sampleCount: 180,
    });
    scenario.samples[40]!.measurements.gpsAltitude = null;
    const before = fullMissionFeatures(scenario);
    expect(before.names).toHaveLength(72);
    expect(new Set(before.names).size).toBe(72);
    expect(before.rows).toHaveLength(141);
    expect(before.rows.every((row) => row.length === 72 && row.every(Number.isFinite))).toBe(true);
    const changed = structuredClone(scenario);
    changed.scenarioId = 'nominal';
    changed.faultTimeline = null;
    for (const sample of changed.samples) {
      sample.phaseTruth = 'ground';
      sample.faultLabels = [];
      sample.truth = {
        altitude: 999_999,
        speed: 999,
        verticalRate: 999,
        fuel: 999,
        fuelFlow: 999,
        vibration: 999,
      };
      for (const key of Object.keys(sample.quality) as (keyof TemporalMeasurements)[])
        sample.quality[key] = 'missing';
    }
    expect(fullMissionFeatures(changed)).toEqual(before);
    expect(resolution('x.freeze-ratio')).toBe(1 / 39);
    expect(resolution('x.missing-fraction')).toBe(1 / 40);
    expect(resolution('x.missing5')).toBe(1 / 5);
    expect(resolution('x.best-lag')).toBe(1);
    expect(resolution('speed-lag.best-offset20')).toBe(1);
    expect(resolution('other')).toBe(0.001);
  });

  it('TC-SM-004 future measurements cannot change prior causal windows', () => {
    const scenario = generateTemporalScenario({
      seed: 80_012,
      scenarioId: 'cross-sensor-decoupling',
      sampleCount: 180,
    });
    const before = fullMissionFeatures(scenario);
    const changed = structuredClone(scenario);
    for (const sample of changed.samples.slice(100)) {
      sample.measurements.barometricAltitude = 100_000;
      sample.measurements.indicatedAirspeed = null;
      sample.measurements.vibration = 900;
    }
    const after = fullMissionFeatures(changed);
    expect(after.names).toEqual(before.names);
    expect(after.rows.slice(0, 61)).toEqual(before.rows.slice(0, 61));
  });
});

describe('numeric preprocessing, logistic inference, and exported trees', () => {
  it('TC-SM-005 masks constant dimensions and clips standardized observed features', () => {
    const value = artifact();
    expect(() => validateArtifact(value, sourceSha256)).not.toThrow();
    expect(scaleFeatures([12, 999, -4.5], value.scaler)).toEqual([1, 0, 1]);
    expect(scaleFeatures([2_000, -999, -1_000], value.scaler)).toEqual([50, 0, -50]);
    expect(() => scaleFeatures([12, 0], value.scaler)).toThrow();
    expect(() => scaleFeatures([12, Number.NaN, -5], value.scaler)).toThrow();
    expect(scoreFeatures([12, 999, -4.5], value, 'linear')).toBeCloseTo(0.9820137900379085, 12);
    const linear = value.models.linear!;
    if (linear.type !== 'logistic') throw new Error('Fixture must be logistic.');
    linear.intercept = 100_000;
    expect(scoreFeatures([10, 0, -5], value, 'linear')).toBe(1);
    linear.intercept = -100_000;
    expect(scoreFeatures([10, 0, -5], value, 'linear')).toBe(0);
  });

  it('TC-SM-006 follows manual tree thresholds and sklearn float32 routing before averaging leaves', () => {
    const value = artifact();
    expect(scoreFeatures([12, 0, -5], value, 'forest')).toBe(0.25);
    expect(scoreFeatures([14, 0, -5], value, 'forest')).toBe(0.75);
    // Standardized x is slightly above 1 in float64 but exactly 1 in float32.
    expect(scoreFeatures([12.00000002, 0, -5], value, 'forest')).toBe(0.25);
    expect(verifyParity(value)).toMatchObject({ cases: 3, tolerance: 1e-10 });
    expect(verifyParity(value).maximumError).toBeLessThanOrEqual(1e-12);
    const changed = structuredClone(value);
    changed.parity[0]!.forest = 0.3;
    expect(() => verifyParity(changed)).toThrow(/parity/);
    expect(() => verifyParity({ ...value, parity: [] })).toThrow(/missing/);
    expect(() => scoreFeatures([10, 0, -5], value, 'missing-model')).toThrow();
  });

  it('TC-SM-007 rejects bad provenance, scales, thresholds, and cyclic or malformed tree exports', () => {
    const value = artifact();
    const mutations: ((row: Artifact) => void)[] = [
      (row) => {
        row.sourceSha256 = 'd'.repeat(64);
      },
      (row) => {
        row.featureNames[1] = row.featureNames[0]!;
      },
      (row) => {
        row.scaler.scale[0] = 0;
      },
      (row) => {
        row.scaler.center[0] = Number.NaN;
      },
      (row) => {
        row.scaler.clip = 20;
      },
      (row) => {
        row.models.linear!.thresholds = [2];
      },
      (row) => {
        if (row.models.linear!.type === 'logistic') row.models.linear!.coefficients.pop();
      },
      (row) => {
        if (row.models.forest!.type === 'random-forest') row.models.forest!.trees.pop();
      },
      (row) => {
        if (row.models.forest!.type === 'random-forest') row.models.forest!.trees[0]!.left[0] = 0;
      },
      (row) => {
        if (row.models.forest!.type === 'random-forest')
          row.models.forest!.trees[0]!.feature[0] = 99;
      },
      (row) => {
        if (row.models.forest!.type === 'random-forest') row.models.forest!.trees[0]!.right.pop();
      },
      (row) => {
        if (row.models.forest!.type === 'random-forest')
          row.models.forest!.trees[0]!.positive[1] = 2;
      },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(value);
      mutate(changed);
      expect(() => validateArtifact(changed, sourceSha256)).toThrow();
    }
  });
});

describe('fault-specific confirmation against independently inferred nominal controls', () => {
  it('TC-SM-008 confirms at the third active fault-only sample with no backdating', () => {
    const result = faultSpecific(points(50, 55), points(), timeline);
    expect(result).toMatchObject({
      observable: true,
      detected: true,
      detectionIndex: 52,
      delayMs: 2_000,
      faultOnlySamples: 6,
      bothAlarmSamples: 0,
      controlOnlySamples: 0,
      neitherAlarmSamples: 0,
      unresolvedControlSamples: 0,
      reason: 'confirmed-fault-only-alarm',
    });
    expect(
      faultSpecific(points(50, 52), points(), { ...timeline, activeEndIndex: 52 }),
    ).toMatchObject({ detected: true, detectionIndex: 52 });
    expect(
      faultSpecific(points(50, 55), points(), { ...timeline, activeEndIndex: 51 }),
    ).toMatchObject({
      detected: false,
      detectionIndex: null,
      reason: 'insufficient-active-confirmation',
    });
    // A later control alarm cannot retroactively change an already causal confirmation.
    expect(faultSpecific(points(50, 55), points(54, 55), timeline)).toMatchObject({
      detected: true,
      detectionIndex: 52,
      bothAlarmSamples: 2,
    });
  });

  it('TC-SM-009 does not credit carried-in, coincident, recovery-only, or persistent control alarms', () => {
    expect(faultSpecific(points(48, 89), points(), timeline).detected).toBe(false);
    expect(faultSpecific(points(50, 89), points(50, 50), timeline)).toMatchObject({
      detected: false,
      reason: 'coincident-control-alarm',
      bothAlarmSamples: 1,
    });
    expect(faultSpecific(points(56, 60), points(), timeline).detected).toBe(false);
    expect(faultSpecific(points(50, 55), points(39, 89), timeline)).toMatchObject({
      detected: false,
      bothAlarmSamples: 6,
      faultOnlySamples: 0,
    });
    expect(faultSpecific(points(), points(50, 55), timeline)).toMatchObject({
      detected: false,
      controlOnlySamples: 6,
      neitherAlarmSamples: 0,
    });
  });

  it('TC-SM-010 unresolved controls disqualify an episode and only a new fault run can restart confirmation', () => {
    for (const state of ['abstained', 'unavailable'] as const) {
      expect(faultSpecific(points(50, 55), points(-1, -1, { 50: state }), timeline)).toMatchObject({
        detected: false,
        unresolvedControlSamples: 1,
        reason: 'unresolved-control',
      });
      expect(faultSpecific(points(50, 55), points(-1, -1, { 51: state }), timeline)).toMatchObject({
        detected: false,
        unresolvedControlSamples: 1,
      });
    }
    expect(faultSpecific(points(50, 55, { 51: 'abstained' }), points(), timeline)).toMatchObject({
      detected: true,
      detectionIndex: 54,
      delayMs: 4_000,
    });
    expect(
      faultSpecific(
        points(50, 55, {
          50: 'unavailable',
          51: 'unavailable',
          52: 'unavailable',
          53: 'unavailable',
          54: 'unavailable',
          55: 'unavailable',
        }),
        points(),
        timeline,
      ),
    ).toMatchObject({ observable: true, detected: false });
    expect(
      faultSpecific(points(), points(), {
        onsetIndex: 20,
        activeEndIndex: 30,
        recoveryEndIndex: 35,
      }),
    ).toMatchObject({ observable: false, detected: false, reason: 'no-eligible-active-samples' });
    expect(
      faultSpecific(points(39, 45), points(), {
        onsetIndex: 35,
        activeEndIndex: 40,
        recoveryEndIndex: 45,
      }),
    ).toMatchObject({ observable: true, detected: false });
  });

  it('TC-SM-011 rejects misaligned predictions and malformed inclusive timelines', () => {
    expect(() => faultSpecific([], [], timeline)).toThrow();
    expect(() => faultSpecific(points(), points().slice(1), timeline)).toThrow();
    const altered = points();
    altered[50]!.timestampMs += 1;
    expect(() => faultSpecific(points(), altered, timeline)).toThrow();
    const invalidState = points();
    invalidState[50]!.modelState = 'invalid' as ModelState;
    expect(() => faultSpecific(invalidState, points(), timeline)).toThrow();
    for (const changed of [
      { onsetIndex: -1, activeEndIndex: 55, recoveryEndIndex: 60 },
      { onsetIndex: 50, activeEndIndex: 49, recoveryEndIndex: 60 },
      { onsetIndex: 50.5, activeEndIndex: 55, recoveryEndIndex: 60 },
      { onsetIndex: 50, activeEndIndex: 55, recoveryEndIndex: 90 },
    ])
      expect(() => faultSpecific(points(), points(), changed)).toThrow();
  });
});

describe('paired fault-specific evidence and seed isolation', () => {
  it('TC-SM-012 retains within-seed variants and produces a known positive paired recall interval', () => {
    const cases = comparisonCases();
    const result = compareSpecific(cases);
    expect(result).toMatchObject({
      recallGain: 0.5,
      pairedDetections: 20,
      p95AddedDelayMs: 1_000,
      passed: true,
      recallGainInterval: { lower: 0.5, upper: 0.5, validReplicates: 1_000 },
    });
    expect(result.baseline).toMatchObject({
      observable: 40,
      detected: 20,
      missed: 20,
      recall: 0.5,
    });
    expect(result.candidate).toMatchObject({ observable: 40, detected: 40, missed: 0, recall: 1 });
    expect(result.candidate.byVariant.gained!.recall).toBe(1);
    expect(compareSpecific(cases)).toEqual(result);
    const duplicates = cases.flatMap((row) => [
      row,
      { ...structuredClone(row), variantId: row.variantId + '-replica' },
    ]);
    expect(compareSpecific(duplicates).recallGainInterval).toEqual(result.recallGainInterval);
    const negative = compareSpecific(
      cases.map((row) => ({ ...row, baseline: row.candidate, candidate: row.baseline })),
    );
    expect(negative.recallGain).toBe(-0.5);
    expect(negative.recallGainInterval).toEqual({
      lower: -0.5,
      upper: -0.5,
      validReplicates: 1_000,
    });
    expect(negative.passed).toBe(false);
  });

  it('TC-SM-013 treats self-comparison and undefined evidence as no improvement', () => {
    const cases = comparisonCases().map((row) => ({
      ...row,
      candidate: structuredClone(row.baseline),
    }));
    const equal = compareSpecific(cases);
    expect(equal.recallGain).toBe(0);
    expect(equal.recallGainInterval).toEqual({ lower: 0, upper: 0, validReplicates: 1_000 });
    expect(equal.p95AddedDelayMs).toBe(0);
    expect(equal.passed).toBe(false);
    const unobservable = specificResult(false);
    unobservable.observable = false;
    unobservable.reason = 'no-eligible-active-samples';
    const none = compareSpecific([
      {
        seed: 1,
        family: 'lag',
        variantId: 'early',
        baseline: unobservable,
        candidate: structuredClone(unobservable),
      },
    ]);
    expect(none.recallGain).toBeNull();
    expect(none.perFamilyRecallGain.lag).toBeNull();
    expect(none.recallGainInterval).toEqual({ lower: null, upper: null, validReplicates: 0 });
    expect(none.passed).toBe(false);
    expect(summarizeSpecific([], 'baseline').recall).toBeNull();
  });

  it('TC-SM-014 rejects duplicate or incomparable pairs and excessive delay', () => {
    const cases = comparisonCases();
    expect(() => compareSpecific([])).toThrow();
    expect(() => compareSpecific([cases[0]!, cases[0]!])).toThrow();
    const mismatch = structuredClone(cases);
    mismatch[0]!.candidate.observable = false;
    expect(() => compareSpecific(mismatch)).toThrow();
    const missingDelay = structuredClone(cases);
    missingDelay[0]!.candidate.delayMs = null;
    expect(() => compareSpecific(missingDelay)).toThrow();
    const delayed = cases.map((row) => ({ ...row, candidate: specificResult(true, 8_000) }));
    expect(compareSpecific(delayed)).toMatchObject({ passed: false, p95AddedDelayMs: 6_000 });
  });

  it('TC-SM-015 rejects historical, prior-experiment, cross-partition, and invalid seeds', () => {
    const defaults = () => [
      [...PROTOCOL.fitSeeds],
      [...PROTOCOL.calibrationSeeds],
      [...PROTOCOL.developmentSeeds],
      [...PROTOCOL.finalSeeds],
    ];
    const excluded = [1_101, 2_101, 9_101, 12_101, 13_101, 14_101, 15_101, 16_101, 17_101];
    expect(() => validateSeeds(excluded)).not.toThrow();
    expect(() => validateSeeds([PROTOCOL.fitSeeds[0]!])).toThrow();
    for (const seed of [...excluded, 0, 2_147_483_648, 1.5]) {
      const partitions = defaults();
      partitions[0]![0] = seed;
      expect(() => validateSeeds(excluded, partitions)).toThrow();
    }
    const duplicate = defaults();
    duplicate[1]![0] = duplicate[0]![0]!;
    expect(() => validateSeeds([], duplicate)).toThrow();
    const within = defaults();
    within[0]![1] = within[0]![0]!;
    expect(() => validateSeeds([], within)).toThrow();
    const short = defaults();
    short[3]!.pop();
    expect(() => validateSeeds([], short)).toThrow();
    expect(() => validateSeeds([], defaults().slice(1))).toThrow();
  });
});
