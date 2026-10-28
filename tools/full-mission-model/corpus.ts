import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { generateTemporalScenario } from '../../src/temporal/generator';
import {
  casesForSeeds,
  hashObject,
  sha256,
  type MissionCase,
} from '../mission-evaluation/protocol';
import { exists, readJson, writeJson } from '../mission-evaluation/run';
import { seal, verify } from '../nominal-correction/run';
import { fullMissionFeatures, resolution } from './features';
import { PROTOCOL } from './protocol';

interface CorpusCase {
  spec: MissionCase;
  scenarioSha256: string;
  faultTimeline: ReturnType<typeof generateTemporalScenario>['faultTimeline'];
}
interface Batch {
  sourceSha256: string;
  specsSha256: string;
  featureSha256: string;
  featureFile: string;
  featureNames: string[];
  rows: number;
  columns: number;
  cases: CorpusCase[];
  contentSha256: string;
}
export async function exportCorpus(
  output: string,
  stage: 'fit' | 'calibration',
  sourceSha256: string,
) {
  const seeds = stage === 'fit' ? PROTOCOL.fitSeeds : PROTOCOL.calibrationSeeds;
  const directory = resolve(output, 'corpus', stage);
  await mkdir(directory, { recursive: true });
  const batches: Batch[] = [];
  for (let i = 0; i < seeds.length; i += PROTOCOL.batchSeeds) {
    const specs = casesForSeeds(seeds.slice(i, i + PROTOCOL.batchSeeds));
    const metaPath = resolve(directory, `${i / PROTOCOL.batchSeeds}.json`);
    if (await exists(metaPath)) {
      const batch = verify(await readJson<Batch>(metaPath));
      if (
        batch.sourceSha256 !== sourceSha256 ||
        batch.specsSha256 !== hashObject(specs) ||
        sha256(await readFile(resolve(directory, batch.featureFile))) !== batch.featureSha256
      )
        throw new Error('Corpus cache checksum/source mismatch.');
      batches.push(batch);
    } else {
      const cases: CorpusCase[] = [],
        rows: number[][] = [];
      let names: string[] = [];
      for (const spec of specs) {
        const scenario = generateTemporalScenario(spec.options),
          features = fullMissionFeatures(scenario);
        names = features.names;
        rows.push(...features.rows);
        cases.push({
          spec,
          scenarioSha256: hashObject(scenario),
          faultTimeline: scenario.faultTimeline,
        });
      }
      const buffer = Buffer.alloc(rows.length * names.length * 8);
      let at = 0;
      for (const row of rows)
        for (const value of row) {
          buffer.writeDoubleLE(value, at);
          at += 8;
        }
      const featureFile = `${i / PROTOCOL.batchSeeds}.f64`;
      await writeFile(resolve(directory, featureFile), buffer);
      const batch = seal({
        sourceSha256,
        specsSha256: hashObject(specs),
        featureSha256: sha256(buffer),
        featureFile,
        featureNames: names,
        rows: rows.length,
        columns: names.length,
        cases,
      });
      await writeJson(metaPath, batch);
      batches.push(batch);
    }
    await writeJson(resolve(directory, 'status.json'), {
      status: 'running',
      completedSeeds: Math.min(i + PROTOCOL.batchSeeds, seeds.length),
      expectedSeeds: seeds.length,
    });
    console.log(
      `${stage} corpus: ${Math.min(i + PROTOCOL.batchSeeds, seeds.length)}/${seeds.length} seeds`,
    );
  }
  const manifest = seal({
    schemaVersion: 'full-mission-corpus.v1',
    stage,
    seeds,
    sourceSha256,
    protocol: PROTOCOL,
    featureNames: batches[0]!.featureNames,
    resolutions: batches[0]!.featureNames.map(resolution),
    batchFiles: batches.map((_, i) => `${i}.json`),
    batchHashes: batches.map((b) => b.contentSha256),
    batchFileHashes: await Promise.all(
      batches.map(async (_, i) => sha256(await readFile(resolve(directory, `${i}.json`)))),
    ),
    rows: batches.reduce((n, b) => n + b.rows, 0),
    dtype: 'little-endian-float64',
    windowEndIndices: [39, 179],
  });
  await writeJson(resolve(directory, 'manifest.json'), manifest);
  await writeJson(resolve(directory, 'status.json'), {
    status: 'completed',
    completedSeeds: seeds.length,
    expectedSeeds: seeds.length,
    manifestSha256: manifest.contentSha256,
  });
  return manifest;
}
