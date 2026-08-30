import { loadEvidenceOperations } from '../../evidence/health';
import type { EvidenceOperationsLoader } from '../../evidence/types';
import { EvidenceApp, type EvidenceAppProps } from './EvidenceApp';

export interface OnlineEvidenceAppProps extends Omit<
  EvidenceAppProps,
  'loadOperations' | 'staticOnly'
> {
  loadOperations?: EvidenceOperationsLoader;
}

export function OnlineEvidenceApp({
  loadOperations = loadEvidenceOperations,
  ...props
}: OnlineEvidenceAppProps) {
  return <EvidenceApp {...props} loadOperations={loadOperations} />;
}
