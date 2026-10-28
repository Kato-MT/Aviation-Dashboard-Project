import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

import { DEFAULT_TEMPORAL_CAMPAIGN_VARIATIONS } from '../../src/campaign/defaultTemporalCampaign';
import { analyzeTemporalScenario } from '../../src/investigation/analyze';
import { evaluateMission, extractPredictions, type PolicyId } from '../../src/mission-evaluation';
import {
  parseTemporalFaultModelArtifact,
  temporalModelPassesQualityGate,
} from '../../src/ml/temporalModel';
import { evaluateModelCompatibility } from '../../src/model-registry/compatibility';
import { temporalFaultRegistryEntry } from '../../src/model-registry/registry';
import {
  DECLARED_TEMPORAL_FAULTS,
  generateTemporalScenario,
  type GenerateTemporalScenarioOptions,
} from '../../src/temporal/generator';
import type { TemporalFaultModelArtifact } from '../../src/ml/temporalTypes';

export const REPOSITORY_ROOT = resolve(import.meta.dirname, '..', '..');
export const PROTOCOL = {
  schemaVersion: 'full-mission-protocol.v1',
  synthetic: true,
  sampleCount: 180,
  cadenceMs: 1000,
  startedAt: '2026-01-01T00:00:00.000Z',
  batchSeeds: 8,
  casesPerSeed: 41,
  developmentSeeds: Array.from({ length: 40 }, (_, i) => 12101 + i),
  finalSeeds: Array.from({ length: 80 }, (_, i) => 13101 + i),
  policyStreaks: [1, 2, 3, 5],
  bootstrap: { iterations: 1000, seed: 22074, confidenceLevel: 0.95, unit: 'paired-seed-cluster' },
  limits: { overallRecallDrop: 0.02, familyRecallDrop: 0.05, pairedP95AddedDelayMs: 5000 },
  variants: DEFAULT_TEMPORAL_CAMPAIGN_VARIATIONS,
} as const;

export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b, 'en'))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
    .join(',')}}`;
}

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hashObject(value: unknown): string {
  return sha256(canonical(value));
}

export interface MissionCase {
  caseId: string;
  family: string;
  variantId: string;
  options: GenerateTemporalScenarioOptions;
}

export function casesForSeeds(seeds: readonly number[]): MissionCase[] {
  return seeds.flatMap((seed) => {
    const common = {
      seed,
      sampleCount: PROTOCOL.sampleCount,
      cadenceMs: PROTOCOL.cadenceMs,
      startedAt: PROTOCOL.startedAt,
    };
    const nominal: MissionCase = {
      caseId: `${seed}:nominal:default`,
      family: 'nominal',
      variantId: 'default',
      options: { ...common, scenarioId: 'nominal' },
    };
    return [
      nominal,
      ...DECLARED_TEMPORAL_FAULTS.flatMap(({ id }) => [
        {
          caseId: `${seed}:${id}:default`,
          family: id,
          variantId: 'default',
          options: { ...common, scenarioId: id },
        },
        ...DEFAULT_TEMPORAL_CAMPAIGN_VARIATIONS.map(({ variationId, ...variation }) => ({
          caseId: `${seed}:${id}:${variationId}`,
          family: id,
          variantId: variationId,
          options: { ...common, scenarioId: id, ...variation },
        })),
      ]),
    ];
  });
}

const PARTITION_PATHS: Record<string, string[]> = {
  'robust_covariance_v1.json': ['training.seeds', 'calibration.seeds', 'evaluation.seeds'],
  'evaluation_v1.json': ['evaluation.seeds'],
  'temporal_fault_model_v1.json': ['training.seeds', 'calibration.seeds', 'evaluation.seeds'],
  'temporal_evaluation_v1.json': [
    'evaluation.seeds',
    'postHocGeneralizationChallenge.heldOutSeeds',
  ],
  'temporal_fault_model_v2.json': ['training.seeds', 'calibration.seeds', 'evaluation.seeds'],
  'temporal_evaluation_v2.json': ['evaluation.seeds'],
};

function atPath(value: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (current, key) =>
        typeof current === 'object' && current !== null
          ? (current as Record<string, unknown>)[key]
          : undefined,
      value,
    );
}

export function assertSeedSeparation(
  existing: readonly number[],
  development: readonly number[] = PROTOCOL.developmentSeeds,
  final: readonly number[] = PROTOCOL.finalSeeds,
): void {
  const all = [...development, ...final];
  if (
    all.some((seed) => !Number.isInteger(seed) || seed < 1 || seed > 2147483647) ||
    new Set(all).size !== all.length ||
    all.some((seed) => existing.includes(seed))
  ) {
    throw new Error('Mission seed partitions overlap or contain invalid seeds.');
  }
}

export interface ModelContext {
  artifact: TemporalFaultModelArtifact;
  artifactSha256: string;
  configurationSha256: string;
  historicalSeeds: number[];
}

export async function loadModelContext(root = REPOSITORY_ROOT): Promise<ModelContext> {
  const bytes = await readFile(resolve(root, 'models/temporal_fault_model_v2.json'));
  const artifact = parseTemporalFaultModelArtifact(JSON.parse(bytes.toString('utf8')));
  const manifest = JSON.parse(
    await readFile(resolve(root, 'models/model_configuration_manifest_v1.json'), 'utf8'),
  ) as {
    entries: {
      registryEntryId: string;
      modelVersion: string;
      canonicalJson: string;
      sha256: string;
    }[];
  };
  const configuration = manifest.entries.find(
    (entry) =>
      entry.registryEntryId === temporalFaultRegistryEntry.registryEntryId &&
      entry.modelVersion === artifact.modelVersion,
  );
  if (!configuration) throw new Error('Registered model configuration is missing.');
  const artifactSha256 = sha256(bytes);
  const configurationSha256 = sha256(configuration.canonicalJson);
  if (
    artifactSha256 !== temporalFaultRegistryEntry.identities.artifactSha256 ||
    configurationSha256 !== configuration.sha256 ||
    configurationSha256 !== artifact.training.configurationSha256 ||
    configurationSha256 !== temporalFaultRegistryEntry.identities.configurationSha256
  )
    throw new Error('Registered artifact or configuration identity mismatch.');
  const historical = new Set<number>();
  for (const [file, paths] of Object.entries(PARTITION_PATHS)) {
    const document: unknown = JSON.parse(await readFile(resolve(root, 'models', file), 'utf8'));
    for (const path of paths) {
      const seeds = atPath(document, path);
      if (
        !Array.isArray(seeds) ||
        seeds.length === 0 ||
        seeds.some((seed) => !Number.isInteger(seed))
      )
        throw new Error(`Invalid seed provenance: ${file}#${path}`);
      seeds.forEach((seed) => historical.add(seed as number));
    }
  }
  const config: unknown = JSON.parse(configuration.canonicalJson);
  for (const split of ['training', 'calibration', 'heldOut']) {
    const seeds = atPath(config, `corpus.splitSeeds.${split}`);
    const artifactSeeds = atPath(artifact, `${split === 'heldOut' ? 'evaluation' : split}.seeds`);
    if (!Array.isArray(seeds) || canonical(seeds) !== canonical(artifactSeeds))
      throw new Error(`Canonical configuration disagrees with ${split} partition.`);
  }
  const historicalSeeds = [...historical].sort((a, b) => a - b);
  assertSeedSeparation(historicalSeeds);
  return { artifact, artifactSha256, configurationSha256, historicalSeeds };
}

export function runMission(
  spec: MissionCase,
  context: ModelContext,
  policyIds: readonly PolicyId[],
) {
  if (spec.options.sampleCount !== 180 || spec.options.cadenceMs !== 1000)
    throw new Error('Full-mission runner supports exactly 180 samples at 1000 ms cadence.');
  const scenario = generateTemporalScenario(spec.options);
  const readiness = evaluateModelCompatibility(temporalFaultRegistryEntry, {
    schemaVersion: context.artifact.schemaVersion,
    profile: { id: scenario.profileId, version: '1.0.0' },
    channelUnits: context.artifact.units,
    cadenceMs: scenario.cadenceMs,
    windowLength: context.artifact.windowLength,
    artifactSha256: context.artifactSha256,
    configurationSha256: context.configurationSha256,
    userSelection: 'enabled',
    qualityGatePassed: temporalModelPassesQualityGate(context.artifact),
  });
  if (!readiness.readiness.active)
    throw new Error(`Registered model unavailable: ${JSON.stringify(readiness.reasons)}`);
  const predictions = extractPredictions(analyzeTemporalScenario(scenario, { modelEnabled: true }));
  const evaluation = evaluateMission(
    {
      caseId: spec.caseId,
      seed: scenario.seed,
      family: spec.family,
      variantId: spec.variantId,
      cadenceMs: scenario.cadenceMs,
      faultTimeline: scenario.faultTimeline,
      predictions,
    },
    policyIds,
  );
  return {
    record: {
      spec,
      scenarioSha256: hashObject(scenario),
      predictionsSha256: hashObject(predictions),
      evaluation,
    },
    predictions,
  };
}

export type MissionRecord = ReturnType<typeof runMission>['record'];

export async function sourceIdentity(root = REPOSITORY_ROOT) {
  const files: Record<string, string> = {};
  async function visit(directory: string): Promise<void> {
    for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name, 'en'),
    )) {
      const path = resolve(directory, item.name);
      if (item.isSymbolicLink()) throw new Error(`Source identity refuses linked files: ${path}`);
      if (item.isDirectory()) await visit(path);
      else if (/\.(?:ts|json)$/.test(item.name))
        files[relative(root, path).replaceAll('\\', '/')] = sha256(await readFile(path));
    }
  }
  for (const dir of ['src', 'tools/mission-evaluation', 'models']) await visit(resolve(root, dir));
  for (const file of ['package.json', 'pnpm-lock.yaml'])
    files[file] = sha256(await readFile(resolve(root, file)));
  return {
    sha256: hashObject(files),
    files,
    gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    node: process.version,
  };
}
