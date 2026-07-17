import type { AnalysisResult, Finding, TelemetryRun, VerificationRun } from '../core/types';

export interface ReportExportOptions {
  includeSourceData?: boolean | undefined;
  generatedAt?: string | undefined;
}

export interface VersionedDiagnosticReport {
  reportSchemaVersion: 'diagnostic-report.v1';
  generatedAt: string;
  run: {
    runId: string;
    schemaVersion: string;
    adapterId: string;
    adapterVersion: string;
    profileId?: string | undefined;
    profileVersion?: string | undefined;
    fatal: boolean;
    provenance: TelemetryRun['provenance'];
    validationIssues: TelemetryRun['validationIssues'];
    quarantinedRows: Array<{
      rowNumber: number;
      sourceId?: string | undefined;
      issueCodes: string[];
      raw?: Record<string, unknown> | undefined;
    }>;
    sources?: TelemetryRun['sources'] | undefined;
    samples?: TelemetryRun['samples'] | undefined;
  };
  analysis: AnalysisResult;
  verification?: VerificationRun | undefined;
  exportPolicy: {
    sourceDataIncluded: boolean;
    note: string;
  };
}

export function buildDiagnosticReport(
  run: TelemetryRun,
  analysis: AnalysisResult,
  verification?: VerificationRun,
  options: ReportExportOptions = {},
): VersionedDiagnosticReport {
  const includeSourceData = options.includeSourceData === true;
  return {
    reportSchemaVersion: 'diagnostic-report.v1',
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    run: {
      runId: run.runId,
      schemaVersion: run.schemaVersion,
      adapterId: run.adapterId,
      adapterVersion: run.adapterVersion,
      profileId: run.profileId,
      profileVersion: run.profileVersion,
      fatal: run.fatal,
      provenance: { ...run.provenance },
      validationIssues: run.validationIssues.map((issue) => ({ ...issue })),
      quarantinedRows: run.quarantinedRows.map((row) => ({
        rowNumber: row.rowNumber,
        sourceId: row.sourceId,
        issueCodes: row.issues.map((issue) => issue.code),
        ...(includeSourceData ? { raw: { ...row.raw } } : {}),
      })),
      ...(includeSourceData
        ? {
            sources: run.sources.map((source) => ({ ...source, units: { ...source.units } })),
            samples: run.samples.map((sample) => ({
              ...sample,
              measurements: { ...sample.measurements },
              units: { ...sample.units },
              qualityFlags: [...sample.qualityFlags],
            })),
          }
        : {}),
    },
    analysis: {
      ...analysis,
      findings: analysis.findings.map((finding) => ({
        ...finding,
        evidence: { ...finding.evidence },
      })),
      findingCounts: { ...analysis.findingCounts },
    },
    verification,
    exportPolicy: {
      sourceDataIncluded: includeSourceData,
      note: includeSourceData
        ? 'Source samples were included by explicit user choice.'
        : 'Uploaded source samples and quarantined raw row values were excluded by default.',
    },
  };
}

export function serializeDiagnosticReport(
  run: TelemetryRun,
  analysis: AnalysisResult,
  verification?: VerificationRun,
  options: ReportExportOptions = {},
): string {
  return JSON.stringify(buildDiagnosticReport(run, analysis, verification, options), null, 2);
}

const CSV_COLUMNS = [
  'finding_id',
  'rule_id',
  'severity',
  'source_id',
  'timestamp',
  'sample_index',
  'row_number',
  'channel',
  'observed_value',
  'expected_condition',
  'evidence',
] as const;

function safeSpreadsheetText(value: string): string {
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
}

function csvCell(value: unknown): string {
  const stringValue = safeSpreadsheetText(
    typeof value === 'string'
      ? value
      : value === undefined || value === null
        ? ''
        : JSON.stringify(value),
  );
  return `"${stringValue.replaceAll('"', '""')}"`;
}

function findingRow(finding: Finding): string[] {
  return [
    finding.findingId,
    finding.ruleId,
    finding.severity,
    finding.sourceId,
    finding.timestamp,
    finding.sampleIndex,
    finding.rowNumber,
    finding.channel,
    finding.observedValue,
    finding.expectedCondition,
    finding.evidence,
  ].map(csvCell);
}

/** Findings-only CSV. It never contains the full uploaded source dataset. */
export function exportFindingsCsv(findings: readonly Finding[]): string {
  return [
    CSV_COLUMNS.map(csvCell).join(','),
    ...findings.map((finding) => findingRow(finding).join(',')),
  ].join('\r\n');
}
