import { afterEach, describe, expect, it, vi } from 'vitest';
import { assembleTelemetryRun } from '../../src/adapters/shared';
import { VersionedJsonAdapter } from '../../src/adapters/versioned-json';
import { sha256Hex } from '../../src/core/hash';
import { parseIsoTimestamp } from '../../src/core/time';
import type { FaultScenarioId } from '../../src/faults/scenarios';
import {
  createInjectedValidationIssue,
  injectFaultScenario,
  injectLegacyCsvFault,
} from '../../src/faults/scenarios';
import { detectionProfiles, getDetectionProfile } from '../../src/profiles/registry';
import { makeRun, makeSample, versionedDocument } from './helpers';

const adapter = new VersionedJsonAdapter();

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('run assembly and hashing edge paths', () => {
  it('assembles a run with safe defaults', async () => {
    const run = await assembleTelemetryRun({
      adapterId: 'test',
      adapterVersion: '1',
      rawInput: new TextEncoder().encode('default'),
      inputBytes: 7,
      totalRows: 0,
    });
    expect(run.sources[0]?.sourceId).toBe('synthetic-source-1');
    expect(run.samples).toEqual([]);
    expect(run.quarantinedRows).toEqual([]);
    expect(run.validationIssues).toEqual([]);
    expect(run.runId).toMatch(/^run-[a-f0-9]{16}$/);
  });

  it('uses declared IDs when options do not override them', async () => {
    const run = await assembleTelemetryRun({
      adapterId: 'test',
      adapterVersion: '1',
      rawInput: 'declared',
      inputBytes: 8,
      totalRows: 0,
      declaredRunId: 'declared-run',
      declaredProfileId: 'profile-a',
      declaredProfileVersion: '1',
    });
    expect(run.runId).toBe('declared-run');
    expect(run.profileId).toBe('profile-a');
  });

  it('uses explicit options ahead of declared IDs', async () => {
    const run = await assembleTelemetryRun({
      adapterId: 'test',
      adapterVersion: '1',
      rawInput: 'override',
      inputBytes: 8,
      totalRows: 0,
      declaredRunId: 'declared-run',
      options: {
        runId: 'option-run',
        sourceId: 'option-source',
        createdAt: '2026-07-17T00:00:00.000Z',
      },
    });
    expect(run.runId).toBe('option-run');
    expect(run.sources[0]?.sourceId).toBe('option-source');
  });

  it('hashes a Uint8Array input', async () => {
    expect(await sha256Hex(new Uint8Array([97, 98, 99]))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('fails clearly when Web Crypto is unavailable', async () => {
    vi.stubGlobal('crypto', undefined);
    await expect(sha256Hex('abc')).rejects.toThrow('Web Crypto');
  });

  it('rejects a blank ISO timestamp', () => {
    expect(parseIsoTimestamp('   ')).toBeNull();
  });
});

describe('versioned JSON schema edge paths', () => {
  it('blocks non-array samples and sources', async () => {
    const run = await adapter.parse({ schemaVersion: 'telemetry.v1', samples: {}, sources: {} });
    expect(run.validationIssues.filter((issue) => issue.code === 'SCHEMA_MISMATCH')).toHaveLength(
      2,
    );
  });

  it.each([null, {}, { sourceId: '' }, { sourceId: 4 }])(
    'blocks malformed source declaration %#',
    async (source) => {
      const run = await adapter.parse({
        schemaVersion: 'telemetry.v1',
        samples: [],
        sources: [source],
      });
      expect(run.validationIssues.some((issue) => issue.code === 'MISSING_SOURCE')).toBe(true);
    },
  );

  it('uses sourceId as the label fallback and filters invalid unit declarations', async () => {
    const run = await adapter.parse({
      schemaVersion: 'telemetry.v1',
      sources: [{ sourceId: 's', units: { altitude: 'ft', ignored: 3, blank: '' } }],
      samples: [],
    });
    expect(run.sources[0]).toMatchObject({ sourceId: 's', label: 's', units: { altitude: 'ft' } });
  });

  it('blocks a profile-version mismatch independently of profile ID', async () => {
    const run = await adapter.parse(versionedDocument(), { profileVersion: '2.0.0' });
    expect(run.validationIssues.some((issue) => issue.code === 'PROFILE_MISMATCH')).toBe(true);
  });

  it('accepts a document without profile metadata', async () => {
    const document = versionedDocument();
    delete document.profile;
    const run = await adapter.parse(document);
    expect(run.fatal).toBe(false);
    expect(run.profileId).toBeUndefined();
  });

  it('quarantines a non-object sample', async () => {
    const document = versionedDocument();
    document.samples = [null];
    const run = await adapter.parse(document);
    expect(run.validationIssues[0]?.code).toBe('SCHEMA_MISMATCH');
  });

  it('quarantines a non-string timestamp', async () => {
    const document = versionedDocument();
    const samples = document.samples as Array<Record<string, unknown>>;
    samples[0] = { ...samples[0], timestamp: 123 };
    const run = await adapter.parse(document);
    expect(run.validationIssues.some((issue) => issue.code === 'INVALID_TIMESTAMP')).toBe(true);
  });

  it.each(['1', 1.5, -1])('quarantines invalid sequence %#', async (sequence) => {
    const document = versionedDocument();
    const samples = document.samples as Array<Record<string, unknown>>;
    samples[0] = { ...samples[0], sequence };
    const run = await adapter.parse(document);
    expect(run.validationIssues.some((issue) => issue.channel === 'sequence')).toBe(true);
  });

  it('accepts a valid sequence', async () => {
    const document = versionedDocument();
    const samples = document.samples as Array<Record<string, unknown>>;
    samples[0] = { ...samples[0], sequence: 0 };
    expect((await adapter.parse(document)).samples[0]?.sequence).toBe(0);
  });

  it('uses sample-level units before source units', async () => {
    const document = versionedDocument();
    const samples = document.samples as Array<Record<string, unknown>>;
    samples[0] = { ...samples[0], measurements: { altitude: 1 }, units: { altitude: 'm' } };
    expect((await adapter.parse(document)).samples[0]?.units.altitude).toBe('m');
  });

  it('uses an explicit adapter unit mapping if source and sample omit it', async () => {
    const document = versionedDocument();
    document.sources = [{ sourceId: 'source-a', units: {} }];
    const samples = document.samples as Array<Record<string, unknown>>;
    document.samples = [{ ...samples[0], measurements: { altitude: 1 } }];
    const run = await adapter.parse(document, { unitMappings: { altitude: 'ft' } });
    expect(run.samples[0]?.units.altitude).toBe('ft');
  });

  it('quarantines non-array quality flags', async () => {
    const document = versionedDocument();
    const samples = document.samples as Array<Record<string, unknown>>;
    samples[0] = { ...samples[0], qualityFlags: 'valid' };
    expect((await adapter.parse(document)).validationIssues[0]?.code).toBe('INVALID_QUALITY_FLAG');
  });

  it('defaults an empty quality flag list to valid', async () => {
    const document = versionedDocument();
    const samples = document.samples as Array<Record<string, unknown>>;
    samples[0] = { ...samples[0], qualityFlags: [] };
    expect((await adapter.parse(document)).samples[0]?.qualityFlags).toEqual(['valid']);
  });

  it('uses the default title when none is declared', async () => {
    const document = versionedDocument();
    delete document.title;
    expect((await adapter.parse(document)).metadata.title).toBe(
      'Versioned synthetic telemetry dataset',
    );
  });
});

describe('profile registry and fault error paths', () => {
  it('registers all three versioned synthetic profiles', () => {
    expect(detectionProfiles.map((profile) => profile.id)).toEqual([
      'included-baseline',
      'generic-fixed-wing',
      'generic-rotary-wing',
    ]);
  });

  it('looks up profiles by ID and optional version', () => {
    expect(getDetectionProfile('generic-fixed-wing')?.version).toBe('1.0.0');
    expect(getDetectionProfile('generic-fixed-wing', '1.0.0')?.id).toBe('generic-fixed-wing');
    expect(getDetectionProfile('generic-fixed-wing', '99')).toBeUndefined();
  });

  it('rejects an unknown canonical fault scenario', async () => {
    await expect(injectFaultScenario(makeRun(), 'unknown' as FaultScenarioId)).rejects.toThrow(
      'Unknown fault',
    );
  });

  it('rejects fault injection on too few samples', async () => {
    await expect(injectFaultScenario(makeRun([makeSample(0)]), 'missing-altitude')).rejects.toThrow(
      'at least 2',
    );
  });

  it('rejects a frozen-altitude injection when the selected channel is absent', async () => {
    const run = makeRun(Array.from({ length: 6 }, (_, index) => makeSample(index)));
    delete run.samples[0]?.measurements.altitude;
    delete run.samples[1]?.measurements.altitude;
    delete run.samples[2]?.measurements.altitude;
    delete run.samples[3]?.measurements.altitude;
    delete run.samples[4]?.measurements.altitude;
    delete run.samples[5]?.measurements.altitude;
    await expect(injectFaultScenario(run, 'frozen-altitude', 1)).rejects.toThrow(
      'requires an altitude channel',
    );
  });

  it('clones per-channel quality flags during injection', async () => {
    const run = makeRun(Array.from({ length: 6 }, (_, index) => makeSample(index)));
    run.samples[0]!.channelQualityFlags = { altitude: ['estimated'] };
    const injected = await injectFaultScenario(run, 'missing-altitude', 1);
    expect(injected.samples[0]?.channelQualityFlags).toEqual({ altitude: ['estimated'] });
    expect(injected.samples[0]?.channelQualityFlags).not.toBe(run.samples[0]?.channelQualityFlags);
  });

  it('rejects CSV fault injection without enough rows', () => {
    expect(() => injectLegacyCsvFault('header\nrow', 'blank-csv-value')).toThrow(
      'header and at least two',
    );
  });

  it('rejects CSV fault injection without four fields', () => {
    expect(() => injectLegacyCsvFault('a,b\n1,2\n3,4', 'blank-csv-value')).toThrow('four fields');
  });

  it('creates a traceable synthetic validation issue', () => {
    expect(createInjectedValidationIssue('BLANK_VALUE', 3, 'altitude')).toMatchObject({
      code: 'BLANK_VALUE',
      sampleIndex: 3,
      channel: 'altitude',
      disposition: 'recoverable',
    });
  });
});
