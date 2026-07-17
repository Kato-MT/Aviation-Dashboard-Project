import { APPLICATION_VERSION, DEFAULT_SOURCE_ID } from '../core/constants';
import { sha256Hex } from '../core/hash';
import type {
  AdapterParseOptions,
  QuarantinedRow,
  TelemetryRun,
  TelemetrySample,
  TelemetrySource,
  ValidationIssue,
} from '../core/types';
import { TELEMETRY_SCHEMA_VERSION } from '../core/types';

export interface RunAssemblyInput {
  adapterId: string;
  adapterVersion: string;
  rawInput: string | Uint8Array;
  inputBytes: number;
  totalRows: number;
  sources?: TelemetrySource[] | undefined;
  samples?: TelemetrySample[] | undefined;
  quarantinedRows?: QuarantinedRow[] | undefined;
  validationIssues?: ValidationIssue[] | undefined;
  options?: AdapterParseOptions | undefined;
  declaredRunId?: string | undefined;
  declaredProfileId?: string | undefined;
  declaredProfileVersion?: string | undefined;
  title?: string | undefined;
}

export async function assembleTelemetryRun(input: RunAssemblyInput): Promise<TelemetryRun> {
  const datasetSha256 = await sha256Hex(input.rawInput);
  const validationIssues = input.validationIssues ?? [];
  const samples = input.samples ?? [];
  const quarantinedRows = input.quarantinedRows ?? [];
  const createdAt = input.options?.createdAt ?? new Date().toISOString();
  const profileId = input.options?.profileId ?? input.declaredProfileId;
  const profileVersion = input.options?.profileVersion ?? input.declaredProfileVersion;

  return {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    runId: input.options?.runId ?? input.declaredRunId ?? `run-${datasetSha256.slice(0, 16)}`,
    createdAt,
    adapterId: input.adapterId,
    adapterVersion: input.adapterVersion,
    profileId,
    profileVersion,
    sources: input.sources ?? [
      {
        sourceId: input.options?.sourceId ?? DEFAULT_SOURCE_ID,
        label: 'Synthetic telemetry source',
        adapterId: input.adapterId,
        units: {},
      },
    ],
    samples,
    quarantinedRows,
    validationIssues,
    fatal: validationIssues.some((issue) => issue.disposition === 'fatal'),
    provenance: {
      applicationVersion: APPLICATION_VERSION,
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      adapterId: input.adapterId,
      adapterVersion: input.adapterVersion,
      profileId,
      profileVersion,
      datasetSha256,
      inputBytes: input.inputBytes,
      totalRows: input.totalRows,
      acceptedRecords: samples.length,
      quarantinedRecords: quarantinedRows.length,
      generatedAt: createdAt,
    },
    metadata: {
      title: input.title,
      dataClassification: 'SYNTHETIC_UNCLASSIFIED',
      synthetic: true,
    },
  };
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
