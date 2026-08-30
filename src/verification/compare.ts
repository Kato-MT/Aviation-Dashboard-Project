import { APPLICATION_VERSION } from '../core/constants';
import type {
  AnalysisResult,
  Finding,
  FindingClassification,
  NewlyIntroducedFindingClassification,
  PersistingFindingClassification,
  ResolvedFindingClassification,
  TelemetryRun,
  VerificationRequirementResult,
  VerificationRun,
  VerificationRunSummary,
} from '../core/types';
import { FINDING_IDENTITY_VERSION, VERIFICATION_SCHEMA_VERSION } from '../core/types';

export interface VerificationOptions {
  createdAt?: string | undefined;
  verificationId?: string | undefined;
}

export type VerificationCompatibilityCode =
  'DUPLICATE_FINGERPRINT' | 'PROFILE_MISMATCH' | 'RUN_BINDING_MISMATCH' | 'RUN_PROVENANCE_MISMATCH';

export class VerificationCompatibilityError extends Error {
  constructor(
    readonly code: VerificationCompatibilityCode,
    message: string,
  ) {
    super(message);
    this.name = 'VerificationCompatibilityError';
  }
}

function mapByFingerprint(
  findings: readonly Finding[],
  collection: 'baseline' | 'candidate',
): Map<string, Finding> {
  const result = new Map<string, Finding>();
  for (const finding of findings) {
    if (result.has(finding.fingerprint)) {
      throw new VerificationCompatibilityError(
        'DUPLICATE_FINGERPRINT',
        `The ${collection} analysis contains duplicate finding fingerprint ${finding.fingerprint}.`,
      );
    }
    result.set(finding.fingerprint, finding);
  }
  return result;
}

export function classifyFindings(
  baselineFindings: readonly Finding[],
  candidateFindings: readonly Finding[],
): Pick<VerificationRun, 'resolved' | 'persisting' | 'newlyIntroduced'> {
  const baseline = mapByFingerprint(baselineFindings, 'baseline');
  const candidate = mapByFingerprint(candidateFindings, 'candidate');
  const resolved: ResolvedFindingClassification[] = [];
  const persisting: PersistingFindingClassification[] = [];
  const newlyIntroduced: NewlyIntroducedFindingClassification[] = [];

  for (const [fingerprint, finding] of baseline) {
    const candidateFinding = candidate.get(fingerprint);
    if (candidateFinding) {
      persisting.push({ fingerprint, baseline: finding, candidate: candidateFinding });
    } else resolved.push({ fingerprint, baseline: finding });
  }

  for (const [fingerprint, finding] of candidate) {
    if (!baseline.has(fingerprint)) newlyIntroduced.push({ fingerprint, candidate: finding });
  }

  const sort = (left: FindingClassification, right: FindingClassification): number =>
    left.fingerprint.localeCompare(right.fingerprint);
  resolved.sort(sort);
  persisting.sort(sort);
  newlyIntroduced.sort(sort);
  return { resolved, persisting, newlyIntroduced };
}

function assertRunBinding(
  label: 'Baseline' | 'Candidate',
  run: TelemetryRun,
  analysis: AnalysisResult,
): void {
  if (analysis.runId !== run.runId) {
    throw new VerificationCompatibilityError(
      'RUN_BINDING_MISMATCH',
      `${label} analysis ${analysis.runId} does not belong to run ${run.runId}.`,
    );
  }
  if (
    run.provenance.acceptedRecords !== run.samples.length ||
    run.provenance.quarantinedRecords !== run.quarantinedRows.length
  ) {
    throw new VerificationCompatibilityError(
      'RUN_PROVENANCE_MISMATCH',
      `${label} provenance counts do not match its accepted and quarantined records.`,
    );
  }
}

function summarizeRun(run: TelemetryRun, analysis: AnalysisResult): VerificationRunSummary {
  return {
    runId: run.runId,
    datasetSha256: run.provenance.datasetSha256,
    schemaVersion: run.schemaVersion,
    adapterId: run.adapterId,
    adapterVersion: run.adapterVersion,
    profileId: analysis.profileId,
    profileVersion: analysis.profileVersion,
    acceptedRecords: run.samples.length,
    quarantinedRecords: run.quarantinedRows.length,
    validationIssueCount: run.validationIssues.length,
    fatalValidationIssueCount: run.validationIssues.filter((issue) => issue.disposition === 'fatal')
      .length,
    fatal: run.fatal,
    analysisBlocked: analysis.blocked,
    findingCount: analysis.findings.length,
  };
}

function requirementResults(
  baseline: VerificationRunSummary,
  candidate: VerificationRunSummary,
  status: VerificationRun['status'],
): VerificationRequirementResult[] {
  return [
    {
      requirementId: 'FDW-VER-001',
      status: 'pass',
      testIds: ['TC-VER-001', 'TC-VER-002', 'TC-VER-003', 'TC-VER-004'],
      evidence: `Compared baseline ${baseline.runId} with candidate ${candidate.runId}.`,
    },
    {
      requirementId: 'FDW-VER-002',
      status: 'pass',
      testIds: ['TC-VER-001', 'TC-VER-002', 'TC-VER-003', 'TC-VER-004'],
      evidence: 'Findings were classified as resolved, persisting, or newly introduced.',
    },
    {
      requirementId: 'FDW-VER-003',
      status: 'pass',
      testIds: ['TC-VER-006', 'TC-VER-008'],
      evidence: `Recorded accepted, quarantined, and validation counts for both runs (${baseline.acceptedRecords}/${baseline.quarantinedRecords}/${baseline.validationIssueCount} and ${candidate.acceptedRecords}/${candidate.quarantinedRecords}/${candidate.validationIssueCount}).`,
    },
    {
      requirementId: 'FDW-VER-004',
      status: 'pass',
      testIds: ['TC-VER-005'],
      evidence: candidate.analysisBlocked
        ? `Candidate analysis was blocked and the overall verification status is ${status}.`
        : 'Candidate analysis contained no fatal blocking condition.',
    },
    {
      requirementId: 'FDW-VER-005',
      status: 'pass',
      testIds: ['TC-VER-008'],
      evidence:
        'Application, profile, schema, adapter, hash, count, finding, and outcome provenance is recorded.',
    },
    {
      requirementId: 'FDW-VER-006',
      status: 'pass',
      testIds: ['TC-VER-009'],
      evidence: `Finding comparison uses ${FINDING_IDENTITY_VERSION}.`,
    },
    {
      requirementId: 'FDW-VER-007',
      status: 'pass',
      testIds: ['TC-VER-008'],
      evidence: `This report records evaluated requirement results and the overall ${status} status.`,
    },
    {
      requirementId: 'FDW-VER-008',
      status: candidate.findingCount === 0 ? 'pass' : 'not-run',
      testIds: ['TC-VER-007'],
      evidence:
        candidate.findingCount === 0
          ? 'The candidate has zero findings and is represented as a nominal result.'
          : `The candidate has ${candidate.findingCount} findings, so nominal-result handling is not applicable.`,
    },
  ];
}

export function createVerificationRun(
  baselineRun: TelemetryRun,
  baselineAnalysis: AnalysisResult,
  candidateRun: TelemetryRun,
  candidateAnalysis: AnalysisResult,
  options: VerificationOptions = {},
): VerificationRun {
  assertRunBinding('Baseline', baselineRun, baselineAnalysis);
  assertRunBinding('Candidate', candidateRun, candidateAnalysis);
  if (
    baselineAnalysis.profileId !== candidateAnalysis.profileId ||
    baselineAnalysis.profileVersion !== candidateAnalysis.profileVersion
  ) {
    throw new VerificationCompatibilityError(
      'PROFILE_MISMATCH',
      'Baseline and candidate analyses must use the same profile ID and version.',
    );
  }

  const classifications = classifyFindings(baselineAnalysis.findings, candidateAnalysis.findings);
  const blocked = baselineAnalysis.blocked || candidateAnalysis.blocked;
  const status = blocked ? 'blocked' : classifications.newlyIntroduced.length > 0 ? 'fail' : 'pass';
  const createdAt = options.createdAt ?? new Date().toISOString();
  const baseline = summarizeRun(baselineRun, baselineAnalysis);
  const candidate = summarizeRun(candidateRun, candidateAnalysis);

  return {
    schemaVersion: VERIFICATION_SCHEMA_VERSION,
    verificationId:
      options.verificationId ??
      `verify-${baselineRun.provenance.datasetSha256.slice(0, 8)}-${candidateRun.provenance.datasetSha256.slice(0, 8)}`,
    createdAt,
    baseline,
    candidate,
    ...classifications,
    status,
    summary: {
      resolved: classifications.resolved.length,
      persisting: classifications.persisting.length,
      newlyIntroduced: classifications.newlyIntroduced.length,
    },
    requirementResults: requirementResults(baseline, candidate, status),
    provenance: {
      applicationVersion: APPLICATION_VERSION,
      findingIdentityVersion: FINDING_IDENTITY_VERSION,
      profileId: baselineAnalysis.profileId,
      profileVersion: baselineAnalysis.profileVersion,
      baselineAdapterId: baselineRun.adapterId,
      baselineAdapterVersion: baselineRun.adapterVersion,
      baselineSchemaVersion: baselineRun.schemaVersion,
      candidateAdapterId: candidateRun.adapterId,
      candidateAdapterVersion: candidateRun.adapterVersion,
      candidateSchemaVersion: candidateRun.schemaVersion,
    },
  };
}
