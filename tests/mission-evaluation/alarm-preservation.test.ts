import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';
import {
  aggregateMissions,
  evaluateMission,
  type PredictionPoint,
} from '../../src/mission-evaluation';
import { faultSpecific } from '../../tools/full-mission-model/specificity';
import { cases, type RecordResult } from '../../tools/residual-lag/evaluate';
import * as incumbentModel from '../../tools/full-mission-model/model';
import * as residualModel from '../../tools/residual-lag/model';
import * as preservationEvaluate from '../../tools/alarm-preservation/evaluate';
import * as missionProtocol from '../../tools/mission-evaluation/protocol';
import { seal } from '../../tools/nominal-correction/run';
import { SETTINGS, applyPolicy, type Setting } from '../../tools/alarm-preservation/policy';
import { compare, select, type Comparison } from '../../tools/alarm-preservation/evaluate';
import { PROTOCOL, validateSeeds } from '../../tools/alarm-preservation/protocol';
import * as preservationProtocol from '../../tools/alarm-preservation/protocol';
import { writeReport } from '../../tools/alarm-preservation/report';
import { parseArguments, run, type Report } from '../../tools/alarm-preservation/run';

const setting = SETTINGS.find((s) => s.generalThreshold === 0.9 && s.lagThreshold === 0.65)!;
const timeline = { onsetIndex: 50, activeEndIndex: 90, recoveryEndIndex: 95 };
function points(from = -1, through = -1): PredictionPoint[] {
  return Array.from({ length: 180 }, (_, i) => ({
    sampleIndex: i,
    timestampMs: i * 1000,
    phase: 'cruise',
    deterministic: i % 5 === 0,
    modelState: i < 39 ? 'warmup' : i >= from && i <= through ? 'anomalous' : 'nominal',
  }));
}
function evidence(value: number | null = 1, validFraction = 1) {
  return Array.from({ length: 141 }, () => ({ value, validFraction }));
}

describe('causal alarm-preservation policy', () => {
  it('TC-AP-001 implements strict score and signed-lag boundaries with inclusive eight-point support', () => {
    const scores = Array<number>(141).fill(0);
    const lag = evidence();
    const rows: [number, number | null, number, boolean][] = [
      [0.9, -1, 1, false],
      [0.900001, null, 0, true],
      [0.65, 1, 1, false],
      [0.650001, 1, 1, true],
      [0.8, 0, 1, false],
      [0.8, -1, 1, false],
      [0.8, 1, 8 / 17, true],
      [0.8, 1, 8 / 17 - 1e-12, false],
      [0.99, -1, 0, true],
      [0.8, null, 1, false],
      [0.99, null, 0, true],
    ];
    rows.forEach(([score, value, validFraction], i) => {
      scores[i] = score;
      lag[i] = { value, validFraction };
    });
    const result = applyPolicy(points(), scores, lag, setting);
    rows.forEach(([, , , alert], i) => {
      expect(result[i + 39]!.modelState).toBe(alert ? 'anomalous' : 'nominal');
      expect(result[i + 39]!.sampleIndex).toBe(i + 39);
      expect(result[i + 39]!.timestampMs).toBe((i + 39) * 1000);
    });
  });

  it('TC-AP-002 preserves warmup, unavailable and abstained states without starting or holding alerts', () => {
    const baseline = points(0, 179);
    baseline[39]!.modelState = 'unavailable';
    baseline[40]!.modelState = 'abstained';
    baseline[41]!.modelState = 'warmup';
    const original = structuredClone(baseline);
    const scores = Array<number>(141).fill(0.99);
    scores[4] = 0;
    const lag = evidence(-1);
    const trace = applyPolicy(baseline, scores, lag, setting);
    expect(trace.slice(0, 39).every((p) => p.modelState === 'warmup')).toBe(true);
    expect(trace.slice(39, 45).map((p) => p.modelState)).toEqual([
      'unavailable',
      'abstained',
      'warmup',
      'anomalous',
      'nominal',
      'anomalous',
    ]);
    expect(
      trace.map(({ sampleIndex, timestampMs, phase, deterministic }) => ({
        sampleIndex,
        timestampMs,
        phase,
        deterministic,
      })),
    ).toEqual(
      baseline.map(({ sampleIndex, timestampMs, phase, deterministic }) => ({
        sampleIndex,
        timestampMs,
        phase,
        deterministic,
      })),
    );
    expect(baseline).toEqual(original);
    expect(scores[4]).toBe(0);
    expect(lag).toEqual(evidence(-1));
  });

  it('TC-AP-003 is point-local and changing future scores or support cannot change earlier decisions', () => {
    const scores = Array<number>(141).fill(0.8);
    const lag = evidence();
    const baseline = points();
    const before = applyPolicy(baseline, scores, lag, setting);
    const futureScores = [...scores];
    const futureLag = structuredClone(lag);
    for (let i = 61; i < 141; i++) {
      futureScores[i] = 0.2;
      futureLag[i] = { value: null, validFraction: 0 };
    }
    const after = applyPolicy(baseline, futureScores, futureLag, setting);
    expect(after.slice(0, 100)).toEqual(before.slice(0, 100));
    expect(after[100]!.modelState).toBe('nominal');
    expect(before[100]!.modelState).toBe('anomalous');
    const changedPast = [...scores];
    changedPast.fill(0, 0, 61);
    expect(applyPolicy(baseline, changedPast, lag, setting).slice(100)).toEqual(before.slice(100));
  });

  it('TC-AP-004 rejects invalid dimensions, numeric evidence and configurations and freezes a four-setting grid', () => {
    const baseline = points(),
      scores = Array<number>(141).fill(0.8),
      lag = evidence();
    expect(SETTINGS).toHaveLength(4);
    expect(new Set(SETTINGS.map((s) => s.id)).size).toBe(4);
    expect(SETTINGS.map((s) => [s.generalThreshold, s.lagThreshold]).sort()).toEqual([
      [0.9, 0.65],
      [0.9, 0.7],
      [0.95, 0.65],
      [0.95, 0.7],
    ]);
    expect(() => applyPolicy(baseline.slice(1), scores, lag, setting)).toThrow();
    expect(() => applyPolicy(baseline, scores.slice(1), lag, setting)).toThrow();
    expect(() => applyPolicy(baseline, scores, lag.slice(1), setting)).toThrow();
    expect(() => applyPolicy(baseline, scores, evidence(NaN), setting)).toThrow();
    expect(() => applyPolicy(baseline, scores, evidence(Infinity), setting)).toThrow();
    expect(() => applyPolicy(baseline, scores, lag, { ...setting, id: 'undeclared' })).toThrow();
    for (const value of [NaN, Infinity, -0.01, 1.01]) {
      expect(() => applyPolicy(baseline, Array<number>(141).fill(value), lag, setting)).toThrow();
      expect(() => applyPolicy(baseline, scores, evidence(1, value), setting)).toThrow();
      expect(() =>
        applyPolicy(baseline, scores, lag, { ...setting, generalThreshold: value } as Setting),
      ).toThrow();
      expect(() =>
        applyPolicy(baseline, scores, lag, { ...setting, lagThreshold: value } as Setting),
      ).toThrow();
    }
  });
});

function replaceTrace(row: RecordResult, id: string, trace: PredictionPoint[]) {
  const nominal = row.spec.family === 'nominal';
  row.evaluations[id] = evaluateMission(
    {
      caseId: row.spec.caseId,
      seed: row.spec.options.seed,
      family: row.spec.family,
      variantId: row.spec.variantId,
      cadenceMs: 1000,
      faultTimeline: nominal ? null : timeline,
      predictions: trace,
    },
    ['model-k1'],
  );
  if (!nominal) row.specific[id] = faultSpecific(trace, points(), timeline);
}
function records(seeds = [81_050, 81_051, 81_052]): RecordResult[] {
  return seeds.flatMap((seed) =>
    [
      { family: 'nominal', variantId: 'default', stream: 'primary' as const },
      { family: 'lag', variantId: 'default', stream: 'primary' as const },
      { family: 'lag', variantId: 'standard-cruise', stream: 'primary' as const },
      { family: 'lag', variantId: 'standard-cruise', stream: 'current-noise' as const },
    ].map(({ family, variantId, stream }) => {
      const nominal = family === 'nominal';
      const row: RecordResult = {
        spec: {
          caseId: [seed, family, variantId, stream].join(':'),
          family,
          variantId,
          stream,
          options: {
            seed,
            scenarioId: nominal ? 'nominal' : 'lag',
            sampleCount: 180,
            cadenceMs: 1000,
            startedAt: '2026-01-01T00:00:00.000Z',
          },
        },
        scenarioSha256: 'hand-fixture',
        predictionSha256: {},
        evaluations: {},
        specific: {},
      };
      replaceTrace(row, 'registered', points());
      replaceTrace(
        row,
        'incumbent',
        !nominal && variantId === 'default' ? points(60, 64) : points(),
      );
      replaceTrace(row, 'lag-baseline', nominal ? points(42, 44) : points(60, 64));
      replaceTrace(
        row,
        'strict-high',
        !nominal && variantId === 'default' ? points(60, 64) : points(),
      );
      replaceTrace(row, setting.id, nominal ? points() : points(60, 64));
      return row;
    }),
  );
}

describe('paired alarm and cruise preservation gates', () => {
  it('TC-AP-005 improves against the lag-sensitive target without requiring fewer alarms than the earlier forest', () => {
    const rows = records(),
      result = compare(rows, setting);
    expect(result.versusTarget.ordinary.baseline.nominalFalseAlarmRate).toBe(1);
    expect(result.versusTarget.ordinary.candidate.nominalFalseAlarmRate).toBe(0);
    expect(result.versusTarget.ordinary.confidence.nominalFalseAlarmRateDelta).toMatchObject({
      lower: -1,
      upper: -1,
    });
    expect(result.versusIncumbent.ordinary.baseline.nominalFalseAlarmRate).toBe(0);
    expect(result.versusIncumbent.ordinary.confidence.nominalFalseAlarmRateDelta).toMatchObject({
      lower: 0,
      upper: 0,
    });
    expect(result.versusTarget.ordinary.baseline.faultMissions).toBe(6);
    for (const key of ['cruise', 'challenge'] as const) {
      expect(result.versusTarget[key].recallGain).toBe(0);
      expect(result.versusTarget[key].recallGainInterval).toMatchObject({
        lower: 0,
        upper: 0,
        validReplicates: 1000,
      });
      expect(result.versusIncumbent[key].recallGain).toBe(1);
      expect(result.versusIncumbent[key].recallGainInterval).toMatchObject({
        lower: 1,
        upper: 1,
        validReplicates: 1000,
      });
    }
    expect(result.preservationReasons).toEqual([]);
    expect(result.passed).toBe(true);
    expect(compare(rows, setting)).toEqual(result);
    const noNominalImprovement = structuredClone(rows);
    for (const row of noNominalImprovement.filter((r) => r.spec.family === 'nominal'))
      replaceTrace(row, setting.id, points(42, 44));
    const rejected = compare(noNominalImprovement, setting);
    expect(rejected.preservationReasons).toEqual([]);
    expect(rejected.passed).toBe(false);
    expect(rejected.reasons).toContain(
      'Nominal reduction versus the lag-sensitive target lacks a strictly negative paired confidence bound.',
    );
  });

  it('TC-AP-006 requires point-recall preservation in each cruise stream separately', () => {
    for (const stream of ['primary', 'current-noise'] as const) {
      const rows = records();
      const lost = rows.find(
        (r) => r.spec.stream === stream && r.spec.variantId === 'standard-cruise',
      )!;
      replaceTrace(lost, setting.id, points());
      const result = compare(rows, setting);
      const key = stream === 'primary' ? 'cruise' : 'challenge';
      const other = stream === 'primary' ? 'challenge' : 'cruise';
      expect(result.versusTarget[key].recallGain).toBeCloseTo(-1 / 3);
      expect(result.versusTarget[other].recallGain).toBe(0);
      expect(result.preservationReasons).toContain(
        key + ': confirmed point recall falls below the lag-sensitive target or is undefined.',
      );
      expect(result.passed).toBe(false);
    }
  });

  it('TC-AP-007 rejects uncertain lost/gained case exchange despite preserving the point count', () => {
    const seeds = Array.from({ length: 20 }, (_, i) => 81_060 + i);
    const rows = records(seeds);
    rows
      .filter((r) => r.spec.stream === 'primary' && r.spec.variantId === 'standard-cruise')
      .forEach((row, index) => {
        replaceTrace(row, 'lag-baseline', index < 10 ? points(60, 64) : points());
        replaceTrace(row, setting.id, index < 9 || index === 10 ? points(60, 64) : points());
      });
    const result = compare(rows, setting);
    expect(result.versusTarget.cruise.baseline.detected).toBe(10);
    expect(result.versusTarget.cruise.candidate.detected).toBe(10);
    expect(result.versusTarget.cruise.recallGain).toBe(0);
    expect(result.versusTarget.cruise.recallGainInterval.lower).toBeLessThan(-0.05);
    expect(result.preservationReasons).toContain(
      'cruise: paired preservation lower bound is below minus five points or undefined.',
    );
    expect(result.passed).toBe(false);
  });

  it('TC-AP-008 allows five seconds but rejects six seconds of added confirmation delay', () => {
    for (const addedSamples of [5, 6]) {
      const rows = records();
      for (const row of rows.filter((r) => r.spec.variantId === 'standard-cruise'))
        replaceTrace(row, setting.id, points(60 + addedSamples, 64 + addedSamples));
      const result = compare(rows, setting);
      expect(result.versusTarget.cruise.p95AddedDelayMs).toBe(addedSamples * 1000);
      expect(result.versusTarget.challenge.p95AddedDelayMs).toBe(addedSamples * 1000);
      expect(result.passed).toBe(addedSamples === 5);
      if (addedSamples === 6)
        expect(result.preservationReasons).toContain(
          'challenge: confirmed paired p95 added delay exceeds five seconds or is undefined.',
        );
    }
  });

  it('TC-AP-009 retains the earlier-forest cruise gain and fails undefined target delay evidence', () => {
    const lostGain = records();
    for (const row of lostGain.filter((r) => r.spec.variantId === 'standard-cruise'))
      replaceTrace(row, 'incumbent', points(60, 64));
    const noLegacyGain = compare(lostGain, setting);
    expect(noLegacyGain.versusTarget.cruise.recallGain).toBe(0);
    expect(noLegacyGain.preservationReasons).toContain(
      'cruise: ten-point gain over the earlier forest lacks positive paired support.',
    );
    expect(noLegacyGain.passed).toBe(false);
    const noPairedDetections = records();
    for (const row of noPairedDetections.filter((r) => r.spec.stream === 'current-noise'))
      replaceTrace(row, 'lag-baseline', points());
    const undefinedDelay = compare(noPairedDetections, setting);
    expect(undefinedDelay.versusTarget.challenge.p95AddedDelayMs).toBeNull();
    expect(undefinedDelay.preservationReasons).toContain(
      'challenge: confirmed paired p95 added delay exceeds five seconds or is undefined.',
    );
    expect(undefinedDelay.passed).toBe(false);
  });
});

describe('preservation study partitions and selection', () => {
  it('TC-AP-010 excludes every earlier partition and retains the separate challenge matrix', async () => {
    expect(PROTOCOL.developmentSeeds).toHaveLength(40);
    expect(PROTOCOL.finalSeeds).toHaveLength(80);
    expect([
      PROTOCOL.developmentSeeds[0],
      PROTOCOL.developmentSeeds.at(-1),
      PROTOCOL.finalSeeds[0],
      PROTOCOL.finalSeeds.at(-1),
    ]).toEqual([26101, 26140, 27101, 27180]);
    expect(new Set([...PROTOCOL.developmentSeeds, ...PROTOCOL.finalSeeds]).size).toBe(120);
    const source = await preservationProtocol.identity();
    expect(source.excludedSeeds).toEqual(
      expect.arrayContaining([
        12101, 13180, 14101, 17180, 18101, 21180, 22101, 23101, 24101, 25180,
      ]),
    );
    expect(() => validateSeeds(source.excludedSeeds)).not.toThrow();
    expect(() => validateSeeds([26101])).toThrow(/Overlapping/);
    expect(() => validateSeeds([27180])).toThrow(/Overlapping/);
    const matrix = cases([81_080]);
    expect(matrix.filter((r) => r.stream === 'primary')).toHaveLength(41);
    expect(matrix.filter((r) => r.stream === 'current-noise')).toHaveLength(1);
  });

  it('TC-AP-011 applies passing/preserving fallback and the declared minimum-cruise/threshold tie order', () => {
    const item = (
      id: string,
      passed: boolean,
      fa: number | null,
      cruise: number | null,
      challenge: number | null,
      confirmed = 0.8,
      general = 0.9,
      lag = 0.65,
      preserving = true,
    ) =>
      ({
        setting: { id, generalThreshold: general, lagThreshold: lag },
        passed,
        preservationReasons: preserving ? [] : ['recall loss'],
        versusTarget: {
          ordinary: { candidate: { nominalFalseAlarmRate: fa } },
          cruise: { candidate: { recall: cruise } },
          challenge: { candidate: { recall: challenge } },
          confirmed: { candidate: { recall: confirmed } },
        },
      }) as unknown as Comparison;
    const baseline = item('baseline', true, 0.2, 0.8, 0.8);
    const all = [item('unsafe', false, 0, 1, 1, 1, 0.95, 0.7, false), baseline];
    const originalOrder = all.map((c) => c.setting.id);
    expect(select(all).setting.id).toBe('baseline');
    expect(all.map((c) => c.setting.id)).toEqual(originalOrder);
    expect(select([baseline, item('lower-fa', true, 0.1, 0.7, 0.7)]).setting.id).toBe('lower-fa');
    expect(select([baseline, item('one-weak-stream', true, 0.2, 1, 0.7)]).setting.id).toBe(
      'baseline',
    );
    expect(select([baseline, item('both-better', true, 0.2, 0.9, 0.9)]).setting.id).toBe(
      'both-better',
    );
    expect(select([baseline, item('confirmed', true, 0.2, 0.8, 0.8, 0.9)]).setting.id).toBe(
      'confirmed',
    );
    expect(select([baseline, item('general', true, 0.2, 0.8, 0.8, 0.8, 0.95)]).setting.id).toBe(
      'general',
    );
    expect(select([baseline, item('lag', true, 0.2, 0.8, 0.8, 0.8, 0.9, 0.7)]).setting.id).toBe(
      'lag',
    );
    const fallback = select([all[0]!, item('preserving', false, 0.4, 0.7, 0.7)]);
    expect(fallback.setting.id).toBe('preserving');
    expect(fallback.passed).toBe(false);
    expect(
      select([item('low-fa', false, 0.1, 0.4, 0.4), item('high-recall', false, 0.2, 1, 1)]).setting
        .id,
    ).toBe('low-fa');
    expect(() => select([])).toThrow(/No candidate/);
  });
});

describe('CLI and frozen run guards', () => {
  it('TC-AP-012 accepts only development parent paths and replay case IDs', () => {
    expect(parseArguments(['--stage', 'development']).output).toBe(
      resolve(missionProtocol.REPOSITORY_ROOT, 'reports/alarm-preservation-v1'),
    );
    expect(
      parseArguments(['--stage', 'development', '--parent', 'parent']).options.parentPath,
    ).toBe('parent');
    expect(
      parseArguments(['--stage', 'replay', '--case-id', 'fixture', '--output', 'local']).output,
    ).toBe(resolve('local'));
    expect(parseArguments(['--stage', 'final']).stage).toBe('final');
    for (const args of [
      [],
      ['--stage', 'train'],
      ['--stage', 'bad'],
      ['--stage', 'final', '--parent', 'parent'],
      ['--stage', 'replay', '--parent', 'parent', '--case-id', 'fixture'],
      ['--stage', 'replay'],
      ['--stage', 'final', '--case-id', 'fixture'],
      ['--stage', 'development', '--case-id', 'fixture'],
      ['--stage', 'final', '--output'],
      ['--stage', 'final', '--unknown', 'value'],
      ['--stage', 'final', '--stage', 'final'],
    ])
      expect(() => parseArguments(args)).toThrow();
  });

  it('TC-AP-013 fails closed on source/model/selection/stage/cache drift before any experiment inference', async () => {
    const parent = resolve(tmpdir());
    const directory = await mkdtemp(resolve(parent, 'flight-alarm-preservation-fixture-'));
    if (!resolve(directory).startsWith(parent + sep))
      throw new Error('Unsafe fixture cleanup path.');
    const write = (name: string, value: unknown) =>
      writeFile(resolve(directory, name), JSON.stringify(value));
    const modelBytes = JSON.stringify({ fixture: 'frozen-model' });
    const incumbentBytes = JSON.stringify({ fixture: 'frozen-incumbent' });
    const actualSha256 = missionProtocol.sha256;
    const source = {
      sha256: 'a'.repeat(64),
      parentResidualSha256: 'b'.repeat(64),
      parentSourceSha256: 'c'.repeat(64),
      files: {},
      excludedSeeds: [],
    } as unknown as Awaited<ReturnType<typeof preservationProtocol.identity>>;
    const manifest = seal({
      schemaVersion: 'alarm-preservation-manifest.v1',
      source,
      protocol: PROTOCOL,
      modelSha256: PROTOCOL.modelSha256,
      incumbentSha256: PROTOCOL.incumbentSha256,
      parentReportSha256: PROTOCOL.parentReportSha256,
    });
    const development = seal({
      schemaVersion: 'alarm-preservation-report.v1',
      stage: 'development',
      status: 'completed',
      sourceSha256: source.sha256,
      modelSha256: PROTOCOL.modelSha256,
      incumbentSha256: PROTOCOL.incumbentSha256,
      selectedId: setting.id,
      comparisons: [{ setting, passed: false }],
    });
    const freeze = {
      setting,
      developmentPassed: false,
      developmentReportSha256: development.contentSha256,
      sourceSha256: source.sha256,
      modelSha256: PROTOCOL.modelSha256,
      incumbentSha256: PROTOCOL.incumbentSha256,
      protocolSha256: missionProtocol.hashObject(PROTOCOL),
      frozenAt: '2020-01-01T00:00:00.000Z',
    };
    const inference = vi.spyOn(preservationEvaluate, 'infer').mockImplementation(() => {
      throw new Error('Fixture must not generate or score experiment missions.');
    });
    vi.spyOn(preservationProtocol, 'identity').mockResolvedValue(source);
    vi.spyOn(missionProtocol, 'loadModelContext').mockResolvedValue(
      {} as Awaited<ReturnType<typeof missionProtocol.loadModelContext>>,
    );
    // Model numerical validation has separate fixtures. Here only these exact tiny byte strings
    // stand in for frozen model artifacts; changed bytes still use their real SHA-256.
    vi.spyOn(missionProtocol, 'sha256').mockImplementation((value) => {
      const text = typeof value === 'string' ? value : value.toString('utf8');
      if (text === modelBytes) return PROTOCOL.modelSha256;
      if (text === incumbentBytes) return PROTOCOL.incumbentSha256;
      return actualSha256(value);
    });
    vi.spyOn(residualModel, 'validateArtifact').mockImplementation(() => {});
    vi.spyOn(residualModel, 'verifyParity').mockReturnValue({
      cases: 1,
      maximumError: 0,
      tolerance: 1e-10,
    });
    vi.spyOn(incumbentModel, 'validateArtifact').mockImplementation(() => {});
    try {
      await write('manifest.json', manifest);
      await writeFile(resolve(directory, 'model.json'), modelBytes);
      await writeFile(resolve(directory, 'incumbent.json'), incumbentBytes);
      await expect(run('final', directory)).rejects.toThrow(/ENOENT/);
      await write('selection.json', {});
      await expect(run('development', directory)).rejects.toThrow(/Development is frozen/);
      await rm(resolve(directory, 'selection.json'));
      await mkdir(resolve(directory, 'final'));
      await write('final/manifest.json', {});
      await expect(run('development', directory)).rejects.toThrow(/Development is frozen/);
      await rm(resolve(directory, 'final/manifest.json'));
      await write('manifest.json', { ...manifest, source: { ...source, sha256: 'tampered' } });
      await expect(run('final', directory)).rejects.toThrow(/checksum/);
      await write(
        'manifest.json',
        seal({
          schemaVersion: manifest.schemaVersion,
          source: { ...source, sha256: 'changed' },
          protocol: PROTOCOL,
          modelSha256: PROTOCOL.modelSha256,
          incumbentSha256: PROTOCOL.incumbentSha256,
          parentReportSha256: PROTOCOL.parentReportSha256,
        }),
      );
      await expect(run('final', directory)).rejects.toThrow(
        /source\/protocol\/model identity changed/,
      );
      await write('manifest.json', manifest);
      await write('model.json', { fixture: 'changed-model' });
      await expect(run('final', directory)).rejects.toThrow(/Frozen model bytes changed/);
      await writeFile(resolve(directory, 'model.json'), modelBytes);
      await write('incumbent.json', { fixture: 'changed-incumbent' });
      await expect(run('final', directory)).rejects.toThrow(/Frozen model bytes changed/);
      await writeFile(resolve(directory, 'incumbent.json'), incumbentBytes);
      await mkdir(resolve(directory, 'development'));
      await write('development/report.json', development);
      for (const changed of [
        { sourceSha256: 'wrong' },
        { modelSha256: 'wrong' },
        { incumbentSha256: 'wrong' },
        { protocolSha256: 'wrong' },
        { developmentReportSha256: 'wrong' },
        { developmentPassed: true },
        { frozenAt: 'invalid-date' },
      ]) {
        await write('selection.json', seal({ ...freeze, ...changed }));
        await expect(run('final', directory)).rejects.toThrow(/Frozen selection mismatch/);
      }
      await write(
        'selection.json',
        seal({ ...freeze, setting: { ...setting, lagThreshold: 0.6 } }),
      );
      await expect(run('final', directory)).rejects.toThrow(/frozen four-policy grid/);
      const wrongDevelopment = seal({
        schemaVersion: development.schemaVersion,
        stage: development.stage,
        status: development.status,
        sourceSha256: development.sourceSha256,
        modelSha256: development.modelSha256,
        incumbentSha256: development.incumbentSha256,
        comparisons: development.comparisons,
        selectedId: 'another-setting',
      });
      await write('development/report.json', wrongDevelopment);
      await write(
        'selection.json',
        seal({ ...freeze, developmentReportSha256: wrongDevelopment.contentSha256 }),
      );
      await expect(run('final', directory)).rejects.toThrow(/Frozen selection mismatch/);
      await write('development/report.json', development);
      const selection = seal(freeze);
      await write('selection.json', selection);
      await write('final/manifest.json', seal({ startedAt: '2019-01-01T00:00:00.000Z' }));
      await expect(run('final', directory)).rejects.toThrow(/final began before selection/);
      const stage = seal({
        stage: 'final',
        seeds: PROTOCOL.finalSeeds,
        choices: [setting],
        parentSha256: manifest.contentSha256,
        selectionSha256: selection.contentSha256,
        startedAt: '2020-01-02T00:00:00.000Z',
      });
      await write(
        'final/manifest.json',
        seal({
          stage: 'final',
          seeds: PROTOCOL.finalSeeds,
          choices: [setting],
          parentSha256: 'wrong',
          selectionSha256: selection.contentSha256,
          startedAt: '2020-01-02T00:00:00.000Z',
        }),
      );
      await expect(run('final', directory)).rejects.toThrow(/Stage manifest mismatch/);
      await write('final/manifest.json', stage);
      await write('final/batches/0.json', { contentSha256: 'corrupt', records: [] });
      await expect(run('final', directory)).rejects.toThrow(/checksum/);
      expect(
        JSON.parse(await readFile(resolve(directory, 'final/status.json'), 'utf8')),
      ).toMatchObject({ status: 'failed', completed: 0 });
      await write(
        'final/batches/0.json',
        seal({ manifestSha256: stage.contentSha256, records: [] }),
      );
      await expect(run('final', directory)).rejects.toThrow(/Batch provenance mismatch/);
      await write(
        'final/report.json',
        seal({
          stage: 'final',
          status: 'completed',
          sourceSha256: source.sha256,
          modelSha256: PROTOCOL.modelSha256,
          incumbentSha256: PROTOCOL.incumbentSha256,
          selectionSha256: 'wrong',
          settings: [setting],
          selectedId: setting.id,
        }),
      );
      await expect(run('replay', directory, { caseId: 'fixture' })).rejects.toThrow(
        /Replay provenance mismatch/,
      );
      expect(inference).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('parent binding and report output', () => {
  it('TC-AP-014 refuses a corrupt or unbound parent report before initializing output', async () => {
    const parent = resolve(tmpdir());
    const directory = await mkdtemp(resolve(parent, 'flight-preservation-parent-fixture-'));
    if (!resolve(directory).startsWith(parent + sep))
      throw new Error('Unsafe fixture cleanup path.');
    const parentPath = resolve(directory, 'parent'),
      output = resolve(directory, 'output');
    const parentSource = 'b'.repeat(64);
    vi.spyOn(preservationProtocol, 'identity').mockResolvedValue({
      sha256: 'a'.repeat(64),
      parentResidualSha256: parentSource,
    } as Awaited<ReturnType<typeof preservationProtocol.identity>>);
    const inference = vi.spyOn(preservationEvaluate, 'infer').mockImplementation(() => {
      throw new Error('Parent guard must not generate missions.');
    });
    try {
      await mkdir(resolve(parentPath, 'final'), { recursive: true });
      const reportPath = resolve(parentPath, 'final/report.json');
      await writeFile(
        reportPath,
        JSON.stringify({ contentSha256: 'corrupt', status: 'completed' }),
      );
      await expect(run('development', output, { parentPath })).rejects.toThrow(/checksum/);
      const otherCompletedReport = seal({
        status: 'completed',
        sourceSha256: parentSource,
        modelSha256: PROTOCOL.modelSha256,
        incumbentSha256: PROTOCOL.incumbentSha256,
      });
      expect(otherCompletedReport.contentSha256).not.toBe(PROTOCOL.parentReportSha256);
      await writeFile(reportPath, JSON.stringify(otherCompletedReport));
      await expect(run('development', output, { parentPath })).rejects.toThrow(
        /Expected the completed, frozen residual-lag parent/,
      );
      await expect(readFile(resolve(output, 'manifest.json'))).rejects.toThrow(/ENOENT/);
      expect(inference).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('TC-AP-015 escapes case identifiers and reasons in a complete local HTML report', async () => {
    const parent = resolve(tmpdir());
    const directory = await mkdtemp(resolve(parent, 'flight-preservation-report-fixture-'));
    if (!resolve(directory).startsWith(parent + sep))
      throw new Error('Unsafe fixture cleanup path.');
    try {
      const rows = records();
      const unsafeCase = '<img src=x onerror=alert(1)>';
      rows[0]!.spec.caseId = unsafeCase;
      for (const evaluation of Object.values(rows[0]!.evaluations)) evaluation.caseId = unsafeCase;
      const result = compare(rows, setting);
      const unsafeReason = '<script>alert("fixture")</script>';
      result.reasons.push(unsafeReason);
      result.passed = false;
      result.decision = 'rejected';
      const primary = rows.filter((r) => r.spec.stream === 'primary');
      const references = Object.fromEntries(
        ['registered', 'incumbent', 'lag-baseline', 'strict-high'].map((id) => [
          id,
          aggregateMissions(
            primary.map((r) => r.evaluations[id]!),
            'model-k1',
          ),
        ]),
      );
      references.rules = references.registered!;
      const report: Report = seal({
        schemaVersion: 'alarm-preservation-report.v1' as const,
        stage: 'development' as const,
        status: 'completed' as const,
        sourceSha256: 'a'.repeat(64),
        modelSha256: PROTOCOL.modelSha256,
        incumbentSha256: PROTOCOL.incumbentSha256,
        manifestSha256: 'b'.repeat(64),
        selectionSha256: null,
        settings: [setting],
        selectedId: setting.id,
        comparisons: [result],
        references,
        primaryMissions: primary.length,
        challengeMissions: rows.length - primary.length,
        batches: [],
        recordsSha256: missionProtocol.hashObject(rows),
      });
      const path = resolve(directory, 'report.html');
      await writeReport(report, rows, path);
      const html = await readFile(path, 'utf8');
      expect(html).toContain('Development decision: rejected');
      expect(html).toContain('Individual cases gained and lost');
      expect(html).toContain('Removed nominal alarms');
      expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
      expect(html).toContain('&lt;script&gt;');
      expect(html).not.toContain(unsafeCase);
      expect(html).not.toContain(unsafeReason);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
