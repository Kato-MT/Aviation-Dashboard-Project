import type { DetectionProfile, TelemetryRun, TelemetrySample } from '../../src/core/types';
import { TELEMETRY_SCHEMA_VERSION } from '../../src/core/types';
import { includedBaselineProfile } from '../../src/profiles/included-baseline';

export function makeSample(
  index: number,
  overrides: Partial<TelemetrySample> = {},
): TelemetrySample {
  const timestampMs = overrides.timestampMs ?? index * 10_000;
  return {
    sampleIndex: index,
    rowNumber: index + 2,
    sourceId: 'source-a',
    timestampMs,
    timestamp: new Date(timestampMs).toISOString(),
    originalTimestamp: `${String(Math.floor(index / 6)).padStart(2, '0')}:${String((index % 6) * 10).padStart(2, '0')}`,
    measurements: { altitude: 1_000 + index * 100, speed: 200 + index, fuel: 90 - index * 0.1 },
    units: { altitude: 'ft', speed: 'kts', fuel: '%' },
    qualityFlags: ['valid'],
    ...overrides,
  };
}

export function makeRun(
  samples: TelemetrySample[] = [makeSample(0), makeSample(1), makeSample(2)],
): TelemetryRun {
  return {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    runId: 'test-run',
    createdAt: '2026-07-17T00:00:00.000Z',
    adapterId: 'test-adapter',
    adapterVersion: '1.0.0',
    profileId: includedBaselineProfile.id,
    profileVersion: includedBaselineProfile.version,
    sources: [
      {
        sourceId: 'source-a',
        label: 'Synthetic source A',
        adapterId: 'test-adapter',
        units: { altitude: 'ft', speed: 'kts', fuel: '%' },
      },
    ],
    samples,
    quarantinedRows: [],
    validationIssues: [],
    fatal: false,
    provenance: {
      applicationVersion: '2.1.0',
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      adapterId: 'test-adapter',
      adapterVersion: '1.0.0',
      profileId: includedBaselineProfile.id,
      profileVersion: includedBaselineProfile.version,
      datasetSha256: 'a'.repeat(64),
      inputBytes: 100,
      totalRows: samples.length,
      acceptedRecords: samples.length,
      quarantinedRecords: 0,
      generatedAt: '2026-07-17T00:00:00.000Z',
    },
    metadata: {
      dataClassification: 'SYNTHETIC_UNCLASSIFIED',
      synthetic: true,
    },
  };
}

export function profileWith(overrides: Partial<DetectionProfile>): DetectionProfile {
  return { ...includedBaselineProfile, ...overrides };
}

export function versionedDocument(run = makeRun()): Record<string, unknown> {
  return {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    runId: run.runId,
    title: 'Synthetic test telemetry',
    profile: { id: includedBaselineProfile.id, version: includedBaselineProfile.version },
    sources: run.sources.map((source) => ({
      sourceId: source.sourceId,
      label: source.label,
      units: source.units,
    })),
    samples: run.samples.map((sample) => ({
      sourceId: sample.sourceId,
      ...(sample.sequence === undefined ? {} : { sequence: sample.sequence }),
      timestamp: sample.timestamp,
      measurements: sample.measurements,
      qualityFlags: sample.qualityFlags,
    })),
  };
}
