import { utf8ByteLength, validateUploadLimits } from '../core/limits';
import { parseIsoTimestamp } from '../core/time';
import type {
  AdapterParseOptions,
  QualityFlag,
  QuarantinedRow,
  TelemetryAdapter,
  TelemetrySample,
  TelemetrySource,
  ValidationIssue,
} from '../core/types';
import { TELEMETRY_SCHEMA_VERSION } from '../core/types';
import { assembleTelemetryRun, isRecord, stableStringify } from './shared';

const QUALITY_FLAGS: readonly QualityFlag[] = [
  'valid',
  'estimated',
  'injected',
  'suspect',
  'stale',
  'quarantined',
];

export type VersionedJsonInput = string | Record<string, unknown>;

function fatalIssue(
  code: ValidationIssue['code'],
  message: string,
  observedValue?: unknown,
  expectedCondition?: string,
): ValidationIssue {
  return { code, disposition: 'fatal', message, observedValue, expectedCondition };
}

export class VersionedJsonAdapter implements TelemetryAdapter<VersionedJsonInput> {
  readonly id = 'versioned-json';
  readonly version = '2.0.0';
  readonly supportedSchemaVersions = [TELEMETRY_SCHEMA_VERSION] as const;

  canHandle(input: VersionedJsonInput): boolean {
    if (typeof input === 'string') {
      try {
        const parsed = JSON.parse(input) as unknown;
        return isRecord(parsed) && 'schemaVersion' in parsed;
      } catch {
        return false;
      }
    }
    return isRecord(input) && 'schemaVersion' in input;
  }

  async parse(input: VersionedJsonInput, options: AdapterParseOptions = {}) {
    let document: unknown;
    let rawInput: string;
    const validationIssues: ValidationIssue[] = [];
    const quarantinedRows: QuarantinedRow[] = [];
    const samples: TelemetrySample[] = [];
    const sources: TelemetrySource[] = [];

    if (typeof input === 'string') {
      rawInput = input;
      try {
        document = JSON.parse(input) as unknown;
      } catch (error) {
        document = undefined;
        validationIssues.push(
          fatalIssue(
            'SCHEMA_MISMATCH',
            `JSON could not be parsed: ${error instanceof Error ? error.message : 'unknown parse error'}`,
            undefined,
            'valid JSON encoded as telemetry.v1',
          ),
        );
      }
    } else {
      document = input;
      rawInput = stableStringify(input);
    }

    const inputBytes = utf8ByteLength(rawInput);
    const root = isRecord(document) ? document : undefined;
    if (!root) {
      if (validationIssues.length === 0) {
        validationIssues.push(fatalIssue('SCHEMA_MISMATCH', 'JSON root must be an object.'));
      }
    }

    const rawSamples = Array.isArray(root?.samples) ? root.samples : [];
    validationIssues.push(...validateUploadLimits(inputBytes, rawSamples.length, options.limits));

    if (root && root.schemaVersion !== TELEMETRY_SCHEMA_VERSION) {
      validationIssues.push(
        fatalIssue(
          'UNSUPPORTED_SCHEMA_VERSION',
          `Schema version '${String(root.schemaVersion)}' is unsupported.`,
          root.schemaVersion,
          TELEMETRY_SCHEMA_VERSION,
        ),
      );
    }

    if (root && !Array.isArray(root.samples)) {
      validationIssues.push(
        fatalIssue('SCHEMA_MISMATCH', "JSON field 'samples' must be an array."),
      );
    }
    if (root && !Array.isArray(root.sources)) {
      validationIssues.push(
        fatalIssue('SCHEMA_MISMATCH', "JSON field 'sources' must be an array."),
      );
    }

    const rawSources = Array.isArray(root?.sources) ? root.sources : [];
    const seenSourceIds = new Set<string>();
    for (const rawSource of rawSources) {
      if (
        !isRecord(rawSource) ||
        typeof rawSource.sourceId !== 'string' ||
        rawSource.sourceId.trim() === ''
      ) {
        validationIssues.push(
          fatalIssue('MISSING_SOURCE', 'Every source requires a nonblank sourceId.'),
        );
        continue;
      }
      const sourceId = rawSource.sourceId.trim();
      if (seenSourceIds.has(sourceId)) {
        validationIssues.push(
          fatalIssue(
            'DUPLICATE_SOURCE',
            `Source '${sourceId}' is declared more than once.`,
            sourceId,
            'unique source IDs',
          ),
        );
        continue;
      }
      seenSourceIds.add(sourceId);
      const rawUnits = isRecord(rawSource.units) ? rawSource.units : {};
      const units = Object.fromEntries(
        Object.entries(rawUnits)
          .filter(
            (entry): entry is [string, string] =>
              typeof entry[1] === 'string' && entry[1].trim() !== '',
          )
          .map(([channel, unit]) => [channel, unit.trim()]),
      );
      sources.push({
        sourceId,
        label: typeof rawSource.label === 'string' ? rawSource.label : sourceId,
        adapterId: this.id,
        units,
        metadata: { synthetic: true, unclassified: true },
      });
    }

    const declaredProfile = isRecord(root?.profile) ? root.profile : undefined;
    const declaredProfileId =
      typeof declaredProfile?.id === 'string' ? declaredProfile.id : undefined;
    const declaredProfileVersion =
      typeof declaredProfile?.version === 'string' ? declaredProfile.version : undefined;
    if (
      (options.profileId && declaredProfileId && options.profileId !== declaredProfileId) ||
      (options.profileVersion &&
        declaredProfileVersion &&
        options.profileVersion !== declaredProfileVersion)
    ) {
      validationIssues.push(
        fatalIssue(
          'PROFILE_MISMATCH',
          'The selected profile does not match the profile declared by the JSON document.',
          `${declaredProfileId ?? 'unspecified'}@${declaredProfileVersion ?? 'unspecified'}`,
          `${options.profileId ?? declaredProfileId ?? 'unspecified'}@${options.profileVersion ?? declaredProfileVersion ?? 'unspecified'}`,
        ),
      );
    }

    if (!validationIssues.some((issue) => issue.disposition === 'fatal')) {
      for (let index = 0; index < rawSamples.length; index += 1) {
        const rawSample = rawSamples[index];
        const rowNumber = index + 1;
        const rowIssues: ValidationIssue[] = [];
        if (!isRecord(rawSample)) {
          rowIssues.push({
            code: 'SCHEMA_MISMATCH',
            disposition: 'recoverable',
            message: 'Sample must be an object.',
            rowNumber,
            expectedCondition: 'a telemetry sample object',
          });
          validationIssues.push(...rowIssues);
          quarantinedRows.push({ rowNumber, issues: rowIssues, raw: { value: rawSample } });
          continue;
        }

        const sourceId = typeof rawSample.sourceId === 'string' ? rawSample.sourceId.trim() : '';
        const source = sources.find((candidate) => candidate.sourceId === sourceId);
        if (!source) {
          rowIssues.push({
            code: 'MISSING_SOURCE',
            disposition: 'recoverable',
            message: `Sample references undeclared source '${sourceId || 'blank'}'.`,
            rowNumber,
            sourceId: sourceId || undefined,
            expectedCondition: 'a sourceId declared in sources',
          });
        }

        const parsedTimestamp =
          typeof rawSample.timestamp === 'string' ? parseIsoTimestamp(rawSample.timestamp) : null;
        if (!parsedTimestamp) {
          rowIssues.push({
            code: 'INVALID_TIMESTAMP',
            disposition: 'recoverable',
            message: 'JSON sample timestamp must be a valid ISO-8601 timestamp.',
            rowNumber,
            sourceId: sourceId || undefined,
            channel: 'timestamp',
            observedValue: rawSample.timestamp,
            expectedCondition: 'a valid ISO-8601 timestamp',
          });
        }

        let sequence: number | undefined;
        if (rawSample.sequence !== undefined) {
          if (
            typeof rawSample.sequence !== 'number' ||
            !Number.isInteger(rawSample.sequence) ||
            rawSample.sequence < 0
          ) {
            rowIssues.push({
              code: 'NONNUMERIC_VALUE',
              disposition: 'recoverable',
              message: 'Sequence must be a nonnegative integer.',
              rowNumber,
              sourceId: sourceId || undefined,
              channel: 'sequence',
              observedValue: rawSample.sequence,
              expectedCondition: 'a nonnegative integer',
            });
          } else sequence = rawSample.sequence;
        }

        const rawMeasurements = isRecord(rawSample.measurements)
          ? rawSample.measurements
          : undefined;
        if (!rawMeasurements || Object.keys(rawMeasurements).length === 0) {
          rowIssues.push({
            code: 'MISSING_VALUE',
            disposition: 'recoverable',
            message: 'Sample requires a nonempty measurements object.',
            rowNumber,
            sourceId: sourceId || undefined,
            expectedCondition: 'at least one measured channel',
          });
        }

        const sampleUnitRecord = isRecord(rawSample.units) ? rawSample.units : {};
        const explicitOptionUnits = options.unitMappings ?? {};
        const measurements: Record<string, number> = {};
        const units: Record<string, string> = {};
        for (const [channel, rawValue] of Object.entries(rawMeasurements ?? {})) {
          if (typeof rawValue !== 'number') {
            rowIssues.push({
              code: 'NONNUMERIC_VALUE',
              disposition: 'recoverable',
              message: `Measurement '${channel}' must be numeric.`,
              rowNumber,
              sourceId: sourceId || undefined,
              channel,
              observedValue: rawValue,
              expectedCondition: 'a finite number',
            });
          } else if (!Number.isFinite(rawValue)) {
            rowIssues.push({
              code: 'NONFINITE_VALUE',
              disposition: 'recoverable',
              message: `Measurement '${channel}' must be finite.`,
              rowNumber,
              sourceId: sourceId || undefined,
              channel,
              observedValue: String(rawValue),
              expectedCondition: 'a finite number',
            });
          } else measurements[channel] = rawValue;

          const unitCandidate =
            sampleUnitRecord[channel] ?? source?.units[channel] ?? explicitOptionUnits[channel];
          if (typeof unitCandidate !== 'string' || unitCandidate.trim() === '') {
            rowIssues.push({
              code: 'MISSING_UNIT',
              disposition: 'recoverable',
              message: `Measurement '${channel}' has no explicit unit.`,
              rowNumber,
              sourceId: sourceId || undefined,
              channel,
              expectedCondition:
                'a unit on the sample, declared source, or explicit adapter mapping',
            });
          } else units[channel] = unitCandidate.trim();
        }

        const rawFlags = rawSample.qualityFlags === undefined ? ['valid'] : rawSample.qualityFlags;
        const qualityFlags: QualityFlag[] = [];
        if (!Array.isArray(rawFlags)) {
          rowIssues.push({
            code: 'INVALID_QUALITY_FLAG',
            disposition: 'recoverable',
            message: 'qualityFlags must be an array.',
            rowNumber,
            sourceId: sourceId || undefined,
            observedValue: rawFlags,
            expectedCondition: 'an array of declared quality flags',
          });
        } else {
          for (const flag of rawFlags) {
            if (typeof flag !== 'string' || !QUALITY_FLAGS.includes(flag as QualityFlag)) {
              rowIssues.push({
                code: 'INVALID_QUALITY_FLAG',
                disposition: 'recoverable',
                message: `Quality flag '${String(flag)}' is unsupported.`,
                rowNumber,
                sourceId: sourceId || undefined,
                observedValue: flag,
                expectedCondition: `one of: ${QUALITY_FLAGS.join(', ')}`,
              });
            } else qualityFlags.push(flag as QualityFlag);
          }
        }

        if (rowIssues.length > 0 || !source || !parsedTimestamp || !rawMeasurements) {
          validationIssues.push(...rowIssues);
          quarantinedRows.push({
            rowNumber,
            sourceId: sourceId || undefined,
            issues: rowIssues,
            raw: { ...rawSample },
          });
          continue;
        }

        samples.push({
          sampleIndex: samples.length,
          rowNumber,
          sourceId,
          sequence,
          timestamp: parsedTimestamp.normalized,
          timestampMs: parsedTimestamp.timestampMs,
          originalTimestamp: rawSample.timestamp as string,
          measurements,
          units,
          qualityFlags: qualityFlags.length > 0 ? qualityFlags : ['valid'],
        });
      }
    }

    return assembleTelemetryRun({
      adapterId: this.id,
      adapterVersion: this.version,
      rawInput,
      inputBytes,
      totalRows: rawSamples.length,
      sources,
      samples,
      quarantinedRows,
      validationIssues,
      options,
      declaredRunId: typeof root?.runId === 'string' ? root.runId : undefined,
      declaredProfileId,
      declaredProfileVersion,
      title: typeof root?.title === 'string' ? root.title : 'Versioned synthetic telemetry dataset',
    });
  }
}

export const versionedJsonAdapter = new VersionedJsonAdapter();
