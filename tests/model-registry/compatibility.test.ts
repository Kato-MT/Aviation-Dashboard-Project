import { describe, expect, it } from 'vitest';

import {
  evaluateModelCompatibility,
  evaluateRegisteredModelForProfile,
} from '../../src/model-registry/compatibility';
import {
  createModelRegistry,
  robustCovarianceRegistryEntry,
  temporalFaultRegistryEntry,
} from '../../src/model-registry/registry';
import type { ModelCompatibilityInput, ModelRegistryEntry } from '../../src/model-registry/types';

function createMatchingInput(
  entry: ModelRegistryEntry = robustCovarianceRegistryEntry,
  overrides: Partial<ModelCompatibilityInput> = {},
): ModelCompatibilityInput {
  return {
    schemaVersion: entry.compatibility.schemaVersion,
    profile: { ...entry.profile },
    channelUnits: Object.fromEntries(
      entry.compatibility.requiredChannels.map(({ channel, unit }) => [channel, unit]),
    ),
    cadenceMs: entry.compatibility.cadenceMs,
    windowLength: entry.compatibility.windowLength,
    artifactSha256: entry.identities.artifactSha256 ?? '0'.repeat(64),
    configurationSha256: entry.identities.configurationSha256 ?? '0'.repeat(64),
    userSelection: 'enabled',
    qualityGatePassed: true,
    ...overrides,
  };
}

describe('evaluateModelCompatibility', () => {
  it('returns supported result for matching entry and input', () => {
    const input = createMatchingInput();
    const result = evaluateModelCompatibility(robustCovarianceRegistryEntry, input);

    expect(result).toEqual({
      status: 'supported',
      supported: true,
      entry: robustCovarianceRegistryEntry,
      reasons: [],
      readiness: {
        userSelection: { state: 'enabled', label: 'Enabled' },
        eligibility: { state: 'eligible', label: 'Eligible', reasons: [] },
        active: true,
        authority: 'deterministic-rules',
      },
    });
  });

  it('handles entry with availability non-registered (planned)', () => {
    const plannedEntry: ModelRegistryEntry = {
      ...robustCovarianceRegistryEntry,
      availability: 'planned',
    };
    const input = createMatchingInput(plannedEntry);
    const result = evaluateModelCompatibility(plannedEntry, input);

    expect(result.status).toBe('unsupported');
    expect(result.supported).toBe(false);
    expect(result.reasons).toEqual([
      {
        code: 'MODEL_NOT_AVAILABLE',
        label: 'Model not available',
        detail: `${plannedEntry.registryEntryId}@${plannedEntry.modelVersion} is a planned descriptor and has no registered artifact.`,
      },
    ]);
    expect(result.readiness).toEqual({
      userSelection: { state: 'enabled', label: 'Enabled' },
      eligibility: {
        state: 'ineligible',
        label: 'Ineligible',
        reasons: ['Model and telemetry are not compatible.', 'Model artifact is not registered.'],
      },
      active: false,
      authority: 'deterministic-rules',
    });
  });

  it('detects schema version mismatch', () => {
    const input = createMatchingInput(robustCovarianceRegistryEntry, {
      schemaVersion: 'invalid-schema-version',
    });
    const result = evaluateModelCompatibility(robustCovarianceRegistryEntry, input);

    expect(result.status).toBe('unsupported');
    expect(result.reasons).toContainEqual({
      code: 'SCHEMA_VERSION_MISMATCH',
      label: 'schema version mismatch',
      detail: 'Telemetry schema version is not supported by this model.',
      expected: robustCovarianceRegistryEntry.compatibility.schemaVersion,
      observed: 'invalid-schema-version',
    });
  });

  it('detects profile ID mismatch', () => {
    const input = createMatchingInput(robustCovarianceRegistryEntry, {
      profile: { id: 'other-profile', version: '1.0.0' },
    });
    const result = evaluateModelCompatibility(robustCovarianceRegistryEntry, input);

    expect(result.status).toBe('unsupported');
    expect(result.reasons).toContainEqual({
      code: 'PROFILE_ID_MISMATCH',
      label: 'profile id mismatch',
      detail: 'Telemetry profile does not match the model profile.',
      expected: robustCovarianceRegistryEntry.profile.id,
      observed: 'other-profile',
    });
  });

  it('detects profile version mismatch', () => {
    const input = createMatchingInput(robustCovarianceRegistryEntry, {
      profile: { id: robustCovarianceRegistryEntry.profile.id, version: '9.9.9' },
    });
    const result = evaluateModelCompatibility(robustCovarianceRegistryEntry, input);

    expect(result.status).toBe('unsupported');
    expect(result.reasons).toContainEqual({
      code: 'PROFILE_VERSION_MISMATCH',
      label: 'profile version mismatch',
      detail: 'Telemetry profile version does not match the model profile version.',
      expected: robustCovarianceRegistryEntry.profile.version,
      observed: '9.9.9',
    });
  });

  it('detects missing required channels', () => {
    const input = createMatchingInput(robustCovarianceRegistryEntry, {
      channelUnits: {},
    });
    const result = evaluateModelCompatibility(robustCovarianceRegistryEntry, input);

    expect(result.status).toBe('unsupported');
    for (const required of robustCovarianceRegistryEntry.compatibility.requiredChannels) {
      expect(result.reasons).toContainEqual({
        code: 'MISSING_CHANNEL',
        label: 'missing channel',
        detail: `Required model channel ${required.channel} is missing.`,
        expected: required.unit,
        channel: required.channel,
      });
    }
  });

  it('detects unit mismatch for existing channels', () => {
    const channelUnits = {
      ...createMatchingInput(robustCovarianceRegistryEntry).channelUnits,
      [robustCovarianceRegistryEntry.compatibility.requiredChannels[0].channel]: 'invalid-unit',
    };
    const input = createMatchingInput(robustCovarianceRegistryEntry, { channelUnits });
    const result = evaluateModelCompatibility(robustCovarianceRegistryEntry, input);

    expect(result.status).toBe('unsupported');
    expect(result.reasons).toContainEqual({
      code: 'UNIT_MISMATCH',
      label: 'unit mismatch',
      detail: `Unit for ${robustCovarianceRegistryEntry.compatibility.requiredChannels[0].channel} does not match the registered model contract.`,
      expected: robustCovarianceRegistryEntry.compatibility.requiredChannels[0].unit,
      observed: 'invalid-unit',
      channel: robustCovarianceRegistryEntry.compatibility.requiredChannels[0].channel,
    });
  });

  it('detects cadence mismatch when out of tolerance or non-finite', () => {
    const inputOut = createMatchingInput(robustCovarianceRegistryEntry, {
      cadenceMs:
        robustCovarianceRegistryEntry.compatibility.cadenceMs +
        robustCovarianceRegistryEntry.compatibility.cadenceToleranceMs +
        1,
    });
    const resultOut = evaluateModelCompatibility(robustCovarianceRegistryEntry, inputOut);
    expect(resultOut.status).toBe('unsupported');
    expect(resultOut.reasons).toContainEqual({
      code: 'CADENCE_MISMATCH',
      label: 'cadence mismatch',
      detail: `Telemetry cadence must be within ${robustCovarianceRegistryEntry.compatibility.cadenceToleranceMs} ms of the registered cadence.`,
      expected: robustCovarianceRegistryEntry.compatibility.cadenceMs,
      observed: inputOut.cadenceMs,
    });

    const inputNaN = createMatchingInput(robustCovarianceRegistryEntry, {
      cadenceMs: Number.NaN,
    });
    const resultNaN = evaluateModelCompatibility(robustCovarianceRegistryEntry, inputNaN);
    expect(resultNaN.status).toBe('unsupported');
    expect(resultNaN.reasons).toContainEqual({
      code: 'CADENCE_MISMATCH',
      label: 'cadence mismatch',
      detail: `Telemetry cadence must be within ${robustCovarianceRegistryEntry.compatibility.cadenceToleranceMs} ms of the registered cadence.`,
      expected: robustCovarianceRegistryEntry.compatibility.cadenceMs,
      observed: Number.NaN,
    });
  });

  it('detects window length mismatch', () => {
    const input = createMatchingInput(robustCovarianceRegistryEntry, {
      windowLength: 999,
    });
    const result = evaluateModelCompatibility(robustCovarianceRegistryEntry, input);

    expect(result.status).toBe('unsupported');
    expect(result.reasons).toContainEqual({
      code: 'WINDOW_LENGTH_MISMATCH',
      label: 'window length mismatch',
      detail: 'Inference window length does not match the registered model contract.',
      expected: robustCovarianceRegistryEntry.compatibility.windowLength,
      observed: 999,
    });
  });

  it('detects artifact identity mismatch and uses fallback expected label when identity is null', () => {
    const input = createMatchingInput(robustCovarianceRegistryEntry, {
      artifactSha256: 'a'.repeat(64),
    });
    const result = evaluateModelCompatibility(robustCovarianceRegistryEntry, input);

    expect(result.status).toBe('unsupported');
    expect(result.reasons).toContainEqual({
      code: 'ARTIFACT_IDENTITY_MISMATCH',
      label: 'artifact identity mismatch',
      detail: 'Model artifact SHA-256 does not match the registered identity.',
      expected: robustCovarianceRegistryEntry.identities.artifactSha256,
      observed: 'a'.repeat(64),
    });

    const entryWithNullSha256: ModelRegistryEntry = {
      ...robustCovarianceRegistryEntry,
      identities: {
        artifactSha256: null,
        configurationSha256: null,
      },
    };
    const inputNull = createMatchingInput(entryWithNullSha256, { artifactSha256: 'a'.repeat(64) });
    const resultNull = evaluateModelCompatibility(entryWithNullSha256, inputNull);
    expect(resultNull.reasons).toContainEqual({
      code: 'ARTIFACT_IDENTITY_MISMATCH',
      label: 'artifact identity mismatch',
      detail: 'Model artifact SHA-256 does not match the registered identity.',
      expected: 'registered SHA-256',
      observed: 'a'.repeat(64),
    });
  });

  it('detects configuration identity mismatch and uses fallback expected label when identity is null', () => {
    const input = createMatchingInput(robustCovarianceRegistryEntry, {
      configurationSha256: 'b'.repeat(64),
    });
    const result = evaluateModelCompatibility(robustCovarianceRegistryEntry, input);

    expect(result.status).toBe('unsupported');
    expect(result.reasons).toContainEqual({
      code: 'CONFIGURATION_IDENTITY_MISMATCH',
      label: 'configuration identity mismatch',
      detail: 'Model configuration SHA-256 does not match the registered identity.',
      expected: robustCovarianceRegistryEntry.identities.configurationSha256,
      observed: 'b'.repeat(64),
    });

    const entryWithNullSha256: ModelRegistryEntry = {
      ...robustCovarianceRegistryEntry,
      identities: {
        artifactSha256: null,
        configurationSha256: null,
      },
    };
    const inputNull = createMatchingInput(entryWithNullSha256, {
      configurationSha256: 'b'.repeat(64),
    });
    const resultNull = evaluateModelCompatibility(entryWithNullSha256, inputNull);
    expect(resultNull.reasons).toContainEqual({
      code: 'CONFIGURATION_IDENTITY_MISMATCH',
      label: 'configuration identity mismatch',
      detail: 'Model configuration SHA-256 does not match the registered identity.',
      expected: 'registered SHA-256',
      observed: 'b'.repeat(64),
    });
  });

  it('handles user selection state disabled', () => {
    const input = createMatchingInput(robustCovarianceRegistryEntry, {
      userSelection: 'disabled',
    });
    const result = evaluateModelCompatibility(robustCovarianceRegistryEntry, input);

    expect(result.status).toBe('supported');
    expect(result.readiness.userSelection).toEqual({
      state: 'disabled',
      label: 'Disabled',
    });
    expect(result.readiness.active).toBe(false);
  });

  it('handles qualityGatePassed false resulting in ineligible eligibility and inactive model', () => {
    const input = createMatchingInput(robustCovarianceRegistryEntry, {
      qualityGatePassed: false,
    });
    const result = evaluateModelCompatibility(robustCovarianceRegistryEntry, input);

    expect(result.status).toBe('supported');
    expect(result.readiness.eligibility).toEqual({
      state: 'ineligible',
      label: 'Ineligible',
      reasons: ['Published model quality gate did not pass.'],
    });
    expect(result.readiness.active).toBe(false);
  });
});

describe('evaluateRegisteredModelForProfile', () => {
  it('returns UNSUPPORTED_PROFILE when profile does not match any entry', () => {
    const registry = createModelRegistry([robustCovarianceRegistryEntry]);
    const input = createMatchingInput(robustCovarianceRegistryEntry, {
      profile: { id: 'unknown-profile', version: '1.0.0' },
    });

    const result = evaluateRegisteredModelForProfile(registry, input);

    expect(result).toEqual({
      status: 'unsupported',
      supported: false,
      reasons: [
        {
          code: 'UNSUPPORTED_PROFILE',
          label: 'Unsupported profile',
          detail: 'No model is registered for unknown-profile@1.0.0.',
          observed: 'unknown-profile@1.0.0',
        },
      ],
      readiness: {
        userSelection: { state: 'enabled', label: 'Enabled' },
        eligibility: {
          state: 'ineligible',
          label: 'Ineligible',
          reasons: ['Model and telemetry are not compatible.'],
        },
        active: false,
        authority: 'deterministic-rules',
      },
    });
  });

  it('returns MODEL_NOT_REGISTERED when profile matches only planned entries', () => {
    const plannedEntry: ModelRegistryEntry = {
      ...robustCovarianceRegistryEntry,
      availability: 'planned',
    };
    const registry = createModelRegistry([plannedEntry]);
    const input = createMatchingInput(plannedEntry);

    const result = evaluateRegisteredModelForProfile(registry, input);

    expect(result.status).toBe('unsupported');
    expect(result.reasons).toEqual([
      {
        code: 'MODEL_NOT_REGISTERED',
        label: 'Model not registered',
        detail: `Only planned model descriptors exist for ${plannedEntry.profile.id}@${plannedEntry.profile.version}.`,
      },
    ]);
  });

  it('returns AMBIGUOUS_MODEL_SELECTION when multiple registered models exist and selectedModel is undefined', () => {
    const entry1: ModelRegistryEntry = {
      ...robustCovarianceRegistryEntry,
      registryEntryId: 'model-entry-1',
      modelVersion: '1.0.0',
    };
    const entry2: ModelRegistryEntry = {
      ...robustCovarianceRegistryEntry,
      registryEntryId: 'model-entry-2',
      modelVersion: '2.0.0',
    };
    const registry = createModelRegistry([entry1, entry2]);
    const input = createMatchingInput(entry1);

    const result = evaluateRegisteredModelForProfile(registry, input);

    expect(result.status).toBe('unsupported');
    expect(result.reasons).toEqual([
      {
        code: 'AMBIGUOUS_MODEL_SELECTION',
        label: 'Ambiguous model selection',
        detail:
          `Multiple models are registered for ${entry1.profile.id}@${entry1.profile.version}. ` +
          'Select an exact registry entry and model version.',
        observed: 'model-entry-1@1.0.0, model-entry-2@2.0.0',
      },
    ]);
  });

  it('returns MODEL_NOT_REGISTERED when specific selectedModel is requested but not found in registered entries', () => {
    const registry = createModelRegistry([robustCovarianceRegistryEntry]);
    const input = createMatchingInput(robustCovarianceRegistryEntry);

    const result = evaluateRegisteredModelForProfile(registry, input, {
      registryEntryId: 'non-existent-entry',
      modelVersion: '9.9.9',
    });

    expect(result.status).toBe('unsupported');
    expect(result.reasons).toEqual([
      {
        code: 'MODEL_NOT_REGISTERED',
        label: 'Model not registered',
        detail:
          `No registered model non-existent-entry@9.9.9 ` +
          `exists for ${robustCovarianceRegistryEntry.profile.id}@${robustCovarianceRegistryEntry.profile.version}.`,
        observed: 'non-existent-entry@9.9.9',
      },
    ]);
  });

  it('evaluates successfully when single registered model exists or exact selectedModel is matched', () => {
    const registry = createModelRegistry([
      robustCovarianceRegistryEntry,
      temporalFaultRegistryEntry,
    ]);
    const input = createMatchingInput(temporalFaultRegistryEntry);

    const result = evaluateRegisteredModelForProfile(registry, input, {
      registryEntryId: temporalFaultRegistryEntry.registryEntryId,
      modelVersion: temporalFaultRegistryEntry.modelVersion,
    });

    expect(result.status).toBe('supported');
    expect(result.entry).toBe(temporalFaultRegistryEntry);
  });
});
