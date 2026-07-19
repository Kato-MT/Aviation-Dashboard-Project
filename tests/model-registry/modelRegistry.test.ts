import { describe, expect, it } from 'vitest';

import type { LearnedBaselineScore } from '../../src/ml/types';
import { classifyProductionAgreement } from '../../src/model-registry/agreement';
import {
  evaluateModelCompatibility,
  evaluateRegisteredModelForProfile,
} from '../../src/model-registry/compatibility';
import {
  createModelRegistry,
  findRegistryEntry,
  modelRegistry,
  robustCovarianceRegistryEntry,
  temporalFaultRegistryEntry,
  temporalFaultResearchRegistryEntry,
} from '../../src/model-registry/registry';
import type {
  ModelCompatibilityInput,
  ModelCompatibilityReasonCode,
} from '../../src/model-registry/types';

function matchingInput(overrides: Partial<ModelCompatibilityInput> = {}): ModelCompatibilityInput {
  return {
    schemaVersion: robustCovarianceRegistryEntry.compatibility.schemaVersion,
    profile: { ...robustCovarianceRegistryEntry.profile },
    channelUnits: Object.fromEntries(
      robustCovarianceRegistryEntry.compatibility.requiredChannels.map(({ channel, unit }) => [
        channel,
        unit,
      ]),
    ),
    cadenceMs: robustCovarianceRegistryEntry.compatibility.cadenceMs,
    windowLength: robustCovarianceRegistryEntry.compatibility.windowLength,
    artifactSha256: robustCovarianceRegistryEntry.identities.artifactSha256!,
    configurationSha256: robustCovarianceRegistryEntry.identities.configurationSha256!,
    userSelection: 'enabled',
    qualityGatePassed: true,
    ...overrides,
  };
}

function modelScore(active: boolean, anomalous: boolean): LearnedBaselineScore {
  return {
    modelVersion: '1.0.0',
    score: anomalous ? 20 : 0,
    threshold: 10,
    anomalous,
    active,
    qualityGatePassed: true,
    contributions: [],
  };
}

describe('profile-specific model registry', () => {
  it('exposes immutable, versioned profile-specific descriptors', () => {
    expect(modelRegistry.schemaVersion).toBe('model-registry.v1');
    expect(Object.isFrozen(modelRegistry)).toBe(true);
    expect(Object.isFrozen(modelRegistry.entries)).toBe(true);
    expect(Object.isFrozen(robustCovarianceRegistryEntry.compatibility.requiredChannels)).toBe(
      true,
    );
    expect(robustCovarianceRegistryEntry.artifact.artifactVersion).toBe('learned-baseline.v1');
    expect(robustCovarianceRegistryEntry.profile).toEqual({
      id: 'generic-fixed-wing',
      version: '1.0.0',
    });
    expect(temporalFaultRegistryEntry).toMatchObject({
      modelVersion: '2.0.0',
      availability: 'registered',
      artifact: {
        family: 'temporal',
        artifactVersion: 'temporal-fault-model.v1',
        modelType: 'causal-multiscale-feature-nearest-prototype',
      },
      compatibility: { windowLength: 40, cadenceMs: 1000 },
      evidence: {
        training: { split: 'training', jsonPointer: '/training' },
        calibration: { split: 'calibration', jsonPointer: '/calibration' },
        evaluation: { split: 'held-out-evaluation', jsonPointer: '/evaluation' },
        modelCardPath: 'models/TEMPORAL_INTEGRATION_MODEL_CARD.md',
        qualityGateJsonPointer: '/qualityGate',
      },
    });
    expect(Object.isFrozen(temporalFaultRegistryEntry.evidence)).toBe(true);
    expect(temporalFaultResearchRegistryEntry.modelVersion).toBe('1.0.0');
  });

  it('can create an immutable registry containing the temporal artifact', () => {
    const temporalRegistry = createModelRegistry([temporalFaultRegistryEntry]);
    expect(temporalRegistry.entries[0]?.availability).toBe('registered');
    expect(Object.isFrozen(temporalRegistry.entries[0])).toBe(true);
    expect(temporalFaultRegistryEntry.identities.artifactSha256).toMatch(/^[a-f\d]{64}$/);
  });

  it('rejects duplicate registry entry identities and versions', () => {
    expect(() =>
      createModelRegistry([robustCovarianceRegistryEntry, robustCovarianceRegistryEntry]),
    ).toThrow('Duplicate model registry entry');
  });

  it('finds exact versions without silently selecting a different model version', () => {
    expect(
      findRegistryEntry(modelRegistry, robustCovarianceRegistryEntry.registryEntryId, '1.0.0'),
    ).toBe(robustCovarianceRegistryEntry);
    expect(
      findRegistryEntry(modelRegistry, robustCovarianceRegistryEntry.registryEntryId, '2.0.0'),
    ).toBeUndefined();
    expect(
      findRegistryEntry(modelRegistry, temporalFaultRegistryEntry.registryEntryId, '1.0.0'),
    ).toBe(temporalFaultResearchRegistryEntry);
    expect(
      findRegistryEntry(modelRegistry, temporalFaultRegistryEntry.registryEntryId, '2.0.0'),
    ).toBe(temporalFaultRegistryEntry);
  });
});

describe('model compatibility and readiness', () => {
  it('supports an exact contract match and exposes enabled, eligible, active state', () => {
    const result = evaluateModelCompatibility(robustCovarianceRegistryEntry, matchingInput());
    expect(result).toMatchObject({
      status: 'supported',
      supported: true,
      reasons: [],
      readiness: {
        userSelection: { state: 'enabled', label: 'Enabled' },
        eligibility: { state: 'eligible', label: 'Eligible', reasons: [] },
        active: true,
        authority: 'deterministic-rules',
      },
    });
  });

  it('accepts SHA-256 identities independent of hexadecimal letter case', () => {
    const input = matchingInput({
      artifactSha256: robustCovarianceRegistryEntry.identities.artifactSha256!.toUpperCase(),
      configurationSha256:
        robustCovarianceRegistryEntry.identities.configurationSha256!.toUpperCase(),
    });
    expect(evaluateModelCompatibility(robustCovarianceRegistryEntry, input).supported).toBe(true);
  });

  it('accepts cadence at the declared tolerance boundary', () => {
    const input = matchingInput({
      cadenceMs:
        robustCovarianceRegistryEntry.compatibility.cadenceMs +
        robustCovarianceRegistryEntry.compatibility.cadenceToleranceMs,
    });
    expect(evaluateModelCompatibility(robustCovarianceRegistryEntry, input).supported).toBe(true);
  });

  const mismatches: readonly {
    name: string;
    code: ModelCompatibilityReasonCode;
    input: () => ModelCompatibilityInput;
  }[] = [
    {
      name: 'schema version',
      code: 'SCHEMA_VERSION_MISMATCH',
      input: () => matchingInput({ schemaVersion: 'telemetry.v2' }),
    },
    {
      name: 'profile id',
      code: 'PROFILE_ID_MISMATCH',
      input: () => matchingInput({ profile: { id: 'generic-rotary-wing', version: '1.0.0' } }),
    },
    {
      name: 'profile version',
      code: 'PROFILE_VERSION_MISMATCH',
      input: () => matchingInput({ profile: { id: 'generic-fixed-wing', version: '2.0.0' } }),
    },
    {
      name: 'required channel',
      code: 'MISSING_CHANNEL',
      input: () => {
        const channelUnits = { ...matchingInput().channelUnits };
        delete channelUnits.vibration;
        return matchingInput({ channelUnits });
      },
    },
    {
      name: 'required unit',
      code: 'UNIT_MISMATCH',
      input: () =>
        matchingInput({ channelUnits: { ...matchingInput().channelUnits, airspeed: 'mph' } }),
    },
    {
      name: 'cadence',
      code: 'CADENCE_MISMATCH',
      input: () => matchingInput({ cadenceMs: 1_251 }),
    },
    {
      name: 'window length',
      code: 'WINDOW_LENGTH_MISMATCH',
      input: () => matchingInput({ windowLength: 2 }),
    },
    {
      name: 'artifact identity',
      code: 'ARTIFACT_IDENTITY_MISMATCH',
      input: () => matchingInput({ artifactSha256: '0'.repeat(64) }),
    },
    {
      name: 'configuration identity',
      code: 'CONFIGURATION_IDENTITY_MISMATCH',
      input: () => matchingInput({ configurationSha256: '0'.repeat(64) }),
    },
  ];

  for (const mismatch of mismatches) {
    it(`reports ${mismatch.name} mismatch as explicitly unsupported`, () => {
      const result = evaluateModelCompatibility(robustCovarianceRegistryEntry, mismatch.input());
      expect(result.status).toBe('unsupported');
      expect(result.supported).toBe(false);
      expect(result.reasons.map(({ code }) => code)).toContain(mismatch.code);
      expect(result.readiness).toMatchObject({
        eligibility: { state: 'ineligible', label: 'Ineligible' },
        active: false,
      });
    });
  }

  it('keeps a supported model eligible but inactive when the user disables it', () => {
    const result = evaluateModelCompatibility(
      robustCovarianceRegistryEntry,
      matchingInput({ userSelection: 'disabled' }),
    );
    expect(result.status).toBe('supported');
    expect(result.readiness).toEqual({
      userSelection: { state: 'disabled', label: 'Disabled' },
      eligibility: { state: 'eligible', label: 'Eligible', reasons: [] },
      active: false,
      authority: 'deterministic-rules',
    });
  });

  it('keeps compatible telemetry supported but ineligible after a failed model quality gate', () => {
    const result = evaluateModelCompatibility(
      robustCovarianceRegistryEntry,
      matchingInput({ qualityGatePassed: false }),
    );
    expect(result.status).toBe('supported');
    expect(result.readiness.userSelection.state).toBe('enabled');
    expect(result.readiness.eligibility).toMatchObject({
      state: 'ineligible',
      label: 'Ineligible',
      reasons: ['Published model quality gate did not pass.'],
    });
    expect(result.readiness.active).toBe(false);
  });

  it('reports a temporal contract mismatch explicitly instead of guessing compatibility', () => {
    const result = evaluateModelCompatibility(temporalFaultRegistryEntry, matchingInput());
    expect(result.status).toBe('unsupported');
    expect(result.reasons.map(({ code }) => code)).toContain('WINDOW_LENGTH_MISMATCH');
    expect(result.readiness.eligibility.state).toBe('ineligible');
  });

  it('reports a profile with no registry contract as unsupported', () => {
    const result = evaluateRegisteredModelForProfile(
      modelRegistry,
      matchingInput({ profile: { id: 'unsupported-profile', version: '9.0.0' } }),
    );
    expect(result.status).toBe('unsupported');
    expect(result.reasons).toMatchObject([{ code: 'UNSUPPORTED_PROFILE' }]);
    expect(result.entry).toBeUndefined();
  });

  it('requires an exact selection when multiple model families share a profile', () => {
    const ambiguous = evaluateRegisteredModelForProfile(
      modelRegistry,
      matchingInput({
        windowLength: 40,
        artifactSha256: temporalFaultRegistryEntry.identities.artifactSha256!,
        configurationSha256: temporalFaultRegistryEntry.identities.configurationSha256!,
      }),
    );
    expect(ambiguous.status).toBe('unsupported');
    expect(ambiguous.reasons).toMatchObject([{ code: 'AMBIGUOUS_MODEL_SELECTION' }]);

    const selected = evaluateRegisteredModelForProfile(
      modelRegistry,
      matchingInput({
        windowLength: 40,
        artifactSha256: temporalFaultRegistryEntry.identities.artifactSha256!,
        configurationSha256: temporalFaultRegistryEntry.identities.configurationSha256!,
      }),
      {
        registryEntryId: temporalFaultRegistryEntry.registryEntryId,
        modelVersion: temporalFaultRegistryEntry.modelVersion,
      },
    );
    expect(selected.status).toBe('supported');
    expect(selected.entry?.registryEntryId).toBe(temporalFaultRegistryEntry.registryEntryId);
  });
});

describe('production agreement and deterministic authority', () => {
  const deterministicFinding = {
    ruleId: 'fixed.range.airspeed',
    severity: 'error',
    sourceId: 'synthetic-1',
  };

  it.each([
    {
      name: 'both-indicate',
      findings: [deterministicFinding],
      score: modelScore(true, true),
      agreement: 'both-indicate',
      authoritativeDecision: 'indicate',
    },
    {
      name: 'rules-only',
      findings: [deterministicFinding],
      score: modelScore(true, false),
      agreement: 'rules-only',
      authoritativeDecision: 'indicate',
    },
    {
      name: 'model-only',
      findings: [],
      score: modelScore(true, true),
      agreement: 'model-only',
      authoritativeDecision: 'nominal',
    },
    {
      name: 'both-nominal',
      findings: [],
      score: modelScore(true, false),
      agreement: 'both-nominal',
      authoritativeDecision: 'nominal',
    },
  ] as const)(
    'classifies $name with stable deterministic authority',
    ({ findings, score, agreement, authoritativeDecision }) => {
      const result = classifyProductionAgreement(findings, score);
      expect(result.agreement).toBe(agreement);
      expect(result.authority).toBe('deterministic-rules');
      expect(result.authoritativeDecision).toBe(authoritativeDecision);
    },
  );

  it('never treats an inactive model score as an indication', () => {
    const result = classifyProductionAgreement([], modelScore(false, true));
    expect(result.agreement).toBe('both-nominal');
    expect(result.advisoryModelDecision).toBe('nominal');
    expect(result.authoritativeDecision).toBe('nominal');
  });
});
