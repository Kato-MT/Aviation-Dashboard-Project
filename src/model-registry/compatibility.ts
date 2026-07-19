import type {
  ModelCompatibilityInput,
  ModelCompatibilityReason,
  ModelCompatibilityResult,
  ModelEligibility,
  ModelReadiness,
  ModelRegistry,
  ModelRegistryEntry,
  RegisteredModelSelection,
  UserModelSelection,
} from './types';
import { DETERMINISTIC_AUTHORITY } from './types';

function selection(state: UserModelSelection['state']): UserModelSelection {
  return state === 'enabled'
    ? { state: 'enabled', label: 'Enabled' }
    : { state: 'disabled', label: 'Disabled' };
}

function readiness(
  input: ModelCompatibilityInput,
  compatibilitySupported: boolean,
  additionalIneligibilityReasons: readonly string[] = [],
): ModelReadiness {
  const reasons = [
    ...(compatibilitySupported ? [] : ['Model and telemetry are not compatible.']),
    ...(input.qualityGatePassed ? [] : ['Published model quality gate did not pass.']),
    ...additionalIneligibilityReasons,
  ];
  const eligibility: ModelEligibility =
    reasons.length === 0
      ? { state: 'eligible', label: 'Eligible', reasons: [] }
      : { state: 'ineligible', label: 'Ineligible', reasons };
  return {
    userSelection: selection(input.userSelection),
    eligibility,
    active:
      compatibilitySupported &&
      eligibility.state === 'eligible' &&
      input.userSelection === 'enabled',
    authority: DETERMINISTIC_AUTHORITY,
  };
}

function reason(
  value: Omit<ModelCompatibilityReason, 'label'> & { label?: string },
): ModelCompatibilityReason {
  return {
    ...value,
    label: value.label ?? value.code.replaceAll('_', ' ').toLowerCase(),
  };
}

function unsupportedWithoutEntry(
  input: ModelCompatibilityInput,
  compatibilityReason: ModelCompatibilityReason,
): ModelCompatibilityResult {
  return {
    status: 'unsupported',
    supported: false,
    reasons: [compatibilityReason],
    readiness: readiness(input, false),
  };
}

export function evaluateModelCompatibility(
  entry: Readonly<ModelRegistryEntry>,
  input: ModelCompatibilityInput,
): ModelCompatibilityResult {
  if (entry.availability !== 'registered') {
    const compatibilityReason = reason({
      code: 'MODEL_NOT_AVAILABLE',
      label: 'Model not available',
      detail: `${entry.registryEntryId}@${entry.modelVersion} is a planned descriptor and has no registered artifact.`,
    });
    return {
      status: 'unsupported',
      supported: false,
      entry,
      reasons: [compatibilityReason],
      readiness: readiness(input, false, ['Model artifact is not registered.']),
    };
  }

  const reasons: ModelCompatibilityReason[] = [];
  if (input.schemaVersion !== entry.compatibility.schemaVersion) {
    reasons.push(
      reason({
        code: 'SCHEMA_VERSION_MISMATCH',
        detail: 'Telemetry schema version is not supported by this model.',
        expected: entry.compatibility.schemaVersion,
        observed: input.schemaVersion,
      }),
    );
  }
  if (input.profile.id !== entry.profile.id) {
    reasons.push(
      reason({
        code: 'PROFILE_ID_MISMATCH',
        detail: 'Telemetry profile does not match the model profile.',
        expected: entry.profile.id,
        observed: input.profile.id,
      }),
    );
  }
  if (input.profile.version !== entry.profile.version) {
    reasons.push(
      reason({
        code: 'PROFILE_VERSION_MISMATCH',
        detail: 'Telemetry profile version does not match the model profile version.',
        expected: entry.profile.version,
        observed: input.profile.version,
      }),
    );
  }
  for (const required of entry.compatibility.requiredChannels) {
    if (!Object.hasOwn(input.channelUnits, required.channel)) {
      reasons.push(
        reason({
          code: 'MISSING_CHANNEL',
          detail: `Required model channel ${required.channel} is missing.`,
          expected: required.unit,
          channel: required.channel,
        }),
      );
    } else if (input.channelUnits[required.channel] !== required.unit) {
      reasons.push(
        reason({
          code: 'UNIT_MISMATCH',
          detail: `Unit for ${required.channel} does not match the registered model contract.`,
          expected: required.unit,
          observed: input.channelUnits[required.channel],
          channel: required.channel,
        }),
      );
    }
  }
  if (
    !Number.isFinite(input.cadenceMs) ||
    Math.abs(input.cadenceMs - entry.compatibility.cadenceMs) >
      entry.compatibility.cadenceToleranceMs
  ) {
    reasons.push(
      reason({
        code: 'CADENCE_MISMATCH',
        detail: `Telemetry cadence must be within ${entry.compatibility.cadenceToleranceMs} ms of the registered cadence.`,
        expected: entry.compatibility.cadenceMs,
        observed: input.cadenceMs,
      }),
    );
  }
  if (input.windowLength !== entry.compatibility.windowLength) {
    reasons.push(
      reason({
        code: 'WINDOW_LENGTH_MISMATCH',
        detail: 'Inference window length does not match the registered model contract.',
        expected: entry.compatibility.windowLength,
        observed: input.windowLength,
      }),
    );
  }
  if (input.artifactSha256.toLowerCase() !== entry.identities.artifactSha256) {
    reasons.push(
      reason({
        code: 'ARTIFACT_IDENTITY_MISMATCH',
        detail: 'Model artifact SHA-256 does not match the registered identity.',
        expected: entry.identities.artifactSha256 ?? 'registered SHA-256',
        observed: input.artifactSha256,
      }),
    );
  }
  if (input.configurationSha256.toLowerCase() !== entry.identities.configurationSha256) {
    reasons.push(
      reason({
        code: 'CONFIGURATION_IDENTITY_MISMATCH',
        detail: 'Model configuration SHA-256 does not match the registered identity.',
        expected: entry.identities.configurationSha256 ?? 'registered SHA-256',
        observed: input.configurationSha256,
      }),
    );
  }

  if (reasons.length > 0) {
    return {
      status: 'unsupported',
      supported: false,
      entry,
      reasons,
      readiness: readiness(input, false),
    };
  }
  return {
    status: 'supported',
    supported: true,
    entry,
    reasons: [],
    readiness: readiness(input, true),
  };
}

export function evaluateRegisteredModelForProfile(
  registry: ModelRegistry,
  input: ModelCompatibilityInput,
  selectedModel?: RegisteredModelSelection,
): ModelCompatibilityResult {
  const matchingProfile = registry.entries.filter(
    (entry) =>
      entry.profile.id === input.profile.id && entry.profile.version === input.profile.version,
  );
  if (matchingProfile.length === 0) {
    return unsupportedWithoutEntry(
      input,
      reason({
        code: 'UNSUPPORTED_PROFILE',
        label: 'Unsupported profile',
        detail: `No model is registered for ${input.profile.id}@${input.profile.version}.`,
        observed: `${input.profile.id}@${input.profile.version}`,
      }),
    );
  }
  const registered = matchingProfile.filter((entry) => entry.availability === 'registered');
  if (registered.length === 0) {
    return unsupportedWithoutEntry(
      input,
      reason({
        code: 'MODEL_NOT_REGISTERED',
        label: 'Model not registered',
        detail: `Only planned model descriptors exist for ${input.profile.id}@${input.profile.version}.`,
      }),
    );
  }
  if (selectedModel === undefined && registered.length > 1) {
    return unsupportedWithoutEntry(
      input,
      reason({
        code: 'AMBIGUOUS_MODEL_SELECTION',
        label: 'Ambiguous model selection',
        detail:
          `Multiple models are registered for ${input.profile.id}@${input.profile.version}. ` +
          'Select an exact registry entry and model version.',
        observed: registered
          .map((entry) => `${entry.registryEntryId}@${entry.modelVersion}`)
          .join(', '),
      }),
    );
  }
  const selected =
    selectedModel === undefined
      ? registered[0]
      : registered.find(
          (entry) =>
            entry.registryEntryId === selectedModel.registryEntryId &&
            entry.modelVersion === selectedModel.modelVersion,
        );
  if (selected === undefined) {
    return unsupportedWithoutEntry(
      input,
      reason({
        code: 'MODEL_NOT_REGISTERED',
        label: 'Model not registered',
        detail:
          `No registered model ${selectedModel!.registryEntryId}@${selectedModel!.modelVersion} ` +
          `exists for ${input.profile.id}@${input.profile.version}.`,
        observed: `${selectedModel!.registryEntryId}@${selectedModel!.modelVersion}`,
      }),
    );
  }
  return evaluateModelCompatibility(selected, input);
}
