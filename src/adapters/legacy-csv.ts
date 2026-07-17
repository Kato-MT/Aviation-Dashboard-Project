import { DEFAULT_SOURCE_ID } from '../core/constants';
import { utf8ByteLength, validateUploadLimits } from '../core/limits';
import { parseLegacyElapsedTimestamp } from '../core/time';
import type {
  AdapterParseOptions,
  QuarantinedRow,
  TelemetryAdapter,
  TelemetrySample,
  TelemetrySource,
  ValidationIssue,
} from '../core/types';
import { parseCsv, recordsToObjects } from './csv-parser';
import { assembleTelemetryRun } from './shared';

export const LEGACY_CHANNELS = ['altitude', 'speed', 'fuel'] as const;

export const LEGACY_FIELD_MAPPINGS: Readonly<Record<string, string>> = Object.freeze({
  timestamp: 'timestamp',
  altitude: 'altitude_ft',
  speed: 'speed_kts',
  fuel: 'fuel_pct',
});

export const LEGACY_UNIT_MAPPINGS: Readonly<Record<string, string>> = Object.freeze({
  altitude: 'ft',
  speed: 'kts',
  fuel: '%',
});

function parseRequiredNumber(
  rawValue: string | undefined,
  channel: string,
  rowNumber: number,
  sourceId: string,
): { value?: number; issue?: ValidationIssue } {
  if (rawValue === undefined) {
    return {
      issue: {
        code: 'MISSING_VALUE',
        disposition: 'recoverable',
        message: `Required channel '${channel}' is missing.`,
        rowNumber,
        sourceId,
        channel,
        expectedCondition: 'a present finite numeric value',
      },
    };
  }

  const trimmed = rawValue.trim();
  if (trimmed === '') {
    return {
      issue: {
        code: 'BLANK_VALUE',
        disposition: 'recoverable',
        message: `Required channel '${channel}' is blank.`,
        rowNumber,
        sourceId,
        channel,
        observedValue: rawValue,
        expectedCondition: 'a nonblank finite numeric value',
      },
    };
  }

  const value = Number(trimmed);
  if (!Number.isFinite(value)) {
    const explicitlyNonfinite = /^(?:[+-]?infinity|nan)$/i.test(trimmed);
    return {
      issue: {
        code: explicitlyNonfinite ? 'NONFINITE_VALUE' : 'NONNUMERIC_VALUE',
        disposition: 'recoverable',
        message: `Required channel '${channel}' is ${explicitlyNonfinite ? 'nonfinite' : 'nonnumeric'}.`,
        rowNumber,
        sourceId,
        channel,
        observedValue: rawValue,
        expectedCondition: 'a finite numeric value',
      },
    };
  }
  return { value };
}

export class LegacyCsvAdapter implements TelemetryAdapter<string> {
  readonly id = 'legacy-csv';
  readonly version = '2.0.0';
  readonly supportedSchemaVersions = ['legacy-flight-csv.v1'] as const;

  canHandle(input: string): boolean {
    const firstLine = input.split(/\r?\n/, 1)[0]?.replace(/^\uFEFF/, '') ?? '';
    return firstLine.includes(',') && firstLine.includes('timestamp');
  }

  async parse(input: string, options: AdapterParseOptions = {}) {
    const inputBytes = utf8ByteLength(input);
    const parsed = parseCsv(input);
    const { headers, rows } = recordsToObjects(parsed.records);
    const validationIssues: ValidationIssue[] = [];
    const quarantinedRows: QuarantinedRow[] = [];
    const samples: TelemetrySample[] = [];

    if (input.trim() === '' || parsed.records.length === 0) {
      validationIssues.push({
        code: 'EMPTY_INPUT',
        disposition: 'fatal',
        message: 'CSV input is empty.',
        expectedCondition: 'a header row and at least one data row',
      });
    }

    if (parsed.records.length === 1 && rows.length === 0) {
      validationIssues.push({
        code: 'EMPTY_INPUT',
        disposition: 'fatal',
        message: 'CSV contains a header but no data rows.',
        expectedCondition: 'at least one telemetry data row',
      });
    }

    validationIssues.push(...validateUploadLimits(inputBytes, rows.length, options.limits));
    validationIssues.push(
      ...parsed.errors.map<ValidationIssue>((error) => ({
        code: 'MALFORMED_CSV',
        disposition: 'fatal',
        message: error.message,
        rowNumber: error.rowNumber,
        expectedCondition: 'valid RFC 4180 CSV quoting',
      })),
    );

    const fieldMappings = { ...LEGACY_FIELD_MAPPINGS, ...options.fieldMappings };
    const changedMeasurementMapping = LEGACY_CHANNELS.some(
      (channel) => fieldMappings[channel] !== LEGACY_FIELD_MAPPINGS[channel],
    );
    const unitMappings = changedMeasurementMapping
      ? { ...(options.unitMappings ?? {}) }
      : { ...LEGACY_UNIT_MAPPINGS, ...options.unitMappings };

    for (const canonicalField of ['timestamp', ...LEGACY_CHANNELS]) {
      const sourceField = fieldMappings[canonicalField];
      if (!sourceField || !headers.includes(sourceField)) {
        validationIssues.push({
          code: 'MISSING_HEADER',
          disposition: 'fatal',
          message: `CSV header for canonical field '${canonicalField}' is missing.`,
          channel: canonicalField === 'timestamp' ? undefined : canonicalField,
          observedValue: headers,
          expectedCondition: `header '${sourceField ?? canonicalField}'`,
        });
      }
    }

    for (const channel of LEGACY_CHANNELS) {
      if (!unitMappings[channel]?.trim()) {
        validationIssues.push({
          code: 'MISSING_UNIT',
          disposition: 'fatal',
          message: `No explicit unit mapping was supplied for canonical channel '${channel}'.`,
          channel,
          expectedCondition: 'an explicit unit mapping; units are never guessed',
        });
      }
    }

    const duplicateHeaders = headers.filter((header, index) => headers.indexOf(header) !== index);
    if (duplicateHeaders.length > 0) {
      validationIssues.push({
        code: 'MALFORMED_CSV',
        disposition: 'fatal',
        message: `CSV contains duplicate headers: ${[...new Set(duplicateHeaders)].join(', ')}.`,
        observedValue: duplicateHeaders,
        expectedCondition: 'unique CSV headers',
      });
    }

    const sourceId = options.sourceId ?? DEFAULT_SOURCE_ID;
    const source: TelemetrySource = {
      sourceId,
      label: 'Included synthetic CSV source',
      adapterId: this.id,
      units: Object.fromEntries(
        LEGACY_CHANNELS.map((channel) => [channel, unitMappings[channel] ?? '']),
      ),
      metadata: { schema: 'legacy-flight-csv.v1', synthetic: true, unclassified: true },
    };

    if (!validationIssues.some((issue) => issue.disposition === 'fatal')) {
      for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
        const row = rows[rowIndex]!;
        const rowNumber = rowIndex + 2;
        const rowIssues: ValidationIssue[] = [];
        const rawTimestamp = row[fieldMappings.timestamp!];
        const parsedTimestamp =
          rawTimestamp === undefined ? null : parseLegacyElapsedTimestamp(rawTimestamp);

        if (!parsedTimestamp) {
          rowIssues.push({
            code: 'INVALID_TIMESTAMP',
            disposition: 'recoverable',
            message: 'Timestamp must use elapsed minutes:seconds with seconds between 00 and 59.',
            rowNumber,
            sourceId,
            channel: 'timestamp',
            observedValue: rawTimestamp,
            expectedCondition: 'elapsed timestamp formatted as mm:ss',
          });
        }

        const measurements: Record<string, number> = {};
        for (const channel of LEGACY_CHANNELS) {
          const result = parseRequiredNumber(
            row[fieldMappings[channel]!],
            channel,
            rowNumber,
            sourceId,
          );
          if (result.issue) rowIssues.push(result.issue);
          else if (result.value !== undefined) measurements[channel] = result.value;
        }

        let sequence: number | undefined;
        const sequenceField =
          options.fieldMappings?.sequence ??
          (headers.includes('sequence') ? 'sequence' : undefined);
        if (sequenceField && row[sequenceField]?.trim() !== '') {
          const candidate = Number(row[sequenceField]);
          if (!Number.isInteger(candidate) || candidate < 0) {
            rowIssues.push({
              code: 'NONNUMERIC_VALUE',
              disposition: 'recoverable',
              message: 'Sequence must be a nonnegative integer.',
              rowNumber,
              sourceId,
              channel: 'sequence',
              observedValue: row[sequenceField],
              expectedCondition: 'a nonnegative integer sequence number',
            });
          } else sequence = candidate;
        }

        if (rowIssues.length > 0 || !parsedTimestamp) {
          validationIssues.push(...rowIssues);
          quarantinedRows.push({ rowNumber, sourceId, issues: rowIssues, raw: { ...row } });
          continue;
        }

        samples.push({
          sampleIndex: samples.length,
          rowNumber,
          sourceId,
          sequence,
          timestamp: parsedTimestamp.normalized,
          timestampMs: parsedTimestamp.timestampMs,
          originalTimestamp: rawTimestamp?.trim(),
          measurements,
          units: { ...source.units },
          qualityFlags: ['valid'],
        });
      }
    }

    return assembleTelemetryRun({
      adapterId: this.id,
      adapterVersion: this.version,
      rawInput: input,
      inputBytes,
      totalRows: rows.length,
      sources: [source],
      samples,
      quarantinedRows,
      validationIssues,
      options,
      title: 'Included synthetic telemetry dataset',
    });
  }
}

export const legacyCsvAdapter = new LegacyCsvAdapter();
