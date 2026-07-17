import { describe, expect, it } from 'vitest';

import { TELEMETRY_SCHEMA_VERSION } from '../../src/core';
import { genericFixedWingProfile, genericRotaryWingProfile } from '../../src/profiles';
import { generateSyntheticDocument } from '../../src/ui/generate';

describe('generated demonstration documents', () => {
  it('TC-UI-007 is deterministic for the same profile and sample count', () => {
    expect(generateSyntheticDocument(genericFixedWingProfile, 25)).toBe(
      generateSyntheticDocument(genericFixedWingProfile, 25),
    );
  });

  it.each([genericFixedWingProfile, genericRotaryWingProfile])(
    'TC-SEC-002 emits an explicitly synthetic versioned document for $id',
    (profile) => {
      const document = JSON.parse(generateSyntheticDocument(profile, 12)) as {
        schemaVersion: string;
        profile: { id: string; version: string };
        sources: Array<{ units: Record<string, string> }>;
        samples: unknown[];
        metadata: { synthetic: boolean; dataClassification: string };
      };
      expect(document.schemaVersion).toBe(TELEMETRY_SCHEMA_VERSION);
      expect(document.profile).toEqual({ id: profile.id, version: profile.version });
      expect(document.samples).toHaveLength(12);
      expect(document.metadata).toMatchObject({
        synthetic: true,
        dataClassification: 'SYNTHETIC_UNCLASSIFIED',
      });
      expect(document.sources[0]?.units).toEqual(
        expect.objectContaining(
          Object.fromEntries(
            Object.values(profile.channels).map((channel) => [channel.channel, channel.unit]),
          ),
        ),
      );
    },
  );
});
