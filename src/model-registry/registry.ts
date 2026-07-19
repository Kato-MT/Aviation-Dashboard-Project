import { TELEMETRY_SCHEMA_VERSION } from '../core/types';
import {
  DETERMINISTIC_AUTHORITY,
  MODEL_REGISTRY_SCHEMA_VERSION,
  type ModelRegistry,
  type ModelRegistryEntry,
} from './types';

function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

export const robustCovarianceRegistryEntry = deepFreeze({
  registryEntryId: 'generic-fixed-wing.robust-covariance',
  modelVersion: '1.0.0',
  profile: {
    id: 'generic-fixed-wing',
    version: '1.0.0',
  },
  artifact: {
    family: 'robust-covariance',
    artifactVersion: 'learned-baseline.v1',
    modelType: 'robust-regularized-covariance-mahalanobis',
  },
  compatibility: {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    requiredChannels: [
      { channel: 'airspeed', unit: 'kts' },
      { channel: 'altitude', unit: 'ft' },
      { channel: 'verticalRate', unit: 'ft/min' },
      { channel: 'fuel', unit: '%' },
      { channel: 'vibration', unit: 'g' },
    ],
    cadenceMs: 1_000,
    cadenceToleranceMs: 250,
    windowLength: 1,
  },
  identities: {
    artifactSha256: '6b8f286e2b2d7db49a8953cae5e301c40bc3f6154cd0b3197afad5647310ce66',
    configurationSha256: '784e3971254f39484151baa25036811e705d9fd21a6b32994f8421399869b48f',
  },
  evidence: {
    training: {
      path: 'models/robust_covariance_v1.json',
      jsonPointer: '/training',
      split: 'training',
      seedSummary: '101, 211, 307, 401',
    },
    calibration: {
      path: 'models/robust_covariance_v1.json',
      jsonPointer: '/calibration',
      split: 'calibration',
      seedSummary: '509, 601',
    },
    evaluation: {
      path: 'models/evaluation_v1.json',
      jsonPointer: '/evaluation',
      split: 'held-out-evaluation',
      seedSummary: '701, 809, 907',
    },
    modelCardPath: 'models/MODEL_CARD.md',
    qualityGateJsonPointer: '/qualityGate',
  },
  availability: 'registered',
  defaultUserSelection: 'disabled',
  authority: DETERMINISTIC_AUTHORITY,
} as const satisfies ModelRegistryEntry);

export const temporalFaultResearchRegistryEntry = deepFreeze({
  registryEntryId: 'generic-fixed-wing.temporal-fault',
  modelVersion: '1.0.0',
  profile: {
    id: 'generic-fixed-wing',
    version: '1.0.0',
  },
  artifact: {
    family: 'temporal',
    artifactVersion: 'temporal-fault-model.v1',
    modelType: 'causal-dilated-convolution-nearest-centroid',
  },
  compatibility: {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    requiredChannels: [
      { channel: 'airspeed', unit: 'kts' },
      { channel: 'altitude', unit: 'ft' },
      { channel: 'verticalRate', unit: 'ft/min' },
      { channel: 'fuel', unit: '%' },
      { channel: 'vibration', unit: 'g' },
    ],
    cadenceMs: 1_000,
    cadenceToleranceMs: 100,
    windowLength: 40,
  },
  identities: {
    artifactSha256: '8d238523f942ccc2b4f60a0048ff413018059dd1e583a1be216653bc3ef60cf4',
    configurationSha256: '9c7639745597b7b5a1b1ea7d498dfb83ae9da045316445b4d77ffbb7696fa230',
  },
  evidence: {
    training: {
      path: 'models/temporal_fault_model_v1.json',
      jsonPointer: '/training',
      split: 'training',
      seedSummary: '1101 through 1140',
    },
    calibration: {
      path: 'models/temporal_fault_model_v1.json',
      jsonPointer: '/calibration',
      split: 'calibration',
      seedSummary: '2101 through 2120',
    },
    evaluation: {
      path: 'models/temporal_evaluation_v1.json',
      jsonPointer: '/evaluation',
      split: 'held-out-evaluation',
      seedSummary: '3101 through 3140',
    },
    modelCardPath: 'models/TEMPORAL_MODEL_CARD.md',
    qualityGateJsonPointer: '/qualityGate',
  },
  availability: 'registered',
  defaultUserSelection: 'disabled',
  authority: DETERMINISTIC_AUTHORITY,
} as const satisfies ModelRegistryEntry);

export const temporalFaultRegistryEntry = deepFreeze({
  registryEntryId: 'generic-fixed-wing.temporal-fault',
  modelVersion: '2.0.0',
  profile: {
    id: 'generic-fixed-wing',
    version: '1.0.0',
  },
  artifact: {
    family: 'temporal',
    artifactVersion: 'temporal-fault-model.v1',
    modelType: 'causal-multiscale-feature-nearest-prototype',
  },
  compatibility: {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    requiredChannels: [
      { channel: 'airspeed', unit: 'kts' },
      { channel: 'altitude', unit: 'ft' },
      { channel: 'verticalRate', unit: 'ft/min' },
      { channel: 'fuel', unit: '%' },
      { channel: 'vibration', unit: 'g' },
    ],
    cadenceMs: 1_000,
    cadenceToleranceMs: 100,
    windowLength: 40,
  },
  identities: {
    artifactSha256: '4cdea6792b8d302a8cc0197caccbb4498b18d136b1c2ed93fe798d66a82633af',
    configurationSha256: '30300e753e278f3ea8633fe71fb6ecdcdecf5a52146c85d2c22c6e2facbe956c',
  },
  evidence: {
    training: {
      path: 'models/temporal_fault_model_v2.json',
      jsonPointer: '/training',
      split: 'training',
      seedSummary: '1101 through 1140',
    },
    calibration: {
      path: 'models/temporal_fault_model_v2.json',
      jsonPointer: '/calibration',
      split: 'calibration',
      seedSummary: '2101 through 2120',
    },
    evaluation: {
      path: 'models/temporal_evaluation_v2.json',
      jsonPointer: '/evaluation',
      split: 'held-out-evaluation',
      seedSummary: '9101 through 9140',
    },
    modelCardPath: 'models/TEMPORAL_INTEGRATION_MODEL_CARD.md',
    qualityGateJsonPointer: '/qualityGate',
  },
  availability: 'registered',
  defaultUserSelection: 'disabled',
  authority: DETERMINISTIC_AUTHORITY,
} as const satisfies ModelRegistryEntry);

export function createModelRegistry(entries: readonly ModelRegistryEntry[]): ModelRegistry {
  const uniqueKeys = new Set<string>();
  for (const entry of entries) {
    const key = `${entry.registryEntryId}@${entry.modelVersion}`;
    if (uniqueKeys.has(key)) {
      throw new Error(`Duplicate model registry entry: ${key}.`);
    }
    uniqueKeys.add(key);
  }
  return deepFreeze({
    schemaVersion: MODEL_REGISTRY_SCHEMA_VERSION,
    entries: [...entries],
  });
}

export const modelRegistry = createModelRegistry([
  robustCovarianceRegistryEntry,
  temporalFaultRegistryEntry,
  temporalFaultResearchRegistryEntry,
]);

export function findRegistryEntry(
  registry: ModelRegistry,
  registryEntryId: string,
  modelVersion?: string,
): Readonly<ModelRegistryEntry> | undefined {
  return registry.entries.find(
    (entry) =>
      entry.registryEntryId === registryEntryId &&
      (modelVersion === undefined || entry.modelVersion === modelVersion),
  );
}
