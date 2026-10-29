import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';
import { evaluateMission, type PredictionPoint } from '../../src/mission-evaluation';
import { faultSpecific } from '../../tools/full-mission-model/specificity';
import * as incumbentModel from '../../tools/full-mission-model/model';
import * as missionProtocol from '../../tools/mission-evaluation/protocol';
import { seal } from '../../tools/nominal-correction/run';
import {
  cases,
  compare,
  predictions,
  select,
  settings,
  type Comparison,
  type RecordResult,
  type Setting,
} from '../../tools/residual-lag/evaluate';
import * as residualEvaluate from '../../tools/residual-lag/evaluate';
import {
  score,
  validateArtifact,
  verifyParity,
  type Artifact,
} from '../../tools/residual-lag/model';
import { PROTOCOL, validateSeeds } from '../../tools/residual-lag/protocol';
import * as residualProtocol from '../../tools/residual-lag/protocol';
import { parseArguments, run } from '../../tools/residual-lag/run';

const sourceSha256 = 'a'.repeat(64);
const target: Setting = { id: 'targeted-0', modelId: 'targeted', threshold: 0.8 };
const timeline = { onsetIndex: 50, activeEndIndex: 90, recoveryEndIndex: 95 };

function artifact(): Artifact {
  const tree = (feature: number) => ({
    left: [1, -1, -1],
    right: [2, -1, -1],
    feature: [feature, -2, -2],
    threshold: [1, -2, -2],
    positive: [0.5, 0.25, 0.75],
  });
  return {
    schemaVersion: 'residual-lag-model.v1',
    sourceSha256,
    fitManifestSha256: 'b'.repeat(64),
    calibrationManifestSha256: 'c'.repeat(64),
    protocol: PROTOCOL,
    featureNames: Array.from({ length: 83 }, (_, i) => 'feature-' + i),
    scaler: {
      center: Array<number>(83).fill(0),
      scale: Array<number>(83).fill(1),
      constantMask: Array<boolean>(83).fill(false),
      clip: 50,
    },
    models: {
      control: {
        trees: Array.from({ length: 64 }, () => tree(71)),
        activeFeatures: Array.from({ length: 72 }, (_, i) => i),
        thresholds: [0.5, 0.8],
        featureImportances: Array<number>(72).fill(1 / 72),
      },
      targeted: {
        trees: Array.from({ length: 64 }, () => tree(72)),
        activeFeatures: Array.from({ length: 83 }, (_, i) => i).filter((i) => i !== 70 && i !== 71),
        thresholds: [0.5, 0.8],
        featureImportances: Array<number>(81).fill(1 / 81),
      },
    },
    parity: [{ features: Array<number>(83).fill(0), scores: { control: 0.25, targeted: 0.25 } }],
    fitSummary: { missions: 1, windows: 141, positiveWindows: 0, constantFeatures: 0 },
    environment: { fixture: 'hand-calculated' },
  };
}

function points(from = -1, through = -1): PredictionPoint[] {
  return Array.from({ length: 180 }, (_, i) => ({
    sampleIndex: i,
    timestampMs: i * 1000,
    phase: 'cruise',
    deterministic: false,
    modelState: i < 39 ? 'warmup' : i >= from && i <= through ? 'anomalous' : 'nominal',
  }));
}

function pairedRecords(
  seeds = [81_010, 81_011, 81_012],
  improvedCruise = seeds.length,
): RecordResult[] {
  return seeds.flatMap((seed, index) =>
    [
      { family: 'nominal', variantId: 'default', stream: 'primary' as const },
      { family: 'lag', variantId: 'default', stream: 'primary' as const },
      { family: 'lag', variantId: 'standard-cruise', stream: 'primary' as const },
      { family: 'lag', variantId: 'standard-cruise', stream: 'current-noise' as const },
    ].map(({ family, variantId, stream }) => {
      const nominal = family === 'nominal';
      const baseline = nominal
        ? points(42, 44)
        : variantId === 'default'
          ? points(60, 64)
          : points();
      const detected =
        stream === 'current-noise' || variantId === 'default' || index < improvedCruise;
      const candidate = !nominal && detected ? points(60, 64) : points();
      const spec = {
        caseId: [seed, family, variantId, stream].join(':'),
        family,
        variantId,
        stream,
        options: {
          seed,
          scenarioId: nominal ? ('nominal' as const) : ('lag' as const),
          sampleCount: 180,
          cadenceMs: 1000,
          startedAt: '2026-01-01T00:00:00.000Z',
        },
      };
      const evaluate = (trace: PredictionPoint[]) =>
        evaluateMission(
          {
            caseId: spec.caseId,
            seed,
            family,
            variantId,
            cadenceMs: 1000,
            faultTimeline: nominal ? null : timeline,
            predictions: trace,
          },
          ['model-k1'],
        );
      return {
        spec,
        scenarioSha256: 'fixture',
        predictionSha256: {},
        evaluations: {
          incumbent: evaluate(baseline),
          [target.id]: evaluate(candidate),
          registered: evaluate(points()),
        },
        specific: nominal
          ? {}
          : {
              incumbent: faultSpecific(baseline, points(), timeline),
              [target.id]: faultSpecific(candidate, points(), timeline),
            },
      };
    }),
  );
}

describe('residual-lag model and inference contract', () => {
  it('TC-RL-008 routes global 83-column features with distinct 72/81 masks and float32 parity', () => {
    const model = artifact();
    expect(() => validateArtifact(model, sourceSha256)).not.toThrow();
    expect(model.models.control.activeFeatures).toHaveLength(72);
    expect(model.models.targeted.activeFeatures).toHaveLength(81);
    const row = Array<number>(83).fill(0);
    row[70] = 30;
    row[71] = 2;
    expect(score(row, model, 'control')).toBe(0.75);
    expect(score(row, model, 'targeted')).toBe(0.25);
    row[72] = 1 + 1e-8;
    expect(row[72]).toBeGreaterThan(1);
    expect(score(row, model, 'targeted')).toBe(0.25);
    row[72] = 1.001;
    expect(score(row, model, 'targeted')).toBe(0.75);
    model.scaler.center[72] = 10;
    model.scaler.scale[72] = 2;
    row[72] = 12;
    expect(score(row, model, 'targeted')).toBe(0.25);
    row[72] = 1000;
    for (const tree of model.models.targeted.trees) tree.threshold[0] = 50;
    expect(score(row, model, 'targeted')).toBe(0.25);
    for (const tree of model.models.targeted.trees) tree.threshold[0] = 1;
    model.scaler.constantMask[72] = true;
    expect(score(row, model, 'targeted')).toBe(0.25);
    expect(verifyParity(artifact())).toEqual({ cases: 1, maximumError: 0, tolerance: 1e-10 });
    const wrong = artifact();
    wrong.parity[0]!.scores.targeted = 0.75;
    expect(() => verifyParity(wrong)).toThrow(/mismatch/);
    wrong.parity = [];
    expect(() => verifyParity(wrong)).toThrow(/Missing parity/);
    expect(() => score(row.slice(1), artifact(), 'targeted')).toThrow();
    row[0] = NaN;
    expect(() => score(row, artifact(), 'targeted')).toThrow();
  });

  it('TC-RL-009 rejects masked features, malformed trees, cycles and preprocessing provenance drift', () => {
    const mutations: ((value: Artifact) => void)[] = [
      (a) => {
        a.sourceSha256 = 'changed';
      },
      (a) => {
        a.featureNames[1] = a.featureNames[0]!;
      },
      (a) => {
        a.scaler.scale[0] = 0;
      },
      (a) => {
        a.scaler.center[0] = Infinity;
      },
      (a) => {
        a.scaler.clip = 49;
      },
      (a) => {
        a.scaler.constantMask.pop();
      },
      (a) => {
        a.models.control.activeFeatures.reverse();
      },
      (a) => {
        a.models.targeted.activeFeatures[70] = 70;
      },
      (a) => {
        a.models.targeted.trees[0]!.feature[0] = 71;
      },
      (a) => {
        a.models.control.trees[0]!.feature[0] = 72;
      },
      (a) => {
        a.models.targeted.trees[0]!.left[0] = 0;
      },
      (a) => {
        a.models.targeted.trees[0]!.right[0] = 3;
      },
      (a) => {
        a.models.targeted.trees[0]!.right[0] = -1;
      },
      (a) => {
        a.models.targeted.trees[0]!.positive[1] = 1.01;
      },
      (a) => {
        a.models.targeted.trees[0]!.threshold[0] = NaN;
      },
      (a) => {
        a.models.targeted.trees[0]!.feature.pop();
      },
      (a) => {
        a.models.targeted.trees.pop();
      },
      (a) => {
        a.models.targeted.thresholds = [];
      },
      (a) => {
        a.models.targeted.thresholds = [Infinity];
      },
      (a) => {
        a.models.targeted.featureImportances.pop();
      },
    ];
    for (const mutate of mutations) {
      const model = structuredClone(artifact());
      mutate(model);
      expect(() => validateArtifact(model, sourceSha256)).toThrow();
    }
    const altered = structuredClone(artifact());
    altered.protocol = { ...PROTOCOL, cadenceMs: 2000 } as unknown as typeof PROTOCOL;
    expect(() => validateArtifact(altered, sourceSha256)).toThrow(/provenance/);
  });

  it('TC-RL-010 preserves warmup and metadata, uses strict thresholds, and rejects invalid scores', () => {
    const baseline = points(0, 179);
    baseline[39]!.modelState = 'abstained';
    baseline[40]!.modelState = 'unavailable';
    baseline[41]!.deterministic = true;
    const original = structuredClone(baseline);
    const values = Array<number>(141).fill(0.8);
    values[1] = 0.80001;
    const trace = predictions(baseline, values, 0.8);
    expect(trace.slice(0, 39).every((p) => p.modelState === 'warmup')).toBe(true);
    expect(trace[39]!.modelState).toBe('nominal');
    expect(trace[40]!.modelState).toBe('anomalous');
    expect(trace[41]!.modelState).toBe('nominal');
    expect(trace[41]!.deterministic).toBe(true);
    expect(
      trace.map(({ sampleIndex, timestampMs, phase }) => ({ sampleIndex, timestampMs, phase })),
    ).toEqual(
      baseline.map(({ sampleIndex, timestampMs, phase }) => ({ sampleIndex, timestampMs, phase })),
    );
    expect(baseline).toEqual(original);
    expect(() => predictions(baseline.slice(1), values, 0.8)).toThrow();
    expect(() => predictions(baseline, values.slice(1), 0.8)).toThrow();
    for (const invalid of [NaN, Infinity, -0.001, 1.001]) {
      expect(() => predictions(baseline, Array<number>(141).fill(invalid), 0.8)).toThrow();
      expect(() => predictions(baseline, values, invalid)).toThrow();
    }
  });
});

describe('case partition, selection and paired acceptance', () => {
  it('TC-RL-011 enumerates 41 primary cases plus a separately identified challenge and disjoint fresh partitions', async () => {
    const matrix = cases([81_013, 81_014]);
    expect(matrix).toHaveLength(84);
    expect(new Set(matrix.map((c) => c.caseId)).size).toBe(84);
    for (const seed of [81_013, 81_014]) {
      const rows = matrix.filter((c) => c.options.seed === seed);
      const primary = rows.filter((c) => c.stream === 'primary');
      const challenge = rows.filter((c) => c.stream === 'current-noise');
      expect(primary).toHaveLength(41);
      expect(primary[0]!.family).toBe('nominal');
      expect(challenge).toHaveLength(1);
      const lag = primary.find((c) => c.family === 'lag' && c.variantId === 'standard-cruise')!;
      expect(challenge[0]!.options).toEqual(lag.options);
      expect(challenge[0]!.caseId).toBe(lag.caseId + ':current-noise');
      expect(rows.every((c) => c.options.sampleCount === 180 && c.options.cadenceMs === 1000)).toBe(
        true,
      );
    }
    const partitions = [
      PROTOCOL.fitSeeds,
      PROTOCOL.calibrationSeeds,
      PROTOCOL.developmentSeeds,
      PROTOCOL.finalSeeds,
    ];
    expect(partitions.map((p) => p.length)).toEqual([60, 40, 40, 80]);
    expect(new Set(partitions.flat()).size).toBe(220);
    expect(partitions.map((p) => [p[0], p.at(-1)])).toEqual([
      [22101, 22160],
      [23101, 23140],
      [24101, 24140],
      [25101, 25180],
    ]);
    const identity = await residualProtocol.identity();
    expect(() => validateSeeds(identity.excludedSeeds)).not.toThrow();
    expect(identity.excludedSeeds).toEqual(
      expect.arrayContaining([12101, 13101, 14101, 17101, 18101, 21180]),
    );
    for (const partition of partitions)
      expect(() => validateSeeds([partition[0]!])).toThrow(/Overlapping/);
    expect(cases([])).toEqual([]);
    expect(settings(artifact())).toEqual([
      { id: 'control-0', modelId: 'control', threshold: 0.5 },
      { id: 'control-1', modelId: 'control', threshold: 0.8 },
      { id: 'targeted-0', modelId: 'targeted', threshold: 0.5 },
      { id: 'targeted-1', modelId: 'targeted', threshold: 0.8 },
    ]);
  });

  it('TC-RL-012 selects within model, prioritizes passing guards and applies declared tie and diagnostic fallback ordering', () => {
    const item = (
      id: string,
      passed: boolean,
      fa: number | null,
      cruise: number | null,
      confirmed = 0.8,
      threshold = 0.8,
      preserving = true,
      modelId: 'targeted' | 'control' = 'targeted',
    ) =>
      ({
        setting: { id, modelId, threshold },
        passed,
        preservationReasons: preserving ? [] : ['recall lost'],
        ordinary: { candidate: { nominalFalseAlarmRate: fa } },
        cruise: { candidate: { recall: cruise } },
        confirmed: { candidate: { recall: confirmed } },
      }) as unknown as Comparison;
    const passing = item('pass', true, 0.2, 0.8);
    const comparisons = [
      item('reject', false, 0, 1),
      passing,
      item('control', true, 0, 1, 1, 0.5, true, 'control'),
    ];
    const ids = comparisons.map((c) => c.setting.id);
    expect(select(comparisons, 'targeted').setting.id).toBe('pass');
    expect(select(comparisons, 'control').setting.id).toBe('control');
    expect(comparisons.map((c) => c.setting.id)).toEqual(ids);
    expect(select([passing, item('lower-fa', true, 0.1, 0.7)], 'targeted').setting.id).toBe(
      'lower-fa',
    );
    expect(select([passing, item('better-cruise', true, 0.2, 0.9)], 'targeted').setting.id).toBe(
      'better-cruise',
    );
    expect(
      select([passing, item('better-confirmed', true, 0.2, 0.8, 0.9)], 'targeted').setting.id,
    ).toBe('better-confirmed');
    expect(
      select([passing, item('lower-threshold', true, 0.2, 0.8, 0.8, 0.7)], 'targeted').setting.id,
    ).toBe('lower-threshold');
    expect(
      select(
        [item('unsafe', false, 0, 1, 1, 0.5, false), item('preserved', false, 0.4, 0.7)],
        'targeted',
      ).setting.id,
    ).toBe('preserved');
    const rejected = select(
      [item('less-lag', false, 0, 0.6), item('more-lag', false, 0.4, 0.9)],
      'targeted',
    );
    expect(rejected.setting.id).toBe('more-lag');
    expect(rejected.passed).toBe(false);
    expect(() => select([], 'targeted')).toThrow(/Missing/);
    expect(() => select([passing], 'control')).toThrow(/Missing/);
  });

  it('TC-RL-013 uses the incumbent and requires independent positive cruise and current-noise gains', () => {
    const rows = pairedRecords();
    const result = compare(rows, target);
    expect(result.ordinary.baseline.detectorId).toBe('full-mission-incumbent-threshold0.8');
    expect(result.ordinary.baseline.nominalFalseAlarmRate).toBe(1);
    expect(result.ordinary.candidate.nominalFalseAlarmRate).toBe(0);
    expect(result.ordinary.baseline.faultMissions).toBe(6);
    expect(result.ordinary.confidence.nominalFalseAlarmRateDelta).toMatchObject({
      lower: -1,
      upper: -1,
    });
    expect(result.confirmed.recallGain).toBe(0.5);
    expect(result.cruise.recallGain).toBe(1);
    expect(result.challenge.recallGain).toBe(1);
    expect(result.cruise.recallGainInterval).toMatchObject({
      lower: 1,
      upper: 1,
      validReplicates: 1000,
    });
    expect(result.challenge.recallGainInterval).toMatchObject({
      lower: 1,
      upper: 1,
      validReplicates: 1000,
    });
    expect(result.passed).toBe(true);
    expect(compare(rows, target)).toEqual(result);
    const noChallengeGain = structuredClone(rows);
    for (const row of noChallengeGain.filter((r) => r.spec.stream === 'current-noise'))
      row.specific[target.id] = structuredClone(row.specific.incumbent!);
    const rejected = compare(noChallengeGain, target);
    expect(rejected.passed).toBe(false);
    expect(rejected.reasons).toEqual(
      expect.arrayContaining([
        'current-noise cruise lag: confirmed gain below ten points or undefined.',
        'current-noise cruise lag: confirmed gain lacks positive paired confidence bound.',
      ]),
    );
    expect(rejected.ordinary).toEqual(result.ordinary);
    const noFalseAlarmReduction = structuredClone(rows);
    for (const row of noFalseAlarmReduction.filter((r) => r.spec.family === 'nominal'))
      row.evaluations[target.id] = structuredClone(row.evaluations.incumbent!);
    expect(compare(noFalseAlarmReduction, target).reasons).toContain(
      'Nominal reduction lacks a strictly negative paired confidence bound.',
    );
  });

  it('TC-RL-014 rejects a sub-ten-point cruise gain and excessive paired delay even with nominal improvement', () => {
    const smallGain = compare(
      pairedRecords(
        Array.from({ length: 20 }, (_, i) => 81_020 + i),
        1,
      ),
      target,
    );
    expect(smallGain.cruise.recallGain).toBe(0.05);
    expect(smallGain.reasons).toContain(
      'primary cruise lag: confirmed gain below ten points or undefined.',
    );
    expect(smallGain.passed).toBe(false);
    const delayed = pairedRecords();
    for (const row of delayed.filter(
      (r) => r.spec.family === 'lag' && r.spec.variantId === 'default',
    )) {
      row.specific[target.id]!.delayMs! += 6000;
      row.specific[target.id]!.detectionIndex! += 6;
    }
    const result = compare(delayed, target);
    expect(result.confirmed.p95AddedDelayMs).toBe(6000);
    expect(result.preservationReasons).toContain(
      'Paired confirmed p95 added delay exceeds five seconds or is undefined.',
    );
    expect(result.passed).toBe(false);
  });
});

describe('residual-lag CLI and frozen orchestration guards', () => {
  it('TC-RL-015 accepts only stage-specific options and does not silently allow duplicate flags', () => {
    expect(parseArguments(['--stage', 'development']).output).toBe(
      resolve(missionProtocol.REPOSITORY_ROOT, 'reports/residual-lag-v1'),
    );
    expect(
      parseArguments(['--stage', 'train', '--python', 'python.exe', '--incumbent', 'model.json'])
        .options,
    ).toMatchObject({ python: 'python.exe', incumbentPath: 'model.json' });
    expect(
      parseArguments(['--stage', 'replay', '--case-id', 'fixture', '--output', 'local']).output,
    ).toBe(resolve('local'));
    expect(parseArguments(['--stage', 'final']).stage).toBe('final');
    for (const args of [
      [],
      ['--stage', 'bad'],
      ['--stage', 'train'],
      ['--stage', 'train', '--python', 'python.exe'],
      ['--stage', 'final', '--python', 'python.exe'],
      ['--stage', 'development', '--incumbent', 'model.json'],
      ['--stage', 'replay'],
      ['--stage', 'final', '--case-id', 'x'],
      ['--stage', 'final', '--output'],
      ['--stage', 'final', '--unknown', 'x'],
      ['--stage', 'final', '--stage', 'final'],
    ])
      expect(() => parseArguments(args)).toThrow();
  });

  it('TC-RL-016 rejects missing selection, corrupt cache, changed sources and frozen development without generating missions', async () => {
    const temporaryParent = resolve(tmpdir());
    const directory = await mkdtemp(resolve(temporaryParent, 'flight-residual-lag-fixture-'));
    if (!resolve(directory).startsWith(temporaryParent + sep))
      throw new Error('Unsafe fixture cleanup path.');
    const write = (name: string, value: unknown) =>
      writeFile(resolve(directory, name), JSON.stringify(value));
    const actualHash = missionProtocol.hashObject;
    // Exercise file/provenance gates without requiring the large completed incumbent artifact.
    const fakeIncumbent = {
      featureNames: ['guard-incumbent'],
      scaler: {},
      models: { forest: { type: 'random-forest', trees: [] } },
    };
    const fakeSource = {
      sha256: sourceSha256,
      parentSourceSha256: 'b'.repeat(64),
      files: {},
      excludedSeeds: [],
    } as unknown as Awaited<ReturnType<typeof residualProtocol.identity>>;
    const incumbentBytes = JSON.stringify(fakeIncumbent);
    const manifest = {
      schemaVersion: 'residual-lag-manifest.v1',
      source: fakeSource,
      protocol: PROTOCOL,
      incumbentSha256: missionProtocol.sha256(incumbentBytes),
    };
    const inference = vi.spyOn(residualEvaluate, 'infer').mockImplementation(() => {
      throw new Error('Fixture must never generate or score experiment missions.');
    });
    vi.spyOn(residualProtocol, 'identity').mockResolvedValue(fakeSource);
    vi.spyOn(missionProtocol, 'loadModelContext').mockResolvedValue(
      {} as Awaited<ReturnType<typeof missionProtocol.loadModelContext>>,
    );
    vi.spyOn(incumbentModel, 'validateArtifact').mockImplementation(() => {});
    vi.spyOn(missionProtocol, 'hashObject').mockImplementation((value) => {
      const candidate = value as { featureNames?: string[]; trees?: unknown } | null;
      return candidate?.featureNames?.[0] === 'guard-incumbent' && candidate.trees
        ? PROTOCOL.incumbentInferenceSha256
        : actualHash(value);
    });
    try {
      await write('manifest.json', seal(manifest));
      await write('model.json', artifact());
      await writeFile(resolve(directory, 'incumbent.json'), incumbentBytes);
      await expect(run('final', directory)).rejects.toThrow(/ENOENT/);
      await write('selection.json', {});
      await expect(
        run('train', directory, { python: 'unused', incumbentPath: 'unused' }),
      ).rejects.toThrow(/frozen/);
      await expect(run('development', directory)).rejects.toThrow(/frozen/);
      await rm(resolve(directory, 'selection.json'));
      await mkdir(resolve(directory, 'final'));
      await write('final/manifest.json', {});
      await expect(run('development', directory)).rejects.toThrow(/frozen/);
      await rm(resolve(directory, 'final/manifest.json'));
      await write(
        'manifest.json',
        seal({ ...manifest, source: { ...fakeSource, sha256: 'changed' } }),
      );
      await expect(run('development', directory)).rejects.toThrow(/source\/protocol changed/);
      await write('manifest.json', seal(manifest));
      await mkdir(resolve(directory, 'development/batches'), { recursive: true });
      await write('development/batches/0.json', { contentSha256: 'corrupt', records: [] });
      await expect(run('development', directory)).rejects.toThrow(/checksum/);
      expect(
        JSON.parse(await readFile(resolve(directory, 'development/status.json'), 'utf8')),
      ).toMatchObject({ status: 'failed', completed: 0 });
      await write('development/report.json', seal({ status: 'fixture-only' }));
      await write('selection.json', seal({ sourceSha256: 'wrong' }));
      await expect(run('final', directory)).rejects.toThrow(/Frozen selection mismatch/);
      expect(inference).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
