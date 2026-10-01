import { describe, expect, it } from 'vitest';

import type { DeterministicFindingSummary, LearnedBaselineScore } from '../../src/ml/types';
import { classifyProductionAgreement } from '../../src/model-registry/agreement';
import { DETERMINISTIC_AUTHORITY } from '../../src/model-registry/types';

function createMockScore(active: boolean, anomalous: boolean): LearnedBaselineScore {
  return {
    modelVersion: '1.0.0',
    score: anomalous ? 25 : 5,
    threshold: 10,
    anomalous,
    active,
    qualityGatePassed: true,
    contributions: [],
  };
}

const mockFinding: DeterministicFindingSummary = {
  ruleId: 'test.rule.exceeded',
  severity: 'error',
  sourceId: 'sensor-1',
};

describe('classifyProductionAgreement', () => {
  it('returns both-indicate when both deterministic rules and active model indicate anomalies', () => {
    const findings = [mockFinding];
    const score = createMockScore(true, true);

    const result = classifyProductionAgreement(findings, score);

    expect(result.agreement).toBe('both-indicate');
    expect(result.authority).toBe(DETERMINISTIC_AUTHORITY);
    expect(result.authoritativeDecision).toBe('indicate');
    expect(result.advisoryModelDecision).toBe('indicate');
    expect(result.deterministicFindings).toEqual([mockFinding]);
    expect(result.learnedBaseline).toBe(score);
  });

  it('returns rules-only when deterministic rules indicate but model does not', () => {
    const findings = [mockFinding];
    const score = createMockScore(true, false);

    const result = classifyProductionAgreement(findings, score);

    expect(result.agreement).toBe('rules-only');
    expect(result.authority).toBe(DETERMINISTIC_AUTHORITY);
    expect(result.authoritativeDecision).toBe('indicate');
    expect(result.advisoryModelDecision).toBe('nominal');
    expect(result.deterministicFindings).toEqual([mockFinding]);
    expect(result.learnedBaseline).toBe(score);
  });

  it('returns model-only when deterministic rules do not indicate but active model does', () => {
    const findings: DeterministicFindingSummary[] = [];
    const score = createMockScore(true, true);

    const result = classifyProductionAgreement(findings, score);

    expect(result.agreement).toBe('model-only');
    expect(result.authority).toBe(DETERMINISTIC_AUTHORITY);
    expect(result.authoritativeDecision).toBe('nominal');
    expect(result.advisoryModelDecision).toBe('indicate');
    expect(result.deterministicFindings).toEqual([]);
    expect(result.learnedBaseline).toBe(score);
  });

  it('returns both-nominal when neither rules nor model indicate anomalies', () => {
    const findings: DeterministicFindingSummary[] = [];
    const score = createMockScore(true, false);

    const result = classifyProductionAgreement(findings, score);

    expect(result.agreement).toBe('both-nominal');
    expect(result.authority).toBe(DETERMINISTIC_AUTHORITY);
    expect(result.authoritativeDecision).toBe('nominal');
    expect(result.advisoryModelDecision).toBe('nominal');
    expect(result.deterministicFindings).toEqual([]);
    expect(result.learnedBaseline).toBe(score);
  });

  it('treats model decision as nominal when learned baseline is inactive, even if anomalous flag is true', () => {
    const findings = [mockFinding];
    const score = createMockScore(false, true);

    const result = classifyProductionAgreement(findings, score);

    expect(result.agreement).toBe('rules-only');
    expect(result.authoritativeDecision).toBe('indicate');
    expect(result.advisoryModelDecision).toBe('nominal');
  });

  it('returns both-nominal when learned baseline is inactive and anomalous is true with no findings', () => {
    const findings: DeterministicFindingSummary[] = [];
    const score = createMockScore(false, true);

    const result = classifyProductionAgreement(findings, score);

    expect(result.agreement).toBe('both-nominal');
    expect(result.authoritativeDecision).toBe('nominal');
    expect(result.advisoryModelDecision).toBe('nominal');
  });

  it('shallow copies the input deterministicFindings array to ensure immutability', () => {
    const findings = [mockFinding];
    const score = createMockScore(true, false);

    const result = classifyProductionAgreement(findings, score);

    expect(result.deterministicFindings).not.toBe(findings);
    expect(result.deterministicFindings).toEqual(findings);
  });
});
