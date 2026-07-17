import { describe, expect, it } from 'vitest';
import { parseCsv } from '../../src/adapters/csv-parser';
import { analyzeTelemetryRun } from '../../src/core/rule-engine';
import type {
  AnalysisResult,
  DetectionProfile,
  Finding,
  ValidationIssue,
} from '../../src/core/types';
import {
  buildDiagnosticReport,
  exportFindingsCsv,
  serializeDiagnosticReport,
} from '../../src/export/reports';
import {
  DECLARED_FAULT_SCENARIOS,
  getFaultScenario,
  injectFaultScenario,
  injectLegacyCsvFault,
} from '../../src/faults/scenarios';
import { createSeededRandom, deterministicIndex } from '../../src/faults/prng';
import { includedBaselineProfile } from '../../src/profiles/included-baseline';
import { classifyFindings, createVerificationRun } from '../../src/verification/compare';
import { makeRun, makeSample, profileWith } from './helpers';

const fixedTime = '2026-07-17T00:00:00.000Z';

function nominalRun(count = 12) {
  return makeRun(Array.from({ length: count }, (_, index) => makeSample(index)));
}

function fixedAnalysis(run = nominalRun(), profile: DetectionProfile = profileWith({ rules: [] })) {
  return analyzeTelemetryRun(run, profile, { generatedAt: fixedTime });
}

describe('seeded deterministic fault injection', () => {
  it('declares at least eight documented scenarios', () => {
    expect(DECLARED_FAULT_SCENARIOS.length).toBeGreaterThanOrEqual(8);
    expect(new Set(DECLARED_FAULT_SCENARIOS.map((scenario) => scenario.id)).size).toBe(
      DECLARED_FAULT_SCENARIOS.length,
    );
  });

  it('returns a repeatable pseudo-random sequence', () => {
    const first = createSeededRandom(42);
    const second = createSeededRandom(42);
    expect([first(), first(), first()]).toEqual([second(), second(), second()]);
  });

  it('selects an index inside the requested margin', () => {
    expect(deterministicIndex(3, 100, 10)).toBeGreaterThanOrEqual(10);
    expect(deterministicIndex(3, 100, 10)).toBeLessThan(90);
  });

  it('rejects selection from an empty run', () => {
    expect(() => deterministicIndex(1, 0)).toThrow('empty run');
  });

  it('looks up a declared scenario', () => {
    expect(getFaultScenario('stale-feed')?.label).toBe('Stale feed');
    expect(getFaultScenario('not-declared')).toBeUndefined();
  });

  it.each(
    DECLARED_FAULT_SCENARIOS.filter((scenario) => scenario.target === 'canonical').map(
      (scenario) => [scenario.id, scenario.expectedRuleIds] as const,
    ),
  )(
    'scenario %s produces exactly its declared diagnostic rule IDs',
    async (scenarioId, expectedRuleIds) => {
      const source = nominalRun();
      const baselineRuleIds = new Set(
        analyzeTelemetryRun(source, includedBaselineProfile, {
          generatedAt: fixedTime,
        }).findings.map((finding) => finding.ruleId),
      );
      const injected = await injectFaultScenario(source, scenarioId, 7);
      const analysis = analyzeTelemetryRun(injected, includedBaselineProfile, {
        generatedAt: fixedTime,
      });
      const actualRuleIds = [
        ...new Set(
          analysis.findings
            .map((finding) => finding.ruleId)
            .filter((ruleId) => !baselineRuleIds.has(ruleId)),
        ),
      ].sort();
      expect(actualRuleIds).toEqual([...expectedRuleIds].sort());
    },
  );

  it('same scenario and seed produce identical canonical hashes', async () => {
    const first = await injectFaultScenario(nominalRun(), 'duplicate-timestamp', 9);
    const second = await injectFaultScenario(nominalRun(), 'duplicate-timestamp', 9);
    expect(first.provenance.datasetSha256).toBe(second.provenance.datasetSha256);
    expect(first.samples).toEqual(second.samples);
  });

  it('different seeds produce different canonical hashes', async () => {
    const first = await injectFaultScenario(nominalRun(), 'missing-altitude', 9);
    const second = await injectFaultScenario(nominalRun(), 'missing-altitude', 10);
    expect(first.provenance.datasetSha256).not.toBe(second.provenance.datasetSha256);
  });

  it('does not mutate the source run', async () => {
    const source = nominalRun();
    const before = JSON.stringify(source);
    await injectFaultScenario(source, 'range-excursion', 2);
    expect(JSON.stringify(source)).toBe(before);
  });

  it('records scenario metadata and recomputed provenance', async () => {
    const source = nominalRun();
    const injected = await injectFaultScenario(source, 'stale-feed', 2);
    expect(injected.metadata.injectedFault).toEqual({
      scenarioId: 'stale-feed',
      seed: 2,
      synthetic: true,
    });
    expect(injected.provenance.datasetSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(injected.provenance.datasetSha256).not.toBe(source.provenance.datasetSha256);
  });

  it('rejects canonical injection of a CSV-targeted scenario', async () => {
    await expect(injectFaultScenario(nominalRun(), 'blank-csv-value', 1)).rejects.toThrow(
      'targets legacy-csv',
    );
  });

  it('injects a blank CSV value deterministically', () => {
    const csv = 'timestamp,altitude_ft,speed_kts,fuel_pct\n00:00,1,2,3\n00:10,4,5,6';
    const first = injectLegacyCsvFault(csv, 'blank-csv-value', 3);
    expect(first).toBe(injectLegacyCsvFault(csv, 'blank-csv-value', 3));
    expect(first).toMatch(/,,\d,\d/);
  });

  it('injects nonnumeric CSV text', () => {
    const csv = 'timestamp,altitude_ft,speed_kts,fuel_pct\n00:00,1,2,3\n00:10,4,5,6';
    expect(injectLegacyCsvFault(csv, 'nonnumeric-csv-value', 1)).toContain('not-a-number');
  });
});

describe('before-and-after verification', () => {
  const thresholdProfile = profileWith({
    rules: [
      {
        id: 'test.speed',
        kind: 'threshold',
        label: 'Test speed',
        description: 'Synthetic test threshold',
        severity: 'error',
        enabled: true,
        channel: 'speed',
        operator: '>',
        threshold: 500,
      },
    ],
  });

  function runWithSpeeds(first: number, second: number) {
    return makeRun([
      makeSample(0, { measurements: { altitude: 1_000, speed: first, fuel: 90 } }),
      makeSample(1, { measurements: { altitude: 1_100, speed: second, fuel: 89.9 } }),
    ]);
  }

  it('classifies a finding present in both runs as persisting', () => {
    const run = runWithSpeeds(600, 200);
    const analysis = fixedAnalysis(run, thresholdProfile);
    const classes = classifyFindings(analysis.findings, analysis.findings);
    expect(classes.persisting).toHaveLength(1);
    expect(classes.resolved).toHaveLength(0);
    expect(classes.newlyIntroduced).toHaveLength(0);
  });

  it('classifies a removed finding as resolved', () => {
    const baseline = fixedAnalysis(runWithSpeeds(600, 200), thresholdProfile);
    const candidate = fixedAnalysis(runWithSpeeds(200, 200), thresholdProfile);
    expect(classifyFindings(baseline.findings, candidate.findings).resolved).toHaveLength(1);
  });

  it('classifies a candidate-only finding as newly introduced', () => {
    const baseline = fixedAnalysis(runWithSpeeds(200, 200), thresholdProfile);
    const candidate = fixedAnalysis(runWithSpeeds(200, 600), thresholdProfile);
    expect(classifyFindings(baseline.findings, candidate.findings).newlyIntroduced).toHaveLength(1);
  });

  it('passes when there are no newly introduced findings', () => {
    const baselineRun = runWithSpeeds(600, 200);
    const candidateRun = runWithSpeeds(200, 200);
    const verification = createVerificationRun(
      baselineRun,
      fixedAnalysis(baselineRun, thresholdProfile),
      candidateRun,
      fixedAnalysis(candidateRun, thresholdProfile),
      { createdAt: fixedTime },
    );
    expect(verification.status).toBe('pass');
    expect(verification.summary.resolved).toBe(1);
  });

  it('fails when a new finding is introduced', () => {
    const baselineRun = runWithSpeeds(200, 200);
    const candidateRun = runWithSpeeds(200, 600);
    const verification = createVerificationRun(
      baselineRun,
      fixedAnalysis(baselineRun, thresholdProfile),
      candidateRun,
      fixedAnalysis(candidateRun, thresholdProfile),
    );
    expect(verification.status).toBe('fail');
    expect(verification.summary.newlyIntroduced).toBe(1);
  });

  it('blocks when either analysis is blocked', () => {
    const baselineRun = runWithSpeeds(200, 200);
    const candidateRun = runWithSpeeds(200, 200);
    candidateRun.fatal = true;
    candidateRun.validationIssues.push({
      code: 'SCHEMA_MISMATCH',
      disposition: 'fatal',
      message: 'blocked',
    });
    const verification = createVerificationRun(
      baselineRun,
      fixedAnalysis(baselineRun, thresholdProfile),
      candidateRun,
      fixedAnalysis(candidateRun, thresholdProfile),
    );
    expect(verification.status).toBe('blocked');
  });

  it('rejects comparison across different profile versions', () => {
    const run = runWithSpeeds(200, 200);
    const baseline = fixedAnalysis(run, thresholdProfile);
    const candidate: AnalysisResult = { ...baseline, profileVersion: 'different' };
    expect(() => createVerificationRun(run, baseline, run, candidate)).toThrow('same profile');
  });
});

describe('evidence exports', () => {
  function runWithQuarantine() {
    const run = nominalRun(2);
    const issue: ValidationIssue = {
      code: 'NONNUMERIC_VALUE',
      disposition: 'recoverable',
      message: 'hostile raw value',
      rowNumber: 2,
      sourceId: 'source-a',
      channel: 'altitude',
      observedValue: '=DANGEROUS()',
    };
    run.validationIssues.push(issue);
    run.quarantinedRows.push({
      rowNumber: 2,
      sourceId: 'source-a',
      issues: [issue],
      raw: { altitude: '=DANGEROUS()' },
    });
    run.provenance.quarantinedRecords = 1;
    return run;
  }

  it('excludes samples and raw quarantined data by default', () => {
    const run = runWithQuarantine();
    const report = buildDiagnosticReport(run, fixedAnalysis(run));
    expect(report.run.samples).toBeUndefined();
    expect(report.run.sources).toBeUndefined();
    expect(report.run.quarantinedRows[0]?.raw).toBeUndefined();
    expect(report.exportPolicy.sourceDataIncluded).toBe(false);
  });

  it('includes source data only after an explicit option', () => {
    const run = runWithQuarantine();
    const report = buildDiagnosticReport(run, fixedAnalysis(run), undefined, {
      includeSourceData: true,
    });
    expect(report.run.samples).toHaveLength(2);
    expect(report.run.quarantinedRows[0]?.raw).toEqual({ altitude: '=DANGEROUS()' });
    expect(report.exportPolicy.sourceDataIncluded).toBe(true);
  });

  it('serializes a versioned diagnostic report', () => {
    const run = nominalRun(2);
    const serialized = serializeDiagnosticReport(run, fixedAnalysis(run), undefined, {
      generatedAt: fixedTime,
    });
    expect(JSON.parse(serialized)).toMatchObject({
      reportSchemaVersion: 'diagnostic-report.v1',
      generatedAt: fixedTime,
    });
  });

  it('exports a fixed findings-only CSV header', () => {
    expect(exportFindingsCsv([]).split('\r\n')[0]).toContain('"rule_id"');
  });

  it('quotes commas and quotes in CSV evidence', () => {
    const finding: Finding = {
      findingId: 'f-1',
      fingerprint: 'f-1',
      ruleId: 'test.csv',
      ruleLabel: 'CSV test',
      severity: 'warning',
      sourceId: 'source-a',
      observedValue: 'value,"quoted"',
      expectedCondition: 'safe',
      evidence: { message: 'message, with "quotes"' },
      origin: 'rule-engine',
    };
    const csv = exportFindingsCsv([finding]);
    expect(csv).toContain('"value,""quoted"""');
    expect(parseCsv(csv).records[1]?.[10]).toBe(JSON.stringify(finding.evidence));
  });

  it('neutralizes spreadsheet formulas in CSV fields', () => {
    const finding: Finding = {
      findingId: '=FORMULA()',
      fingerprint: 'formula',
      ruleId: 'test.formula',
      ruleLabel: 'Formula test',
      severity: 'warning',
      sourceId: 'source-a',
      observedValue: '@SUM(1,2)',
      expectedCondition: '+SAFE',
      evidence: { message: '-danger' },
      origin: 'adapter',
    };
    const csv = exportFindingsCsv([finding]);
    expect(csv).toContain("'=FORMULA()");
    expect(csv).toContain("'@SUM(1,2)");
    expect(csv).toContain("'+SAFE");
  });
});
