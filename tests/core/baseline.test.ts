import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LegacyCsvAdapter } from '../../src/adapters/legacy-csv';
import { VersionedJsonAdapter } from '../../src/adapters/versioned-json';
import { analyzeTelemetryRun, countFindingsByRule } from '../../src/core/rule-engine';
import { includedBaselineProfile } from '../../src/profiles/included-baseline';

const fixedTime = '2026-07-17T00:00:00.000Z';

async function loadBaseline() {
  const csv = await readFile(resolve('data/flight.csv'), 'utf8');
  const run = await new LegacyCsvAdapter().parse(csv, {
    profileId: includedBaselineProfile.id,
    profileVersion: includedBaselineProfile.version,
    createdAt: fixedTime,
  });
  const analysis = analyzeTelemetryRun(run, includedBaselineProfile, { generatedAt: fixedTime });
  return { csv, run, analysis };
}

describe('included 85-record golden regression', () => {
  it('accepts exactly 85 records with no quarantined rows', async () => {
    const { run } = await loadBaseline();
    expect(run.samples).toHaveLength(85);
    expect(run.quarantinedRows).toHaveLength(0);
    expect(run.fatal).toBe(false);
  });

  it('preserves the exact repository dataset hash', async () => {
    const { run } = await loadBaseline();
    expect(run.provenance.datasetSha256).toBe(
      'b3b50781afde9b3895707109e40e86b2fae82ed8e38cc4e964d9cb2de327b700',
    );
  });

  it('produces exactly five synthetic overspeed findings', async () => {
    const { analysis } = await loadBaseline();
    expect(countFindingsByRule(analysis.findings)['baseline.overspeed']).toBe(5);
  });

  it('produces exactly three synthetic rapid-descent findings', async () => {
    const { analysis } = await loadBaseline();
    expect(countFindingsByRule(analysis.findings)['baseline.rapid-descent']).toBe(3);
  });

  it('produces exactly one synthetic fuel-change finding', async () => {
    const { analysis } = await loadBaseline();
    expect(countFindingsByRule(analysis.findings)['baseline.fuel-change']).toBe(1);
  });

  it('produces nine findings and no additional rule IDs', async () => {
    const { analysis } = await loadBaseline();
    expect(analysis.findings).toHaveLength(9);
    expect(Object.keys(countFindingsByRule(analysis.findings)).sort()).toEqual([
      'baseline.fuel-change',
      'baseline.overspeed',
      'baseline.rapid-descent',
    ]);
  });

  it('normalizes equivalent versioned JSON to identical samples and findings', async () => {
    const { run, analysis } = await loadBaseline();
    const document = {
      schemaVersion: 'telemetry.v1',
      runId: 'baseline-json',
      profile: { id: includedBaselineProfile.id, version: includedBaselineProfile.version },
      sources: run.sources.map((source) => ({
        sourceId: source.sourceId,
        label: source.label,
        units: source.units,
      })),
      samples: run.samples.map((sample) => ({
        sourceId: sample.sourceId,
        timestamp: sample.timestamp,
        measurements: sample.measurements,
        qualityFlags: sample.qualityFlags,
      })),
    };
    const jsonRun = await new VersionedJsonAdapter().parse(document, { createdAt: fixedTime });
    const jsonAnalysis = analyzeTelemetryRun(jsonRun, includedBaselineProfile, {
      generatedAt: fixedTime,
    });
    expect(
      jsonRun.samples.map(({ sourceId, timestampMs, measurements, units }) => ({
        sourceId,
        timestampMs,
        measurements,
        units,
      })),
    ).toEqual(
      run.samples.map(({ sourceId, timestampMs, measurements, units }) => ({
        sourceId,
        timestampMs,
        measurements,
        units,
      })),
    );
    expect(jsonAnalysis.findings.map((finding) => finding.fingerprint)).toEqual(
      analysis.findings.map((finding) => finding.fingerprint),
    );
  });
});
