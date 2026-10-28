import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  hashObject,
  loadModelContext,
  PROTOCOL as PREVIOUS,
  REPOSITORY_ROOT,
  sha256,
  sourceIdentity,
} from '../mission-evaluation/protocol';

const seeds = (start: number, count: number) => Array.from({ length: count }, (_, i) => start + i);
export const PROTOCOL = {
  schemaVersion: 'nominal-correction-protocol.v1',
  method: 'additional-full-stream-nominal-envelope',
  fitSeeds: seeds(14101, 40),
  calibrationSeeds: seeds(15101, 40),
  developmentSeeds: seeds(16101, 40),
  finalSeeds: seeds(17101, 80),
  sampleCount: 180,
  cadenceMs: 1000,
  casesPerSeed: 41,
  batchSeeds: 8,
  candidates: ['window-p95', 'window-p99', 'mission-max-p95'] as const,
  selection:
    'lowest nominal mission false-alarm rate among passing candidates; then highest recall; then smallest threshold. If none passes, freeze lowest false-alarm candidate for a declared rejected confirmatory test.',
  scaling:
    'max(registered feature scale, full nominal fitting population std, one discrete step for freeze/missing fractions)',
  prototypes:
    'one centroid per eligible window end (39 through 179); inference searches all 141 without time or phase labels',
  calibration:
    'nearest-rank p95/p99 of all window distances, or p95 of per-mission maximum distances',
  limits: PREVIOUS.limits,
  bootstrap: { iterations: 1000, seed: 22075, unit: 'paired-seed-cluster', confidenceLevel: 0.95 },
  production: 'unchanged; experimental outputs never registered or imported by app',
} as const;

export function validatePartitions(
  historical: readonly number[],
  partitions: readonly (readonly number[])[] = [
    PROTOCOL.fitSeeds,
    PROTOCOL.calibrationSeeds,
    PROTOCOL.developmentSeeds,
    PROTOCOL.finalSeeds,
  ],
): void {
  const excluded = new Set([...historical, ...PREVIOUS.developmentSeeds, ...PREVIOUS.finalSeeds]);
  if (partitions.length !== 4 || partitions.some((p, i) => p.length !== [40, 40, 40, 80][i]))
    throw new Error('Unexpected partition sizes.');
  const all = partitions.flat();
  if (
    all.some((s) => !Number.isInteger(s) || s < 1 || s > 2147483647 || excluded.has(s)) ||
    new Set(all).size !== all.length
  )
    throw new Error('Fresh seed partitions overlap or are invalid.');
}

export async function identity() {
  const base = await sourceIdentity();
  const files = { ...base.files };
  for (const name of (await readdir(resolve(REPOSITORY_ROOT, 'tools/nominal-correction'))).sort()) {
    if (/\.(ts|json)$/.test(name))
      files[`tools/nominal-correction/${name}`] = sha256(
        await readFile(resolve(REPOSITORY_ROOT, 'tools/nominal-correction', name)),
      );
  }
  const model = await loadModelContext();
  validatePartitions(model.historicalSeeds);
  return {
    ...base,
    files,
    sha256: hashObject(files),
    modelSha256: model.artifactSha256,
    configurationSha256: model.configurationSha256,
    excludedSeeds: [
      ...new Set([...model.historicalSeeds, ...PREVIOUS.developmentSeeds, ...PREVIOUS.finalSeeds]),
    ].sort((a, b) => a - b),
  };
}
