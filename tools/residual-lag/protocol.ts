import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { hashObject, REPOSITORY_ROOT, sha256 } from '../mission-evaluation/protocol';
import { identity as parentIdentity, PROTOCOL as PARENT } from '../full-mission-model/protocol';

const seeds = (start: number, count: number) => Array.from({ length: count }, (_, i) => start + i);
export const PROTOCOL = {
  schemaVersion: 'residual-lag-protocol.v1',
  fitSeeds: seeds(22101, 60),
  calibrationSeeds: seeds(23101, 40),
  developmentSeeds: seeds(24101, 40),
  finalSeeds: seeds(25101, 80),
  samples: 180,
  cadenceMs: 1000,
  batchSeeds: 5,
  primaryCasesPerSeed: 41,
  challengeCasesPerSeed: 1,
  models: {
    forest: {
      n_estimators: 64,
      max_depth: 18,
      min_samples_leaf: 5,
      max_features: 0.75,
      n_jobs: 2,
      random_state: 26076,
    },
  },
  target: PARENT.target,
  weighting: PARENT.weighting,
  scaling: PARENT.scaling,
  masks: {
    control: 'original72features only',
    targeted: 'all83features except original raw best-offset20 and rms-improvement20',
  },
  thresholdGrid:
    '0.50,0.60,0.70,0.80,0.90,0.95 plus nominal-mission-max p50,p75,p90,p95,max; strict greater-than; streak1',
  lagFeature:
    '7-point centered GPS smoothing within causal40window; common indices20..36; compare3sample delay; signed squared-loss improvement / sqrt(max(reference energy,1e-9)); >=8valid supports plus explicit support fraction',
  challenge:
    'evaluation-only standard-cruise lag with current-time IAS noise and delayed latent mean; separate from primary matrix',
  limits: {
    overallRecallDrop: 0.02,
    familyRecallDrop: 0.05,
    pairedP95AddedDelayMs: 5000,
    specificRecallDrop: 0.02,
    specificFamilyRecallDrop: 0.05,
    specificP95AddedDelayMs: 5000,
    cruiseSpecificGain: 0.1,
  },
  bootstrap: { iterations: 1000, seed: 22075, confidence: 0.95, unit: 'paired seed cluster' },
  selection:
    'targeted model primary; passing gates then lowest nominal alarm rate, higher confirmed cruise-lag recall, higher overall confirmed recall, lower threshold. Control frozen separately for descriptive ablation. Failed development cannot be rescued by final.',
  incumbent: { model: 'previous full-mission forest', threshold: 0.8, streak: 1 },
  incumbentInferenceSha256: '2a2741b8b1048a61f7fc79602014dcc8e6d3d24bc297d04c2255ac955bd916a6',
  production: 'unchanged; offline experimental binary fault-presence model only',
} as const;

export function validateSeeds(excluded: readonly number[]) {
  const partitions = [
      PROTOCOL.fitSeeds,
      PROTOCOL.calibrationSeeds,
      PROTOCOL.developmentSeeds,
      PROTOCOL.finalSeeds,
    ],
    all = partitions.flat();
  if (
    partitions.some((p, i) => p.length !== [60, 40, 40, 80][i]) ||
    new Set(all).size !== all.length ||
    all.some((s) => excluded.includes(s))
  )
    throw new Error('Overlapping residual-lag seed partitions.');
}
export async function identity() {
  const parent = await parentIdentity(),
    excludedSeeds = [
      ...new Set([
        ...parent.excludedSeeds,
        ...PARENT.fitSeeds,
        ...PARENT.calibrationSeeds,
        ...PARENT.developmentSeeds,
        ...PARENT.finalSeeds,
      ]),
    ].sort((a, b) => a - b);
  validateSeeds(excludedSeeds);
  const files = { ...parent.files };
  for (const name of (await readdir(resolve(REPOSITORY_ROOT, 'tools/residual-lag'))).sort())
    if (/\.(ts|py|txt)$/.test(name))
      files[`tools/residual-lag/${name}`] = sha256(
        await readFile(resolve(REPOSITORY_ROOT, 'tools/residual-lag', name)),
      );
  return {
    ...parent,
    files,
    sha256: hashObject(files),
    excludedSeeds,
    parentSourceSha256: parent.sha256,
  };
}
