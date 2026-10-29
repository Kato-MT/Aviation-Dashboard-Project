import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { hashObject, REPOSITORY_ROOT, sha256 } from '../mission-evaluation/protocol';
import { identity as parentIdentity, PROTOCOL as PARENT } from '../residual-lag/protocol';
import { SETTINGS } from './policy';

const seeds = (start: number, count: number) => Array.from({ length: count }, (_, i) => start + i);
export const PROTOCOL = {
  schemaVersion: 'alarm-preservation-protocol.v1',
  developmentSeeds: seeds(26101, 40),
  finalSeeds: seeds(27101, 80),
  samples: 180,
  cadenceMs: 1000,
  batchSeeds: 5,
  primaryCasesPerSeed: 41,
  challengeCasesPerSeed: 1,
  settings: SETTINGS,
  rule: 'score > general threshold OR (score > lag threshold AND signed lag > 0 AND support >= 8/17); no holding, streak or backdating',
  targetBaseline: { model: 'residual-lag targeted forest', threshold: 0.7 },
  incumbent: { model: 'earlier full-mission forest', threshold: 0.8 },
  strictReference: { model: 'residual-lag targeted forest', threshold: 0.95 },
  modelSha256: '8b261036651f1b0708c8e45b27565d17280fc84396ca2fef6c1d41a0aa2aed6e',
  incumbentSha256: 'e1a0fa89202e33b3819ab134301b59f1dedbb4d4d0f5d209b3ead862e9d328e2',
  parentReportSha256: 'aacc41e08a844e800f7372dafaddee1c419a2a8329305ace9d06cb30367b4b8e',
  limits: {
    overallRecallDrop: 0.02,
    familyRecallDrop: 0.05,
    pairedP95AddedDelayMs: 5000,
    cruisePointRecallDrop: 0,
    cruiseIntervalLowerBound: -0.05,
    legacyCruiseGain: 0.1,
  },
  bootstrap: { iterations: 1000, seed: 22075, confidence: 0.95, unit: 'paired seed cluster' },
  selection:
    'passing then lowest nominal alarm rate, higher minimum primary/challenge confirmed recall, higher overall confirmed recall, higher general threshold, higher lag threshold; rejected fallback uses preserving settings first',
  production: 'unchanged; experimental decision rule around frozen weights',
} as const;

export function validateSeeds(excluded: readonly number[]) {
  const all = [...PROTOCOL.developmentSeeds, ...PROTOCOL.finalSeeds];
  if (
    PROTOCOL.developmentSeeds.length !== 40 ||
    PROTOCOL.finalSeeds.length !== 80 ||
    new Set(all).size !== all.length ||
    all.some((s) => excluded.includes(s))
  )
    throw new Error('Overlapping alarm-preservation partitions.');
}
export async function identity() {
  const parent = await parentIdentity();
  const excludedSeeds = [
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
  for (const name of (await readdir(resolve(REPOSITORY_ROOT, 'tools/alarm-preservation'))).sort())
    if (/\.(ts|py|txt)$/.test(name))
      files[`tools/alarm-preservation/${name}`] = sha256(
        await readFile(resolve(REPOSITORY_ROOT, 'tools/alarm-preservation', name)),
      );
  return {
    ...parent,
    files,
    sha256: hashObject(files),
    excludedSeeds,
    parentResidualSha256: parent.sha256,
  };
}
