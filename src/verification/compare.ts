import { APPLICATION_VERSION } from '../core/constants';
import type {
  AnalysisResult,
  Finding,
  FindingClassification,
  TelemetryRun,
  VerificationRun,
} from '../core/types';
import { VERIFICATION_SCHEMA_VERSION } from '../core/types';

export interface VerificationOptions {
  createdAt?: string | undefined;
  verificationId?: string | undefined;
}

function mapByFingerprint(findings: readonly Finding[]): Map<string, Finding> {
  return new Map(findings.map((finding) => [finding.fingerprint, finding]));
}

export function classifyFindings(
  baselineFindings: readonly Finding[],
  candidateFindings: readonly Finding[],
): Pick<VerificationRun, 'resolved' | 'persisting' | 'newlyIntroduced'> {
  const baseline = mapByFingerprint(baselineFindings);
  const candidate = mapByFingerprint(candidateFindings);
  const resolved: FindingClassification[] = [];
  const persisting: FindingClassification[] = [];
  const newlyIntroduced: FindingClassification[] = [];

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

export function createVerificationRun(
  baselineRun: TelemetryRun,
  baselineAnalysis: AnalysisResult,
  candidateRun: TelemetryRun,
  candidateAnalysis: AnalysisResult,
  options: VerificationOptions = {},
): VerificationRun {
  if (
    baselineAnalysis.profileId !== candidateAnalysis.profileId ||
    baselineAnalysis.profileVersion !== candidateAnalysis.profileVersion
  ) {
    throw new Error('Baseline and candidate analyses must use the same profile ID and version.');
  }

  const classifications = classifyFindings(baselineAnalysis.findings, candidateAnalysis.findings);
  const blocked = baselineAnalysis.blocked || candidateAnalysis.blocked;
  const status = blocked ? 'blocked' : classifications.newlyIntroduced.length > 0 ? 'fail' : 'pass';
  const createdAt = options.createdAt ?? new Date().toISOString();

  return {
    schemaVersion: VERIFICATION_SCHEMA_VERSION,
    verificationId:
      options.verificationId ??
      `verify-${baselineRun.provenance.datasetSha256.slice(0, 8)}-${candidateRun.provenance.datasetSha256.slice(0, 8)}`,
    createdAt,
    baseline: {
      runId: baselineRun.runId,
      datasetSha256: baselineRun.provenance.datasetSha256,
      findingCount: baselineAnalysis.findings.length,
    },
    candidate: {
      runId: candidateRun.runId,
      datasetSha256: candidateRun.provenance.datasetSha256,
      findingCount: candidateAnalysis.findings.length,
    },
    ...classifications,
    status,
    summary: {
      resolved: classifications.resolved.length,
      persisting: classifications.persisting.length,
      newlyIntroduced: classifications.newlyIntroduced.length,
    },
    provenance: {
      applicationVersion: APPLICATION_VERSION,
      profileId: baselineAnalysis.profileId,
      profileVersion: baselineAnalysis.profileVersion,
      baselineAdapterId: baselineRun.adapterId,
      candidateAdapterId: candidateRun.adapterId,
    },
  };
}
