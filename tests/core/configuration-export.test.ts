import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';

import configurationReportSchema from '../../schemas/configuration-report.v1.schema.json';
import { APPLICATION_VERSION, analyzeTelemetryRun, type DetectionProfile } from '../../src/core';
import type { EvidenceBuildIdentity } from '../../src/evidence/types';
import {
  buildConfigurationReport,
  type BuildConfigurationReportInput,
  type ConfigurationModelEvidenceInput,
} from '../../src/export';
import type { LabConfigurationStreamEvidence, LoadedLabRun } from '../../src/features/lab/session';
import { includedBaselineProfile } from '../../src/profiles';
import { makeRun, makeSample } from './helpers';

const generatedAt = '2026-08-29T10:00:00.000Z';
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
const validate = ajv.compile(configurationReportSchema);

function mutableProfile(): DetectionProfile {
  return {
    ...includedBaselineProfile,
    channels: Object.fromEntries(
      Object.entries(includedBaselineProfile.channels).map(([key, channel]) => [
        key,
        { ...channel },
      ]),
    ),
    rules: includedBaselineProfile.rules.map((rule) => ({ ...rule })),
  };
}

function loadedRun(): LoadedLabRun {
  const run = makeRun([makeSample(0), makeSample(1)]);
  return {
    run,
    analysis: analyzeTelemetryRun(run, includedBaselineProfile, { generatedAt }),
    label: 'Uploaded synthetic telemetry.csv',
    sourceText: 'timestamp,altitude,speed,fuel',
    inputFormat: 'json',
  };
}

function modelEvidence(
  overrides: Partial<ConfigurationModelEvidenceInput> = {},
): ConfigurationModelEvidenceInput {
  return {
    key: 'robust-covariance@1.0.0',
    family: 'robust-covariance',
    activationPurpose: 'integrated-advisory',
    context: 'Current accepted synthetic telemetry run',
    expectedIdentities: {
      artifactSha256: 'a'.repeat(64),
      configurationSha256: 'b'.repeat(64),
    },
    observedIdentities: {
      artifactSha256: 'a'.repeat(64),
      configurationSha256: 'b'.repeat(64),
    },
    identityVerification: { artifact: 'verified', configuration: 'verified' },
    qualityGate: { state: 'passed', storedPassed: true, recomputedPassed: true },
    userSelection: 'enabled',
    supported: true,
    reasons: [],
    eligibility: 'eligible',
    active: true,
    authority: 'deterministic-rules',
    ...overrides,
  };
}

function streamEvidence(
  overrides: Partial<LabConfigurationStreamEvidence> = {},
): LabConfigurationStreamEvidence {
  return {
    phase: 'complete',
    sources: 2,
    receivedMessages: 48,
    droppedMessages: 3,
    queueDepth: 0,
    reconnectAttempts: 1,
    maximumHeartbeatAgeMs: 25,
    sourceHealth: [],
    injectedFaultIds: ['latency', 'duplicate'],
    ...overrides,
  };
}

function reportInput(
  overrides: Partial<BuildConfigurationReportInput> = {},
): BuildConfigurationReportInput {
  const buildIdentity: EvidenceBuildIdentity = {
    applicationVersion: '3.0.0-react-shell',
    releaseSha: 'local-unreleased',
    releaseStatus: 'unreleased',
    buildTarget: 'local-mock',
  };
  return {
    buildIdentity,
    currentRun: loadedRun(),
    selectedProfile: mutableProfile(),
    modelEvidence: [modelEvidence()],
    streamEvidence: streamEvidence(),
    generatedAt,
    ...overrides,
  };
}

function collectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) collectKeys(entry, keys);
    return keys;
  }
  if (typeof value !== 'object' || value === null) return keys;
  for (const [key, child] of Object.entries(value)) {
    keys.add(key);
    collectKeys(child, keys);
  }
  return keys;
}

describe('configuration-report.v1 export contract', () => {
  it('builds a ready report with separate shell and deterministic-engine identities', () => {
    const report = buildConfigurationReport(reportInput());

    expect(report).toMatchObject({
      reportSchemaVersion: 'configuration-report.v1',
      generatedAt,
      buildIdentities: {
        reactShell: { applicationVersion: '3.0.0-react-shell' },
        deterministicEngine: {
          applicationVersion: APPLICATION_VERSION,
          authority: 'deterministic-rules',
        },
      },
      run: {
        state: 'ready',
        identity: { runId: 'test-run', schemaVersion: 'telemetry.v1' },
        counts: { acceptedRecords: 2, quarantinedRecords: 0 },
        provenance: { datasetSha256: 'a'.repeat(64), inputFormat: 'json' },
      },
      simulator: {
        phase: 'complete',
        aggregateTotals: { sourceCount: 2, receivedMessages: 48, droppedMessages: 3 },
        injectedFaultIds: ['latency', 'duplicate'],
      },
      exportPolicy: { sourceDataIncluded: false, streamPayloadsIncluded: false },
    });
    expect(report.buildIdentities.reactShell.applicationVersion).not.toBe(
      report.buildIdentities.deterministicEngine.applicationVersion,
    );
    expect(report.selectedAnalysisProfile.channels.length).toBeGreaterThan(0);
    expect(report.selectedAnalysisProfile.rules.length).toBeGreaterThan(0);
    expect(report.models[0]).toMatchObject({
      key: 'robust-covariance@1.0.0',
      family: 'robust-covariance',
      eligibility: 'eligible',
      active: true,
      authority: 'deterministic-rules',
    });
  });

  it('represents an absent run without inventing run identity or provenance', () => {
    const report = buildConfigurationReport(reportInput({ currentRun: undefined }));

    expect(report.run).toEqual({
      state: 'no-run',
      identity: null,
      counts: null,
      provenance: null,
    });
    expect(validate(report), JSON.stringify(validate.errors)).toBe(true);
  });

  it('preserves exact mismatch evidence while keeping the model inactive', () => {
    const mismatch = modelEvidence({
      observedIdentities: {
        artifactSha256: 'c'.repeat(64),
        configurationSha256: 'b'.repeat(64),
      },
      identityVerification: { artifact: 'mismatch', configuration: 'verified' },
      qualityGate: { state: 'failed', storedPassed: true, recomputedPassed: false },
      supported: false,
      reasons: ['ARTIFACT_IDENTITY_MISMATCH', 'QUALITY_GATE_FAILED'],
      eligibility: 'ineligible',
      active: false,
    });
    const report = buildConfigurationReport(reportInput({ modelEvidence: [mismatch] }));

    expect(report.models[0]).toMatchObject({
      expectedIdentities: { artifactSha256: 'a'.repeat(64) },
      observedIdentities: { artifactSha256: 'c'.repeat(64) },
      identityVerification: { artifact: 'mismatch' },
      qualityGate: { state: 'failed', recomputedPassed: false },
      supported: false,
      reasons: ['ARTIFACT_IDENTITY_MISMATCH', 'QUALITY_GATE_FAILED'],
      eligibility: 'ineligible',
      active: false,
    });
  });

  it('does not retain mutable input objects or arrays', () => {
    const input = reportInput();
    const report = buildConfigurationReport(input);
    const snapshot = JSON.stringify(report);
    const buildIdentity = input.buildIdentity as EvidenceBuildIdentity;
    const current = input.currentRun as LoadedLabRun;
    const profile = input.selectedProfile as DetectionProfile;
    const model = input.modelEvidence[0] as ConfigurationModelEvidenceInput;
    const stream = input.streamEvidence as LabConfigurationStreamEvidence;

    buildIdentity.applicationVersion = 'mutated-shell';
    current.run.runId = 'mutated-run';
    current.run.provenance.datasetSha256 = 'f'.repeat(64);
    current.run.samples.push(makeSample(10));
    Object.values(profile.channels)[0]!.label = 'Mutated channel';
    profile.rules[0]!.description = 'Mutated rule';
    (model.expectedIdentities as { artifactSha256: string | null }).artifactSha256 = null;
    (model.reasons as string[]).push('MUTATED_REASON');
    stream.receivedMessages = 999;
    (stream.injectedFaultIds as string[]).push('mutated-fault');

    expect(JSON.stringify(report)).toBe(snapshot);
  });

  it('validates ready and no-run reports against the strict AJV schema', () => {
    const ready = buildConfigurationReport(reportInput());
    const noRun = buildConfigurationReport(reportInput({ currentRun: undefined }));

    expect(validate(ready), JSON.stringify(validate.errors)).toBe(true);
    expect(validate(noRun), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...ready, unexpected: true })).toBe(false);
  });

  it('recursively excludes source data, payloads, endpoints, and browser state', () => {
    const sentinels = [
      'UPLOADED_SOURCE_TEXT_SENTINEL',
      'RAW_QUARANTINE_SENTINEL',
      'SOURCE_ID_SENTINEL',
      'wss://private-endpoint.invalid/SENTINEL',
      'STREAM_PAYLOAD_SENTINEL',
      'MEASUREMENT_SENTINEL',
      'BROWSER_STATE_SENTINEL',
      'UPLOAD_LABEL_SENTINEL',
    ];
    const current = loadedRun();
    current.sourceText = sentinels[0];
    current.label = sentinels[7]!;
    current.run.sources[0]!.sourceId = sentinels[2]!;
    current.run.samples[0]!.sourceId = sentinels[2]!;
    current.run.quarantinedRows.push({
      rowNumber: 9,
      raw: { altitude: sentinels[1] },
      issues: [],
    });
    current.run.metadata.endpoint = sentinels[3];
    current.run.metadata.measurementNote = sentinels[5];
    (current as LoadedLabRun & { browserState: string }).browserState = sentinels[6]!;
    const stream = streamEvidence({
      sourceHealth: [
        {
          sourceId: sentinels[2]!,
          status: 'nominal',
          receivedMessages: 1,
          duplicateMessages: 0,
          outOfOrderMessages: 0,
          missingMessages: 0,
          remoteQueueDepth: 0,
          remoteDroppedMessages: 0,
          localDroppedMessages: 0,
          reconnectAttempts: 0,
        },
      ],
      issue: sentinels[3],
    });
    (stream as LabConfigurationStreamEvidence & { payloads: string[] }).payloads = [sentinels[4]!];

    const report = buildConfigurationReport(
      reportInput({ currentRun: current, streamEvidence: stream }),
    );
    const serialized = JSON.stringify(report);
    const forbiddenKeys = [
      'samples',
      'sources',
      'raw',
      'sourceText',
      'sourceHealth',
      'sourceId',
      'measurements',
      'endpoint',
      'payloads',
      'browserState',
      'issue',
    ];
    const keys = collectKeys(report);

    for (const key of forbiddenKeys) expect(keys.has(key), key).toBe(false);
    for (const sentinel of sentinels) expect(serialized, sentinel).not.toContain(sentinel);
    expect(report.exportPolicy).toMatchObject({
      sourceDataIncluded: false,
      streamPayloadsIncluded: false,
    });
  });
});
