import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { cpus, platform, release } from 'node:os';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { format } from 'prettier';

import { APPLICATION_VERSION } from '../../src/core/constants';
import { analyzeTelemetryRun } from '../../src/core/rule-engine';
import type { TelemetryRun, TelemetrySample } from '../../src/core/types';
import { genericFixedWingProfile } from '../../src/profiles/generic-fixed-wing';

interface BenchmarkResult {
  benchmarkId: string;
  name: string;
  sampleCount: number;
  iterations: number;
  durationMs: number;
  minimumDurationMs: number;
  maximumDurationMs: number;
  throughputPerSecond: number;
  peakHeapBytes: number;
  findingCount: number;
  datasetSha256: string;
  configurationSha256: string;
}

const SIZES = [1_000, 10_000, 100_000] as const;
const SEED = 20_260_717;
const ITERATIONS = 3;

function recordedAt(): string {
  const sourceDateEpoch = process.env.SOURCE_DATE_EPOCH;
  if (sourceDateEpoch === undefined) return new Date().toISOString();
  const epochSeconds = Number(sourceDateEpoch);
  if (!Number.isFinite(epochSeconds) || epochSeconds < 0) {
    throw new Error('SOURCE_DATE_EPOCH must be a nonnegative finite number of seconds.');
  }
  return new Date(epochSeconds * 1_000).toISOString();
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

function makeRun(sampleCount: number): TelemetryRun {
  const random = seededRandom(SEED + sampleCount);
  const start = Date.parse('2026-01-01T00:00:00.000Z');
  const samples: TelemetrySample[] = Array.from({ length: sampleCount }, (_, sampleIndex) => {
    const phase = sampleIndex / 120;
    const timestampMs = start + sampleIndex * 1_000;
    const noise = () => (random() - 0.5) * 0.1;
    return {
      sampleIndex,
      rowNumber: sampleIndex + 2,
      sourceId: 'benchmark-source',
      sequence: sampleIndex,
      timestamp: new Date(timestampMs).toISOString(),
      timestampMs,
      originalTimestamp: new Date(timestampMs).toISOString(),
      measurements: {
        altitude: 5_000 + 120 * Math.sin(phase) + noise(),
        airspeed: 125 + 6 * Math.sin(phase / 2) + noise(),
        fuel: 85 - sampleIndex * (40 / Math.max(1, sampleCount)) + noise() * 0.01,
        verticalRate: 120 * Math.cos(phase) + noise(),
      },
      units: {
        altitude: 'ft',
        airspeed: 'kts',
        fuel: '%',
        verticalRate: 'ft/min',
      },
      qualityFlags: ['valid'],
    };
  });

  const datasetSha256 = sha256({
    schemaVersion: 'telemetry.v1',
    seed: SEED,
    sampleCount,
    samples,
  });

  return {
    schemaVersion: 'telemetry.v1',
    runId: `benchmark-${sampleCount}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    adapterId: 'benchmark-generator',
    adapterVersion: '1.0.0',
    profileId: genericFixedWingProfile.id,
    profileVersion: genericFixedWingProfile.version,
    sources: [
      {
        sourceId: 'benchmark-source',
        label: 'Synthetic benchmark source',
        adapterId: 'benchmark-generator',
        units: {
          altitude: 'ft',
          airspeed: 'kts',
          fuel: '%',
          verticalRate: 'ft/min',
        },
      },
    ],
    samples,
    quarantinedRows: [],
    validationIssues: [],
    fatal: false,
    provenance: {
      applicationVersion: APPLICATION_VERSION,
      schemaVersion: 'telemetry.v1',
      adapterId: 'benchmark-generator',
      adapterVersion: '1.0.0',
      profileId: genericFixedWingProfile.id,
      profileVersion: genericFixedWingProfile.version,
      datasetSha256,
      inputBytes: 0,
      totalRows: sampleCount,
      acceptedRecords: sampleCount,
      quarantinedRecords: 0,
      generatedAt: '2026-01-01T00:00:00.000Z',
    },
    metadata: {
      title: 'Synthetic performance benchmark',
      dataClassification: 'SYNTHETIC_UNCLASSIFIED',
      synthetic: true,
      seed: SEED,
    },
  };
}

function runCase(run: TelemetryRun, sampleCount: number): BenchmarkResult {
  analyzeTelemetryRun(run, genericFixedWingProfile, {
    generatedAt: '2026-01-01T00:00:00.000Z',
  });

  const durations: number[] = [];
  let findingCount = 0;
  let peakHeapBytes = process.memoryUsage().heapUsed;
  for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
    const beforeHeap = process.memoryUsage().heapUsed;
    const started = performance.now();
    const result = analyzeTelemetryRun(run, genericFixedWingProfile, {
      generatedAt: '2026-01-01T00:00:00.000Z',
    });
    durations.push(performance.now() - started);
    findingCount = result.findings.length;
    peakHeapBytes = Math.max(peakHeapBytes, beforeHeap, process.memoryUsage().heapUsed);
  }
  const durationMs = durations.reduce((sum, value) => sum + value, 0) / durations.length;
  return {
    benchmarkId: `rule-engine-${sampleCount}-${SEED}`,
    name: 'profile-rule-engine',
    sampleCount,
    iterations: ITERATIONS,
    durationMs,
    minimumDurationMs: Math.min(...durations),
    maximumDurationMs: Math.max(...durations),
    throughputPerSecond: sampleCount / (durationMs / 1_000),
    peakHeapBytes,
    findingCount,
    datasetSha256: run.provenance.datasetSha256,
    configurationSha256: sha256({
      applicationVersion: APPLICATION_VERSION,
      profileId: genericFixedWingProfile.id,
      profileVersion: genericFixedWingProfile.version,
      seed: SEED,
      sampleCount,
      iterations: ITERATIONS,
    }),
  };
}

async function main(): Promise<void> {
  const outputFlag = process.argv.indexOf('--output');
  const outputPath = resolve(
    outputFlag >= 0 && process.argv[outputFlag + 1]
      ? process.argv[outputFlag + 1]!
      : 'benchmark/latest.json',
  );
  const results = SIZES.map((sampleCount) => runCase(makeRun(sampleCount), sampleCount));
  const document = {
    schemaVersion: 'benchmark.v1',
    recordedAt: recordedAt(),
    syntheticDataOnly: true,
    reproducibility: {
      applicationVersion: APPLICATION_VERSION,
      sourceRevision: process.env.GITHUB_SHA ?? process.env.SOURCE_REVISION ?? 'working-tree',
      seed: SEED,
      sizes: SIZES,
      iterations: ITERATIONS,
      warmupIterations: 1,
      profile: {
        id: genericFixedWingProfile.id,
        version: genericFixedWingProfile.version,
      },
    },
    environment: {
      node: process.version,
      platform: platform(),
      release: release(),
      architecture: process.arch,
      logicalCpuCount: cpus().length,
      ci: process.env.CI === 'true',
    },
    results,
    limitations: [
      'Results depend on hardware, operating system, Node.js version, and background load.',
      'Generated synthetic telemetry is used; results do not represent an operational system.',
      'The benchmark reports rule-engine execution only and excludes browser rendering.',
      'peakHeapBytes is the absolute Node.js process heap and includes loaded benchmark dependencies.',
    ],
  };
  await mkdir(dirname(outputPath), { recursive: true });
  const artifact = await format(JSON.stringify(document), {
    parser: 'json',
    printWidth: 100,
  });
  await writeFile(outputPath, artifact, 'utf8');
  process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
}

await main();
