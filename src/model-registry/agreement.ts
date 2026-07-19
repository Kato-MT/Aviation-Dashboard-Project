import type { DeterministicFindingSummary, LearnedBaselineScore } from '../ml/types';
import { DETERMINISTIC_AUTHORITY, type ProductionAgreement } from './types';

export function classifyProductionAgreement(
  deterministicFindings: readonly DeterministicFindingSummary[],
  learnedBaseline: LearnedBaselineScore,
): ProductionAgreement {
  const rulesIndicate = deterministicFindings.length > 0;
  const modelIndicates = learnedBaseline.active && learnedBaseline.anomalous;
  const agreement = rulesIndicate
    ? modelIndicates
      ? 'both-indicate'
      : 'rules-only'
    : modelIndicates
      ? 'model-only'
      : 'both-nominal';

  return {
    authority: DETERMINISTIC_AUTHORITY,
    authoritativeDecision: rulesIndicate ? 'indicate' : 'nominal',
    advisoryModelDecision: modelIndicates ? 'indicate' : 'nominal',
    agreement,
    deterministicFindings: [...deterministicFindings],
    learnedBaseline,
  };
}
