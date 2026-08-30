import type { DetectionProfile, TelemetrySchemaVersion } from '../core/types';
import type {
  DetectionComparison,
  DeterministicFindingSummary,
  LearnedBaselineArtifact,
  LearnedBaselineScore,
} from '../ml/types';

export const MODEL_REGISTRY_SCHEMA_VERSION = 'model-registry.v1' as const;
export const DETERMINISTIC_AUTHORITY: DetectionComparison['authority'] = 'deterministic-rules';

export type ModelRegistrySchemaVersion = typeof MODEL_REGISTRY_SCHEMA_VERSION;
export type Sha256Identity = string;
export type ModelActivationPurpose = 'integrated-advisory' | 'research-evidence-only';
export type ModelRegistryEntryKey = `${string}@${string}`;

export interface ModelEvidenceReference {
  readonly path: string;
  readonly jsonPointer: string;
  readonly split: 'training' | 'calibration' | 'held-out-evaluation';
  readonly seedSummary: string;
}

export interface ModelEvidenceContract {
  readonly training: Readonly<ModelEvidenceReference>;
  readonly calibration: Readonly<ModelEvidenceReference>;
  readonly evaluation: Readonly<ModelEvidenceReference>;
  readonly modelCardPath: string;
  readonly qualityGateJsonPointer: string;
}

export interface RequiredModelChannel {
  readonly channel: string;
  readonly unit: string;
}

export type ModelArtifactContract =
  | {
      readonly family: 'robust-covariance';
      readonly artifactVersion: LearnedBaselineArtifact['artifactVersion'];
      readonly modelType: LearnedBaselineArtifact['modelType'];
    }
  | {
      readonly family: 'temporal';
      readonly artifactVersion: 'temporal-fault-model.v1';
      readonly modelType:
        | 'causal-dilated-convolution-nearest-centroid'
        | 'causal-multiscale-feature-nearest-centroid'
        | 'causal-multiscale-feature-nearest-prototype';
    };

export interface ModelRegistryEntry {
  readonly registryEntryId: string;
  readonly modelVersion: string;
  /** Declares whether this exact version may be activated or is display-only research evidence. */
  readonly activationPurpose: ModelActivationPurpose;
  readonly profile: Readonly<Pick<DetectionProfile, 'id' | 'version'>>;
  readonly artifact: Readonly<ModelArtifactContract>;
  readonly compatibility: {
    readonly schemaVersion: TelemetrySchemaVersion;
    readonly requiredChannels: readonly Readonly<RequiredModelChannel>[];
    readonly cadenceMs: number;
    readonly cadenceToleranceMs: number;
    readonly windowLength: number;
  };
  readonly identities: {
    readonly artifactSha256: Sha256Identity | null;
    readonly configurationSha256: Sha256Identity | null;
  };
  readonly evidence: Readonly<ModelEvidenceContract>;
  readonly availability: 'registered' | 'planned';
  readonly defaultUserSelection: 'disabled';
  readonly authority: DetectionComparison['authority'];
}

export interface ModelRegistry {
  readonly schemaVersion: ModelRegistrySchemaVersion;
  readonly entries: readonly Readonly<ModelRegistryEntry>[];
}

export type ModelCompatibilityReasonCode =
  | 'MODEL_NOT_REGISTERED'
  | 'MODEL_NOT_AVAILABLE'
  | 'AMBIGUOUS_MODEL_SELECTION'
  | 'UNSUPPORTED_PROFILE'
  | 'SCHEMA_VERSION_MISMATCH'
  | 'PROFILE_ID_MISMATCH'
  | 'PROFILE_VERSION_MISMATCH'
  | 'MISSING_CHANNEL'
  | 'UNIT_MISMATCH'
  | 'CADENCE_MISMATCH'
  | 'WINDOW_LENGTH_MISMATCH'
  | 'ARTIFACT_IDENTITY_MISMATCH'
  | 'CONFIGURATION_IDENTITY_MISMATCH';

export interface ModelCompatibilityReason {
  readonly code: ModelCompatibilityReasonCode;
  readonly label: string;
  readonly detail: string;
  readonly expected?: string | number | undefined;
  readonly observed?: string | number | undefined;
  readonly channel?: string | undefined;
}

export type UserModelSelection =
  | { readonly state: 'enabled'; readonly label: 'Enabled' }
  | { readonly state: 'disabled'; readonly label: 'Disabled' };

export type ModelEligibility =
  | { readonly state: 'eligible'; readonly label: 'Eligible'; readonly reasons: readonly [] }
  | {
      readonly state: 'ineligible';
      readonly label: 'Ineligible';
      readonly reasons: readonly string[];
    };

export interface ModelReadiness {
  readonly userSelection: UserModelSelection;
  readonly eligibility: ModelEligibility;
  readonly active: boolean;
  readonly authority: DetectionComparison['authority'];
}

export interface ModelCompatibilityInput {
  readonly schemaVersion: string;
  readonly profile: Readonly<Pick<DetectionProfile, 'id' | 'version'>>;
  readonly channelUnits: Readonly<Record<string, string>>;
  readonly cadenceMs: number;
  readonly windowLength: number;
  readonly artifactSha256: Sha256Identity;
  readonly configurationSha256: Sha256Identity;
  readonly userSelection: UserModelSelection['state'];
  readonly qualityGatePassed: boolean;
}

export interface RegisteredModelSelection {
  readonly registryEntryId: string;
  readonly modelVersion: string;
}

export interface SupportedModelCompatibility {
  readonly status: 'supported';
  readonly supported: true;
  readonly entry: Readonly<ModelRegistryEntry>;
  readonly reasons: readonly [];
  readonly readiness: ModelReadiness;
}

export interface UnsupportedModelCompatibility {
  readonly status: 'unsupported';
  readonly supported: false;
  readonly entry?: Readonly<ModelRegistryEntry> | undefined;
  readonly reasons: readonly ModelCompatibilityReason[];
  readonly readiness: ModelReadiness;
}

export type ModelCompatibilityResult = SupportedModelCompatibility | UnsupportedModelCompatibility;

export interface ProductionAgreement {
  readonly authority: DetectionComparison['authority'];
  readonly authoritativeDecision: 'indicate' | 'nominal';
  readonly advisoryModelDecision: 'indicate' | 'nominal';
  readonly agreement: DetectionComparison['agreement'];
  readonly deterministicFindings: readonly DeterministicFindingSummary[];
  readonly learnedBaseline: LearnedBaselineScore;
}
