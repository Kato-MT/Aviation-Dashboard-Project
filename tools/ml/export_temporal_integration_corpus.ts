import { pathToFileURL } from 'node:url';

import { extractTemporalFeatures } from '../../src/ml/temporalModel';
import {
  TEMPORAL_LABELS,
  type TemporalFaultLabel,
  type TemporalLabel,
  type TemporalSample as ModelSample,
} from '../../src/ml/temporalTypes';
import {
  INVESTIGATION_MODEL_PROJECTION_ID,
  INVESTIGATION_MODEL_PROJECTION_VERSION,
  INVESTIGATION_MODEL_WINDOW_LENGTH,
  projectInvestigationScenario,
} from '../../src/investigation/modelProjection';
import { generateTemporalScenario } from '../../src/temporal/generator';
import type { MissionPhase, TemporalFaultId, TemporalScenario } from '../../src/temporal/types';

export const TEMPORAL_INTEGRATION_CORPUS_SCHEMA_VERSION = 'temporal-integration-corpus.v1';
export const TEMPORAL_INTEGRATION_GENERATED_AT = '2026-07-17T00:00:00.000Z';
export const TEMPORAL_INTEGRATION_SAMPLE_COUNT = 180;
export const TEMPORAL_INTEGRATION_CADENCE_MS = 1_000;

export const TEMPORAL_INTEGRATION_SPLIT_SEEDS = {
  training: Array.from({ length: 40 }, (_, index) => 1_101 + index),
  calibration: Array.from({ length: 20 }, (_, index) => 2_101 + index),
  heldOut: Array.from({ length: 40 }, (_, index) => 9_101 + index),
} as const;

// A causal 40-sample window cannot end during the short initial ground or
// takeoff segments of the 180-sample mission. The final ground segment and the
// four longer airborne phases provide five balanced nominal end-phase choices.
export const TEMPORAL_INTEGRATION_NOMINAL_END_PHASES = [
  'climb',
  'cruise',
  'descent',
  'landing',
  'ground',
] as const satisfies readonly MissionPhase[];

const SCENARIO_BY_LABEL = {
  'gradual-drift': 'gradual-drift',
  'noise-growth': 'noise-growth',
  oscillation: 'oscillation',
  'sensor-lag': 'lag',
  'intermittent-dropout': 'intermittent-dropout',
  'stuck-value': 'stuck-value',
  'gain-error': 'gain-error',
  'fuel-leak': 'fuel-leak',
  'cross-sensor-decoupling': 'cross-sensor-decoupling',
  'simultaneous-faults': 'simultaneous-faults',
} as const satisfies Readonly<Record<TemporalFaultLabel, TemporalFaultId>>;

type CorpusSplitName = keyof typeof TEMPORAL_INTEGRATION_SPLIT_SEEDS;
type CorpusLifecycle = 'nominal' | 'active' | 'recovering';

export interface TemporalIntegrationCorpusExample {
  readonly exampleId: string;
  readonly seed: number;
  readonly label: TemporalLabel;
  readonly endIndex: number;
  readonly endPhase: MissionPhase;
  readonly lifecycle: CorpusLifecycle;
  readonly features: readonly number[];
}

export interface TemporalIntegrationParityCase extends TemporalIntegrationCorpusExample {
  readonly window: readonly ModelSample[];
}

export interface TemporalIntegrationCorpusSplit {
  readonly seeds: readonly number[];
  readonly examples: readonly TemporalIntegrationCorpusExample[];
}

export interface TemporalIntegrationCorpus {
  readonly schemaVersion: typeof TEMPORAL_INTEGRATION_CORPUS_SCHEMA_VERSION;
  readonly generatedAt: typeof TEMPORAL_INTEGRATION_GENERATED_AT;
  readonly projection: {
    readonly id: typeof INVESTIGATION_MODEL_PROJECTION_ID;
    readonly version: typeof INVESTIGATION_MODEL_PROJECTION_VERSION;
    readonly sampleCount: typeof TEMPORAL_INTEGRATION_SAMPLE_COUNT;
    readonly cadenceMs: typeof TEMPORAL_INTEGRATION_CADENCE_MS;
    readonly windowLength: typeof INVESTIGATION_MODEL_WINDOW_LENGTH;
    readonly featureNames: readonly string[];
  };
  readonly splits: {
    readonly training: TemporalIntegrationCorpusSplit;
    readonly calibration: TemporalIntegrationCorpusSplit;
    readonly heldOut: TemporalIntegrationCorpusSplit;
  };
  readonly parityCases: readonly TemporalIntegrationParityCase[];
}

interface SelectedWindow {
  readonly endIndex: number;
  readonly lifecycle: CorpusLifecycle;
  readonly window: readonly ModelSample[];
}

function nominalEndIndex(scenario: TemporalScenario, seed: number): number {
  const phase =
    TEMPORAL_INTEGRATION_NOMINAL_END_PHASES[seed % TEMPORAL_INTEGRATION_NOMINAL_END_PHASES.length]!;
  const eligible = scenario.samples.filter(
    (sample) =>
      sample.sampleIndex >= INVESTIGATION_MODEL_WINDOW_LENGTH - 1 && sample.phaseTruth === phase,
  );
  if (eligible.length === 0) {
    throw new Error(`No online-safe nominal ${phase} window exists for seed ${seed}.`);
  }
  return eligible[Math.floor(eligible.length / 2)]!.sampleIndex;
}

function faultEndIndex(
  scenario: TemporalScenario,
  seed: number,
): { readonly endIndex: number; readonly lifecycle: 'active' | 'recovering' } {
  const timeline = scenario.faultTimeline;
  if (timeline === null) throw new Error('Fault-window selection requires a fault timeline.');
  const lifecycle = seed % 2 === 0 ? 'active' : 'recovering';
  const lower =
    lifecycle === 'active'
      ? Math.max(INVESTIGATION_MODEL_WINDOW_LENGTH - 1, timeline.onsetIndex)
      : timeline.activeEndIndex + 1;
  const upper = lifecycle === 'active' ? timeline.activeEndIndex : timeline.recoveryEndIndex;
  if (lower > upper) {
    throw new Error(`No online-safe ${lifecycle} fault window exists for seed ${seed}.`);
  }
  return { endIndex: Math.floor((lower + upper) / 2), lifecycle };
}

function selectWindow(
  scenario: TemporalScenario,
  projected: readonly ModelSample[],
  label: TemporalLabel,
  seed: number,
): SelectedWindow {
  const selection =
    label === 'nominal'
      ? { endIndex: nominalEndIndex(scenario, seed), lifecycle: 'nominal' as const }
      : faultEndIndex(scenario, seed);
  const startIndex = selection.endIndex - INVESTIGATION_MODEL_WINDOW_LENGTH + 1;
  const window = projected.slice(startIndex, selection.endIndex + 1);
  if (window.length !== INVESTIGATION_MODEL_WINDOW_LENGTH) {
    throw new Error(`Selected window for seed ${seed} and label ${label} is incomplete.`);
  }
  if (label !== 'nominal') {
    const selectedLifecycle = scenario.samples[selection.endIndex]!.faultLabels.find(
      ({ faultId }) => faultId === scenario.scenarioId,
    )?.lifecycle;
    if (selectedLifecycle !== selection.lifecycle) {
      throw new Error(
        `Selected ${label} window lifecycle is ${String(selectedLifecycle)}, expected ${selection.lifecycle}.`,
      );
    }
  }
  return { ...selection, window };
}

function buildExample(
  split: CorpusSplitName,
  seed: number,
  label: TemporalLabel,
): { readonly example: TemporalIntegrationCorpusExample; readonly window: readonly ModelSample[] } {
  const scenario = generateTemporalScenario({
    seed,
    scenarioId: label === 'nominal' ? 'nominal' : SCENARIO_BY_LABEL[label],
    sampleCount: TEMPORAL_INTEGRATION_SAMPLE_COUNT,
    cadenceMs: TEMPORAL_INTEGRATION_CADENCE_MS,
    startedAt: TEMPORAL_INTEGRATION_GENERATED_AT,
  });
  const projected = projectInvestigationScenario(scenario).map(({ modelSample }) => modelSample);
  const selected = selectWindow(scenario, projected, label, seed);
  const features = extractTemporalFeatures(selected.window);
  if (
    features.names.length === 0 ||
    features.values.length !== features.names.length ||
    features.values.some((value) => !Number.isFinite(value))
  ) {
    throw new Error(`Feature extraction failed for seed ${seed} and label ${label}.`);
  }
  return {
    example: {
      exampleId: `${split}:${label}:${seed}`,
      seed,
      label,
      endIndex: selected.endIndex,
      endPhase: scenario.samples[selected.endIndex]!.phaseTruth,
      lifecycle: selected.lifecycle,
      features: features.values,
    },
    window: selected.window,
  };
}

function buildSplit(split: CorpusSplitName): TemporalIntegrationCorpusSplit {
  const seeds = TEMPORAL_INTEGRATION_SPLIT_SEEDS[split];
  return {
    seeds,
    examples: seeds.flatMap((seed) =>
      TEMPORAL_LABELS.map((label) => buildExample(split, seed, label).example),
    ),
  };
}

export function buildTemporalIntegrationCorpus(): TemporalIntegrationCorpus {
  const featureNames = extractTemporalFeatures(
    buildExample('heldOut', TEMPORAL_INTEGRATION_SPLIT_SEEDS.heldOut[0]!, 'nominal').window,
  ).names;
  const paritySelections = [
    { seed: 9_101, label: 'nominal' },
    { seed: 9_102, label: 'sensor-lag' },
    { seed: 9_103, label: 'simultaneous-faults' },
  ] as const satisfies readonly { readonly seed: number; readonly label: TemporalLabel }[];
  const parityCases = paritySelections.map(({ seed, label }) => {
    const result = buildExample('heldOut', seed, label);
    return { ...result.example, window: result.window };
  });

  return {
    schemaVersion: TEMPORAL_INTEGRATION_CORPUS_SCHEMA_VERSION,
    generatedAt: TEMPORAL_INTEGRATION_GENERATED_AT,
    projection: {
      id: INVESTIGATION_MODEL_PROJECTION_ID,
      version: INVESTIGATION_MODEL_PROJECTION_VERSION,
      sampleCount: TEMPORAL_INTEGRATION_SAMPLE_COUNT,
      cadenceMs: TEMPORAL_INTEGRATION_CADENCE_MS,
      windowLength: INVESTIGATION_MODEL_WINDOW_LENGTH,
      featureNames,
    },
    splits: {
      training: buildSplit('training'),
      calibration: buildSplit('calibration'),
      heldOut: buildSplit('heldOut'),
    },
    parityCases,
  };
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  process.stdout.write(`${JSON.stringify(buildTemporalIntegrationCorpus())}\n`);
}
