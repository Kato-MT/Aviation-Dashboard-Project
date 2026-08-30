import { createHash, randomBytes } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, rm, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';

import {
  RUNTIME_POLICY_MOCK_PROVIDER_ORIGIN,
  RUNTIME_POLICY_SCHEMA_VERSION,
  compileRuntimePolicy,
  runtimePolicyCanonicalJson,
  type RuntimePolicyReleaseIdentity,
} from '../../src/live/runtimePolicy';
import {
  RUNTIME_POLICY_LIMITS_SCHEMA_VERSION,
  type RuntimePolicyLimits,
} from '../../src/live/runtimePolicyLimits';
import { loadApprovedRollback } from './approvedRollback';
import {
  OPERATOR_PROCEDURE_DEFINITIONS,
  OPERATOR_RUNBOOK_MANIFEST_FILE,
  OPERATOR_RUNBOOK_MANIFEST_SCHEMA_VERSION,
  parseCanonicalRunbookJson,
  verifyRunbookBundle,
  type OperatorProcedure,
  type OperatorProcedureFileIdentity,
  type OperatorProcedureId,
  type OperatorReceiptResult,
  type VerifiedRunbookBundle,
} from './verifyRunbooks';

export const RUNBOOK_REHEARSAL_REQUEST_SCHEMA_VERSION = 'runbook-rehearsal-request.v1' as const;
export const RUNBOOK_REHEARSAL_RECEIPT_SCHEMA_VERSION = 'runbook-rehearsal-receipt.v1' as const;
export const RUNBOOK_REHEARSAL_BINDINGS_SCHEMA_VERSION = 'runbook-rehearsal-bindings.v1' as const;
export const RUNBOOK_REHEARSAL_EVIDENCE_CLASS = 'synthetic-local-runbook-rehearsal' as const;
export const RUNBOOK_REHEARSAL_PRIVACY =
  'aggregate-only-no-aircraft-request-client-or-event-data' as const;
export const MAX_RUNBOOK_REHEARSAL_REQUEST_BYTES = 64 * 1024;
export const MAX_RUNBOOK_REHEARSAL_RECEIPT_BYTES = 256 * 1024;

export type RunbookRehearsalFinalResult = OperatorReceiptResult;

export interface SyntheticRunbookSourceIdentityV1 {
  readonly schemaVersion: 'synthetic-source-build-identity.v1';
  readonly head: string;
  readonly contentSha256: string;
}

export interface SyntheticRunbookArtifactIdentityV1 {
  readonly schemaVersion: 'synthetic-artifact-identity.v1';
  readonly kind: 'synthetic-source-built-artifact';
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly sha256: string;
}

export interface RunbookRehearsalIdentityInputV1 {
  readonly source: Readonly<SyntheticRunbookSourceIdentityV1>;
  readonly release: Readonly<RuntimePolicyReleaseIdentity>;
  readonly syntheticArtifact: Readonly<SyntheticRunbookArtifactIdentityV1>;
}

export interface RunbookRehearsalProcedureSelectionV1 {
  readonly procedureId: OperatorProcedureId;
  readonly result: OperatorReceiptResult;
}

export interface RunbookRehearsalRequestV1 extends RunbookRehearsalIdentityInputV1 {
  readonly schemaVersion: typeof RUNBOOK_REHEARSAL_REQUEST_SCHEMA_VERSION;
  readonly evidenceClass: typeof RUNBOOK_REHEARSAL_EVIDENCE_CLASS;
  readonly checkedAt: string;
  readonly outcomes: readonly RunbookRehearsalProcedureSelectionV1[];
}

export interface RunbookRehearsalBindingsV1 {
  readonly schemaVersion: typeof RUNBOOK_REHEARSAL_BINDINGS_SCHEMA_VERSION;
  readonly runbooks: {
    readonly schemaVersion: typeof OPERATOR_RUNBOOK_MANIFEST_SCHEMA_VERSION;
    readonly path: typeof OPERATOR_RUNBOOK_MANIFEST_FILE;
    readonly bytes: number;
    readonly sha256: string;
    readonly procedureCount: number;
  };
  readonly compiledPolicy: {
    readonly schemaVersion: typeof RUNTIME_POLICY_SCHEMA_VERSION;
    readonly policyId: string;
    readonly policyEpoch: string;
    readonly canonicalSha256: string;
    readonly sourceDescriptorSha256: string;
    readonly limitsSchemaVersion: typeof RUNTIME_POLICY_LIMITS_SCHEMA_VERSION;
    readonly limitsSha256: string;
    readonly limits: RuntimePolicyLimits;
  };
  readonly source: Readonly<SyntheticRunbookSourceIdentityV1>;
  readonly release: Readonly<RuntimePolicyReleaseIdentity>;
  readonly syntheticArtifact: Readonly<SyntheticRunbookArtifactIdentityV1>;
  readonly approvedRollback: {
    readonly schemaVersion: 'fdw-approved-rollback.v1';
    readonly releaseTag: 'v2.2.0';
    readonly sourceRevision: string;
    readonly manifest: {
      readonly bytes: number;
      readonly sha256: string;
    };
    readonly archive: {
      readonly bytes: number;
      readonly sha256: string;
    };
  };
}

export interface RunbookRehearsalExpectedBindingsV1 {
  readonly bindings: Readonly<RunbookRehearsalBindingsV1>;
  readonly finalResult: RunbookRehearsalFinalResult;
}

export interface RunbookRehearsalProcedureOutcomeV1 {
  readonly procedureId: OperatorProcedureId;
  readonly procedureSha256: string;
  readonly runtimePolicyReasonCodes: readonly string[];
  readonly operationsReasonCodes: readonly string[];
  readonly entryEvidenceIds: readonly string[];
  readonly rehearsedActionIds: readonly string[];
  readonly rehearsedRollbackActionIds: readonly string[];
  readonly stopConditionIds: readonly string[];
  readonly result: OperatorReceiptResult;
}

export interface RunbookRehearsalReceiptV1 {
  readonly schemaVersion: typeof RUNBOOK_REHEARSAL_RECEIPT_SCHEMA_VERSION;
  readonly evidenceClass: typeof RUNBOOK_REHEARSAL_EVIDENCE_CLASS;
  readonly privacy: typeof RUNBOOK_REHEARSAL_PRIVACY;
  readonly checkedAt: string;
  readonly bindings: Readonly<RunbookRehearsalBindingsV1>;
  readonly procedureOutcomes: readonly RunbookRehearsalProcedureOutcomeV1[];
  readonly summary: {
    readonly procedureCount: number;
    readonly verifiedCount: number;
    readonly stoppedCount: number;
    readonly rolledBackCount: number;
    readonly recoveredCount: number;
    readonly finalResult: RunbookRehearsalFinalResult;
  };
  readonly executionBoundary: {
    readonly syntheticOnly: true;
    readonly localOnly: true;
    readonly networkRequests: 0;
    readonly providerActions: 0;
    readonly cloudActions: 0;
    readonly deploymentActions: 0;
    readonly runtimeMutations: 0;
    readonly productionActions: 0;
  };
}

export interface RunbookRehearsalEnvironmentOptions {
  readonly repositoryRoot?: string;
  readonly procedureDirectory?: string;
}

export interface RunbookRehearsalOptions extends RunbookRehearsalEnvironmentOptions {
  readonly request: unknown;
  readonly outputPath: string;
}

export type RunbookRehearsalErrorCode =
  | 'INVALID_REQUEST'
  | 'INVALID_RECEIPT'
  | 'NONCANONICAL_RECEIPT'
  | 'BINDING_MISMATCH'
  | 'PROCEDURE_MISMATCH'
  | 'INVALID_OUTPUT';

export class RunbookRehearsalError extends Error {
  readonly code: RunbookRehearsalErrorCode;

  constructor(code: RunbookRehearsalErrorCode, message: string) {
    super(message);
    this.name = 'RunbookRehearsalError';
    this.code = code;
  }
}

type JsonRecord = Record<string, unknown>;

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SOURCE_HEAD_PATTERN = /^[a-f0-9]{40}$/u;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/u;
const UTF8 = new TextDecoder('utf-8', { fatal: true });
const MODULE_REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SYNTHETIC_POLICY_ORIGIN = 'http://127.0.0.1:4173';
const SYNTHETIC_POLICY_EPOCH = 'r3-runbook-rehearsal-1';
const RESULT_VALUES = new Set<OperatorReceiptResult>([
  'verified',
  'stopped',
  'rolled-back',
  'recovered',
]);
const RECEIPT_KEYS = Object.freeze([
  'schemaVersion',
  'evidenceClass',
  'privacy',
  'checkedAt',
  'bindings',
  'procedureOutcomes',
  'summary',
  'executionBoundary',
] as const);
const REQUEST_KEYS = Object.freeze([
  'schemaVersion',
  'evidenceClass',
  'checkedAt',
  'source',
  'release',
  'syntheticArtifact',
  'outcomes',
] as const);
const SOURCE_KEYS = Object.freeze(['schemaVersion', 'head', 'contentSha256'] as const);
const ARTIFACT_KEYS = Object.freeze([
  'schemaVersion',
  'kind',
  'fileCount',
  'totalBytes',
  'sha256',
] as const);
const RELEASE_KEYS = Object.freeze([
  'applicationVersion',
  'releaseSha',
  'releaseStatus',
  'buildTarget',
] as const);
const SELECTION_KEYS = Object.freeze(['procedureId', 'result'] as const);
const EXPECTED_KEYS = Object.freeze(['bindings', 'finalResult'] as const);
const BINDING_KEYS = Object.freeze([
  'schemaVersion',
  'runbooks',
  'compiledPolicy',
  'source',
  'release',
  'syntheticArtifact',
  'approvedRollback',
] as const);
const RUNBOOK_BINDING_KEYS = Object.freeze([
  'schemaVersion',
  'path',
  'bytes',
  'sha256',
  'procedureCount',
] as const);
const POLICY_BINDING_KEYS = Object.freeze([
  'schemaVersion',
  'policyId',
  'policyEpoch',
  'canonicalSha256',
  'sourceDescriptorSha256',
  'limitsSchemaVersion',
  'limitsSha256',
  'limits',
] as const);
const ROLLBACK_BINDING_KEYS = Object.freeze([
  'schemaVersion',
  'releaseTag',
  'sourceRevision',
  'manifest',
  'archive',
] as const);
const FILE_IDENTITY_KEYS = Object.freeze(['bytes', 'sha256'] as const);
const OUTCOME_KEYS = Object.freeze([
  'procedureId',
  'procedureSha256',
  'runtimePolicyReasonCodes',
  'operationsReasonCodes',
  'entryEvidenceIds',
  'rehearsedActionIds',
  'rehearsedRollbackActionIds',
  'stopConditionIds',
  'result',
] as const);
const SUMMARY_KEYS = Object.freeze([
  'procedureCount',
  'verifiedCount',
  'stoppedCount',
  'rolledBackCount',
  'recoveredCount',
  'finalResult',
] as const);
const EXECUTION_BOUNDARY_KEYS = Object.freeze([
  'syntheticOnly',
  'localOnly',
  'networkRequests',
  'providerActions',
  'cloudActions',
  'deploymentActions',
  'runtimeMutations',
  'productionActions',
] as const);

function fail(code: RunbookRehearsalErrorCode, message: string): never {
  throw new RunbookRehearsalError(code, message);
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
  code: RunbookRehearsalErrorCode,
): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail(code, `${label} must be an object.`);
  }
  const record = value as JsonRecord;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    return fail(code, `${label} contains missing or unknown fields.`);
  }
  return record;
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalJsonValue(entry)]),
    );
  }
  return value;
}

export function canonicalRunbookRehearsalJson(value: unknown): string {
  return `${JSON.stringify(canonicalJsonValue(value), null, 2)}\n`;
}

function positiveInteger(value: unknown, label: string, code: RunbookRehearsalErrorCode): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    return fail(code, `${label} must be a positive safe integer.`);
  }
  return value;
}

function shaIdentity(value: unknown, label: string, code: RunbookRehearsalErrorCode): string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    return fail(code, `${label} must be a lowercase SHA-256.`);
  }
  return value;
}

function isoTimestamp(value: unknown, label: string, code: RunbookRehearsalErrorCode): string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    new Date(value).toISOString() !== value
  ) {
    return fail(code, `${label} must be one canonical UTC timestamp.`);
  }
  return value;
}

function resultValue(
  value: unknown,
  label: string,
  code: RunbookRehearsalErrorCode,
): OperatorReceiptResult {
  if (typeof value !== 'string' || !RESULT_VALUES.has(value as OperatorReceiptResult)) {
    return fail(code, `${label} is not an approved rehearsal result.`);
  }
  return value as OperatorReceiptResult;
}

function parseSourceIdentity(
  value: unknown,
  code: RunbookRehearsalErrorCode,
): Readonly<SyntheticRunbookSourceIdentityV1> {
  const source = exactRecord(value, SOURCE_KEYS, 'Synthetic source identity', code);
  if (
    source.schemaVersion !== 'synthetic-source-build-identity.v1' ||
    typeof source.head !== 'string' ||
    !SOURCE_HEAD_PATTERN.test(source.head)
  ) {
    return fail(code, 'Synthetic source identity is outside the closed schema.');
  }
  return Object.freeze({
    schemaVersion: 'synthetic-source-build-identity.v1',
    head: source.head,
    contentSha256: shaIdentity(source.contentSha256, 'Synthetic source content', code),
  });
}

function parseArtifactIdentity(
  value: unknown,
  code: RunbookRehearsalErrorCode,
): Readonly<SyntheticRunbookArtifactIdentityV1> {
  const artifact = exactRecord(value, ARTIFACT_KEYS, 'Synthetic artifact identity', code);
  if (
    artifact.schemaVersion !== 'synthetic-artifact-identity.v1' ||
    artifact.kind !== 'synthetic-source-built-artifact'
  ) {
    return fail(code, 'Synthetic artifact identity is outside the closed schema.');
  }
  return Object.freeze({
    schemaVersion: 'synthetic-artifact-identity.v1',
    kind: 'synthetic-source-built-artifact',
    fileCount: positiveInteger(artifact.fileCount, 'Synthetic artifact fileCount', code),
    totalBytes: positiveInteger(artifact.totalBytes, 'Synthetic artifact totalBytes', code),
    sha256: shaIdentity(artifact.sha256, 'Synthetic artifact', code),
  });
}

function parseReleaseIdentity(
  value: unknown,
  code: RunbookRehearsalErrorCode,
): Readonly<RuntimePolicyReleaseIdentity> {
  const release = exactRecord(value, RELEASE_KEYS, 'Synthetic release identity', code);
  if (
    typeof release.applicationVersion !== 'string' ||
    !VERSION_PATTERN.test(release.applicationVersion) ||
    typeof release.releaseSha !== 'string' ||
    !SOURCE_HEAD_PATTERN.test(release.releaseSha) ||
    (release.releaseStatus !== 'unreleased' && release.releaseStatus !== 'exact-release') ||
    release.buildTarget !== 'mock-staging'
  ) {
    return fail(code, 'Synthetic release identity is invalid or is not mock-staging.');
  }
  return Object.freeze({
    applicationVersion: release.applicationVersion,
    releaseSha: release.releaseSha,
    releaseStatus: release.releaseStatus,
    buildTarget: 'mock-staging',
  });
}

function parseProcedureSelections(
  value: unknown,
  code: RunbookRehearsalErrorCode,
): readonly RunbookRehearsalProcedureSelectionV1[] {
  if (!Array.isArray(value) || value.length !== OPERATOR_PROCEDURE_DEFINITIONS.length) {
    return fail(code, 'Synthetic rehearsal must select every closed procedure exactly once.');
  }
  const selections = value.map((candidate, index) => {
    const selection = exactRecord(candidate, SELECTION_KEYS, `Outcome selection ${index}`, code);
    const definition = OPERATOR_PROCEDURE_DEFINITIONS[index];
    if (definition === undefined || selection.procedureId !== definition.procedureId) {
      return fail(code, `Outcome selection ${index} does not match the closed procedure order.`);
    }
    const result = resultValue(selection.result, `Outcome selection ${index}.result`, code);
    if (result === 'rolled-back' && definition.procedureId !== 'rollback') {
      return fail(code, 'Only the rollback procedure may have a rolled-back result.');
    }
    if (result === 'recovered' && definition.procedureId !== 'recovery') {
      return fail(code, 'Only the recovery procedure may have a recovered result.');
    }
    return Object.freeze({ procedureId: definition.procedureId, result });
  });
  const nonVerified = selections.filter(({ result }) => result !== 'verified');
  if (nonVerified.length > 1) {
    return fail(code, 'One synthetic rehearsal receipt may contain at most one branch result.');
  }
  return Object.freeze(selections);
}

function parseRequest(value: unknown): Readonly<RunbookRehearsalRequestV1> {
  const request = exactRecord(value, REQUEST_KEYS, 'Runbook rehearsal request', 'INVALID_REQUEST');
  if (
    request.schemaVersion !== RUNBOOK_REHEARSAL_REQUEST_SCHEMA_VERSION ||
    request.evidenceClass !== RUNBOOK_REHEARSAL_EVIDENCE_CLASS
  ) {
    return fail('INVALID_REQUEST', 'Runbook rehearsal request is not synthetic rehearsal v1.');
  }
  return Object.freeze({
    schemaVersion: RUNBOOK_REHEARSAL_REQUEST_SCHEMA_VERSION,
    evidenceClass: RUNBOOK_REHEARSAL_EVIDENCE_CLASS,
    checkedAt: isoTimestamp(request.checkedAt, 'Runbook rehearsal checkedAt', 'INVALID_REQUEST'),
    source: parseSourceIdentity(request.source, 'INVALID_REQUEST'),
    release: parseReleaseIdentity(request.release, 'INVALID_REQUEST'),
    syntheticArtifact: parseArtifactIdentity(request.syntheticArtifact, 'INVALID_REQUEST'),
    outcomes: parseProcedureSelections(request.outcomes, 'INVALID_REQUEST'),
  });
}

function finalResult(
  selections: readonly RunbookRehearsalProcedureSelectionV1[],
): RunbookRehearsalFinalResult {
  return selections.find(({ result }) => result !== 'verified')?.result ?? 'verified';
}

function resolvedPaths(options: Readonly<RunbookRehearsalEnvironmentOptions>): Readonly<{
  repositoryRoot: string;
  procedureDirectory: string;
}> {
  const repositoryRoot = resolve(options.repositoryRoot ?? MODULE_REPOSITORY_ROOT);
  return Object.freeze({
    repositoryRoot,
    procedureDirectory: resolve(
      options.procedureDirectory ?? join(repositoryRoot, 'docs', 'operations'),
    ),
  });
}

async function compileBindingsWithBundle(
  input: Readonly<RunbookRehearsalIdentityInputV1>,
  options: Readonly<RunbookRehearsalEnvironmentOptions>,
): Promise<Readonly<{ bindings: RunbookRehearsalBindingsV1; bundle: VerifiedRunbookBundle }>> {
  const source = parseSourceIdentity(input.source, 'BINDING_MISMATCH');
  const release = parseReleaseIdentity(input.release, 'BINDING_MISMATCH');
  const syntheticArtifact = parseArtifactIdentity(input.syntheticArtifact, 'BINDING_MISMATCH');
  if (source.head !== release.releaseSha) {
    return fail('BINDING_MISMATCH', 'Synthetic source and release revisions do not match.');
  }
  const paths = resolvedPaths(options);
  const [bundle, rollback, policy] = await Promise.all([
    verifyRunbookBundle(paths.procedureDirectory),
    loadApprovedRollback(paths.repositoryRoot),
    compileRuntimePolicy({
      target: 'mock-staging',
      providerMode: 'mock',
      providerBaseUrl: RUNTIME_POLICY_MOCK_PROVIDER_ORIGIN,
      mockBindingPresent: true,
      allowedOrigins: [SYNTHETIC_POLICY_ORIGIN],
      deploymentClass: 'loopback',
      release,
      policyEpoch: SYNTHETIC_POLICY_EPOCH,
      providerGate: { status: 'closed', reason: 'source-disabled' },
    }),
  ]);
  const policyCanonical = runtimePolicyCanonicalJson(policy);
  const sourceDescriptorCanonical = runtimePolicyCanonicalJson(policy.source.descriptor);
  const limitsCanonical = runtimePolicyCanonicalJson(policy.limits);
  const bindings: RunbookRehearsalBindingsV1 = {
    schemaVersion: RUNBOOK_REHEARSAL_BINDINGS_SCHEMA_VERSION,
    runbooks: {
      schemaVersion: OPERATOR_RUNBOOK_MANIFEST_SCHEMA_VERSION,
      path: OPERATOR_RUNBOOK_MANIFEST_FILE,
      bytes: bundle.manifestIdentity.bytes,
      sha256: bundle.manifestIdentity.sha256,
      procedureCount: bundle.procedures.length,
    },
    compiledPolicy: {
      schemaVersion: RUNTIME_POLICY_SCHEMA_VERSION,
      policyId: policy.policyId,
      policyEpoch: policy.policyEpoch,
      canonicalSha256: sha256(policyCanonical),
      sourceDescriptorSha256: sha256(sourceDescriptorCanonical),
      limitsSchemaVersion: RUNTIME_POLICY_LIMITS_SCHEMA_VERSION,
      limitsSha256: sha256(limitsCanonical),
      limits: policy.limits,
    },
    source,
    release: policy.release,
    syntheticArtifact,
    approvedRollback: {
      schemaVersion: rollback.provenance.schemaVersion,
      releaseTag: rollback.provenance.releaseTag,
      sourceRevision: rollback.provenance.sourceRevision,
      manifest: {
        bytes: rollback.provenance.manifest.bytes,
        sha256: rollback.provenance.manifest.sha256,
      },
      archive: {
        bytes: rollback.provenance.archive.bytes,
        sha256: rollback.provenance.archive.sha256,
      },
    },
  };
  return Object.freeze({
    bindings: Object.freeze(bindings),
    bundle,
  });
}

/** Resolves current closed runbook, runtime-policy, and rollback commitments without rehearsing. */
export async function compileRunbookRehearsalBindings(
  input: Readonly<RunbookRehearsalIdentityInputV1>,
  options: Readonly<RunbookRehearsalEnvironmentOptions> = {},
): Promise<Readonly<RunbookRehearsalBindingsV1>> {
  return (await compileBindingsWithBundle(input, options)).bindings;
}

function buildProcedureOutcome(
  procedure: Readonly<OperatorProcedure>,
  identity: Readonly<OperatorProcedureFileIdentity>,
  result: OperatorReceiptResult,
): Readonly<RunbookRehearsalProcedureOutcomeV1> {
  const readyStopIds = procedure.stopConditions
    .filter(({ outcome }) => outcome === 'ready-for-receipt')
    .map(({ conditionId }) => conditionId);
  const haltStopId = procedure.stopConditions.find(
    ({ outcome }) => outcome === 'halt',
  )?.conditionId;
  if (readyStopIds.length === 0 || haltStopId === undefined) {
    return fail('PROCEDURE_MISMATCH', `${procedure.procedureId} lacks a closed rehearsal branch.`);
  }
  const completed =
    result === 'stopped' ? procedure.boundedActions.slice(0, 1) : procedure.boundedActions;
  return Object.freeze({
    procedureId: procedure.procedureId,
    procedureSha256: identity.sha256,
    runtimePolicyReasonCodes: Object.freeze([...procedure.reasonVocabulary.runtimePolicy]),
    operationsReasonCodes: Object.freeze([...procedure.reasonVocabulary.operations]),
    entryEvidenceIds: Object.freeze(procedure.entryEvidence.map(({ evidenceId }) => evidenceId)),
    rehearsedActionIds: Object.freeze(completed.map(({ actionId }) => actionId)),
    rehearsedRollbackActionIds: Object.freeze(
      result === 'rolled-back' ? procedure.rollbackActions.map(({ actionId }) => actionId) : [],
    ),
    stopConditionIds: Object.freeze(
      result === 'verified' || result === 'recovered' ? readyStopIds : [haltStopId],
    ),
    result,
  });
}

function buildSummary(
  outcomes: readonly RunbookRehearsalProcedureOutcomeV1[],
): RunbookRehearsalReceiptV1['summary'] {
  const count = (result: OperatorReceiptResult): number =>
    outcomes.filter((outcome) => outcome.result === result).length;
  const result = outcomes.find((outcome) => outcome.result !== 'verified')?.result ?? 'verified';
  return Object.freeze({
    procedureCount: outcomes.length,
    verifiedCount: count('verified'),
    stoppedCount: count('stopped'),
    rolledBackCount: count('rolled-back'),
    recoveredCount: count('recovered'),
    finalResult: result,
  });
}

function buildReceipt(
  request: Readonly<RunbookRehearsalRequestV1>,
  bindings: Readonly<RunbookRehearsalBindingsV1>,
  bundle: Readonly<VerifiedRunbookBundle>,
): Readonly<RunbookRehearsalReceiptV1> {
  const outcomes = request.outcomes.map((selection, index) => {
    const procedure = bundle.procedures[index];
    const identity = bundle.procedureIdentities[index];
    if (
      procedure === undefined ||
      identity === undefined ||
      procedure.procedureId !== selection.procedureId ||
      identity.procedureId !== selection.procedureId
    ) {
      return fail('PROCEDURE_MISMATCH', 'Closed runbook order changed during rehearsal.');
    }
    return buildProcedureOutcome(procedure, identity, selection.result);
  });
  return Object.freeze({
    schemaVersion: RUNBOOK_REHEARSAL_RECEIPT_SCHEMA_VERSION,
    evidenceClass: RUNBOOK_REHEARSAL_EVIDENCE_CLASS,
    privacy: RUNBOOK_REHEARSAL_PRIVACY,
    checkedAt: request.checkedAt,
    bindings,
    procedureOutcomes: Object.freeze(outcomes),
    summary: buildSummary(outcomes),
    executionBoundary: Object.freeze({
      syntheticOnly: true,
      localOnly: true,
      networkRequests: 0,
      providerActions: 0,
      cloudActions: 0,
      deploymentActions: 0,
      runtimeMutations: 0,
      productionActions: 0,
    }),
  });
}

function parseStringArray(value: unknown, label: string): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== 'string' || entry.length === 0 || entry.length > 128)
  ) {
    return fail('INVALID_RECEIPT', `${label} must be a bounded string array.`);
  }
  return Object.freeze([...value] as string[]);
}

function parseReceiptOutcome(value: unknown, index: number): RunbookRehearsalProcedureOutcomeV1 {
  const outcome = exactRecord(
    value,
    OUTCOME_KEYS,
    `Receipt procedure outcome ${index}`,
    'INVALID_RECEIPT',
  );
  const definition = OPERATOR_PROCEDURE_DEFINITIONS[index];
  if (definition === undefined || outcome.procedureId !== definition.procedureId) {
    return fail('INVALID_RECEIPT', `Receipt procedure outcome ${index} is out of order.`);
  }
  return Object.freeze({
    procedureId: definition.procedureId,
    procedureSha256: shaIdentity(
      outcome.procedureSha256,
      `Receipt procedure outcome ${index}.procedureSha256`,
      'INVALID_RECEIPT',
    ),
    runtimePolicyReasonCodes: parseStringArray(
      outcome.runtimePolicyReasonCodes,
      `Receipt procedure outcome ${index}.runtimePolicyReasonCodes`,
    ),
    operationsReasonCodes: parseStringArray(
      outcome.operationsReasonCodes,
      `Receipt procedure outcome ${index}.operationsReasonCodes`,
    ),
    entryEvidenceIds: parseStringArray(
      outcome.entryEvidenceIds,
      `Receipt procedure outcome ${index}.entryEvidenceIds`,
    ),
    rehearsedActionIds: parseStringArray(
      outcome.rehearsedActionIds,
      `Receipt procedure outcome ${index}.rehearsedActionIds`,
    ),
    rehearsedRollbackActionIds: parseStringArray(
      outcome.rehearsedRollbackActionIds,
      `Receipt procedure outcome ${index}.rehearsedRollbackActionIds`,
    ),
    stopConditionIds: parseStringArray(
      outcome.stopConditionIds,
      `Receipt procedure outcome ${index}.stopConditionIds`,
    ),
    result: resultValue(
      outcome.result,
      `Receipt procedure outcome ${index}.result`,
      'INVALID_RECEIPT',
    ),
  });
}

function parseReceipt(value: unknown): Readonly<RunbookRehearsalReceiptV1> {
  const receipt = exactRecord(value, RECEIPT_KEYS, 'Runbook rehearsal receipt', 'INVALID_RECEIPT');
  if (
    receipt.schemaVersion !== RUNBOOK_REHEARSAL_RECEIPT_SCHEMA_VERSION ||
    receipt.evidenceClass !== RUNBOOK_REHEARSAL_EVIDENCE_CLASS ||
    receipt.privacy !== RUNBOOK_REHEARSAL_PRIVACY ||
    !Array.isArray(receipt.procedureOutcomes) ||
    receipt.procedureOutcomes.length !== OPERATOR_PROCEDURE_DEFINITIONS.length
  ) {
    return fail('INVALID_RECEIPT', 'Runbook rehearsal receipt is outside the closed schema.');
  }
  const outcomes = receipt.procedureOutcomes.map(parseReceiptOutcome);
  const summary = exactRecord(receipt.summary, SUMMARY_KEYS, 'Receipt summary', 'INVALID_RECEIPT');
  const boundary = exactRecord(
    receipt.executionBoundary,
    EXECUTION_BOUNDARY_KEYS,
    'Receipt execution boundary',
    'INVALID_RECEIPT',
  );
  const parsed: RunbookRehearsalReceiptV1 = {
    schemaVersion: RUNBOOK_REHEARSAL_RECEIPT_SCHEMA_VERSION,
    evidenceClass: RUNBOOK_REHEARSAL_EVIDENCE_CLASS,
    privacy: RUNBOOK_REHEARSAL_PRIVACY,
    checkedAt: isoTimestamp(receipt.checkedAt, 'Receipt checkedAt', 'INVALID_RECEIPT'),
    bindings: receipt.bindings as RunbookRehearsalBindingsV1,
    procedureOutcomes: Object.freeze(outcomes),
    summary: {
      procedureCount: positiveInteger(
        summary.procedureCount,
        'Receipt summary.procedureCount',
        'INVALID_RECEIPT',
      ),
      verifiedCount: Number(summary.verifiedCount),
      stoppedCount: Number(summary.stoppedCount),
      rolledBackCount: Number(summary.rolledBackCount),
      recoveredCount: Number(summary.recoveredCount),
      finalResult: resultValue(
        summary.finalResult,
        'Receipt summary.finalResult',
        'INVALID_RECEIPT',
      ),
    },
    executionBoundary: {
      syntheticOnly: boundary.syntheticOnly as true,
      localOnly: boundary.localOnly as true,
      networkRequests: boundary.networkRequests as 0,
      providerActions: boundary.providerActions as 0,
      cloudActions: boundary.cloudActions as 0,
      deploymentActions: boundary.deploymentActions as 0,
      runtimeMutations: boundary.runtimeMutations as 0,
      productionActions: boundary.productionActions as 0,
    },
  };
  if (
    ![
      summary.verifiedCount,
      summary.stoppedCount,
      summary.rolledBackCount,
      summary.recoveredCount,
    ].every((count) => typeof count === 'number' && Number.isSafeInteger(count) && count >= 0) ||
    boundary.syntheticOnly !== true ||
    boundary.localOnly !== true ||
    boundary.networkRequests !== 0 ||
    boundary.providerActions !== 0 ||
    boundary.cloudActions !== 0 ||
    boundary.deploymentActions !== 0 ||
    boundary.runtimeMutations !== 0 ||
    boundary.productionActions !== 0
  ) {
    return fail('INVALID_RECEIPT', 'Receipt aggregate counts or execution boundary are invalid.');
  }
  return Object.freeze(parsed);
}

function parseExpectedBindings(value: unknown): Readonly<RunbookRehearsalExpectedBindingsV1> {
  const expected = exactRecord(
    value,
    EXPECTED_KEYS,
    'Expected rehearsal bindings',
    'BINDING_MISMATCH',
  );
  const bindings = exactRecord(
    expected.bindings,
    BINDING_KEYS,
    'Expected rehearsal binding object',
    'BINDING_MISMATCH',
  );
  exactRecord(
    bindings.runbooks,
    RUNBOOK_BINDING_KEYS,
    'Expected runbook binding',
    'BINDING_MISMATCH',
  );
  exactRecord(
    bindings.compiledPolicy,
    POLICY_BINDING_KEYS,
    'Expected compiled policy binding',
    'BINDING_MISMATCH',
  );
  exactRecord(bindings.source, SOURCE_KEYS, 'Expected source binding', 'BINDING_MISMATCH');
  exactRecord(bindings.release, RELEASE_KEYS, 'Expected release binding', 'BINDING_MISMATCH');
  exactRecord(
    bindings.syntheticArtifact,
    ARTIFACT_KEYS,
    'Expected artifact binding',
    'BINDING_MISMATCH',
  );
  const rollback = exactRecord(
    bindings.approvedRollback,
    ROLLBACK_BINDING_KEYS,
    'Expected rollback binding',
    'BINDING_MISMATCH',
  );
  exactRecord(
    rollback.manifest,
    FILE_IDENTITY_KEYS,
    'Expected rollback manifest',
    'BINDING_MISMATCH',
  );
  exactRecord(
    rollback.archive,
    FILE_IDENTITY_KEYS,
    'Expected rollback archive',
    'BINDING_MISMATCH',
  );
  return Object.freeze({
    bindings: expected.bindings as RunbookRehearsalBindingsV1,
    finalResult: resultValue(expected.finalResult, 'Expected final result', 'BINDING_MISMATCH'),
  });
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return canonicalRunbookRehearsalJson(left) === canonicalRunbookRehearsalJson(right);
}

/**
 * Strictly verifies an already-created synthetic receipt against independent expected bindings.
 * This reads only local runbook and rollback policy files and never executes a procedure.
 */
export async function verifyRunbookRehearsalReceipt(
  value: unknown,
  expectedBindings: Readonly<RunbookRehearsalExpectedBindingsV1>,
  options: Readonly<RunbookRehearsalEnvironmentOptions> = {},
): Promise<Readonly<RunbookRehearsalReceiptV1>> {
  const expected = parseExpectedBindings(expectedBindings);
  const resolved = await compileBindingsWithBundle(
    {
      source: expected.bindings.source,
      release: expected.bindings.release,
      syntheticArtifact: expected.bindings.syntheticArtifact,
    },
    options,
  );
  if (!sameCanonical(resolved.bindings, expected.bindings)) {
    return fail('BINDING_MISMATCH', 'Expected bindings do not match current closed policy inputs.');
  }
  const receipt = parseReceipt(value);
  if (!sameCanonical(receipt.bindings, expected.bindings)) {
    return fail('BINDING_MISMATCH', 'Receipt bindings do not match the independent expectation.');
  }
  const selections = parseProcedureSelections(
    receipt.procedureOutcomes.map(({ procedureId, result }) => ({ procedureId, result })),
    'INVALID_RECEIPT',
  );
  const expectedOutcomes = selections.map((selection, index) => {
    const procedure = resolved.bundle.procedures[index];
    const identity = resolved.bundle.procedureIdentities[index];
    if (procedure === undefined || identity === undefined) {
      return fail('PROCEDURE_MISMATCH', 'Current closed runbook bundle is incomplete.');
    }
    return buildProcedureOutcome(procedure, identity, selection.result);
  });
  if (!sameCanonical(receipt.procedureOutcomes, expectedOutcomes)) {
    return fail(
      'PROCEDURE_MISMATCH',
      'Receipt procedure details do not match the closed runbooks.',
    );
  }
  const expectedSummary = buildSummary(expectedOutcomes);
  if (!sameCanonical(receipt.summary, expectedSummary)) {
    return fail('INVALID_RECEIPT', 'Receipt summary does not match its procedure outcomes.');
  }
  if (receipt.summary.finalResult !== expected.finalResult) {
    return fail(
      'BINDING_MISMATCH',
      'Receipt final result does not match the independent expectation.',
    );
  }
  return Object.freeze(receipt);
}

async function readStableJson(path: string, maximumBytes: number, label: string): Promise<unknown> {
  const absolute = resolve(path);
  const before = await lstat(absolute).catch(() => undefined);
  if (
    before === undefined ||
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size < 2 ||
    before.size > maximumBytes
  ) {
    return fail('INVALID_RECEIPT', `${label} must be a bounded regular file.`);
  }
  const contents = await readFile(absolute);
  const after = await lstat(absolute);
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    contents.byteLength !== after.size
  ) {
    return fail('INVALID_RECEIPT', `${label} changed while it was read.`);
  }
  let text: string;
  try {
    text = UTF8.decode(contents);
  } catch {
    return fail('NONCANONICAL_RECEIPT', `${label} is not strict UTF-8.`);
  }
  const value = parseCanonicalRunbookJson(text, label);
  if (text !== canonicalRunbookRehearsalJson(value)) {
    return fail('NONCANONICAL_RECEIPT', `${label} is not canonical JSON.`);
  }
  return value;
}

/** Reads and strictly verifies an existing receipt without running any rehearsal actions. */
export async function readRunbookRehearsalReceipt(
  path: string,
  expectedBindings: Readonly<RunbookRehearsalExpectedBindingsV1>,
  options: Readonly<RunbookRehearsalEnvironmentOptions> = {},
): Promise<Readonly<RunbookRehearsalReceiptV1>> {
  return verifyRunbookRehearsalReceipt(
    await readStableJson(path, MAX_RUNBOOK_REHEARSAL_RECEIPT_BYTES, 'Runbook rehearsal receipt'),
    expectedBindings,
    options,
  );
}

async function atomicWriteNewFile(path: string, contents: string): Promise<void> {
  const absolute = resolve(path);
  const parent = dirname(absolute);
  await mkdir(parent, { recursive: true });
  const parentInfo = await lstat(parent);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) {
    return fail('INVALID_OUTPUT', 'Runbook rehearsal output parent must be a regular directory.');
  }
  const existing = await lstat(absolute).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (existing !== undefined) {
    return fail('INVALID_OUTPUT', 'Runbook rehearsal output already exists.');
  }
  const temporary = join(
    parent,
    `.${basename(absolute)}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporary, absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return fail('INVALID_OUTPUT', 'Runbook rehearsal output already exists.');
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

/** Creates one aggregate synthetic rehearsal receipt. No procedure or provider action is run. */
export async function runSyntheticRunbookRehearsal(
  options: Readonly<RunbookRehearsalOptions>,
): Promise<Readonly<RunbookRehearsalReceiptV1>> {
  const request = parseRequest(options.request);
  const resolved = await compileBindingsWithBundle(request, options);
  const receipt = buildReceipt(request, resolved.bindings, resolved.bundle);
  const expected: RunbookRehearsalExpectedBindingsV1 = {
    bindings: resolved.bindings,
    finalResult: finalResult(request.outcomes),
  };
  await verifyRunbookRehearsalReceipt(receipt, expected, options);
  const outputPath = resolve(options.outputPath);
  await atomicWriteNewFile(outputPath, canonicalRunbookRehearsalJson(receipt));
  try {
    return await readRunbookRehearsalReceipt(outputPath, expected, options);
  } catch (error) {
    await rm(outputPath, { force: true });
    throw error;
  }
}

function cliArguments(arguments_: readonly string[]): Readonly<{
  requestPath: string;
  outputPath: string;
  repositoryRoot?: string;
  procedureDirectory?: string;
}> {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (
      flag === undefined ||
      value === undefined ||
      !flag.startsWith('--') ||
      value.startsWith('--')
    ) {
      return fail(
        'INVALID_REQUEST',
        'Usage: tsx tools/live/rehearseRunbooks.ts --request <synthetic-request.json> --output <new-receipt.json> [--repository <root>] [--procedures <directory>]',
      );
    }
    if (
      !['--request', '--output', '--repository', '--procedures'].includes(flag) ||
      flag in parsed
    ) {
      return fail('INVALID_REQUEST', `Unknown or duplicate rehearsal argument: ${flag}.`);
    }
    parsed[flag] = value;
  }
  if (parsed['--request'] === undefined || parsed['--output'] === undefined) {
    return fail(
      'INVALID_REQUEST',
      'Synthetic rehearsal request and new output paths are required.',
    );
  }
  return Object.freeze({
    requestPath: parsed['--request'],
    outputPath: parsed['--output'],
    ...(parsed['--repository'] === undefined ? {} : { repositoryRoot: parsed['--repository'] }),
    ...(parsed['--procedures'] === undefined ? {} : { procedureDirectory: parsed['--procedures'] }),
  });
}

function isMainModule(): boolean {
  const invoked = process.argv[1];
  return invoked !== undefined && resolve(invoked) === resolve(fileURLToPath(import.meta.url));
}

if (isMainModule()) {
  const cli = cliArguments(process.argv.slice(2));
  readStableJson(cli.requestPath, MAX_RUNBOOK_REHEARSAL_REQUEST_BYTES, 'Runbook rehearsal request')
    .then((request) =>
      runSyntheticRunbookRehearsal({
        request,
        outputPath: cli.outputPath,
        ...(cli.repositoryRoot === undefined ? {} : { repositoryRoot: cli.repositoryRoot }),
        ...(cli.procedureDirectory === undefined
          ? {}
          : { procedureDirectory: cli.procedureDirectory }),
      }),
    )
    .then(
      (receipt) => {
        console.log(
          `Recorded ${receipt.summary.finalResult} synthetic local rehearsal for ${receipt.summary.procedureCount} closed procedures. No provider, cloud, deployment, runtime, or production action was performed.`,
        );
      },
      (error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      },
    );
}
