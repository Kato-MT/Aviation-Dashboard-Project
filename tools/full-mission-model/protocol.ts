import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { hashObject, REPOSITORY_ROOT, sha256 } from '../mission-evaluation/protocol';
import { identity as previousIdentity, PROTOCOL as PREVIOUS } from '../nominal-correction/protocol';

const seeds = (start: number, count: number) => Array.from({ length: count }, (_, i) => start + i);
export const PROTOCOL = {
  schemaVersion: 'full-mission-training-protocol.v1',
  fitSeeds: seeds(18101, 60),
  calibrationSeeds: seeds(19101, 40),
  developmentSeeds: seeds(20101, 40),
  finalSeeds: seeds(21101, 80),
  samples: 180,
  cadenceMs: 1000,
  windowLength: 40,
  casesPerSeed: 41,
  batchSeeds: 5,
  target:
    'fault present at window endpoint: inclusive onset through recovery end; all other eligible endpoints negative',
  weighting:
    'equal contribution per mission and target class within mission; globally balance the two target classes',
  scaling: {
    center: 'training median',
    scale: 'max(training IQR / 1.349, 0.1 * training population std, feature resolution)',
    clip: 50,
    constantMask: 'training range <= 1e-12',
  },
  models: {
    linear: { C: 1, max_iter: 2000 },
    forest: {
      n_estimators: 64,
      max_depth: 18,
      min_samples_leaf: 5,
      max_features: 0.75,
      n_jobs: 2,
      random_state: 22076,
    },
  },
  thresholdGrid:
    '0.5 plus nearest-rank p50, p90, p95 and max of calibration nominal mission maxima; identical thresholds deduplicated',
  faultSpecific: {
    confirmationSamples: 3,
    definition:
      'new active fault-run alert, control explicitly nominal from start through confirmation; disqualify entire episode on any unknown or control alarm; detection at third sample, no backdating',
  },
  limits: {
    overallRecallDrop: 0.02,
    familyRecallDrop: 0.05,
    pairedP95AddedDelayMs: 5000,
    faultSpecificRecallGain: 0.05,
    faultSpecificFamilyRecallDrop: 0.05,
    pairedP95AddedSpecificDelayMs: 5000,
  },
  bootstrap: {
    iterations: 1000,
    seed: 22075,
    confidence: 0.95,
    unit: 'paired seed with nominal control and all40fault variants',
  },
  selection:
    'passing gates first; lowest nominal false-alarm rate, highest fault-specific recall, highest ordinary recall, linear before forest, lower threshold. If none passes, freeze highest fault-specific recall among candidates reducing nominal alarms as rejected.',
  production:
    'unchanged; experimental binary detector and preprocessing never registered or imported by app',
} as const;

export async function identity() {
  const previous = await previousIdentity();
  const excludedSeeds = [
    ...new Set([
      ...previous.excludedSeeds,
      ...PREVIOUS.fitSeeds,
      ...PREVIOUS.calibrationSeeds,
      ...PREVIOUS.developmentSeeds,
      ...PREVIOUS.finalSeeds,
    ]),
  ].sort((a, b) => a - b);
  validateSeeds(excludedSeeds);
  const files = { ...previous.files };
  for (const name of (await readdir(resolve(REPOSITORY_ROOT, 'tools/full-mission-model'))).sort()) {
    if (/\.(ts|py|txt)$/.test(name))
      files[`tools/full-mission-model/${name}`] = sha256(
        await readFile(resolve(REPOSITORY_ROOT, 'tools/full-mission-model', name)),
      );
  }
  return { ...previous, files, sha256: hashObject(files), excludedSeeds };
}

export function validateSeeds(
  excluded: readonly number[],
  partitions: readonly (readonly number[])[] = [
    PROTOCOL.fitSeeds,
    PROTOCOL.calibrationSeeds,
    PROTOCOL.developmentSeeds,
    PROTOCOL.finalSeeds,
  ],
) {
  const all = partitions.flat();
  if (
    partitions.length !== 4 ||
    partitions.some((p, i) => p.length !== [60, 40, 40, 80][i]) ||
    new Set(all).size !== all.length ||
    all.some((s) => !Number.isInteger(s) || s < 1 || s > 2147483647 || excluded.includes(s))
  )
    throw new Error('Full-mission training seed partitions overlap or are invalid.');
}
