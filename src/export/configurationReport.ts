import { APPLICATION_VERSION } from '../core/constants';
import type { DetectionProfile, DetectionRule } from '../core/types';
import type { EvidenceBuildIdentity } from '../evidence/types';
import type { LabConfigurationStreamEvidence, LoadedLabRun } from '../features/lab/session';
import { DETERMINISTIC_AUTHORITY } from '../model-registry/types';
import type {
  ModelActivationPurpose,
  ModelArtifactContract,
  ModelRegistryEntryKey,
} from '../model-registry/types';

export type ConfigurationIdentityVerificationState =
  'pending' | 'verified' | 'mismatch' | 'unavailable';
export type ConfigurationQualityGateState = 'pending' | 'passed' | 'failed' | 'unavailable';
export type ConfigurationModelEligibility = 'eligible' | 'ineligible';

export interface ConfigurationModelEvidenceInput {
  readonly key: ModelRegistryEntryKey;
  readonly family: ModelArtifactContract['family'];
  readonly activationPurpose: ModelActivationPurpose;
  readonly context: string;
  readonly expectedIdentities: {
    readonly artifactSha256: string | null;
    readonly configurationSha256: string | null;
  };
  readonly observedIdentities: {
    readonly artifactSha256: string | null;
    readonly configurationSha256: string | null;
  };
  readonly identityVerification: {
    readonly artifact: ConfigurationIdentityVerificationState;
    readonly configuration: ConfigurationIdentityVerificationState;
  };
  readonly qualityGate: {
    readonly state: ConfigurationQualityGateState;
    readonly storedPassed: boolean | null;
    readonly recomputedPassed: boolean | null;
  };
  readonly userSelection: 'enabled' | 'disabled';
  readonly supported: boolean;
  readonly reasons: readonly string[];
  readonly eligibility: ConfigurationModelEligibility;
  readonly active: boolean;
  readonly authority: typeof DETERMINISTIC_AUTHORITY;
}

export interface BuildConfigurationReportInput {
  readonly buildIdentity: Readonly<EvidenceBuildIdentity>;
  readonly currentRun: Readonly<LoadedLabRun> | undefined;
  readonly selectedProfile: Readonly<DetectionProfile>;
  readonly modelEvidence: readonly Readonly<ConfigurationModelEvidenceInput>[];
  readonly streamEvidence: Readonly<LabConfigurationStreamEvidence>;
  readonly generatedAt?: string | undefined;
}

export type ConfigurationRuleParameterName =
  | 'operator'
  | 'threshold'
  | 'minimum'
  | 'maximum'
  | 'maximumAbsoluteRate'
  | 'maximumDecreaseRate'
  | 'maximumDecrease'
  | 'windowMs'
  | 'toleranceMs'
  | 'minimumDurationMs'
  | 'tolerance';

export interface ConfigurationRuleParameter {
  readonly name: ConfigurationRuleParameterName;
  readonly value: string | number;
}

export interface ConfigurationReportRule {
  readonly id: string;
  readonly kind: DetectionRule['kind'];
  readonly label: string;
  readonly description: string;
  readonly severity: DetectionRule['severity'];
  readonly enabled: boolean;
  readonly channel: string;
  readonly condition: string;
  readonly parameters: readonly ConfigurationRuleParameter[];
}

export interface ConfigurationReportProfile {
  readonly id: string;
  readonly version: string;
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly synthetic: true;
  readonly dataClassification: 'SYNTHETIC_UNCLASSIFIED';
  readonly platformCategory: DetectionProfile['platformCategory'];
  readonly contract: {
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
  readonly rules: readonly ConfigurationReportRule[];
}

export interface ConfigurationReportReadyRun {
  readonly state: 'ready';
  readonly identity: {
    readonly runId: string;
    readonly schemaVersion: string;
    readonly adapterId: string;
    readonly adapterVersion: string;
    readonly declaredProfile: { readonly id: string; readonly version: string } | null;
  };
  readonly counts: {
    readonly acceptedRecords: number;
    readonly quarantinedRecords: number;
    readonly validationIssues: number;
    readonly fatalValidationIssues: number;
    readonly findings: number;
  };
  readonly provenance: {
    readonly applicationVersion: string;
    readonly datasetSha256: string;
    readonly generatedAt: string;
    readonly inputBytes: number;
    readonly totalRows: number;
    readonly inputFormat: LoadedLabRun['inputFormat'];
  };
}

export interface ConfigurationReportNoRun {
  readonly state: 'no-run';
  readonly identity: null;
  readonly counts: null;
  readonly provenance: null;
}

export type ConfigurationReportRun = ConfigurationReportReadyRun | ConfigurationReportNoRun;

export interface ConfigurationReportV1 {
  readonly reportSchemaVersion: 'configuration-report.v1';
  readonly generatedAt: string;
  readonly buildIdentities: {
    readonly reactShell: EvidenceBuildIdentity;
    readonly deterministicEngine: {
      readonly applicationVersion: string;
      readonly authority: typeof DETERMINISTIC_AUTHORITY;
    };
  };
  readonly run: ConfigurationReportRun;
  readonly selectedAnalysisProfile: ConfigurationReportProfile;
  readonly models: readonly ConfigurationModelEvidenceInput[];
  readonly simulator: {
    readonly phase: LabConfigurationStreamEvidence['phase'];
    readonly aggregateTotals: {
      readonly sourceCount: number;
      readonly receivedMessages: number;
      readonly droppedMessages: number;
      readonly queueDepth: number;
      readonly reconnectAttempts: number;
      readonly maximumHeartbeatAgeMs: number | null;
    };
    readonly injectedFaultIds: readonly string[];
  };
  readonly exportPolicy: {
    readonly sourceDataIncluded: false;
    readonly streamPayloadsIncluded: false;
    readonly note: string;
  };
}

function ruleCondition(rule: DetectionRule): string {
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

function ruleParameters(rule: DetectionRule): ConfigurationRuleParameter[] {
  switch (rule.kind) {
    case 'threshold':
      return [
        { name: 'operator', value: rule.operator },
        { name: 'threshold', value: rule.threshold },
      ];
    case 'range':
      return [
        { name: 'minimum', value: rule.minimum },
        { name: 'maximum', value: rule.maximum },
      ];
    case 'rate':
      return [{ name: 'maximumAbsoluteRate', value: rule.maximumAbsoluteRate }];
    case 'decrease-rate':
      return [{ name: 'maximumDecreaseRate', value: rule.maximumDecreaseRate }];
    case 'window-decrease':
      return [
        { name: 'maximumDecrease', value: rule.maximumDecrease },
        { name: 'windowMs', value: rule.windowMs },
        { name: 'toleranceMs', value: rule.toleranceMs },
      ];
    case 'frozen':
      return [
        { name: 'minimumDurationMs', value: rule.minimumDurationMs },
        { name: 'tolerance', value: rule.tolerance },
      ];
  }
}

function projectProfile(profile: Readonly<DetectionProfile>): ConfigurationReportProfile {
  return {
    id: profile.id,
    version: profile.version,
    key: `${profile.id}@${profile.version}`,
    label: profile.label,
    description: profile.description,
    synthetic: true,
    dataClassification: profile.dataClassification,
    platformCategory: profile.platformCategory,
    contract: {
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
  };
}

function projectRun(current: Readonly<LoadedLabRun> | undefined): ConfigurationReportRun {
  if (current === undefined) {
    return { state: 'no-run', identity: null, counts: null, provenance: null };
  }
  const run = current.run;
  const declaredProfile =
    run.profileId !== undefined && run.profileVersion !== undefined
      ? { id: run.profileId, version: run.profileVersion }
      : null;
  return {
    state: 'ready',
    identity: {
      runId: run.runId,
      schemaVersion: run.schemaVersion,
      adapterId: run.adapterId,
      adapterVersion: run.adapterVersion,
      declaredProfile,
    },
    counts: {
      acceptedRecords: run.samples.length,
      quarantinedRecords: run.quarantinedRows.length,
      validationIssues: run.validationIssues.length,
      fatalValidationIssues: run.validationIssues.filter((issue) => issue.disposition === 'fatal')
        .length,
      findings: current.analysis.findings.length,
    },
    provenance: {
      applicationVersion: run.provenance.applicationVersion,
      datasetSha256: run.provenance.datasetSha256,
      generatedAt: run.provenance.generatedAt,
      inputBytes: run.provenance.inputBytes,
      totalRows: run.provenance.totalRows,
      inputFormat: current.inputFormat,
    },
  };
}

function projectModel(
  model: Readonly<ConfigurationModelEvidenceInput>,
): ConfigurationModelEvidenceInput {
  return {
    key: model.key,
    family: model.family,
    activationPurpose: model.activationPurpose,
    context: model.context,
    expectedIdentities: {
      artifactSha256: model.expectedIdentities.artifactSha256,
      configurationSha256: model.expectedIdentities.configurationSha256,
    },
    observedIdentities: {
      artifactSha256: model.observedIdentities.artifactSha256,
      configurationSha256: model.observedIdentities.configurationSha256,
    },
    identityVerification: {
      artifact: model.identityVerification.artifact,
      configuration: model.identityVerification.configuration,
    },
    qualityGate: {
      state: model.qualityGate.state,
      storedPassed: model.qualityGate.storedPassed,
      recomputedPassed: model.qualityGate.recomputedPassed,
    },
    userSelection: model.userSelection,
    supported: model.supported,
    reasons: [...model.reasons],
    eligibility: model.eligibility,
    active: model.active,
    authority: DETERMINISTIC_AUTHORITY,
  };
}

export function buildConfigurationReport(
  input: Readonly<BuildConfigurationReportInput>,
): ConfigurationReportV1 {
  return {
    reportSchemaVersion: 'configuration-report.v1',
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    buildIdentities: {
      reactShell: {
        applicationVersion: input.buildIdentity.applicationVersion,
        releaseSha: input.buildIdentity.releaseSha,
        releaseStatus: input.buildIdentity.releaseStatus,
        buildTarget: input.buildIdentity.buildTarget,
      },
      deterministicEngine: {
        applicationVersion: APPLICATION_VERSION,
        authority: DETERMINISTIC_AUTHORITY,
      },
    },
    run: projectRun(input.currentRun),
    selectedAnalysisProfile: projectProfile(input.selectedProfile),
    models: input.modelEvidence.map(projectModel),
    simulator: {
      phase: input.streamEvidence.phase,
      aggregateTotals: {
        sourceCount: input.streamEvidence.sources,
        receivedMessages: input.streamEvidence.receivedMessages,
        droppedMessages: input.streamEvidence.droppedMessages,
        queueDepth: input.streamEvidence.queueDepth,
        reconnectAttempts: input.streamEvidence.reconnectAttempts,
        maximumHeartbeatAgeMs: input.streamEvidence.maximumHeartbeatAgeMs,
      },
      injectedFaultIds: [...input.streamEvidence.injectedFaultIds],
    },
    exportPolicy: {
      sourceDataIncluded: false,
      streamPayloadsIncluded: false,
      note: 'Uploaded source data, stream payloads, per-source state, and browser state are excluded.',
    },
  };
}

export function serializeConfigurationReport(
  input: Readonly<BuildConfigurationReportInput>,
): string {
  return JSON.stringify(buildConfigurationReport(input), null, 2);
}
