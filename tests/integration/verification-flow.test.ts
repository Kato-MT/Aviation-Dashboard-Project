import { describe, expect, it } from 'vitest';

import baselineCsv from '../../data/flight.csv?raw';
import { legacyCsvAdapter } from '../../src/adapters';
import { analyzeTelemetryRun } from '../../src/core';
import { buildDiagnosticReport } from '../../src/export';
import { injectFaultScenario } from '../../src/faults';
import { includedBaselineProfile } from '../../src/profiles';
import { createVerificationRun } from '../../src/verification';

describe('end-to-end deterministic verification flow', () => {
  it('TC-VER-001 compares a rehashed injected candidate without exposing source samples', async () => {
    const baseline = await legacyCsvAdapter.parse(baselineCsv, {
      profileId: includedBaselineProfile.id,
      profileVersion: includedBaselineProfile.version,
    });
    const baselineAnalysis = analyzeTelemetryRun(baseline, includedBaselineProfile, {
      generatedAt: '2026-07-17T00:00:00.000Z',
    });
    const candidate = await injectFaultScenario(baseline, 'missing-altitude', 1_337);
    const candidateAnalysis = analyzeTelemetryRun(candidate, includedBaselineProfile, {
      generatedAt: '2026-07-17T00:00:00.000Z',
    });
    const verification = createVerificationRun(
      baseline,
      baselineAnalysis,
      candidate,
      candidateAnalysis,
      { createdAt: '2026-07-17T00:00:00.000Z' },
    );
    const report = buildDiagnosticReport(candidate, candidateAnalysis, verification);

    expect(baselineAnalysis.findings).toHaveLength(9);
    expect(candidate.provenance.datasetSha256).not.toBe(baseline.provenance.datasetSha256);
    expect(verification.status).toBe('fail');
    expect(verification.newlyIntroduced.map((item) => item.candidate?.ruleId)).toContain(
      'data.value.missing',
    );
    expect(report.exportPolicy.sourceDataIncluded).toBe(false);
    expect(report.run).not.toHaveProperty('samples');
  });
});
