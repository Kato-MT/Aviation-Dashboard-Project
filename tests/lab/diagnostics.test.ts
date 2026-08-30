import { describe, expect, it } from 'vitest';
import type { Finding } from '../../src/core';
import {
  DEFAULT_DIAGNOSTICS_FILTERS,
  diagnosticsFilterOptions,
  diagnosticsFindingPage,
  filterDiagnosticsFindings,
  hasActiveDiagnosticsFilters,
  normalizeDiagnosticsFilters,
} from '../../src/features/lab/diagnostics';

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    findingId: 'finding-1',
    fingerprint: 'fingerprint-1',
    ruleId: 'rule.alpha',
    ruleLabel: 'Alpha rule',
    severity: 'warning',
    sourceId: 'source-b',
    timestamp: '2026-01-01T00:00:00.000Z',
    sampleIndex: 3,
    channel: 'speed',
    observedValue: 525,
    expectedCondition: 'speed at or below 520',
    evidence: { message: 'speed value 525 triggered the rule' },
    origin: 'rule-engine',
    ...overrides,
  };
}

describe('React Diagnostics filtering', () => {
  const findings = [
    finding(),
    finding({
      findingId: 'finding-2',
      fingerprint: 'fingerprint-2',
      ruleId: 'rule.beta',
      ruleLabel: 'Beta rule',
      severity: 'error',
      sourceId: 'source-a',
      observedValue: { altitude: 800 },
      evidence: { message: 'rapid descent evidence' },
    }),
    finding({ findingId: 'finding-3', fingerprint: 'fingerprint-3' }),
  ];

  it('builds sorted unique rule and source options without mutating findings', () => {
    const before = structuredClone(findings);
    expect(diagnosticsFilterOptions(findings)).toEqual({
      ruleIds: ['rule.alpha', 'rule.beta'],
      sourceIds: ['source-a', 'source-b'],
    });
    expect(findings).toEqual(before);
  });

  it('combines severity, rule, source and evidence search filters', () => {
    expect(
      filterDiagnosticsFindings(findings, {
        severity: 'error',
        ruleId: 'rule.beta',
        sourceId: 'source-a',
        search: '800',
      }).map(({ findingId }) => findingId),
    ).toEqual(['finding-2']);
    expect(
      filterDiagnosticsFindings(findings, {
        ...DEFAULT_DIAGNOSTICS_FILTERS,
        search: 'rapid descent',
      }),
    ).toHaveLength(1);
    expect(
      filterDiagnosticsFindings(findings, {
        ...DEFAULT_DIAGNOSTICS_FILTERS,
        search: 'no matching evidence',
      }),
    ).toEqual([]);
  });

  it('normalizes stale dynamic options while retaining intentional severity and search state', () => {
    expect(
      normalizeDiagnosticsFilters(
        {
          severity: 'critical',
          ruleId: 'missing-rule',
          sourceId: 'missing-source',
          search: 'fuel',
        },
        findings,
      ),
    ).toEqual({ severity: 'critical', ruleId: 'all', sourceId: 'all', search: 'fuel' });
  });

  it('distinguishes the default query from every active filter dimension', () => {
    expect(hasActiveDiagnosticsFilters({ ...DEFAULT_DIAGNOSTICS_FILTERS })).toBe(false);
    expect(
      hasActiveDiagnosticsFilters({ ...DEFAULT_DIAGNOSTICS_FILTERS, search: '  evidence  ' }),
    ).toBe(true);
    expect(hasActiveDiagnosticsFilters({ ...DEFAULT_DIAGNOSTICS_FILTERS, severity: 'info' })).toBe(
      true,
    );
  });

  it('paginates every matching finding with bounded and clamped page indexes', () => {
    const many = Array.from({ length: 205 }, (_, index) =>
      finding({ findingId: `finding-${index}`, fingerprint: `fingerprint-${index}` }),
    );
    expect(diagnosticsFindingPage(many, 0)).toMatchObject({
      pageIndex: 0,
      pageCount: 3,
      firstItem: 1,
      lastItem: 100,
    });
    expect(diagnosticsFindingPage(many, 1)).toMatchObject({
      pageIndex: 1,
      firstItem: 101,
      lastItem: 200,
    });
    const final = diagnosticsFindingPage(many, 99);
    expect(final).toMatchObject({ pageIndex: 2, firstItem: 201, lastItem: 205 });
    expect(final.items).toHaveLength(5);
    expect(diagnosticsFindingPage([], -5)).toMatchObject({
      pageIndex: 0,
      pageCount: 1,
      firstItem: 0,
      lastItem: 0,
      items: [],
    });
    expect(diagnosticsFindingPage(many, Number.NaN, Number.POSITIVE_INFINITY)).toMatchObject({
      pageIndex: 0,
      pageCount: 3,
      firstItem: 1,
      lastItem: 100,
    });
  });
});
