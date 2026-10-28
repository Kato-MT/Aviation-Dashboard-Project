import { describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { evaluateMission, type PredictionPoint } from '../../src/mission-evaluation';
import {
  hashObject,
  REPOSITORY_ROOT,
  type MissionCase,
  type loadModelContext,
} from '../../tools/mission-evaluation/protocol';
import type { Artifact } from '../../tools/full-mission-model/model';
import { addControl, inferCase, type Comparison } from '../../tools/full-mission-model/run';
import {
  applyPolicy,
  infer,
  parseArguments,
  policies,
  select,
  run,
  type Policy,
} from '../../tools/full-mission-refinement/run';

vi.mock('../../tools/full-mission-model/run', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../tools/full-mission-model/run')>();
  return { ...actual, inferCase: vi.fn() };
});

function points(): PredictionPoint[] {
  return Array.from({ length: 180 }, (_, sampleIndex) => ({
    sampleIndex,
    timestampMs: sampleIndex * 1_000,
    phase: 'cruise',
    modelState: sampleIndex < 39 ? 'warmup' : 'nominal',
    deterministic: sampleIndex === 50,
  }));
}

function scores(positive: readonly number[] = [], equal: readonly number[] = []): number[] {
  return Array.from({ length: 141 }, (_, index) =>
    positive.includes(index + 39) ? 0.9 : equal.includes(index + 39) ? 0.7 : 0.1,
  );
}

const policy: Policy = { id: 'test-k3', modelId: 'forest', threshold: 0.7, streak: 3 };

function candidate(
  id: string,
  options: {
    passed?: boolean;
    falseAlarm?: number | null;
    streak?: number;
    specificRecall?: number | null;
    recall?: number | null;
    threshold?: number;
  } = {},
): Comparison {
  return {
    setting: {
      id,
      modelId: 'forest',
      threshold: options.threshold ?? 0.7,
      streak: options.streak ?? 3,
    },
    passed: options.passed ?? true,
    reasons: options.passed === false ? ['fixture rejected'] : [],
    decision: options.passed === false ? 'rejected' : 'improved',
    ordinary: {
      candidate: {
        nominalFalseAlarmRate: options.falseAlarm === undefined ? 0.2 : options.falseAlarm,
        activeRecall: options.recall === undefined ? 0.9 : options.recall,
      },
    },
    specific: {
      candidate: { recall: options.specificRecall === undefined ? 0.8 : options.specificRecall },
    },
  } as unknown as Comparison;
}

describe('frozen threshold and persistence refinement', () => {
  it('TC-SMR-001 starts at the kth score, never backdates, and resets at nominal or equal threshold', () => {
    const original = points();
    const values = scores([50, 51, 52, 54, 55, 56], [53]);
    const before = structuredClone({ original, values, policy });
    const filtered = applyPolicy(original, values, policy);
    expect(
      filtered
        .filter((point) => point.modelState === 'anomalous')
        .map((point) => point.sampleIndex),
    ).toEqual([52, 56]);
    expect(filtered[50]!.modelState).toBe('nominal');
    expect(filtered[51]!.modelState).toBe('nominal');
    expect(filtered[53]!.modelState).toBe('nominal');
    expect({ original, values, policy }).toEqual(before);
    expect(filtered[52]).not.toBe(original[52]);
    const metadata = (point: PredictionPoint) => [
      point.sampleIndex,
      point.timestampMs,
      point.phase,
      point.deterministic,
    ];
    expect(filtered.map(metadata)).toEqual(original.map(metadata));
  });

  it('TC-SMR-002 cannot accumulate streaks during warmup and handles the final endpoint', () => {
    const filtered = applyPolicy(points(), scores([39, 40, 41, 177, 178, 179]), policy);
    expect(filtered.slice(0, 39).every((point) => point.modelState === 'warmup')).toBe(true);
    expect(filtered[39]!.modelState).toBe('nominal');
    expect(filtered[40]!.modelState).toBe('nominal');
    expect(filtered[41]!.modelState).toBe('anomalous');
    expect(filtered[177]!.modelState).toBe('nominal');
    expect(filtered[178]!.modelState).toBe('nominal');
    expect(filtered[179]!.modelState).toBe('anomalous');
    const immediate = applyPolicy(points(), scores([39]), { ...policy, streak: 1 });
    expect(immediate[39]!.modelState).toBe('anomalous');
  });

  it('TC-SMR-003 derives the independent trained-model state from valid scores, not baseline abstention', () => {
    const baseline = points();
    baseline[39]!.modelState = 'unavailable';
    baseline[40]!.modelState = 'abstained';
    baseline[41]!.modelState = 'anomalous';
    const filtered = applyPolicy(baseline, scores([39, 40]), { ...policy, streak: 1 });
    expect(filtered.slice(39, 42).map((point) => point.modelState)).toEqual([
      'anomalous',
      'anomalous',
      'nominal',
    ]);
    expect(baseline.slice(39, 42).map((point) => point.modelState)).toEqual([
      'unavailable',
      'abstained',
      'anomalous',
    ]);
  });

  it('TC-SMR-004 rejects malformed score vectors and invalid thresholds or streaks', () => {
    expect(() => applyPolicy(points().slice(1), scores(), policy)).toThrow();
    expect(() => applyPolicy(points(), scores().slice(1), policy)).toThrow();
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -0.1, 1.1]) {
      const changed = scores();
      changed[0] = value;
      expect(() => applyPolicy(points(), changed, policy)).toThrow();
    }
    for (const threshold of [Number.NaN, -0.1, 1.1]) {
      expect(() => applyPolicy(points(), scores(), { ...policy, threshold })).toThrow();
    }
    for (const streak of [0, -1, 1.5]) {
      expect(() => applyPolicy(points(), scores(), { ...policy, streak })).toThrow();
    }
  });

  it('TC-SMR-005 sends the identical filtered stream into ordinary and fault-specific evaluation', () => {
    vi.mocked(inferCase).mockImplementation((spec) => {
      const nominal = spec.family === 'nominal';
      const baselinePredictions = points();
      const timeline = nominal
        ? null
        : { onsetIndex: 50, activeEndIndex: 70, recoveryEndIndex: 75 };
      const baseline = evaluateMission(
        {
          caseId: spec.caseId,
          seed: spec.options.seed!,
          family: spec.family,
          variantId: spec.variantId,
          cadenceMs: 1_000,
          faultTimeline: timeline,
          predictions: baselinePredictions,
        },
        ['model-k1', 'deterministic'],
      );
      return {
        baselinePredictions,
        predictions: {},
        scores: {
          forest: scores(nominal ? [52] : Array.from({ length: 11 }, (_, index) => 50 + index)),
        },
        record: {
          spec,
          scenarioSha256: 'scenario',
          baselinePredictionSha256: hashObject(baselinePredictions),
          candidatePredictionSha256: {},
          baseline,
          candidates: {},
          specific: {},
        },
      };
    });
    const common = {
      seed: 80_021,
      startedAt: '2026-01-01T00:00:00.000Z',
      sampleCount: 180,
      cadenceMs: 1_000,
    };
    const controlSpec: MissionCase = {
      caseId: '80021:nominal:default',
      family: 'nominal',
      variantId: 'default',
      options: { ...common, scenarioId: 'nominal' },
    };
    const faultSpec: MissionCase = {
      caseId: '80021:gradual-drift:default',
      family: 'gradual-drift',
      variantId: 'default',
      options: { ...common, scenarioId: 'gradual-drift' },
    };
    const context = {} as Awaited<ReturnType<typeof loadModelContext>>;
    const control = infer(controlSpec, context, {} as Artifact, [policy]);
    const fault = infer(faultSpec, context, {} as Artifact, [policy]);
    addControl(fault, control, [policy]);
    expect(fault.record.candidates[policy.id]!.policies['model-k1']).toMatchObject({
      detectionIndex: 52,
      detectionDelayMs: 2_000,
    });
    // Three-sample specificity confirmation follows the filtered alert beginning at52.
    expect(fault.record.specific[policy.id]!.candidate).toMatchObject({
      detected: true,
      detectionIndex: 54,
      delayMs: 4_000,
    });
    expect(control.record.candidates[policy.id]!.policies['model-k1']!.nominalFalseAlarm).toBe(
      false,
    );
    expect(fault.record.candidatePredictionSha256[policy.id]).toBe(
      hashObject(fault.predictions[policy.id]),
    );
    expect(fault.predictions[policy.id]![50]!.modelState).toBe('nominal');
    expect(fault.predictions[policy.id]![52]!.modelState).toBe('anomalous');
    vi.mocked(inferCase).mockReset();
  });
});

describe('development-only candidate ordering and CLI boundaries', () => {
  it('TC-SMR-009 prevents a partial development resume after parent final access', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'fdw-refinement-'));
    try {
      await mkdir(resolve(directory, 'parent/final'), { recursive: true });
      await mkdir(resolve(directory, 'output'), { recursive: true });
      await writeFile(resolve(directory, 'parent/final/manifest.json'), '{}');
      await writeFile(resolve(directory, 'output/manifest.json'), '{}');
      await expect(
        run('development', resolve(directory, 'output'), resolve(directory, 'parent')),
      ).rejects.toThrow('Development cannot resume after parent final access.');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('TC-SMR-006 selects passing gates before rates and follows every frozen tie breaker', () => {
    expect(
      select([
        candidate('failed', { passed: false, falseAlarm: 0 }),
        candidate('passed', { falseAlarm: 0.8 }),
      ]).setting.id,
    ).toBe('passed');
    expect(
      select([
        candidate('higher-rate', { falseAlarm: 0.2, streak: 1 }),
        candidate('lower-rate', { falseAlarm: 0.1, streak: 5 }),
      ]).setting.id,
    ).toBe('lower-rate');
    expect(
      select([
        candidate('longer', { streak: 3, specificRecall: 1 }),
        candidate('shorter', { streak: 1, specificRecall: 0.5 }),
      ]).setting.id,
    ).toBe('shorter');
    expect(
      select([
        candidate('specific-lower', { specificRecall: 0.7 }),
        candidate('specific-higher', { specificRecall: 0.9 }),
      ]).setting.id,
    ).toBe('specific-higher');
    expect(
      select([
        candidate('recall-lower', { recall: 0.8 }),
        candidate('recall-higher', { recall: 0.95 }),
      ]).setting.id,
    ).toBe('recall-higher');
    expect(
      select([
        candidate('threshold-higher', { threshold: 0.8 }),
        candidate('threshold-lower', { threshold: 0.6 }),
      ]).setting.id,
    ).toBe('threshold-lower');
    expect(
      select([
        candidate('undefined-rate', { falseAlarm: null }),
        candidate('measured-rate', { falseAlarm: 0.3 }),
      ]).setting.id,
    ).toBe('measured-rate');
    const allFail = [
      candidate('worse', { passed: false, falseAlarm: 0.3 }),
      candidate('best-rejected', { passed: false, falseAlarm: 0.1 }),
    ];
    const order = allFail.map((row) => row.setting.id);
    expect(select(allFail)).toMatchObject({ setting: { id: 'best-rejected' }, passed: false });
    expect(allFail.map((row) => row.setting.id)).toEqual(order);
    expect(() => select([])).toThrow();
  });

  it('TC-SMR-007 declares 48 grid policies plus the unchanged incumbent exactly once', () => {
    const choices = policies();
    expect(choices).toHaveLength(49);
    expect(new Set(choices.map((row) => row.id)).size).toBe(49);
    expect(choices.every((row) => row.modelId === 'forest')).toBe(true);
    expect(
      choices.filter((row) => row.threshold === 0.6322699583395381 && row.streak === 1),
    ).toHaveLength(1);
    expect(choices.filter((row) => row.threshold === 0.7).map((row) => row.streak)).toEqual([
      1, 2, 3, 5,
    ]);
  });

  it('TC-SMR-008 parses explicit stages and paths while refusing ambiguous or malformed actions', () => {
    expect(parseArguments(['--stage', 'development'])).toEqual({
      stage: 'development',
      output: resolve(REPOSITORY_ROOT, 'reports/full-mission-refinement-v1'),
      parent: resolve(REPOSITORY_ROOT, 'reports/full-mission-model-v1'),
      caseId: undefined,
    });
    expect(
      parseArguments([
        '--stage',
        'replay',
        '--case-id',
        '80021:gradual-drift:default',
        '--parent',
        'work/parent',
        '--output',
        'work/replay',
      ]),
    ).toEqual({
      stage: 'replay',
      caseId: '80021:gradual-drift:default',
      parent: resolve('work/parent'),
      output: resolve('work/replay'),
    });
    expect(parseArguments(['--stage', 'final']).stage).toBe('final');
    for (const args of [
      [],
      ['--stage'],
      ['--stage', 'fit'],
      ['--unknown', 'x'],
      ['--stage', 'development', '--stage', 'final'],
      ['--stage', 'development', '--case-id', 'case'],
      ['--stage', 'final', '--case-id', 'case'],
      ['--stage', 'replay'],
      ['--stage', 'development', '--output', '--parent'],
    ])
      expect(() => parseArguments(args)).toThrow();
  });
});
