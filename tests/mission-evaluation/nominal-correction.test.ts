import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import registeredArtifact from '../../models/temporal_fault_model_v2.json';
import { analyzeTemporalScenario } from '../../src/investigation/analyze';
import {
  evaluateMission,
  extractPredictions,
  type MissionEvaluationResult,
  type ModelState,
  type PredictionPoint,
} from '../../src/mission-evaluation';
import { parseTemporalFaultModelArtifact } from '../../src/ml/temporalModel';
import { generateTemporalScenario } from '../../src/temporal/generator';
import { hashObject, PROTOCOL as PREVIOUS_PROTOCOL } from '../../tools/mission-evaluation/protocol';
import {
  correctPredictions,
  fitEnvelope,
  missionFeatures,
  nominalDistance,
  validateEnvelope,
  type Envelope,
} from '../../tools/nominal-correction/core';
import { compareDetectors, type PairedCase } from '../../tools/nominal-correction/compare';
import { identity, PROTOCOL, validatePartitions } from '../../tools/nominal-correction/protocol';
import {
  parseArguments,
  pairedMission,
  run,
  seal,
  verify,
} from '../../tools/nominal-correction/run';
import { loadModelContext, REPOSITORY_ROOT } from '../../tools/mission-evaluation/protocol';

const baselineSha256 = 'a'.repeat(64);

function simpleEnvelope(): Envelope {
  return {
    schemaVersion: 'nominal-envelope.v1',
    baselineSha256,
    protocolSha256: hashObject(PROTOCOL),
    fitSeeds: [...PROTOCOL.fitSeeds],
    calibrationSeeds: [...PROTOCOL.calibrationSeeds],
    scale: Array<number>(51).fill(1),
    prototypes: Array.from({ length: 141 }, () => Array<number>(51).fill(0)),
    thresholds: { 'window-p95': 0.5, 'window-p99': 1, 'mission-max-p95': 2 },
  };
}

function predictions(states: readonly ModelState[] = []): PredictionPoint[] {
  return Array.from({ length: 39 + states.length }, (_, sampleIndex) => ({
    sampleIndex,
    timestampMs: sampleIndex * 1_000,
    phase: 'cruise',
    modelState: sampleIndex < 39 ? 'warmup' : states[sampleIndex - 39]!,
    deterministic: sampleIndex >= 39,
  }));
}

function evaluatedCase(
  seed: number,
  nominal: boolean,
  unavailable = false,
): MissionEvaluationResult {
  const rows: PredictionPoint[] = Array.from({ length: 80 }, (_, sampleIndex) => ({
    sampleIndex,
    timestampMs: sampleIndex * 1_000,
    phase: 'cruise',
    modelState:
      sampleIndex < 39
        ? 'warmup'
        : unavailable
          ? 'unavailable'
          : nominal
            ? sampleIndex === 45
              ? 'anomalous'
              : 'nominal'
            : sampleIndex >= 50 && sampleIndex <= 60
              ? 'anomalous'
              : 'nominal',
    deterministic: false,
  }));
  return evaluateMission(
    {
      caseId: String(seed) + (nominal ? ':nominal' : ':fault'),
      seed,
      family: nominal ? 'nominal' : 'gradual-drift',
      variantId: 'default',
      cadenceMs: 1_000,
      faultTimeline: nominal ? null : { onsetIndex: 50, activeEndIndex: 60, recoveryEndIndex: 65 },
      predictions: rows,
    },
    ['model-k1'],
  );
}

function pairedCases(unavailable = false): PairedCase[] {
  return [1, 2, 3].flatMap((seed) =>
    [true, false].map((nominal) => {
      const baseline = evaluatedCase(seed, nominal, unavailable);
      return { baseline, candidates: { self: structuredClone(baseline) } };
    }),
  );
}

describe('nominal envelope fitting and scaling', () => {
  let fitted: Envelope;

  beforeAll(() => {
    const registered = parseTemporalFaultModelArtifact(registeredArtifact);
    const artifact = {
      ...registered,
      featureNames: [
        'sensor.mean',
        'sensor.freeze-ratio',
        'sensor.missing-fraction',
        'sensor.phase-feature',
        ...Array.from({ length: 47 }, (_, index) => 'other.' + index),
      ],
      featureScale: [4, 0.001, 0.001, 0.001, ...Array<number>(47).fill(0.001)],
    };
    const training = Array.from({ length: 40 }, (_, mission) =>
      Array.from({ length: 141 }, (_, end) => [
        mission < 20 ? -1 : 1,
        0,
        0,
        end,
        ...Array<number>(47).fill(0),
      ]),
    );
    const calibration = Array.from({ length: 40 }, (_, mission) =>
      Array.from({ length: 141 }, (_, end) => [
        mission + 1,
        0,
        0,
        end,
        ...Array<number>(47).fill(0),
      ]),
    );
    const inputHash = hashObject({ training, calibration, artifact });
    fitted = fitEnvelope(training, calibration, artifact, baselineSha256);
    expect(hashObject({ training, calibration, artifact })).toBe(inputHash);
  }, 30_000);

  it('TC-NC-001 fits registered, population-variance, and discrete-resolution scale floors exactly', () => {
    expect(fitted.scale).toHaveLength(51);
    expect(fitted.scale[0]).toBe(4);
    expect(fitted.scale[1]).toBe(1 / 39);
    expect(fitted.scale[2]).toBe(1 / 40);
    expect(fitted.scale[3]).toBeCloseTo(Math.sqrt((141 ** 2 - 1) / 12), 10);
    expect(fitted.scale[4]).toBe(0.001);
    expect(fitted.prototypes).toHaveLength(141);
    expect(fitted.prototypes[0]!.slice(0, 4)).toEqual([0, 0, 0, 0]);
    expect(fitted.prototypes[140]!.slice(0, 4)).toEqual([0, 0, 0, 140]);
    expect(fitted.thresholds['window-p95']).toBeCloseTo(38 ** 2 / (16 * 51), 12);
    expect(fitted.thresholds['window-p99']).toBeCloseTo(40 ** 2 / (16 * 51), 12);
    expect(fitted.thresholds['mission-max-p95']).toBeCloseTo(38 ** 2 / (16 * 51), 12);
    expect(() => validateEnvelope(fitted, baselineSha256)).not.toThrow();
  });

  it('TC-NC-002 rejects incomplete or nonfinite fitting populations and incompatible fitted artifacts', () => {
    const artifact = parseTemporalFaultModelArtifact(registeredArtifact);
    const complete = Array.from({ length: 40 }, () =>
      Array.from({ length: 141 }, () => Array<number>(51).fill(0)),
    );
    expect(() => fitEnvelope(complete.slice(1), complete, artifact, baselineSha256)).toThrow();
    expect(() => fitEnvelope(complete, complete.slice(1), artifact, baselineSha256)).toThrow();
    const ragged = structuredClone(complete);
    ragged[0]![0]!.pop();
    expect(() => fitEnvelope(ragged, complete, artifact, baselineSha256)).toThrow();
    const missingWindow = structuredClone(complete);
    missingWindow[0]!.pop();
    expect(() => fitEnvelope(complete, missingWindow, artifact, baselineSha256)).toThrow();
    const nonfinite = structuredClone(complete);
    nonfinite[0]![0]![0] = Number.NaN;
    expect(() => fitEnvelope(nonfinite, complete, artifact, baselineSha256)).toThrow();
    const mutations: ((value: Envelope) => void)[] = [
      (value) => {
        value.baselineSha256 = 'b'.repeat(64);
      },
      (value) => {
        value.protocolSha256 = 'b'.repeat(64);
      },
      (value) => {
        value.fitSeeds[0] = 1;
      },
      (value) => {
        value.calibrationSeeds[0] = 1;
      },
      (value) => {
        value.scale[0] = 0;
      },
      (value) => {
        value.scale[0] = Number.NaN;
      },
      (value) => {
        value.prototypes.pop();
      },
      (value) => {
        value.prototypes[0]!.pop();
      },
      (value) => {
        value.prototypes[0]![0] = Number.POSITIVE_INFINITY;
      },
      (value) => {
        value.thresholds['window-p95'] = 0;
      },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(fitted);
      mutate(changed);
      expect(() => validateEnvelope(changed, baselineSha256)).toThrow();
    }
  });

  it('TC-NC-003 uses the nearest prototype and mean squared standardized feature distance', () => {
    const envelope = {
      scale: [2, 4],
      prototypes: [
        [2, 8],
        [10, 16],
      ],
    };
    expect(nominalDistance([4, 12], envelope)).toBe(1);
    expect(nominalDistance([10, 16], envelope)).toBe(0);
    expect(() => nominalDistance([4], envelope)).toThrow();
    expect(() => nominalDistance([Number.NaN, 12], envelope)).toThrow();
    expect(() => nominalDistance([4, 12], { ...envelope, prototypes: [] })).toThrow();
    expect(() => nominalDistance([4, 12], { ...envelope, prototypes: [[1]] })).toThrow();
  });
});

describe('observed-only nominal correction', () => {
  it('TC-NC-004 preserves warmup, unavailable scores, baseline inputs, and authoritative rule decisions', () => {
    const baseline = predictions(['unavailable', 'anomalous', 'abstained', 'nominal', 'abstained']);
    const original = structuredClone(baseline);
    const features = Array.from({ length: 5 }, (_, index) =>
      Array<number>(51).fill(index === 4 ? 10 : 0),
    );
    const envelope = simpleEnvelope();
    const inputHash = hashObject({ baseline, features, envelope });
    const corrected = correctPredictions(baseline, features, envelope, 'window-p95');
    expect(corrected.slice(0, 39)).toEqual(baseline.slice(0, 39));
    expect(corrected.slice(39).map((point) => point.modelState)).toEqual([
      'unavailable',
      'nominal',
      'nominal',
      'nominal',
      'abstained',
    ]);
    expect(corrected.map((point) => point.deterministic)).toEqual(
      baseline.map((point) => point.deterministic),
    );
    expect(baseline).toEqual(original);
    expect(hashObject({ baseline, features, envelope })).toBe(inputHash);
    expect(corrected[39]).not.toBe(baseline[39]);
    expect(() => correctPredictions(baseline, features.slice(1), envelope, 'window-p95')).toThrow();
    expect(() => correctPredictions(baseline, features, envelope, 'missing-candidate')).toThrow();
    expect(() =>
      correctPredictions(
        baseline,
        features,
        {
          ...envelope,
          thresholds: { 'window-p95': 0 },
        },
        'window-p95',
      ),
    ).toThrow();
  });

  it('TC-NC-005 missing sensor observations produce finite features without consuming truth labels', () => {
    const scenario = generateTemporalScenario({
      seed: 80_001,
      scenarioId: 'intermittent-dropout',
      sampleCount: 180,
    });
    scenario.samples[40]!.measurements.gpsAltitude = null;
    scenario.samples[41]!.measurements.barometricAltitude = null;
    const before = missionFeatures(scenario);
    expect(before).toHaveLength(141);
    expect(before.every((row) => row.length === 51 && row.every(Number.isFinite))).toBe(true);
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
    }
    expect(missionFeatures(changed)).toEqual(before);
    const originalPredictions = extractPredictions(
      analyzeTemporalScenario(scenario, { modelEnabled: true }),
    );
    const changedPredictions = extractPredictions(
      analyzeTemporalScenario(changed, { modelEnabled: true }),
    );
    expect(correctPredictions(changedPredictions, before, simpleEnvelope(), 'window-p95')).toEqual(
      correctPredictions(originalPredictions, before, simpleEnvelope(), 'window-p95'),
    );
  });

  it('TC-NC-006 future observations cannot change earlier features or corrected predictions', () => {
    const scenario = generateTemporalScenario({
      seed: 80_002,
      scenarioId: 'cross-sensor-decoupling',
      sampleCount: 180,
    });
    const beforeFeatures = missionFeatures(scenario);
    const beforePredictions = extractPredictions(
      analyzeTemporalScenario(scenario, { modelEnabled: true }),
    );
    const changed = structuredClone(scenario);
    for (const sample of changed.samples.slice(100)) {
      sample.measurements.barometricAltitude = 100_000;
      sample.measurements.gpsGroundSpeed = null;
      sample.measurements.vibration = 900;
    }
    const afterFeatures = missionFeatures(changed);
    const afterPredictions = extractPredictions(
      analyzeTemporalScenario(changed, { modelEnabled: true }),
    );
    expect(afterFeatures.slice(0, 61)).toEqual(beforeFeatures.slice(0, 61));
    const envelope = simpleEnvelope();
    expect(
      correctPredictions(afterPredictions, afterFeatures, envelope, 'window-p95').slice(0, 100),
    ).toEqual(
      correctPredictions(beforePredictions, beforeFeatures, envelope, 'window-p95').slice(0, 100),
    );
  });
});

describe('paired detector comparisons and fresh partitions', () => {
  it('TC-NC-007 self-comparison has exactly zero paired deltas and never claims improvement', () => {
    const pairs = pairedCases();
    const result = compareDetectors(pairs, 'self');
    expect(result.constraints).toMatchObject({
      passed: true,
      overallRecallDrop: 0,
      pairedP95AddedDelayMs: 0,
      pairedDetections: 3,
    });
    expect(result.decision).toBe('inconclusive');
    expect(result.baseline.detectorId).toBe('registered-v2');
    expect(result.candidate.detectorId).toBe('self');
    expect(result.bootstrap.seedCount).toBe(3);
    for (const key of [
      'nominalFalseAlarmRateDelta',
      'activeRecallDelta',
      'pairedMeanAddedDelayMs',
    ]) {
      expect(result.confidence[key]).toEqual({ lower: 0, upper: 0, validReplicates: 1_000 });
    }
    expect(compareDetectors(pairs, 'self')).toEqual(result);
    const duplicatedVariants = pairs.flatMap((pair) => {
      const duplicate = structuredClone(pair);
      duplicate.baseline.caseId += ':variant';
      duplicate.baseline.variantId = 'replicated-variant';
      duplicate.candidates.self!.caseId = duplicate.baseline.caseId;
      duplicate.candidates.self!.variantId = duplicate.baseline.variantId;
      return [pair, duplicate];
    });
    expect(compareDetectors(duplicatedVariants, 'self').confidence).toEqual(result.confidence);
    expect(compareDetectors(pairs, 'self', false).confidence.nominalFalseAlarmRateDelta).toEqual({
      lower: null,
      upper: null,
      validReplicates: 0,
    });
  });

  it('TC-NC-008 unavailable nominal scores yield null rates and cannot pass acceptance', () => {
    const result = compareDetectors(pairedCases(true), 'self');
    expect(result.baseline.nominalFalseAlarmRate).toBeNull();
    expect(result.candidate.nominalFalseAlarmRate).toBeNull();
    expect(result.constraints.passed).toBe(false);
    expect(result.decision).toBe('rejected');
    expect(result.confidence.nominalFalseAlarmRateDelta).toEqual({
      lower: null,
      upper: null,
      validReplicates: 0,
    });
    expect(result.confidence.pairedMeanAddedDelayMs).toEqual({
      lower: null,
      upper: null,
      validReplicates: 0,
    });
  });

  it('TC-NC-009 rejects unmatched identity, timeline, duration, cadence, and inference coverage', () => {
    expect(() => compareDetectors([], 'self')).toThrow();
    const pairs = pairedCases();
    expect(() => compareDetectors([pairs[0]!, pairs[0]!], 'self')).toThrow();
    expect(() => compareDetectors(pairs, 'missing')).toThrow();
    const mutations: ((value: MissionEvaluationResult) => void)[] = [
      (value) => {
        value.caseId += ':other';
      },
      (value) => {
        value.seed += 1;
      },
      (value) => {
        value.family = 'noise-growth';
      },
      (value) => {
        value.variantId = 'other';
      },
      (value) => {
        value.faultTimeline = { onsetIndex: 50, activeEndIndex: 60, recoveryEndIndex: 65 };
      },
      (value) => {
        value.sampleCount -= 1;
      },
      (value) => {
        value.cadenceMs *= 2;
      },
      (value) => {
        value.policies['model-k1']!.eligibleSamples -= 1;
      },
      (value) => {
        value.policies['model-k1']!.unavailableSamples += 1;
      },
      (value) => {
        value.policies['model-k1']!.nominalEvaluable = false;
      },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(pairs);
      mutate(changed[0]!.candidates.self!);
      expect(() => compareDetectors(changed, 'self')).toThrow();
    }
  });

  it('TC-NC-010 protects historical seeds, both previous sprint partitions, and all new partitions', () => {
    const defaults = () => [
      [...PROTOCOL.fitSeeds],
      [...PROTOCOL.calibrationSeeds],
      [...PROTOCOL.developmentSeeds],
      [...PROTOCOL.finalSeeds],
    ];
    expect(() => validatePartitions([1_101, 2_101, 9_101])).not.toThrow();
    expect(() => validatePartitions([PROTOCOL.fitSeeds[0]!])).toThrow(/overlap|invalid/);
    for (const excluded of [
      PREVIOUS_PROTOCOL.developmentSeeds[0]!,
      PREVIOUS_PROTOCOL.finalSeeds[0]!,
      1_101,
      0,
      2_147_483_648,
      3.5,
    ]) {
      const partitions = defaults();
      partitions[0]![0] = excluded;
      expect(() => validatePartitions([1_101], partitions)).toThrow();
    }
    const duplicateWithin = defaults();
    duplicateWithin[0]![1] = duplicateWithin[0]![0]!;
    expect(() => validatePartitions([], duplicateWithin)).toThrow();
    const duplicateAcross = defaults();
    duplicateAcross[1]![0] = duplicateAcross[0]![0]!;
    expect(() => validatePartitions([], duplicateAcross)).toThrow();
    expect(() => validatePartitions([], defaults().slice(1))).toThrow(/sizes/);
    const short = defaults();
    short[3]!.pop();
    expect(() => validatePartitions([], short)).toThrow(/sizes/);
  });
});

describe('frozen experimental runner', () => {
  it('TC-NC-011 checks CLI and embedded evidence integrity', () => {
    expect(parseArguments(['--stage', 'fit']).stage).toBe('fit');
    expect(parseArguments(['--stage', 'replay', '--case-id', 'x']).caseId).toBe('x');
    for (const args of [
      [],
      ['--stage', 'bad'],
      ['--stage', 'final', '--case-id', 'x'],
      ['--stage', 'replay'],
      ['--stage', 'fit', '--stage', 'fit'],
      ['--wat', 'x'],
      ['--stage'],
    ])
      expect(() => parseArguments(args)).toThrow();
    const value = seal({ example: [1, 2] });
    expect(verify(value)).toEqual(value);
    expect(() => verify({ ...value, example: [2, 1] })).toThrow(/checksum/);
  });

  it('TC-NC-014 signed paired deltas and recall guard match a hand-calculated improvement and loss', () => {
    const pairs = pairedCases();
    for (const pair of pairs) {
      const value = pair.candidates.self!.policies['model-k1']!;
      if (pair.baseline.family === 'nominal') {
        value.nominalFalseAlarm = false;
        value.falseAlarmEpisodes = 0;
        value.intervals = [];
      } else {
        value.detectionDelayMs = 3000;
        value.detectionIndex = 53;
      }
    }
    const result = compareDetectors(pairs, 'self');
    expect(result.decision).toBe('improved');
    expect(result.candidate.nominalFalseAlarmRate).toBe(0);
    expect(result.confidence.nominalFalseAlarmRateDelta).toEqual({
      lower: -1,
      upper: -1,
      validReplicates: 1000,
    });
    expect(result.confidence.activeRecallDelta).toEqual({
      lower: 0,
      upper: 0,
      validReplicates: 1000,
    });
    expect(result.confidence.pairedMeanAddedDelayMs).toEqual({
      lower: 3000,
      upper: 3000,
      validReplicates: 1000,
    });
    expect(result.constraints.pairedP95AddedDelayMs).toBe(3000);
    const missed = pairs.at(-1)!.candidates.self!.policies['model-k1']!;
    missed.activeDetected = false;
    missed.detectionDelayMs = null;
    missed.detectionIndex = null;
    const rejected = compareDetectors(pairs, 'self');
    expect(rejected.constraints.overallRecallDrop).toBeCloseTo(1 / 3);
    expect(rejected.decision).toBe('rejected');
  });

  it('TC-NC-012 exact paired replay preserves registered predictions and model identity', async () => {
    const context = await loadModelContext();
    const envelope = { ...simpleEnvelope(), baselineSha256: context.artifactSha256 };
    const spec = {
      caseId: '80003:nominal:default',
      family: 'nominal',
      variantId: 'default',
      options: { seed: 80003, scenarioId: 'nominal' as const, sampleCount: 180, cadenceMs: 1000 },
    };
    const hash = hashObject(context);
    const first = pairedMission(spec, context, envelope, ['window-p95']);
    expect(pairedMission(spec, context, envelope, ['window-p95'])).toEqual(first);
    expect(hashObject(context)).toBe(hash);
    expect(first.record.baselinePredictionSha256).toBe(
      hashObject(
        extractPredictions(
          analyzeTemporalScenario(generateTemporalScenario(spec.options), { modelEnabled: true }),
        ),
      ),
    );
  });

  it('TC-NC-013 refuses missing final selection, changed sources, corrupt batches, and refitting after freeze', async () => {
    const parent = resolve(REPOSITORY_ROOT, '.tmp-tests');
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(resolve(parent, 'nominal-correction-'));
    const write = async (name: string, value: unknown) =>
      writeFile(resolve(directory, name), JSON.stringify(value));
    try {
      const source = await identity();
      const context = await loadModelContext();
      const manifest = seal({
        schemaVersion: 'nominal-correction-manifest.v1',
        protocol: PROTOCOL,
        source,
        createdAt: 'test',
      });
      await write('manifest.json', manifest);
      await write(
        'envelope.json',
        seal({ envelope: { ...simpleEnvelope(), baselineSha256: context.artifactSha256 } }),
      );
      await expect(run('final', directory)).rejects.toThrow(/ENOENT/);
      await write(
        'manifest.json',
        seal({
          schemaVersion: manifest.schemaVersion,
          protocol: PROTOCOL,
          source: { ...source, sha256: 'changed' },
          createdAt: 'test',
        }),
      );
      await expect(run('development', directory)).rejects.toThrow(/Source\/protocol changed/);
      await write('manifest.json', manifest);
      await mkdir(resolve(directory, 'development', 'batches'), { recursive: true });
      await write('development/batches/0.json', { contentSha256: 'corrupt', records: [] });
      await expect(run('development', directory)).rejects.toThrow(/checksum/);
      expect(
        JSON.parse(await readFile(resolve(directory, 'development/status.json'), 'utf8')).status,
      ).toBe('failed');
      await write('selection.json', {});
      await expect(run('fit', directory)).rejects.toThrow(/Cannot fit/);
      await expect(run('development', directory)).rejects.toThrow(/frozen/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
