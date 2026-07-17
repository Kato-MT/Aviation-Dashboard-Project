import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCsv, recordsToObjects } from '../../src/adapters/csv-parser';
import { LegacyCsvAdapter } from '../../src/adapters/legacy-csv';
import { stableStringify } from '../../src/adapters/shared';
import { VersionedJsonAdapter } from '../../src/adapters/versioned-json';
import { sha256Hex } from '../../src/core/hash';
import { parseIsoTimestamp, parseLegacyElapsedTimestamp } from '../../src/core/time';
import { TELEMETRY_SCHEMA_VERSION } from '../../src/core/types';
import { versionedDocument } from './helpers';

const csvAdapter = new LegacyCsvAdapter();
const jsonAdapter = new VersionedJsonAdapter();
const validCsv =
  'timestamp,altitude_ft,speed_kts,fuel_pct\n00:00,1000,200,90\n00:10,1100,205,89.5\n';

describe('CSV parsing primitives', () => {
  it('parses a quoted comma', () => {
    expect(parseCsv('a,b\n"x,y",z').records[1]).toEqual(['x,y', 'z']);
  });

  it('parses escaped quotes', () => {
    expect(parseCsv('a\n"x""y"').records[1]).toEqual(['x"y']);
  });

  it('accepts CRLF records', () => {
    expect(parseCsv('a,b\r\n1,2\r\n').records).toHaveLength(2);
  });

  it('keeps a newline inside a quoted field', () => {
    expect(parseCsv('a,b\n"x\ny",z').records[1]?.[0]).toBe('x\ny');
  });

  it('ignores fully empty records', () => {
    expect(parseCsv('a,b\n\n1,2\n   ,  \n').records).toHaveLength(2);
  });

  it('reports an unclosed quoted field', () => {
    expect(parseCsv('a\n"x').errors[0]?.message).toContain('not closed');
  });

  it('reports a quote in an unquoted field', () => {
    expect(parseCsv('a\nx"y').errors[0]?.message).toContain('Unexpected quote');
  });

  it('removes a UTF-8 BOM from the first header', () => {
    expect(recordsToObjects(parseCsv('\uFEFFtimestamp,x\n00:00,1').records).headers[0]).toBe(
      'timestamp',
    );
  });
});

describe('timestamp normalization', () => {
  it.each([
    ['00:00', 0],
    ['00:10', 10_000],
    ['14:00', 840_000],
    ['100:59.5', 6_059_500],
  ])('normalizes legacy %s', (input, expectedMs) => {
    expect(parseLegacyElapsedTimestamp(input)?.timestampMs).toBe(expectedMs);
  });

  it.each(['', '1', '1:60', 'aa:10', '10:-1', '10:1'])(
    'rejects invalid legacy timestamp "%s"',
    (input) => {
      expect(parseLegacyElapsedTimestamp(input)).toBeNull();
    },
  );

  it('normalizes an ISO timestamp to UTC', () => {
    expect(parseIsoTimestamp('2026-07-17T01:00:00-04:00')?.normalized).toBe(
      '2026-07-17T05:00:00.000Z',
    );
  });

  it('rejects an invalid ISO timestamp', () => {
    expect(parseIsoTimestamp('today-ish')).toBeNull();
  });
});

describe('legacy CSV adapter', () => {
  it('recognizes the legacy header', () => {
    expect(csvAdapter.canHandle(validCsv)).toBe(true);
  });

  it('rejects unrelated text in canHandle', () => {
    expect(csvAdapter.canHandle('hello world')).toBe(false);
  });

  it('normalizes valid rows and explicit legacy units', async () => {
    const run = await csvAdapter.parse(validCsv, { createdAt: '2026-07-17T00:00:00.000Z' });
    expect(run.samples).toHaveLength(2);
    expect(run.samples[0]?.measurements).toEqual({ altitude: 1000, speed: 200, fuel: 90 });
    expect(run.samples[0]?.units).toEqual({ altitude: 'ft', speed: 'kts', fuel: '%' });
    expect(run.fatal).toBe(false);
  });

  it('quarantines a blank number instead of converting it to zero', async () => {
    const run = await csvAdapter.parse(
      'timestamp,altitude_ft,speed_kts,fuel_pct\n00:00,,200,90\n00:10,1100,205,89.5',
    );
    expect(run.samples).toHaveLength(1);
    expect(run.quarantinedRows).toHaveLength(1);
    expect(run.validationIssues[0]?.code).toBe('BLANK_VALUE');
  });

  it('treats whitespace-only values as blank', async () => {
    const run = await csvAdapter.parse(
      'timestamp,altitude_ft,speed_kts,fuel_pct\n00:00,   ,200,90',
    );
    expect(run.validationIssues.some((issue) => issue.code === 'BLANK_VALUE')).toBe(true);
  });

  it.each(['NaN', 'Infinity', '-Infinity'])(
    'quarantines the explicit nonfinite value "%s"',
    async (value) => {
      const run = await csvAdapter.parse(
        `timestamp,altitude_ft,speed_kts,fuel_pct\n00:00,1000,${value},90`,
      );
      expect(run.validationIssues[0]?.code).toBe('NONFINITE_VALUE');
      expect(run.samples).toHaveLength(0);
    },
  );

  it('quarantines arbitrary nonnumeric text', async () => {
    const run = await csvAdapter.parse(
      'timestamp,altitude_ft,speed_kts,fuel_pct\n00:00,nope,200,90',
    );
    expect(run.validationIssues[0]?.code).toBe('NONNUMERIC_VALUE');
  });

  it('retains hostile text only in quarantined evidence', async () => {
    const csv = await readFile(resolve('tests/fixtures/hostile-values.csv'), 'utf8');
    const run = await csvAdapter.parse(csv);
    expect(run.samples).toHaveLength(1);
    expect(run.quarantinedRows[0]?.raw.altitude_ft).toContain('<img');
  });

  it('blocks a missing required header', async () => {
    const run = await csvAdapter.parse('timestamp,altitude_ft,speed_kts\n00:00,1,2');
    expect(run.fatal).toBe(true);
    expect(run.validationIssues.some((issue) => issue.code === 'MISSING_HEADER')).toBe(true);
  });

  it('blocks duplicate headers', async () => {
    const run = await csvAdapter.parse(
      'timestamp,altitude_ft,speed_kts,fuel_pct,fuel_pct\n00:00,1,2,3,4',
    );
    expect(run.validationIssues.some((issue) => issue.code === 'MALFORMED_CSV')).toBe(true);
    expect(run.fatal).toBe(true);
  });

  it('blocks an empty file', async () => {
    expect((await csvAdapter.parse('   \n')).fatal).toBe(true);
  });

  it('blocks a header-only file', async () => {
    expect((await csvAdapter.parse('timestamp,altitude_ft,speed_kts,fuel_pct\n')).fatal).toBe(true);
  });

  it('enforces a configured byte limit', async () => {
    const run = await csvAdapter.parse(validCsv, { limits: { maxBytes: 1 } });
    expect(run.validationIssues.some((issue) => issue.code === 'UPLOAD_TOO_LARGE')).toBe(true);
  });

  it('enforces a configured sample limit', async () => {
    const run = await csvAdapter.parse(validCsv, { limits: { maxSamples: 1 } });
    expect(run.validationIssues.some((issue) => issue.code === 'SAMPLE_LIMIT_EXCEEDED')).toBe(true);
  });

  it('parses an explicit sequence field', async () => {
    const run = await csvAdapter.parse(
      'timestamp,altitude_ft,speed_kts,fuel_pct,sequence\n00:00,1,2,3,42',
    );
    expect(run.samples[0]?.sequence).toBe(42);
  });

  it('quarantines an invalid sequence', async () => {
    const run = await csvAdapter.parse(
      'timestamp,altitude_ft,speed_kts,fuel_pct,sequence\n00:00,1,2,3,4.5',
    );
    expect(run.quarantinedRows).toHaveLength(1);
  });

  it('requires explicit units when custom fields replace unit-bearing legacy headers', async () => {
    const run = await csvAdapter.parse('time,alt,spd,remaining\n00:00,1,2,3', {
      fieldMappings: { timestamp: 'time', altitude: 'alt', speed: 'spd', fuel: 'remaining' },
    });
    expect(run.validationIssues.filter((issue) => issue.code === 'MISSING_UNIT')).toHaveLength(3);
    expect(run.fatal).toBe(true);
  });

  it('accepts custom fields with explicit units', async () => {
    const run = await csvAdapter.parse('time,alt,spd,remaining\n00:00,1,2,3', {
      fieldMappings: { timestamp: 'time', altitude: 'alt', speed: 'spd', fuel: 'remaining' },
      unitMappings: { altitude: 'm', speed: 'm/s', fuel: 'kg' },
    });
    expect(run.samples[0]?.units).toEqual({ altitude: 'm', speed: 'm/s', fuel: 'kg' });
  });
});

describe('versioned JSON adapter', () => {
  it('recognizes a versioned object and string', () => {
    const document = versionedDocument();
    expect(jsonAdapter.canHandle(document)).toBe(true);
    expect(jsonAdapter.canHandle(JSON.stringify(document))).toBe(true);
  });

  it('does not recognize malformed JSON', () => {
    expect(jsonAdapter.canHandle('{')).toBe(false);
  });

  it('normalizes a valid document', async () => {
    const run = await jsonAdapter.parse(versionedDocument());
    expect(run.samples).toHaveLength(3);
    expect(run.sources).toHaveLength(1);
    expect(run.fatal).toBe(false);
  });

  it('blocks an unsupported schema version', async () => {
    const document = { ...versionedDocument(), schemaVersion: 'telemetry.v99' };
    const run = await jsonAdapter.parse(document);
    expect(run.validationIssues[0]?.code).toBe('UNSUPPORTED_SCHEMA_VERSION');
    expect(run.fatal).toBe(true);
  });

  it('blocks malformed JSON text', async () => {
    const run = await jsonAdapter.parse('{');
    expect(run.validationIssues[0]?.code).toBe('SCHEMA_MISMATCH');
  });

  it('blocks a non-object root', async () => {
    const run = await jsonAdapter.parse('[]');
    expect(run.fatal).toBe(true);
  });

  it('blocks duplicate source IDs', async () => {
    const document = versionedDocument();
    document.sources = [
      { sourceId: 'source-a', units: { altitude: 'ft' } },
      { sourceId: 'source-a', units: { altitude: 'ft' } },
    ];
    const run = await jsonAdapter.parse(document);
    expect(run.validationIssues.some((issue) => issue.code === 'DUPLICATE_SOURCE')).toBe(true);
  });

  it('blocks a selected-profile mismatch', async () => {
    const run = await jsonAdapter.parse(versionedDocument(), { profileId: 'generic-fixed-wing' });
    expect(run.validationIssues.some((issue) => issue.code === 'PROFILE_MISMATCH')).toBe(true);
  });

  it('quarantines a sample that references an undeclared source', async () => {
    const document = versionedDocument();
    const samples = document.samples as Array<Record<string, unknown>>;
    samples[0] = { ...samples[0], sourceId: 'unknown' };
    const run = await jsonAdapter.parse(document);
    expect(run.quarantinedRows).toHaveLength(1);
    expect(run.validationIssues.some((issue) => issue.code === 'MISSING_SOURCE')).toBe(true);
  });

  it('quarantines an invalid ISO timestamp', async () => {
    const document = versionedDocument();
    const samples = document.samples as Array<Record<string, unknown>>;
    samples[0] = { ...samples[0], timestamp: 'bad-time' };
    expect((await jsonAdapter.parse(document)).validationIssues[0]?.code).toBe('INVALID_TIMESTAMP');
  });

  it('quarantines a nonnumeric measurement', async () => {
    const document = versionedDocument();
    const samples = document.samples as Array<Record<string, unknown>>;
    samples[0] = { ...samples[0], measurements: { altitude: 'high' } };
    expect((await jsonAdapter.parse(document)).validationIssues[0]?.code).toBe('NONNUMERIC_VALUE');
  });

  it('quarantines a nonfinite object-input measurement', async () => {
    const document = versionedDocument();
    const samples = document.samples as Array<Record<string, unknown>>;
    samples[0] = {
      ...samples[0],
      measurements: { altitude: Number.NaN },
      units: { altitude: 'ft' },
    };
    expect((await jsonAdapter.parse(document)).validationIssues[0]?.code).toBe('NONFINITE_VALUE');
  });

  it('quarantines a measurement with no explicit unit', async () => {
    const document = versionedDocument();
    document.sources = [{ sourceId: 'source-a', units: {} }];
    const run = await jsonAdapter.parse(document);
    expect(run.validationIssues.some((issue) => issue.code === 'MISSING_UNIT')).toBe(true);
  });

  it('quarantines an unsupported quality flag', async () => {
    const document = versionedDocument();
    const samples = document.samples as Array<Record<string, unknown>>;
    samples[0] = { ...samples[0], qualityFlags: ['invented'] };
    expect((await jsonAdapter.parse(document)).validationIssues[0]?.code).toBe(
      'INVALID_QUALITY_FLAG',
    );
  });

  it('quarantines an empty measurements object', async () => {
    const document = versionedDocument();
    const samples = document.samples as Array<Record<string, unknown>>;
    samples[0] = { ...samples[0], measurements: {} };
    expect((await jsonAdapter.parse(document)).validationIssues[0]?.code).toBe('MISSING_VALUE');
  });

  it('produces the same hash for object keys in different orders', async () => {
    const first = await jsonAdapter.parse({
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      sources: [],
      samples: [],
    });
    const second = await jsonAdapter.parse({
      samples: [],
      sources: [],
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
    });
    expect(first.provenance.datasetSha256).toBe(second.provenance.datasetSha256);
  });
});

describe('hashing and stable serialization', () => {
  it('matches the published SHA-256 vector for abc', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('sorts object keys recursively', () => {
    expect(stableStringify({ z: 1, a: { y: 2, b: 3 } })).toBe('{"a":{"b":3,"y":2},"z":1}');
  });

  it('canonicalizes undefined values as null', () => {
    expect(stableStringify({ value: undefined })).toBe('{"value":null}');
  });
});
