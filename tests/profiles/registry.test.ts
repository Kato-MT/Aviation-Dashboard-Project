import { describe, expect, it } from 'vitest';
import { genericFixedWingProfile } from '../../src/profiles/generic-fixed-wing';
import { genericRotaryWingProfile } from '../../src/profiles/generic-rotary-wing';
import { includedBaselineProfile } from '../../src/profiles/included-baseline';
import { detectionProfiles, getDetectionProfile } from '../../src/profiles/registry';

describe('detectionProfiles', () => {
  it('contains all predefined profiles in order', () => {
    expect(detectionProfiles).toEqual([
      includedBaselineProfile,
      genericFixedWingProfile,
      genericRotaryWingProfile,
    ]);
  });
});

describe('getDetectionProfile', () => {
  it('returns the matching profile when given a valid ID without specifying a version', () => {
    expect(getDetectionProfile('included-baseline')).toBe(includedBaselineProfile);
    expect(getDetectionProfile('generic-fixed-wing')).toBe(genericFixedWingProfile);
    expect(getDetectionProfile('generic-rotary-wing')).toBe(genericRotaryWingProfile);
  });

  it('returns the matching profile when given a valid ID and matching version', () => {
    expect(getDetectionProfile('included-baseline', includedBaselineProfile.version)).toBe(
      includedBaselineProfile,
    );
    expect(getDetectionProfile('generic-fixed-wing', genericFixedWingProfile.version)).toBe(
      genericFixedWingProfile,
    );
    expect(getDetectionProfile('generic-rotary-wing', genericRotaryWingProfile.version)).toBe(
      genericRotaryWingProfile,
    );
  });

  it('returns undefined when ID exists but version does not match', () => {
    expect(getDetectionProfile('included-baseline', '99.0.0')).toBeUndefined();
    expect(getDetectionProfile('generic-fixed-wing', 'invalid-version')).toBeUndefined();
  });

  it('returns undefined when ID does not exist', () => {
    expect(getDetectionProfile('non-existent-profile')).toBeUndefined();
    expect(getDetectionProfile('')).toBeUndefined();
  });

  it('is case-sensitive and returns undefined for wrong-cased IDs', () => {
    expect(getDetectionProfile('INCLUDED-BASELINE')).toBeUndefined();
    expect(getDetectionProfile('Generic-Fixed-Wing')).toBeUndefined();
  });
});
