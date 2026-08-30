import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import verificationSchema from '../../schemas/verification.v2.schema.json';
import {
  analyzeTelemetryRun,
  type AnalysisResult,
  type Finding,
  type ValidationIssue,
} from '../../src/core';
import { buildDiagnosticReport } from '../../src/export';
import { includedBaselineProfile } from '../../src/profiles';
import {
  classifyFindings,
  createVerificationRun,
  VerificationCompatibilityError,
} from '../../src/verification';
import { makeRun, makeSample } from './helpers';

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
const validate = ajv.compile(verificationSchema);
const generatedAt = '2026-07-17T00:00:00.000Z';

function analysis(run: ReturnType<typeof makeRun>): AnalysisResult {
  return analyzeTelemetryRun(run, includedBaselineProfile, { generatedAt });
}

function candidateRun() {
  const run = makeRun();
  run.runId = 'candidate-run';
  run.provenance.datasetSha256 = 'b'.repeat(64);
  return run;
}

function finding(fingerprint: string): Finding {
  return {
    findingId: `finding-${fingerprint}`,
    fingerprint,
    ruleId: 'test.verification',
    ruleLabel: 'Verification test finding',
    severity: 'warning',
    sourceId: 'source-a',
    observedValue: 1,
    expectedCondition: 'value <= 0',
    evidence: { message: 'Deterministic test evidence.' },
    origin: 'rule-engine',
  };
}

describe('verification.v2 evidence contract', () => {
  it('TC-VER-008 records complete provenance and canonical requirement results', () => {
    const baseline = makeRun();
    const candidate = candidateRun();
    const verification = createVerificationRun(
      baseline,
      analysis(baseline),
      candidate,
      analysis(candidate),
      { createdAt: generatedAt, verificationId: 'verification-contract' },
    );

    expect(validate(verification), JSON.stringify(validate.errors)).toBe(true);
    expect(verification.schemaVersion).toBe('verification.v2');
    expect(verification.baseline).toMatchObject({
      acceptedRecords: 3,
      quarantinedRecords: 0,
      validationIssueCount: 0,
      fatalValidationIssueCount: 0,
      fatal: false,
      schemaVersion: 'telemetry.v1',
      adapterId: 'test-adapter',
      adapterVersion: '1.0.0',
    });
    expect(verification.provenance.findingIdentityVersion).toBe('finding-fingerprint.v1');
    expect(verification.requirementResults.map((result) => result.requirementId)).toEqual([
      'FDW-VER-001',
      'FDW-VER-002',
      'FDW-VER-003',
      'FDW-VER-004',
      'FDW-VER-005',
      'FDW-VER-006',
      'FDW-VER-007',
      'FDW-VER-008',
    ]);
    expect(verification.requirementResults.at(-1)?.status).toBe('pass');
  });

  it('TC-VER-004 returns exact disjoint counts for a mixed comparison', () => {
    const resolved = finding('resolved');
    const persisting = finding('persisting');
    const introduced = finding('introduced');
    const classes = classifyFindings([resolved, persisting], [persisting, introduced]);
    expect(classes.resolved.map((entry) => entry.fingerprint)).toEqual(['resolved']);
    expect(classes.persisting.map((entry) => entry.fingerprint)).toEqual(['persisting']);
    expect(classes.newlyIntroduced.map((entry) => entry.fingerprint)).toEqual(['introduced']);
  });

  it('TC-VER-006 records a candidate quarantine increase in comparison evidence', () => {
    const baseline = makeRun();
    const candidate = candidateRun();
    const issue: ValidationIssue = {
      code: 'NONNUMERIC_VALUE',
      disposition: 'recoverable',
      message: 'Candidate row was quarantined.',
      rowNumber: 5,
    };
    candidate.validationIssues.push(issue);
    candidate.quarantinedRows.push({ rowNumber: 5, issues: [issue], raw: { speed: 'invalid' } });
    candidate.provenance.totalRows += 1;
    candidate.provenance.quarantinedRecords = 1;
    const verification = createVerificationRun(
      baseline,
      analysis(baseline),
      candidate,
      analysis(candidate),
    );
    expect(verification.baseline).toMatchObject({
      acceptedRecords: 3,
      quarantinedRecords: 0,
      validationIssueCount: 0,
    });
    expect(verification.candidate).toMatchObject({
      acceptedRecords: 3,
      quarantinedRecords: 1,
      validationIssueCount: 1,
    });
  });

  it('TC-VER-007 exports a zero-finding candidate as a nominal passing result', () => {
    const baseline = makeRun();
    const candidate = candidateRun();
    const candidateAnalysis = analysis(candidate);
    expect(candidateAnalysis.findings).toHaveLength(0);
    const verification = createVerificationRun(
      baseline,
      analysis(baseline),
      candidate,
      candidateAnalysis,
    );
    const report = buildDiagnosticReport(candidate, candidateAnalysis, verification);
    expect(verification).toMatchObject({
      status: 'pass',
      candidate: { findingCount: 0 },
    });
    expect(
      verification.requirementResults.find((result) => result.requirementId === 'FDW-VER-008'),
    ).toMatchObject({ status: 'pass', testIds: ['TC-VER-007'] });
    expect(report.verification?.candidate.findingCount).toBe(0);
  });

  it('TC-VER-009 comparison identity does not depend on localized display text', () => {
    const baseline = finding('stable-fingerprint');
    const candidate: Finding = {
      ...baseline,
      ruleLabel: 'Localized display label',
      evidence: { message: 'Localized evidence message.' },
    };
    expect(classifyFindings([baseline], [candidate])).toMatchObject({
      resolved: [],
      persisting: [{ fingerprint: 'stable-fingerprint' }],
      newlyIntroduced: [],
    });
  });

  it('rejects a run paired with another analysis instead of producing misleading evidence', () => {
    const baseline = makeRun();
    const candidate = candidateRun();
    const mismatched = { ...analysis(baseline), runId: 'another-run' };
    expect(() =>
      createVerificationRun(baseline, mismatched, candidate, analysis(candidate)),
    ).toThrowError(
      expect.objectContaining<Partial<VerificationCompatibilityError>>({
        code: 'RUN_BINDING_MISMATCH',
      }),
    );
  });

  it('rejects accepted or quarantined provenance counts that disagree with the run', () => {
    const baseline = makeRun();
    const candidate = candidateRun();
    candidate.provenance.acceptedRecords += 1;
    expect(() =>
      createVerificationRun(baseline, analysis(baseline), candidate, analysis(candidate)),
    ).toThrowError(
      expect.objectContaining<Partial<VerificationCompatibilityError>>({
        code: 'RUN_PROVENANCE_MISMATCH',
      }),
    );
  });

  it('rejects duplicate fingerprints rather than silently collapsing evidence', () => {
    const run = makeRun([
      makeSample(0, {
        measurements: { altitude: 1_000, speed: 600, fuel: 90 },
      }),
    ]);
    const finding = analysis(run).findings[0];
    expect(finding).toBeDefined();
    expect(() => classifyFindings([finding!, finding!], [])).toThrowError(
      expect.objectContaining<Partial<VerificationCompatibilityError>>({
        code: 'DUPLICATE_FINGERPRINT',
      }),
    );
  });

  it('rejects serialized evidence with the wrong classification side or duplicate requirement IDs', () => {
    const baseline = makeRun();
    const candidate = candidateRun();
    const verification = createVerificationRun(
      baseline,
      analysis(baseline),
      candidate,
      analysis(candidate),
    );
    const wrongSide = structuredClone(verification) as unknown as Record<string, unknown>;
    wrongSide.resolved = [{ fingerprint: 'wrong-side', candidate: {} }];
    expect(validate(wrongSide)).toBe(false);
    const duplicateRequirements = structuredClone(verification);
    duplicateRequirements.requirementResults = duplicateRequirements.requirementResults.map(
      (result) => ({ ...result, requirementId: 'FDW-VER-001' }),
    );
    expect(validate(duplicateRequirements)).toBe(false);
  });
});
