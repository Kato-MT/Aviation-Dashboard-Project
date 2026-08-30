import type { Finding, Severity } from '../../core';
import { formatObserved } from '../../ui/dom';

export interface DiagnosticsFilters {
  severity: Severity | 'all';
  ruleId: string;
  sourceId: string;
  search: string;
}

export const DEFAULT_DIAGNOSTICS_FILTERS: Readonly<DiagnosticsFilters> = Object.freeze({
  severity: 'all',
  ruleId: 'all',
  sourceId: 'all',
  search: '',
});

export interface DiagnosticsFilterOptions {
  ruleIds: string[];
  sourceIds: string[];
}

export interface DiagnosticsFindingPage {
  items: Finding[];
  pageIndex: number;
  pageCount: number;
  firstItem: number;
  lastItem: number;
}

export function diagnosticsFilterOptions(findings: readonly Finding[]): DiagnosticsFilterOptions {
  return {
    ruleIds: [...new Set(findings.map((finding) => finding.ruleId))].sort(),
    sourceIds: [...new Set(findings.map((finding) => finding.sourceId))].sort(),
  };
}

/** Keeps persistent filters honest when a new run has different rules or sources. */
export function normalizeDiagnosticsFilters(
  filters: DiagnosticsFilters,
  findings: readonly Finding[],
): DiagnosticsFilters {
  const options = diagnosticsFilterOptions(findings);
  return {
    ...filters,
    ruleId:
      filters.ruleId === 'all' || options.ruleIds.includes(filters.ruleId) ? filters.ruleId : 'all',
    sourceId:
      filters.sourceId === 'all' || options.sourceIds.includes(filters.sourceId)
        ? filters.sourceId
        : 'all',
  };
}

export function hasActiveDiagnosticsFilters(filters: DiagnosticsFilters): boolean {
  return (
    filters.severity !== 'all' ||
    filters.ruleId !== 'all' ||
    filters.sourceId !== 'all' ||
    filters.search.trim() !== ''
  );
}

function searchableFinding(finding: Finding): string {
  return [
    finding.ruleId,
    finding.sourceId,
    finding.timestamp,
    formatObserved(finding.observedValue),
    finding.expectedCondition,
    finding.evidence.message,
  ]
    .map(formatObserved)
    .join(' ')
    .toLocaleLowerCase('en-US');
}

export function filterDiagnosticsFindings(
  findings: readonly Finding[],
  filters: DiagnosticsFilters,
): Finding[] {
  const search = filters.search.trim().toLocaleLowerCase('en-US');
  return findings.filter((finding) => {
    if (filters.severity !== 'all' && finding.severity !== filters.severity) return false;
    if (filters.ruleId !== 'all' && finding.ruleId !== filters.ruleId) return false;
    if (filters.sourceId !== 'all' && finding.sourceId !== filters.sourceId) return false;
    return search === '' || searchableFinding(finding).includes(search);
  });
}

export function diagnosticsFindingPage(
  findings: readonly Finding[],
  requestedPage: number,
  pageSize = 100,
): DiagnosticsFindingPage {
  const normalizedPageSize = Number.isFinite(pageSize) ? Math.floor(pageSize) : 100;
  const boundedPageSize = Math.max(1, normalizedPageSize);
  const pageCount = Math.max(1, Math.ceil(findings.length / boundedPageSize));
  const normalizedPage = Number.isFinite(requestedPage) ? Math.floor(requestedPage) : 0;
  const pageIndex = Math.max(0, Math.min(pageCount - 1, normalizedPage));
  const start = pageIndex * boundedPageSize;
  const items = findings.slice(start, start + boundedPageSize);
  return {
    items,
    pageIndex,
    pageCount,
    firstItem: items.length === 0 ? 0 : start + 1,
    lastItem: start + items.length,
  };
}
