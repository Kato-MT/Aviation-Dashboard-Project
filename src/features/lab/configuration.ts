import robustCovarianceArtifact from '../../../models/robust_covariance_v1.json';
import robustCovarianceArtifactRaw from '../../../models/robust_covariance_v1.json?raw';
import configurationManifest from '../../../models/model_configuration_manifest_v1.json';
import temporalV2Artifact from '../../../models/temporal_fault_model_v2.json';
import temporalV2ArtifactRaw from '../../../models/temporal_fault_model_v2.json?raw';
import { LEGACY_FIELD_MAPPINGS, LEGACY_UNIT_MAPPINGS } from '../../adapters/legacy-csv';
import { sha256Hex } from '../../core/hash';
import type {
  DetectionProfile,
  DetectionRule,
  TelemetryRun,
  TelemetrySource,
} from '../../core/types';
import {
  modelPassesQualityGate,
  parseLearnedBaselineArtifact,
  parseTemporalFaultModelArtifact,
  temporalModelPassesQualityGate,
} from '../../ml';
import { evaluateModelCompatibility } from '../../model-registry/compatibility';
import {
  modelRegistry,
  modelRegistryEntryKey,
  robustCovarianceRegistryEntry,
  temporalFaultRegistryEntry,
} from '../../model-registry/registry';
import type {
  ModelCompatibilityReason,
  ModelRegistry,
  ModelRegistryEntry,
  ModelRegistryEntryKey,
  UserModelSelection,
} from '../../model-registry/types';

type HashFunction = (value: string | Uint8Array) => Promise<string>;

function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export type EvidenceVerificationState = 'pending' | 'verified' | 'mismatch' | 'unavailable';

export interface Sha256VerificationEvidence {
  readonly state: EvidenceVerificationState;
  readonly expectedSha256: string | null;
  readonly actualSha256: string | null;
  readonly detail: string;
}

export type QualityGateVerificationState = 'pending' | 'passed' | 'failed' | 'unavailable';

export interface QualityGateVerificationEvidence {
  readonly state: QualityGateVerificationState;
  readonly storedPassed: boolean | null;
  readonly recomputedPassed: boolean | null;
  readonly detail: string;
}

export interface BundledModelVerificationEvidence {
  readonly key: ModelRegistryEntryKey;
  readonly activationPurpose: ModelRegistryEntry['activationPurpose'];
  readonly artifact: Sha256VerificationEvidence;
  readonly configuration: Sha256VerificationEvidence;
  readonly declaredConfigurationSha256: string | null;
  readonly qualityGate: QualityGateVerificationEvidence;
}

export interface BundledModelVerificationSet {
  readonly robustCovariance: BundledModelVerificationEvidence;
  readonly temporalV2: BundledModelVerificationEvidence;
}

function pendingIdentity(expectedSha256: string | null): Sha256VerificationEvidence {
  return {
    state: expectedSha256 === null ? 'unavailable' : 'pending',
    expectedSha256,
    actualSha256: null,
    detail:
      expectedSha256 === null
        ? 'No registered SHA-256 identity is available.'
        : 'Runtime SHA-256 verification is pending.',
  };
}

function pendingModel(entry: Readonly<ModelRegistryEntry>): BundledModelVerificationEvidence {
  return {
    key: modelRegistryEntryKey(entry),
    activationPurpose: entry.activationPurpose,
    artifact: pendingIdentity(entry.identities.artifactSha256),
    configuration: pendingIdentity(entry.identities.configurationSha256),
    declaredConfigurationSha256: null,
    qualityGate: {
      state: 'pending',
      storedPassed: null,
      recomputedPassed: null,
      detail: 'Artifact parsing and quality-gate recomputation are pending.',
    },
  };
}

export function pendingBundledModelVerification(): BundledModelVerificationSet {
  return deepFreeze({
    robustCovariance: pendingModel(robustCovarianceRegistryEntry),
    temporalV2: pendingModel(temporalFaultRegistryEntry),
  });
}

export function compareSha256Evidence(
  expectedSha256: string | null,
  actualSha256?: string,
  unavailableDetail?: string,
): Sha256VerificationEvidence {
  if (expectedSha256 === null) {
    return deepFreeze({
      state: 'unavailable',
      expectedSha256,
      actualSha256: actualSha256 ?? null,
      detail: 'No registered SHA-256 identity is available.',
    });
  }
  if (unavailableDetail !== undefined) {
    return deepFreeze({
      state: 'unavailable',
      expectedSha256,
      actualSha256: actualSha256 ?? null,
      detail: unavailableDetail,
    });
  }
  if (actualSha256 === undefined) return deepFreeze(pendingIdentity(expectedSha256));
  const verified = actualSha256.toLowerCase() === expectedSha256.toLowerCase();
  return deepFreeze({
    state: verified ? 'verified' : 'mismatch',
    expectedSha256,
    actualSha256: actualSha256.toLowerCase(),
    detail: verified
      ? 'Runtime SHA-256 matches the registered identity.'
      : 'Runtime SHA-256 does not match the registered identity.',
  });
}

interface ConfigurationManifestEntry {
  readonly registryEntryId: string;
  readonly modelVersion: string;
  readonly canonicalJson: string;
  readonly sha256: string;
}

function manifestEntry(
  value: unknown,
  entry: Readonly<ModelRegistryEntry>,
): ConfigurationManifestEntry | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const entries = (value as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) return undefined;
  return entries.find(
    (candidate): candidate is ConfigurationManifestEntry =>
      typeof candidate === 'object' &&
      candidate !== null &&
      (candidate as ConfigurationManifestEntry).registryEntryId === entry.registryEntryId &&
      (candidate as ConfigurationManifestEntry).modelVersion === entry.modelVersion &&
      typeof (candidate as ConfigurationManifestEntry).canonicalJson === 'string' &&
      typeof (candidate as ConfigurationManifestEntry).sha256 === 'string',
  );
}

async function hashEvidence(
  expectedSha256: string | null,
  payload: string | undefined,
  hash: HashFunction,
  missingDetail: string,
): Promise<Sha256VerificationEvidence> {
  if (payload === undefined) return compareSha256Evidence(expectedSha256, undefined, missingDetail);
  try {
    return compareSha256Evidence(expectedSha256, await hash(payload));
  } catch (error) {
    return compareSha256Evidence(
      expectedSha256,
      undefined,
      error instanceof Error ? error.message : 'SHA-256 verification failed.',
    );
  }
}

function robustQualityGate(value: unknown): QualityGateVerificationEvidence {
  try {
    const artifact = parseLearnedBaselineArtifact(value);
    const recomputedPassed = modelPassesQualityGate(artifact);
    return deepFreeze({
      state: recomputedPassed ? 'passed' : 'failed',
      storedPassed: artifact.qualityGate.passed,
      recomputedPassed,
      detail: recomputedPassed
        ? 'Held-out F1 and false-positive thresholds pass after recomputation.'
        : 'The robust-covariance quality gate does not pass after recomputation.',
    });
  } catch (error) {
    return deepFreeze({
      state: 'unavailable',
      storedPassed: null,
      recomputedPassed: null,
      detail: error instanceof Error ? error.message : 'The artifact could not be parsed.',
    });
  }
}

function temporalQualityGate(value: unknown): QualityGateVerificationEvidence {
  try {
    const artifact = parseTemporalFaultModelArtifact(value);
    const recomputedPassed = temporalModelPassesQualityGate(artifact);
    return deepFreeze({
      state: recomputedPassed ? 'passed' : 'failed',
      storedPassed: artifact.qualityGate.passed,
      recomputedPassed,
      detail: recomputedPassed
        ? 'All selected-window and classification thresholds pass after recomputation.'
        : 'The temporal-v2 quality gate does not pass after recomputation.',
    });
  } catch (error) {
    return deepFreeze({
      state: 'unavailable',
      storedPassed: null,
      recomputedPassed: null,
      detail: error instanceof Error ? error.message : 'The artifact could not be parsed.',
    });
  }
}

export interface BundledModelVerificationOptions {
  readonly hash?: HashFunction | undefined;
  readonly robustArtifactRaw?: string | undefined;
  readonly temporalArtifactRaw?: string | undefined;
  readonly robustArtifact?: unknown;
  readonly temporalArtifact?: unknown;
  readonly manifest?: unknown;
}

export async function verifyBundledModelEvidence(
  options: BundledModelVerificationOptions = {},
): Promise<BundledModelVerificationSet> {
  const hash = options.hash ?? sha256Hex;
  const manifest = options.manifest ?? configurationManifest;
  const robustConfiguration = manifestEntry(manifest, robustCovarianceRegistryEntry);
  const temporalConfiguration = manifestEntry(manifest, temporalFaultRegistryEntry);
  const robustParsed = options.robustArtifact ?? robustCovarianceArtifact;
  const temporalParsed = options.temporalArtifact ?? temporalV2Artifact;
  const [
    robustArtifactIdentity,
    robustConfigurationIdentity,
    temporalArtifactIdentity,
    temporalConfigurationIdentity,
  ] = await Promise.all([
    hashEvidence(
      robustCovarianceRegistryEntry.identities.artifactSha256,
      options.robustArtifactRaw ?? robustCovarianceArtifactRaw,
      hash,
      'The bundled robust-covariance artifact bytes are unavailable.',
    ),
    hashEvidence(
      robustCovarianceRegistryEntry.identities.configurationSha256,
      robustConfiguration?.canonicalJson,
      hash,
      'The robust-covariance canonical configuration is unavailable.',
    ),
    hashEvidence(
      temporalFaultRegistryEntry.identities.artifactSha256,
      options.temporalArtifactRaw ?? temporalV2ArtifactRaw,
      hash,
      'The bundled temporal-v2 artifact bytes are unavailable.',
    ),
    hashEvidence(
      temporalFaultRegistryEntry.identities.configurationSha256,
      temporalConfiguration?.canonicalJson,
      hash,
      'The temporal-v2 canonical configuration is unavailable.',
    ),
  ]);

  let temporalDeclaredConfiguration: string | null = null;
  try {
    temporalDeclaredConfiguration =
      parseTemporalFaultModelArtifact(temporalParsed).training.configurationSha256;
  } catch {
    // The quality-gate evidence below preserves the parse failure without trusting a declaration.
  }
  const temporalConfigurationWithDeclaration =
    temporalConfigurationIdentity.state === 'verified' &&
    temporalDeclaredConfiguration?.toLowerCase() !==
      temporalConfigurationIdentity.actualSha256?.toLowerCase()
      ? compareSha256Evidence(
          temporalFaultRegistryEntry.identities.configurationSha256,
          temporalDeclaredConfiguration ?? undefined,
        )
      : temporalConfigurationIdentity;

  return deepFreeze({
    robustCovariance: {
      key: modelRegistryEntryKey(robustCovarianceRegistryEntry),
      activationPurpose: robustCovarianceRegistryEntry.activationPurpose,
      artifact: robustArtifactIdentity,
      configuration: robustConfigurationIdentity,
      declaredConfigurationSha256: robustConfiguration?.sha256 ?? null,
      qualityGate: robustQualityGate(robustParsed),
    },
    temporalV2: {
      key: modelRegistryEntryKey(temporalFaultRegistryEntry),
      activationPurpose: temporalFaultRegistryEntry.activationPurpose,
      artifact: temporalArtifactIdentity,
      configuration: temporalConfigurationWithDeclaration,
      declaredConfigurationSha256: temporalDeclaredConfiguration,
      qualityGate: temporalQualityGate(temporalParsed),
    },
  });
}

export function ruleCondition(rule: DetectionRule): string {
  switch (rule.kind) {
    case 'threshold':
      return `${rule.channel} ${rule.operator} ${rule.threshold}`;
    case 'range':
      return `${rule.minimum} <= ${rule.channel} <= ${rule.maximum}`;
    case 'rate':
      return `|delta ${rule.channel}| <= ${rule.maximumAbsoluteRate}/s`;
    case 'decrease-rate':
      return `decrease ${rule.channel} <= ${rule.maximumDecreaseRate}/s`;
    case 'window-decrease':
      return `decrease ${rule.channel} <= ${rule.maximumDecrease} in ${rule.windowMs / 1_000}s`;
    case 'frozen':
      return `${rule.channel} changes within ${rule.minimumDurationMs / 1_000}s`;
  }
}

function ruleParameters(rule: DetectionRule): Readonly<Record<string, number | string>> {
  switch (rule.kind) {
    case 'threshold':
      return { operator: rule.operator, threshold: rule.threshold };
    case 'range':
      return { minimum: rule.minimum, maximum: rule.maximum };
    case 'rate':
      return { maximumAbsoluteRate: rule.maximumAbsoluteRate };
    case 'decrease-rate':
      return { maximumDecreaseRate: rule.maximumDecreaseRate };
    case 'window-decrease':
      return {
        maximumDecrease: rule.maximumDecrease,
        windowMs: rule.windowMs,
        toleranceMs: rule.toleranceMs,
      };
    case 'frozen':
      return { minimumDurationMs: rule.minimumDurationMs, tolerance: rule.tolerance };
  }
}

export interface ProfileConfigurationEvidence {
  readonly id: string;
  readonly version: string;
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly synthetic: true;
  readonly dataClassification: 'SYNTHETIC_UNCLASSIFIED';
  readonly platformCategory: DetectionProfile['platformCategory'];
  readonly limits: {
    readonly expectedCadenceMs: number | null;
    readonly cadenceToleranceMs: number | null;
    readonly staleAfterMs: number | null;
    readonly sequencePolicy: DetectionProfile['sequencePolicy'];
  };
  readonly channels: readonly {
    readonly channel: string;
    readonly label: string;
    readonly unit: string;
    readonly required: boolean;
    readonly minimum: number | null;
    readonly maximum: number | null;
  }[];
  readonly rules: readonly {
    readonly id: string;
    readonly kind: DetectionRule['kind'];
    readonly label: string;
    readonly description: string;
    readonly severity: DetectionRule['severity'];
    readonly enabled: boolean;
    readonly channel: string;
    readonly condition: string;
    readonly parameters: Readonly<Record<string, number | string>>;
  }[];
}

export function projectProfileConfiguration(
  profile: Readonly<DetectionProfile>,
): ProfileConfigurationEvidence {
  return deepFreeze({
    id: profile.id,
    version: profile.version,
    key: `${profile.id}@${profile.version}`,
    label: profile.label,
    description: profile.description,
    synthetic: true,
    dataClassification: profile.dataClassification,
    platformCategory: profile.platformCategory,
    limits: {
      expectedCadenceMs: profile.expectedCadenceMs ?? null,
      cadenceToleranceMs: profile.cadenceToleranceMs ?? null,
      staleAfterMs: profile.staleAfterMs ?? null,
      sequencePolicy: profile.sequencePolicy,
    },
    channels: Object.values(profile.channels)
      .map((channel) => ({
        channel: channel.channel,
        label: channel.label,
        unit: channel.unit,
        required: channel.required,
        minimum: channel.minimum ?? null,
        maximum: channel.maximum ?? null,
      }))
      .sort((left, right) => left.channel.localeCompare(right.channel)),
    rules: profile.rules.map((rule) => ({
      id: rule.id,
      kind: rule.kind,
      label: rule.label,
      description: rule.description,
      severity: rule.severity,
      enabled: rule.enabled,
      channel: rule.channel,
      condition: ruleCondition(rule),
      parameters: ruleParameters(rule),
    })),
  });
}

export interface SourceUnitEvidence {
  readonly sourceId: string;
  readonly adapterId: string;
  readonly declaredUnits: Readonly<Record<string, string>>;
  readonly acceptedSampleUnits: Readonly<Record<string, readonly string[]>>;
}

export interface ActiveRunConfigurationEvidence {
  readonly state: 'empty' | 'available';
  readonly schemaVersion: string | null;
  readonly adapter: { readonly id: string; readonly version: string } | null;
  readonly declaredProfile: { readonly id: string; readonly version: string } | null;
  readonly selectedAnalysisProfile: { readonly id: string; readonly version: string };
  readonly profileRelationship: 'match' | 'mismatch' | 'undeclared';
  readonly datasetSha256: string | null;
  readonly applicationVersion: string | null;
  readonly acceptedRecords: number;
  readonly quarantinedRecords: number;
  readonly fatal: boolean;
  readonly fieldMappings: readonly {
    readonly canonicalField: string;
    readonly sourceField: string;
    readonly origin: 'adapter-default' | 'canonical-json';
  }[];
  readonly unitMappings: readonly {
    readonly canonicalChannel: string;
    readonly unit: string;
    readonly origin: 'adapter-default';
  }[];
  readonly sourceUnits: readonly SourceUnitEvidence[];
}

function sourceUnits(run: TelemetryRun, source: TelemetrySource): SourceUnitEvidence {
  const accepted = new Map<string, Set<string>>();
  for (const sample of run.samples.filter((candidate) => candidate.sourceId === source.sourceId)) {
    for (const [channel, unit] of Object.entries(sample.units)) {
      const values = accepted.get(channel) ?? new Set<string>();
      values.add(unit);
      accepted.set(channel, values);
    }
  }
  return {
    sourceId: source.sourceId,
    adapterId: source.adapterId,
    declaredUnits: Object.fromEntries(
      Object.entries(source.units).sort(([left], [right]) => left.localeCompare(right)),
    ),
    acceptedSampleUnits: Object.fromEntries(
      [...accepted.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([channel, values]) => [channel, [...values].sort()]),
    ),
  };
}

export function projectActiveRunConfiguration(
  run: Readonly<TelemetryRun> | undefined,
  selectedProfile: Readonly<DetectionProfile>,
): ActiveRunConfigurationEvidence {
  const selectedAnalysisProfile = { id: selectedProfile.id, version: selectedProfile.version };
  if (!run) {
    return deepFreeze({
      state: 'empty',
      schemaVersion: null,
      adapter: null,
      declaredProfile: null,
      selectedAnalysisProfile,
      profileRelationship: 'undeclared',
      datasetSha256: null,
      applicationVersion: null,
      acceptedRecords: 0,
      quarantinedRecords: 0,
      fatal: false,
      fieldMappings: [],
      unitMappings: [],
      sourceUnits: [],
    });
  }
  const declaredProfile =
    run.profileId && run.profileVersion ? { id: run.profileId, version: run.profileVersion } : null;
  const legacy = run.adapterId === 'legacy-csv';
  return deepFreeze({
    state: 'available',
    schemaVersion: run.schemaVersion,
    adapter: { id: run.adapterId, version: run.adapterVersion },
    declaredProfile,
    selectedAnalysisProfile,
    profileRelationship:
      declaredProfile === null
        ? 'undeclared'
        : declaredProfile.id === selectedProfile.id &&
            declaredProfile.version === selectedProfile.version
          ? 'match'
          : 'mismatch',
    datasetSha256: run.provenance.datasetSha256,
    applicationVersion: run.provenance.applicationVersion,
    acceptedRecords: run.samples.length,
    quarantinedRecords: run.quarantinedRows.length,
    fatal: run.fatal,
    fieldMappings: legacy
      ? Object.entries(LEGACY_FIELD_MAPPINGS).map(([canonicalField, sourceField]) => ({
          canonicalField,
          sourceField,
          origin: 'adapter-default' as const,
        }))
      : ['sourceId', 'sequence', 'timestamp', 'measurements', 'units', 'qualityFlags'].map(
          (field) => ({
            canonicalField: field,
            sourceField: field,
            origin: 'canonical-json' as const,
          }),
        ),
    unitMappings: legacy
      ? Object.entries(LEGACY_UNIT_MAPPINGS).map(([canonicalChannel, unit]) => ({
          canonicalChannel,
          unit,
          origin: 'adapter-default' as const,
        }))
      : [],
    sourceUnits: run.sources
      .map((source) => sourceUnits(run as TelemetryRun, source))
      .sort((left, right) => left.sourceId.localeCompare(right.sourceId)),
  });
}

export interface ConfigurationCompatibilityReason {
  readonly code:
    | 'FATAL_RUN'
    | 'NO_SOURCES'
    | 'RUN_PROFILE_MISMATCH'
    | 'SOURCE_REQUIRED_CHANNEL_MISSING'
    | 'SOURCE_UNIT_CONFLICT'
    | 'CADENCE_UNAVAILABLE'
    | 'SOURCE_CADENCE_CONFLICT'
    | 'SOURCE_CADENCE_OUT_OF_CONTRACT'
    | 'ARTIFACT_IDENTITY_PENDING'
    | 'ARTIFACT_IDENTITY_UNAVAILABLE'
    | 'ARTIFACT_IDENTITY_MISMATCH'
    | 'CONFIGURATION_IDENTITY_PENDING'
    | 'CONFIGURATION_IDENTITY_UNAVAILABLE'
    | 'CONFIGURATION_IDENTITY_MISMATCH'
    | 'QUALITY_GATE_PENDING'
    | 'QUALITY_GATE_UNAVAILABLE'
    | 'QUALITY_GATE_FAILED'
    | 'RESEARCH_EVIDENCE_ONLY'
    | 'ARTIFACT_PARSE_FAILED';
  readonly detail: string;
  readonly sourceId?: string | undefined;
  readonly channel?: string | undefined;
}

export interface ModelConfigurationCompatibilityEvidence {
  readonly key: ModelRegistryEntryKey;
  readonly contextLabel: string;
  readonly userSelection: UserModelSelection['state'];
  readonly supported: boolean;
  readonly eligible: boolean;
  readonly active: boolean;
  readonly authority: ModelRegistryEntry['authority'];
  readonly observed: {
    readonly schemaVersion: string;
    readonly profile: { readonly id: string; readonly version: string };
    readonly channelUnits: Readonly<Record<string, string>>;
    readonly cadenceMs: number | null;
    readonly windowLength: number;
    readonly sourceCadenceMs: Readonly<Record<string, number | null>>;
  };
  readonly reasons: readonly (
    ConfigurationCompatibilityReason | Readonly<ModelCompatibilityReason>
  )[];
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function identityReasons(
  model: BundledModelVerificationEvidence,
): ConfigurationCompatibilityReason[] {
  const reasons: ConfigurationCompatibilityReason[] = [];
  for (const [kind, evidence] of [
    ['ARTIFACT', model.artifact],
    ['CONFIGURATION', model.configuration],
  ] as const) {
    if (evidence.state !== 'verified') {
      reasons.push({
        code: `${kind}_IDENTITY_${evidence.state.toUpperCase()}` as ConfigurationCompatibilityReason['code'],
        detail: evidence.detail,
      });
    }
  }
  if (model.qualityGate.state !== 'passed') {
    reasons.push({
      code: `QUALITY_GATE_${model.qualityGate.state.toUpperCase()}` as ConfigurationCompatibilityReason['code'],
      detail: model.qualityGate.detail,
    });
  }
  if (model.activationPurpose === 'research-evidence-only') {
    reasons.push({
      code: 'RESEARCH_EVIDENCE_ONLY',
      detail: 'This exact model version is display-only research evidence and cannot activate.',
    });
  }
  return reasons;
}

function observedRunContext(
  run: Readonly<TelemetryRun>,
  profile: Readonly<DetectionProfile>,
  entry: Readonly<ModelRegistryEntry>,
): {
  channelUnits: Record<string, string>;
  cadenceMs: number | null;
  sourceCadenceMs: Record<string, number | null>;
  reasons: ConfigurationCompatibilityReason[];
} {
  const reasons: ConfigurationCompatibilityReason[] = [];
  if (run.fatal) reasons.push({ code: 'FATAL_RUN', detail: 'Fatal validation blocks model use.' });
  if (run.profileId !== profile.id || run.profileVersion !== profile.version) {
    reasons.push({
      code: 'RUN_PROFILE_MISMATCH',
      detail: 'The selected analysis profile does not match the profile declared by this run.',
    });
  }
  const sourceIds = [
    ...new Set([
      ...run.sources.map(({ sourceId }) => sourceId),
      ...run.samples.map(({ sourceId }) => sourceId),
    ]),
  ].sort();
  if (sourceIds.length === 0)
    reasons.push({ code: 'NO_SOURCES', detail: 'No source is available.' });

  const channelUnits: Record<string, string> = {};
  for (const required of entry.compatibility.requiredChannels) {
    const unitsAcrossSources = new Set<string>();
    let complete = true;
    for (const sourceId of sourceIds) {
      const units = new Set<string>();
      const source = run.sources.find((candidate) => candidate.sourceId === sourceId);
      const declared = source?.units[required.channel];
      if (declared) units.add(declared);
      for (const sample of run.samples.filter((candidate) => candidate.sourceId === sourceId)) {
        const unit = sample.units[required.channel];
        if (unit) units.add(unit);
      }
      if (units.size === 0) {
        complete = false;
        reasons.push({
          code: 'SOURCE_REQUIRED_CHANNEL_MISSING',
          detail: `Source ${sourceId} does not declare required channel ${required.channel}.`,
          sourceId,
          channel: required.channel,
        });
      } else if (units.size > 1) {
        complete = false;
        reasons.push({
          code: 'SOURCE_UNIT_CONFLICT',
          detail: `Source ${sourceId} declares conflicting units for ${required.channel}: ${[...units].sort().join(', ')}.`,
          sourceId,
          channel: required.channel,
        });
      } else {
        unitsAcrossSources.add([...units][0]!);
      }
    }
    if (complete && unitsAcrossSources.size === 1) {
      channelUnits[required.channel] = [...unitsAcrossSources][0]!;
    } else if (unitsAcrossSources.size > 1) {
      reasons.push({
        code: 'SOURCE_UNIT_CONFLICT',
        detail: `Sources disagree on the unit for ${required.channel}: ${[...unitsAcrossSources].sort().join(', ')}.`,
        channel: required.channel,
      });
    }
  }

  const sourceCadenceMs: Record<string, number | null> = {};
  for (const sourceId of sourceIds) {
    const timestamps = run.samples
      .filter((sample) => sample.sourceId === sourceId)
      .map(({ timestampMs }) => timestampMs)
      .sort((left, right) => left - right);
    const deltas = timestamps.slice(1).map((timestamp, index) => timestamp - timestamps[index]!);
    if (deltas.length === 0 || deltas.some((delta) => !Number.isFinite(delta) || delta <= 0)) {
      sourceCadenceMs[sourceId] = null;
      reasons.push({
        code: 'CADENCE_UNAVAILABLE',
        detail: `A positive observed cadence cannot be derived for source ${sourceId}.`,
        sourceId,
      });
      continue;
    }
    sourceCadenceMs[sourceId] = median(deltas);
    if (
      deltas.some(
        (delta) =>
          Math.abs(delta - entry.compatibility.cadenceMs) > entry.compatibility.cadenceToleranceMs,
      )
    ) {
      reasons.push({
        code: 'SOURCE_CADENCE_OUT_OF_CONTRACT',
        detail: `Source ${sourceId} contains intervals outside the registered cadence tolerance.`,
        sourceId,
      });
    }
  }
  const finiteCadences = Object.values(sourceCadenceMs).filter(
    (value): value is number => value !== null,
  );
  const cadenceConflict =
    finiteCadences.length > 1 &&
    Math.max(...finiteCadences) - Math.min(...finiteCadences) >
      entry.compatibility.cadenceToleranceMs;
  if (cadenceConflict) {
    reasons.push({
      code: 'SOURCE_CADENCE_CONFLICT',
      detail: 'Sources have incompatible observed cadences; no first-source cadence was selected.',
    });
  }
  return {
    channelUnits,
    cadenceMs:
      finiteCadences.length === sourceIds.length && !cadenceConflict
        ? median(finiteCadences)
        : null,
    sourceCadenceMs,
    reasons,
  };
}

function identityForCompatibility(
  evidence: Sha256VerificationEvidence,
  registeredSha256: string | null,
): string {
  // Pending and unavailable are represented by the explicit evidence reason below. Supplying the
  // registered value here prevents the lower-level comparator from relabeling those states as a
  // mismatch merely because no runtime digest exists yet.
  return evidence.actualSha256 ?? registeredSha256 ?? '';
}

function distinctCompatibilityReasons(
  reasons: readonly Readonly<ModelCompatibilityReason>[],
  model: BundledModelVerificationEvidence,
): readonly Readonly<ModelCompatibilityReason>[] {
  return reasons.filter(
    (reason) =>
      !(
        (reason.code === 'ARTIFACT_IDENTITY_MISMATCH' && model.artifact.state !== 'verified') ||
        (reason.code === 'CONFIGURATION_IDENTITY_MISMATCH' &&
          model.configuration.state !== 'verified')
      ),
  );
}

function blocksCompatibility(reason: ConfigurationCompatibilityReason): boolean {
  return !reason.code.startsWith('QUALITY_GATE_') && reason.code !== 'RESEARCH_EVIDENCE_ONLY';
}

export function projectRobustCovarianceCompatibility(
  run: Readonly<TelemetryRun>,
  selectedProfile: Readonly<DetectionProfile>,
  bundled: Readonly<BundledModelVerificationEvidence>,
  userSelection: UserModelSelection['state'],
): ModelConfigurationCompatibilityEvidence {
  const observed = observedRunContext(run, selectedProfile, robustCovarianceRegistryEntry);
  const identityAndGateReasons = identityReasons(bundled);
  const compatibility = evaluateModelCompatibility(robustCovarianceRegistryEntry, {
    schemaVersion: run.schemaVersion,
    profile: { id: selectedProfile.id, version: selectedProfile.version },
    channelUnits: observed.channelUnits,
    cadenceMs: observed.cadenceMs ?? Number.NaN,
    windowLength: robustCovarianceRegistryEntry.compatibility.windowLength,
    artifactSha256: identityForCompatibility(
      bundled.artifact,
      robustCovarianceRegistryEntry.identities.artifactSha256,
    ),
    configurationSha256: identityForCompatibility(
      bundled.configuration,
      robustCovarianceRegistryEntry.identities.configurationSha256,
    ),
    userSelection,
    qualityGatePassed: bundled.qualityGate.recomputedPassed === true,
  });
  const reasons = [
    ...observed.reasons,
    ...identityAndGateReasons,
    ...distinctCompatibilityReasons(compatibility.reasons, bundled),
  ];
  const supported =
    compatibility.supported &&
    observed.reasons.length === 0 &&
    !identityAndGateReasons.some(blocksCompatibility);
  const eligible =
    supported &&
    compatibility.readiness.eligibility.state === 'eligible' &&
    bundled.activationPurpose === 'integrated-advisory';
  return deepFreeze({
    key: modelRegistryEntryKey(robustCovarianceRegistryEntry),
    contextLabel: 'Current accepted synthetic telemetry run',
    userSelection,
    supported,
    eligible,
    active: eligible && userSelection === 'enabled',
    authority: robustCovarianceRegistryEntry.authority,
    observed: {
      schemaVersion: run.schemaVersion,
      profile: { id: selectedProfile.id, version: selectedProfile.version },
      channelUnits: observed.channelUnits,
      cadenceMs: observed.cadenceMs,
      windowLength: robustCovarianceRegistryEntry.compatibility.windowLength,
      sourceCadenceMs: observed.sourceCadenceMs,
    },
    reasons,
  });
}

export function projectTemporalV2Compatibility(
  bundled: Readonly<BundledModelVerificationEvidence>,
  userSelection: UserModelSelection['state'],
  artifactInput: unknown = temporalV2Artifact,
): ModelConfigurationCompatibilityEvidence {
  const identityAndGateReasons = identityReasons(bundled);
  try {
    const artifact = parseTemporalFaultModelArtifact(artifactInput);
    const compatibility = evaluateModelCompatibility(temporalFaultRegistryEntry, {
      schemaVersion: artifact.schemaVersion,
      profile: artifact.profile,
      channelUnits: artifact.units,
      cadenceMs: artifact.cadenceMs,
      windowLength: artifact.windowLength,
      artifactSha256: identityForCompatibility(
        bundled.artifact,
        temporalFaultRegistryEntry.identities.artifactSha256,
      ),
      configurationSha256: identityForCompatibility(
        bundled.configuration,
        temporalFaultRegistryEntry.identities.configurationSha256,
      ),
      userSelection,
      qualityGatePassed: bundled.qualityGate.recomputedPassed === true,
    });
    const reasons = [
      ...identityAndGateReasons,
      ...distinctCompatibilityReasons(compatibility.reasons, bundled),
    ];
    const supported = compatibility.supported && !identityAndGateReasons.some(blocksCompatibility);
    const eligible =
      supported &&
      compatibility.readiness.eligibility.state === 'eligible' &&
      bundled.activationPurpose === 'integrated-advisory';
    return deepFreeze({
      key: modelRegistryEntryKey(temporalFaultRegistryEntry),
      contextLabel: 'Fixed-wing Investigation generator and projection',
      userSelection,
      supported,
      eligible,
      active: eligible && userSelection === 'enabled',
      authority: temporalFaultRegistryEntry.authority,
      observed: {
        schemaVersion: artifact.schemaVersion,
        profile: { ...artifact.profile },
        channelUnits: { ...artifact.units },
        cadenceMs: artifact.cadenceMs,
        windowLength: artifact.windowLength,
        sourceCadenceMs: {},
      },
      reasons,
    });
  } catch (error) {
    return deepFreeze({
      key: modelRegistryEntryKey(temporalFaultRegistryEntry),
      contextLabel: 'Fixed-wing Investigation generator and projection',
      userSelection,
      supported: false,
      eligible: false,
      active: false,
      authority: temporalFaultRegistryEntry.authority,
      observed: {
        schemaVersion: '',
        profile: { id: '', version: '' },
        channelUnits: {},
        cadenceMs: null,
        windowLength: temporalFaultRegistryEntry.compatibility.windowLength,
        sourceCadenceMs: {},
      },
      reasons: [
        ...identityAndGateReasons,
        {
          code: 'ARTIFACT_PARSE_FAILED',
          detail: error instanceof Error ? error.message : 'Temporal-v2 artifact parsing failed.',
        },
      ],
    });
  }
}

export interface ModelRegistryDescriptorEvidence {
  readonly key: ModelRegistryEntryKey;
  readonly registryEntryId: string;
  readonly modelVersion: string;
  readonly activationPurpose: ModelRegistryEntry['activationPurpose'];
  readonly profile: ModelRegistryEntry['profile'];
  readonly artifact: ModelRegistryEntry['artifact'];
  readonly compatibility: ModelRegistryEntry['compatibility'];
  readonly identities: ModelRegistryEntry['identities'];
  readonly evidence: ModelRegistryEntry['evidence'];
  readonly availability: ModelRegistryEntry['availability'];
  readonly defaultUserSelection: ModelRegistryEntry['defaultUserSelection'];
  readonly authority: ModelRegistryEntry['authority'];
}

export function projectModelRegistryDescriptors(
  registry: Readonly<ModelRegistry> = modelRegistry,
): readonly ModelRegistryDescriptorEvidence[] {
  return deepFreeze(
    registry.entries.map((entry) => ({
      key: modelRegistryEntryKey(entry),
      registryEntryId: entry.registryEntryId,
      modelVersion: entry.modelVersion,
      activationPurpose: entry.activationPurpose,
      profile: { ...entry.profile },
      artifact: { ...entry.artifact },
      compatibility: {
        ...entry.compatibility,
        requiredChannels: entry.compatibility.requiredChannels.map((channel) => ({ ...channel })),
      },
      identities: { ...entry.identities },
      evidence: {
        training: { ...entry.evidence.training },
        calibration: { ...entry.evidence.calibration },
        evaluation: { ...entry.evidence.evaluation },
        modelCardPath: entry.evidence.modelCardPath,
        qualityGateJsonPointer: entry.evidence.qualityGateJsonPointer,
      },
      availability: entry.availability,
      defaultUserSelection: entry.defaultUserSelection,
      authority: entry.authority,
    })),
  );
}
