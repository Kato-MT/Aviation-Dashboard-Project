import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import { legacyCsvAdapter } from '../../src/adapters';
import { APPLICATION_VERSION, analyzeTelemetryRun, countFindingsByRule } from '../../src/core';
import { includedBaselineProfile } from '../../src/profiles';

const repositoryRoot = resolve(import.meta.dirname, '..', '..');
const generatedAt = process.env.SOURCE_DATE_EPOCH
  ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1_000).toISOString()
  : new Date().toISOString();
const fixedAnalysisTime = '2026-07-17T00:00:00.000Z';
const expectedDatasetHash = 'b3b50781afde9b3895707109e40e86b2fae82ed8e38cc4e964d9cb2de327b700';
const includeExpandedEvidence = /^2\.1\./.test(APPLICATION_VERSION);

interface TraceabilityMapping {
  requirements: string[];
  tests: string[];
}

interface CoverageSummary {
  total: {
    branches: { pct: number };
    functions: { pct: number };
    lines: { pct: number };
    statements: { pct: number };
  };
}

async function readJson<T>(relativePath: string): Promise<T> {
  return JSON.parse(await readFile(resolve(repositoryRoot, relativePath), 'utf8')) as T;
}

function requireGate(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Release evidence gate failed: ${message}`);
  }
}

const csv = await readFile(resolve(repositoryRoot, 'data', 'flight.csv'), 'utf8');
const run = await legacyCsvAdapter.parse(csv, {
  runId: 'included-baseline-release-evidence',
  createdAt: fixedAnalysisTime,
  profileId: includedBaselineProfile.id,
  profileVersion: includedBaselineProfile.version,
});
const analysis = analyzeTelemetryRun(run, includedBaselineProfile, {
  generatedAt: fixedAnalysisTime,
});
const findingDistribution = countFindingsByRule(analysis.findings);
const coverage = await readJson<CoverageSummary>('coverage/coverage-summary.json');
const benchmark = await readJson<Record<string, unknown>>('benchmark/latest.json');
const modelEvaluation = await readJson<Record<string, unknown>>('models/evaluation_v1.json');
const traceability = await readJson<{
  schemaVersion: string;
  mappings: TraceabilityMapping[];
}>('requirements/traceability.json');

const requirementIds = [
  ...new Set(traceability.mappings.flatMap((mapping) => mapping.requirements)),
];
const testIds = [...new Set(traceability.mappings.flatMap((mapping) => mapping.tests))];
const modelGate =
  (modelEvaluation.qualityGate as { passed?: boolean } | undefined)?.passed === true;

const gates = {
  datasetHash: run.provenance.datasetSha256 === expectedDatasetHash,
  acceptedRecords: run.samples.length === 85,
  quarantinedRecords: run.quarantinedRows.length === 0,
  fatalValidation: run.fatal === false,
  findingTotal: analysis.findings.length === 9,
  overspeed: findingDistribution['baseline.overspeed'] === 5,
  rapidDescent: findingDistribution['baseline.rapid-descent'] === 3,
  fuelChange: findingDistribution['baseline.fuel-change'] === 1,
  branchCoverage: coverage.total.branches.pct >= 90,
  ...(includeExpandedEvidence ? { modelQuality: modelGate } : {}),
};

for (const [gate, passed] of Object.entries(gates)) {
  requireGate(passed, gate);
}

const report = {
  reportSchemaVersion: 'release-verification.v1',
  runId: run.runId,
  createdAt: generatedAt,
  status: 'pass',
  dataBoundary:
    'All telemetry, profiles, thresholds, and injected scenarios are synthetic and unclassified.',
  applicationVersion: APPLICATION_VERSION,
  profileId: includedBaselineProfile.id,
  profileVersion: includedBaselineProfile.version,
  adapter: `${run.adapterId}@${run.adapterVersion}`,
  datasetHash: run.provenance.datasetSha256,
  provenance: {
    applicationVersion: APPLICATION_VERSION,
    sourceRevision: process.env.GITHUB_SHA ?? process.env.SOURCE_REVISION ?? 'working-tree',
    adapter: `${run.adapterId}@${run.adapterVersion}`,
    datasetHash: run.provenance.datasetSha256,
    profileId: includedBaselineProfile.id,
    profileVersion: includedBaselineProfile.version,
    generatedAt,
  },
  recordCounts: {
    total: run.provenance.totalRows,
    accepted: run.samples.length,
    quarantined: run.quarantinedRows.length,
    validationErrors: run.validationIssues.filter((issue) => issue.disposition === 'fatal').length,
  },
  validation: {
    fatal: run.fatal,
    issues: run.validationIssues,
  },
  sources: run.sources.map((source) => ({
    sourceId: source.sourceId,
    profileId: includedBaselineProfile.id,
    schemaVersion: run.schemaVersion,
    acceptedRecords: run.samples.filter((sample) => sample.sourceId === source.sourceId).length,
    droppedMessages: 0,
  })),
  findings: analysis.findings,
  comparison: {
    outcome: 'baseline-golden-regression',
    status: 'pass',
    expected: {
      acceptedRecords: 85,
      findingTotal: 9,
      distribution: {
        'baseline.overspeed': 5,
        'baseline.rapid-descent': 3,
        'baseline.fuel-change': 1,
      },
    },
    actual: {
      acceptedRecords: run.samples.length,
      findingTotal: analysis.findings.length,
      distribution: findingDistribution,
    },
  },
  coverage: coverage.total,
  ...(includeExpandedEvidence ? { benchmark, modelEvaluation } : {}),
  traceability: {
    schemaVersion: traceability.schemaVersion,
    requirementCount: requirementIds.length,
    declaredTestIdCount: testIds.length,
  },
  requirementResults: [
    {
      requirementId: 'FDW-ING-003',
      status: 'pass',
      testIds: ['TC-CSV-001', 'TC-CSV-002'],
      evidence: 'Included dataset hash and 85 accepted records verified by the generated report.',
    },
    {
      requirementId: 'FDW-RUL-009',
      status: 'pass',
      testIds: ['TC-RULE-001', 'TC-RULE-002', 'TC-RULE-003', 'TC-RULE-004'],
      evidence: 'Exact 5 overspeed, 3 rapid-descent, and 1 fuel-change distribution verified.',
    },
    {
      requirementId: 'FDW-CM-004',
      status: 'pass',
      testIds: ['TC-CM-001'],
      evidence: `Extracted-core branch coverage is ${coverage.total.branches.pct} percent.`,
    },
    ...(includeExpandedEvidence
      ? [
          {
            requirementId: 'FDW-ML-005',
            status: modelGate ? 'pass' : 'fail',
            testIds: ['TC-ML-002', 'TC-ML-003'],
            evidence:
              'Committed held-out evaluation satisfies the declared F1 and false-positive gates.',
          },
        ]
      : []),
  ],
  releaseGates: gates,
  exportPolicy: {
    sourceDataIncluded: false,
    note: 'The verification report contains findings and provenance, not source telemetry samples.',
  },
};

const outputDirectory = resolve(repositoryRoot, 'artifacts');
await mkdir(outputDirectory, { recursive: true });
const outputPath = resolve(outputDirectory, 'verification-report.json');
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`release-report: wrote verified evidence to ${outputPath}`);
