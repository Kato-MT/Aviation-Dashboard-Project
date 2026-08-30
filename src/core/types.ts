export const TELEMETRY_SCHEMA_VERSION = 'telemetry.v1' as const;
export const VERIFICATION_SCHEMA_VERSION = 'verification.v2' as const;
export const FINDING_IDENTITY_VERSION = 'finding-fingerprint.v1' as const;

export type TelemetrySchemaVersion = typeof TELEMETRY_SCHEMA_VERSION;

export type Severity = 'info' | 'warning' | 'error' | 'critical';

export type ValidationDisposition = 'recoverable' | 'fatal';

export type ValidationIssueCode =
  | 'EMPTY_INPUT'
  | 'UPLOAD_TOO_LARGE'
  | 'SAMPLE_LIMIT_EXCEEDED'
  | 'MALFORMED_CSV'
  | 'MISSING_HEADER'
  | 'UNSUPPORTED_SCHEMA_VERSION'
  | 'SCHEMA_MISMATCH'
  | 'PROFILE_MISMATCH'
  | 'DUPLICATE_SOURCE'
  | 'MISSING_SOURCE'
  | 'INVALID_TIMESTAMP'
  | 'BLANK_VALUE'
  | 'MISSING_VALUE'
  | 'NONNUMERIC_VALUE'
  | 'NONFINITE_VALUE'
  | 'MISSING_UNIT'
  | 'INVALID_QUALITY_FLAG';

export interface ValidationIssue {
  code: ValidationIssueCode;
  disposition: ValidationDisposition;
  message: string;
  rowNumber?: number | undefined;
  sampleIndex?: number | undefined;
  sourceId?: string | undefined;
  channel?: string | undefined;
  observedValue?: unknown | undefined;
  expectedCondition?: string | undefined;
}

export interface QuarantinedRow {
  rowNumber: number;
  sourceId?: string | undefined;
  issues: ValidationIssue[];
  /** Raw values are retained in memory for diagnosis, but excluded from exports by default. */
  raw: Record<string, unknown>;
}

export type QualityFlag = 'valid' | 'estimated' | 'injected' | 'suspect' | 'stale' | 'quarantined';

export interface TelemetrySample {
  sampleIndex: number;
  rowNumber?: number | undefined;
  sourceId: string;
  sequence?: number | undefined;
  /** ISO-8601 UTC timestamp. */
  timestamp: string;
  /** Milliseconds since the Unix epoch, used for deterministic ordering and rates. */
  timestampMs: number;
  /** Original source timestamp, retained for traceability. */
  originalTimestamp?: string | undefined;
  measurements: Record<string, number>;
  units: Record<string, string>;
  qualityFlags: QualityFlag[];
  channelQualityFlags?: Record<string, QualityFlag[]> | undefined;
}

export interface TelemetrySource {
  sourceId: string;
  label: string;
  adapterId: string;
  units: Record<string, string>;
  metadata?: Record<string, string | number | boolean | null> | undefined;
}

export interface DatasetProvenance {
  applicationVersion: string;
  schemaVersion: TelemetrySchemaVersion;
  adapterId: string;
  adapterVersion: string;
  profileId?: string | undefined;
  profileVersion?: string | undefined;
  datasetSha256: string;
  inputBytes: number;
  totalRows: number;
  acceptedRecords: number;
  quarantinedRecords: number;
  generatedAt: string;
}

export interface TelemetryRun {
  schemaVersion: TelemetrySchemaVersion;
  runId: string;
  createdAt: string;
  adapterId: string;
  adapterVersion: string;
  profileId?: string | undefined;
  profileVersion?: string | undefined;
  sources: TelemetrySource[];
  samples: TelemetrySample[];
  quarantinedRows: QuarantinedRow[];
  validationIssues: ValidationIssue[];
  fatal: boolean;
  provenance: DatasetProvenance;
  metadata: {
    title?: string | undefined;
    description?: string | undefined;
    dataClassification: 'SYNTHETIC_UNCLASSIFIED';
    synthetic: true;
    injectedFault?: InjectedFaultProvenance | undefined;
    [key: string]: unknown;
  };
}

export interface InjectedFaultProvenance {
  scenarioId: string;
  seed: number;
  target: 'canonical' | 'legacy-csv';
  expectedRuleIds: string[];
  synthetic: true;
}

export interface AdapterInputLimits {
  maxBytes: number;
  maxSamples: number;
}

export interface AdapterParseOptions {
  runId?: string | undefined;
  sourceId?: string | undefined;
  createdAt?: string | undefined;
  profileId?: string | undefined;
  profileVersion?: string | undefined;
  /** Maps canonical channel names to source field names. */
  fieldMappings?: Record<string, string> | undefined;
  /** Maps canonical channel names to explicit source units. */
  unitMappings?: Record<string, string> | undefined;
  limits?: Partial<AdapterInputLimits> | undefined;
}

export interface TelemetryAdapter<TInput = unknown> {
  readonly id: string;
  readonly version: string;
  readonly supportedSchemaVersions: readonly string[];
  canHandle(input: TInput): boolean;
  parse(input: TInput, options?: AdapterParseOptions): Promise<TelemetryRun>;
}

export type ComparisonOperator = '>' | '>=' | '<' | '<=';

interface DetectionRuleBase {
  id: string;
  label: string;
  severity: Severity;
  enabled: boolean;
  description: string;
}

export interface ThresholdRule extends DetectionRuleBase {
  kind: 'threshold';
  channel: string;
  operator: ComparisonOperator;
  threshold: number;
}

export interface RangeRule extends DetectionRuleBase {
  kind: 'range';
  channel: string;
  minimum: number;
  maximum: number;
}

export interface RateRule extends DetectionRuleBase {
  kind: 'rate';
  channel: string;
  /** Absolute rate limit, expressed as channel units per second. */
  maximumAbsoluteRate: number;
}

export interface DecreaseRateRule extends DetectionRuleBase {
  kind: 'decrease-rate';
  channel: string;
  /** Maximum permitted decrease, expressed as channel units per second. */
  maximumDecreaseRate: number;
}

export interface WindowDecreaseRule extends DetectionRuleBase {
  kind: 'window-decrease';
  channel: string;
  maximumDecrease: number;
  windowMs: number;
  toleranceMs: number;
}

export interface FrozenSensorRule extends DetectionRuleBase {
  kind: 'frozen';
  channel: string;
  minimumDurationMs: number;
  tolerance: number;
}

export type DetectionRule =
  ThresholdRule | RangeRule | RateRule | DecreaseRateRule | WindowDecreaseRule | FrozenSensorRule;

export interface ChannelDefinition {
  channel: string;
  label: string;
  unit: string;
  required: boolean;
  minimum?: number | undefined;
  maximum?: number | undefined;
}

export interface DetectionProfile {
  id: string;
  version: string;
  label: string;
  description: string;
  synthetic: true;
  dataClassification: 'SYNTHETIC_UNCLASSIFIED';
  platformCategory: 'included-baseline' | 'generic-fixed-wing' | 'generic-rotary-wing';
  channels: Record<string, ChannelDefinition>;
  expectedCadenceMs?: number | undefined;
  cadenceToleranceMs?: number | undefined;
  staleAfterMs?: number | undefined;
  sequencePolicy: 'optional' | 'required';
  rules: DetectionRule[];
}

export interface FindingEvidence {
  message: string;
  sampleIndices?: number[] | undefined;
  rowNumbers?: number[] | undefined;
  elapsedMs?: number | undefined;
  previousValue?: number | undefined;
  currentValue?: number | undefined;
  calculatedRate?: number | undefined;
  [key: string]: unknown;
}

export interface Finding {
  findingId: string;
  fingerprint: string;
  ruleId: string;
  ruleLabel: string;
  severity: Severity;
  sourceId: string;
  timestamp?: string | undefined;
  timestampMs?: number | undefined;
  sampleIndex?: number | undefined;
  rowNumber?: number | undefined;
  channel?: string | undefined;
  observedValue: unknown;
  expectedCondition: string;
  evidence: FindingEvidence;
  origin: 'adapter' | 'rule-engine';
}

export interface AnalysisResult {
  runId: string;
  profileId: string;
  profileVersion: string;
  blocked: boolean;
  findings: Finding[];
  findingCounts: Record<Severity, number>;
  analyzedRecords: number;
  generatedAt: string;
}

export interface FindingClassification {
  fingerprint: string;
  baseline?: Finding | undefined;
  candidate?: Finding | undefined;
}

export interface ResolvedFindingClassification extends FindingClassification {
  baseline: Finding;
  candidate?: never;
}

export interface PersistingFindingClassification extends FindingClassification {
  baseline: Finding;
  candidate: Finding;
}

export interface NewlyIntroducedFindingClassification extends FindingClassification {
  baseline?: never;
  candidate: Finding;
}

export interface VerificationRunSummary {
  runId: string;
  datasetSha256: string;
  schemaVersion: TelemetrySchemaVersion;
  adapterId: string;
  adapterVersion: string;
  profileId: string;
  profileVersion: string;
  acceptedRecords: number;
  quarantinedRecords: number;
  validationIssueCount: number;
  fatalValidationIssueCount: number;
  fatal: boolean;
  analysisBlocked: boolean;
  findingCount: number;
}

export type VerificationRequirementId =
  | 'FDW-VER-001'
  | 'FDW-VER-002'
  | 'FDW-VER-003'
  | 'FDW-VER-004'
  | 'FDW-VER-005'
  | 'FDW-VER-006'
  | 'FDW-VER-007'
  | 'FDW-VER-008';

export interface VerificationRequirementResult {
  requirementId: VerificationRequirementId;
  status: 'pass' | 'fail' | 'blocked' | 'not-run';
  testIds: string[];
  evidence: string;
}

export interface VerificationRun {
  schemaVersion: typeof VERIFICATION_SCHEMA_VERSION;
  verificationId: string;
  createdAt: string;
  baseline: VerificationRunSummary;
  candidate: VerificationRunSummary;
  resolved: ResolvedFindingClassification[];
  persisting: PersistingFindingClassification[];
  newlyIntroduced: NewlyIntroducedFindingClassification[];
  status: 'pass' | 'fail' | 'blocked';
  summary: {
    resolved: number;
    persisting: number;
    newlyIntroduced: number;
  };
  requirementResults: VerificationRequirementResult[];
  provenance: {
    applicationVersion: string;
    findingIdentityVersion: typeof FINDING_IDENTITY_VERSION;
    profileId: string;
    profileVersion: string;
    baselineAdapterId: string;
    baselineAdapterVersion: string;
    baselineSchemaVersion: TelemetrySchemaVersion;
    candidateAdapterId: string;
    candidateAdapterVersion: string;
    candidateSchemaVersion: TelemetrySchemaVersion;
  };
}
