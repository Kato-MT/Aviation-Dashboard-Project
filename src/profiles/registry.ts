import type { DetectionProfile } from '../core/types';
import { genericFixedWingProfile } from './generic-fixed-wing';
import { genericRotaryWingProfile } from './generic-rotary-wing';
import { includedBaselineProfile } from './included-baseline';

export const detectionProfiles = [
  includedBaselineProfile,
  genericFixedWingProfile,
  genericRotaryWingProfile,
] as const satisfies readonly DetectionProfile[];

export function getDetectionProfile(id: string, version?: string): DetectionProfile | undefined {
  return detectionProfiles.find(
    (profile) => profile.id === id && (version === undefined || profile.version === version),
  );
}
