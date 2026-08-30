import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';

import { OPERATIONS_REASON_CODES, type OperationsReasonCode } from '../../src/operations/contract';
import {
  RUNTIME_POLICY_REASON_CODES,
  type RuntimePolicyReasonCode,
} from '../../src/live/runtimePolicy';

export const OPERATOR_PROCEDURE_SCHEMA_VERSION = 'operator-procedure.v1' as const;
export const OPERATOR_RECEIPT_SCHEMA_VERSION = 'operator-verification-receipt.v1' as const;
export const OPERATOR_RUNBOOK_MANIFEST_SCHEMA_VERSION = 'operator-procedure-manifest.v1' as const;
export const OPERATOR_RUNBOOK_MANIFEST_FILE = 'manifest.json' as const;
export const MAX_OPERATOR_PROCEDURE_BYTES = 32_768;
export const MAX_OPERATOR_MANIFEST_BYTES = 16_384;
export const MAX_OPERATOR_ACTION_ATTEMPTS = 3;
export const MAX_OPERATOR_ACTION_MINUTES = 120;

export const OPERATOR_RECEIPT_REQUIRED_FIELDS = Object.freeze([
  'procedureId',
  'procedureSha256',
  'policyId',
  'policyEpoch',
  'applicationVersion',
  'releaseSha',
  'checkedAt',
  'runtimePolicyReasonCodes',
  'operationsReasonCodes',
  'entryEvidenceIds',
  'rehearsedActionIds',
  'stopConditionIds',
  'result',
] as const);

export const OPERATOR_RECEIPT_RESULT_VALUES = Object.freeze([
  'verified',
  'stopped',
  'rolled-back',
  'recovered',
] as const);

export type OperatorReceiptResult = (typeof OPERATOR_RECEIPT_RESULT_VALUES)[number];

export type OperatorProcedureId =
  | 'provider-term-hold'
  | 'quota-hold'
  | 'stale-feed'
  | 'internal-fault'
  | 'disablement'
  | 'rollback'
  | 'candidate-retention'
  | 'recovery';

interface OperatorProcedureDefinition {
  readonly procedureId: OperatorProcedureId;
  readonly fileName: string;
  readonly title: string;
  readonly runtimePolicyReasons: readonly RuntimePolicyReasonCode[];
  readonly operationsReasons: readonly OperationsReasonCode[];
}

export const OPERATOR_PROCEDURE_DEFINITIONS = Object.freeze([
  {
    procedureId: 'provider-term-hold',
    fileName: 'provider-term-hold.json',
    title: 'Provider-term hold',
    runtimePolicyReasons: ['terms-hold'],
    operationsReasons: ['PROVIDER_DISABLED'],
  },
  {
    procedureId: 'quota-hold',
    fileName: 'quota-hold.json',
    title: 'Quota hold',
    runtimePolicyReasons: ['quota-hold'],
    operationsReasons: ['PROVIDER_RATE_LIMITED'],
  },
  {
    procedureId: 'stale-feed',
    fileName: 'stale-feed.json',
    title: 'Stale or empty feed',
    runtimePolicyReasons: ['upstream-stale'],
    operationsReasons: [
      'PROVIDER_EMPTY',
      'FRESHNESS_EMPTY',
      'FRESHNESS_STALE',
      'FRESHNESS_EXPIRED',
      'FRESHNESS_UNAVAILABLE',
      'FRESHNESS_CURRENT',
    ],
  },
  {
    procedureId: 'internal-fault',
    fileName: 'internal-fault.json',
    title: 'Internal fault',
    runtimePolicyReasons: ['internal-fault'],
    operationsReasons: [
      'REGION_READ_UNAVAILABLE',
      'APPLICATION_PARTIAL_REGIONS',
      'APPLICATION_UNAVAILABLE',
      'APPLICATION_AVAILABLE',
    ],
  },
  {
    procedureId: 'disablement',
    fileName: 'disablement.json',
    title: 'Disablement',
    runtimePolicyReasons: ['source-disabled'],
    operationsReasons: ['PROVIDER_DISABLED'],
  },
  {
    procedureId: 'rollback',
    fileName: 'rollback.json',
    title: 'Rollback',
    runtimePolicyReasons: ['rollback'],
    operationsReasons: ['APPLICATION_UNAVAILABLE', 'APPLICATION_AVAILABLE'],
  },
  {
    procedureId: 'candidate-retention',
    fileName: 'candidate-retention.json',
    title: 'Candidate retention',
    runtimePolicyReasons: ['source-disabled'],
    operationsReasons: ['APPLICATION_AVAILABLE'],
  },
  {
    procedureId: 'recovery',
    fileName: 'recovery.json',
    title: 'Recovery',
    runtimePolicyReasons: ['internal-fault'],
    operationsReasons: ['APPLICATION_UNAVAILABLE', 'APPLICATION_AVAILABLE'],
  },
] as const satisfies readonly OperatorProcedureDefinition[]);

export type OperatorEvidenceSource =
  | 'runtime-policy'
  | 'operations-v1'
  | 'provider-written-record'
  | 'incident-record'
  | 'source-build'
  | 'retained-candidate'
  | 'release-receipt';

export type OperatorActionType =
  | 'capture-evidence'
  | 'verify-read-only'
  | 'prepare-policy-change'
  | 'request-approval'
  | 'select-approved-rollback'
  | 'restore-approved-policy'
  | 'preserve-current-release';

export type OperatorActionAuthority = 'read-only-local' | 'separate-explicit-approval';
export type OperatorStopOutcome = 'halt' | 'ready-for-receipt';

export interface OperatorProcedure {
  readonly schemaVersion: typeof OPERATOR_PROCEDURE_SCHEMA_VERSION;
  readonly procedureId: OperatorProcedureId;
  readonly title: string;
  readonly purpose: string;
  readonly documentationBoundary: {
    readonly mode: 'local-documentation-only';
    readonly executionClaim: 'none';
    readonly runtimeControlPlane: 'forbidden';
  };
  readonly reasonVocabulary: {
    readonly runtimePolicy: readonly RuntimePolicyReasonCode[];
    readonly operations: readonly OperationsReasonCode[];
  };
  readonly entryEvidence: readonly {
    readonly evidenceId: string;
    readonly source: OperatorEvidenceSource;
    readonly reasonCode: RuntimePolicyReasonCode | OperationsReasonCode;
    readonly required: true;
    readonly observation: string;
  }[];
  readonly boundedActions: readonly OperatorAction[];
  readonly stopConditions: readonly {
    readonly conditionId: string;
    readonly outcome: OperatorStopOutcome;
    readonly reasonCode: RuntimePolicyReasonCode | OperationsReasonCode;
    readonly observation: string;
  }[];
  readonly rollbackActions: readonly OperatorAction[];
  readonly verificationReceipt: {
    readonly schemaVersion: typeof OPERATOR_RECEIPT_SCHEMA_VERSION;
    readonly status: 'template-only-not-executed';
    readonly privacy: 'aggregate-only-no-aircraft-request-client-or-event-data';
    readonly requiredFields: typeof OPERATOR_RECEIPT_REQUIRED_FIELDS;
    readonly resultValues: typeof OPERATOR_RECEIPT_RESULT_VALUES;
  };
}

export interface OperatorAction {
  readonly sequence: number;
  readonly actionId: string;
  readonly actionType: OperatorActionType;
  readonly authority: OperatorActionAuthority;
  readonly instruction: string;
  readonly maximumAttempts: number;
  readonly maximumDurationMinutes: number;
}

export interface OperatorProcedureFileIdentity {
  readonly procedureId: OperatorProcedureId;
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface OperatorRunbookManifestV1 {
  readonly schemaVersion: typeof OPERATOR_RUNBOOK_MANIFEST_SCHEMA_VERSION;
  readonly mode: 'closed-synthetic-rehearsal-only';
  readonly privacy: 'aggregate-only-no-aircraft-request-client-or-event-data';
  readonly procedureCount: number;
  readonly procedures: readonly OperatorProcedureFileIdentity[];
}

export interface VerifiedRunbookBundle {
  readonly root: string;
  readonly manifest: Readonly<OperatorRunbookManifestV1>;
  readonly manifestIdentity: Readonly<{ bytes: number; sha256: string }>;
  readonly procedures: readonly OperatorProcedure[];
  readonly procedureIdentities: readonly OperatorProcedureFileIdentity[];
}

export type RunbookPolicyErrorCode =
  | 'INVALID_DIRECTORY'
  | 'INVALID_FILE_SET'
  | 'INVALID_JSON'
  | 'NONCANONICAL_JSON'
  | 'INVALID_SHAPE'
  | 'INVALID_REASON'
  | 'INVALID_BOUND'
  | 'HASH_MISMATCH'
  | 'UNSAFE_INSTRUCTION'
  | 'INVALID_SEMANTICS';

export class RunbookPolicyError extends Error {
  readonly code: RunbookPolicyErrorCode;

  constructor(code: RunbookPolicyErrorCode, message: string) {
    super(message);
    this.name = 'RunbookPolicyError';
    this.code = code;
  }
}

type JsonRecord = Record<string, unknown>;

const PROCEDURE_KEYS = Object.freeze([
  'schemaVersion',
  'procedureId',
  'title',
  'purpose',
  'documentationBoundary',
  'reasonVocabulary',
  'entryEvidence',
  'boundedActions',
  'stopConditions',
  'rollbackActions',
  'verificationReceipt',
] as const);
const BOUNDARY_KEYS = Object.freeze(['mode', 'executionClaim', 'runtimeControlPlane'] as const);
const VOCABULARY_KEYS = Object.freeze(['runtimePolicy', 'operations'] as const);
const EVIDENCE_KEYS = Object.freeze([
  'evidenceId',
  'source',
  'reasonCode',
  'required',
  'observation',
] as const);
const ACTION_KEYS = Object.freeze([
  'sequence',
  'actionId',
  'actionType',
  'authority',
  'instruction',
  'maximumAttempts',
  'maximumDurationMinutes',
] as const);
const STOP_KEYS = Object.freeze(['conditionId', 'outcome', 'reasonCode', 'observation'] as const);
const RECEIPT_KEYS = Object.freeze([
  'schemaVersion',
  'status',
  'privacy',
  'requiredFields',
  'resultValues',
] as const);
const MANIFEST_KEYS = Object.freeze([
  'schemaVersion',
  'mode',
  'privacy',
  'procedureCount',
  'procedures',
] as const);
const MANIFEST_PROCEDURE_KEYS = Object.freeze(['procedureId', 'path', 'bytes', 'sha256'] as const);
const EVIDENCE_SOURCES = new Set<OperatorEvidenceSource>([
  'runtime-policy',
  'operations-v1',
  'provider-written-record',
  'incident-record',
  'source-build',
  'retained-candidate',
  'release-receipt',
]);
const ACTION_TYPES = new Set<OperatorActionType>([
  'capture-evidence',
  'verify-read-only',
  'prepare-policy-change',
  'request-approval',
  'select-approved-rollback',
  'restore-approved-policy',
  'preserve-current-release',
]);
const READ_ONLY_ACTION_TYPES = new Set<OperatorActionType>([
  'capture-evidence',
  'verify-read-only',
  'preserve-current-release',
]);
const STOP_OUTCOMES = new Set<OperatorStopOutcome>(['halt', 'ready-for-receipt']);
const RUNTIME_REASON_SET = new Set<string>(RUNTIME_POLICY_REASON_CODES);
const OPERATIONS_REASON_SET = new Set<string>(OPERATIONS_REASON_CODES);
const IDENTIFIER_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const UTF8 = new TextDecoder('utf-8', { fatal: true });
const FORBIDDEN_ENDPOINT_PATTERN =
  /(?:\/api\/|\/(?:admin|control)(?:\/|\b)|\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/|\b(?:admin|control)[-_ ](?:endpoint|route|binding)\b|\bbinding\b|\b(?:ADMIN|CONTROL)_[A-Z0-9_]+\b)/iu;
const MUTABLE_BINDING_PATTERN =
  /\b(?:LIVE_PROVIDER_BASE_URL|LIVE_PROVIDER_MODE|RUNTIME_PROVIDER_GATE_[A-Z_]+|MUTABLE_[A-Z0-9_]+)\b/u;
const MUTABLE_SECRET_PATTERN =
  /(?:\b(?:password|passwd|secret|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|bearer|authorization|cookie|private[-_ ]?key|client[-_ ]?secret)\b|\b(?:gh[pousr]_|sk-)[A-Za-z0-9_-]{16,}\b|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b)/iu;
const PROVIDER_SWITCH_PATTERN =
  /(?:\b(?:switch|change|replace|migrate|rotate|select)\s+(?:the\s+)?(?:provider|upstream|source)\b|\b(?:fail\s+over\s+to|fallback\s+to)\s+(?:an?\s+)?(?:provider|upstream|source)\b|\b(?:alternate|alternative|different|secondary|backup)\s+(?:provider|upstream|source)\b|\bprovider\s+(?:switch|selection|migration)\b)/iu;
const PAYMENT_PATTERN =
  /\b(?:pay|payment|purchase|buy|billing|credit card|upgrade|subscribe|spend|charge|paid tier|increase(?:\s+the)?\s+quota)\b/iu;
const UNBOUNDED_PATTERN =
  /\b(?:until|indefinitely|continuously|forever|ongoing|always|unbounded|as needed|without limit|every minute|periodically|automatically retry|keep (?:trying|retrying))\b/iu;
const COMMAND_PATTERN =
  /(?:^|\s)(?:rm|rmdir|del|erase|format|mkfs|dd|sudo|curl|wget|powershell|pwsh|cmd(?:\.exe)?|bash|sh|git|wrangler|npm|pnpm|npx|node|python|tsx|echo|kubectl|terraform|Remove-Item|Invoke-RestMethod|Invoke-WebRequest)(?:\s|$)|\$\(|`/iu;
const URL_PATTERN = /\b(?:https?|wss?):\/\//iu;

function failure(code: RunbookPolicyErrorCode, message: string): never {
  throw new RunbookPolicyError(code, message);
}

function jsonStringEnd(text: string, start: number): number {
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const character = text[index];
    if (escaped) {
      escaped = false;
    } else if (character === '\\') {
      escaped = true;
    } else if (character === '"') {
      return index + 1;
    }
  }
  return failure('INVALID_JSON', 'Operator procedure contains an unterminated string.');
}

function assertNoDuplicateJsonFields(text: string): void {
  const whitespace = /\s/u;
  const skipWhitespace = (start: number): number => {
    let index = start;
    while (index < text.length && whitespace.test(text[index] ?? '')) index += 1;
    return index;
  };
  const scanValue = (start: number): number => {
    let index = skipWhitespace(start);
    const character = text[index];
    if (character === '{') {
      const keys = new Set<string>();
      index = skipWhitespace(index + 1);
      if (text[index] === '}') return index + 1;
      while (index < text.length) {
        if (text[index] !== '"') {
          return failure('INVALID_JSON', 'Operator procedure object key is invalid.');
        }
        const end = jsonStringEnd(text, index);
        const key = JSON.parse(text.slice(index, end)) as string;
        if (keys.has(key)) {
          return failure('NONCANONICAL_JSON', `Operator procedure repeats field ${key}.`);
        }
        keys.add(key);
        index = skipWhitespace(end);
        if (text[index] !== ':') {
          return failure('INVALID_JSON', 'Operator procedure object separator is invalid.');
        }
        index = skipWhitespace(scanValue(index + 1));
        if (text[index] === '}') return index + 1;
        if (text[index] !== ',') {
          return failure('INVALID_JSON', 'Operator procedure object delimiter is invalid.');
        }
        index = skipWhitespace(index + 1);
      }
      return failure('INVALID_JSON', 'Operator procedure object is unterminated.');
    }
    if (character === '[') {
      index = skipWhitespace(index + 1);
      if (text[index] === ']') return index + 1;
      while (index < text.length) {
        index = skipWhitespace(scanValue(index));
        if (text[index] === ']') return index + 1;
        if (text[index] !== ',') {
          return failure('INVALID_JSON', 'Operator procedure array delimiter is invalid.');
        }
        index = skipWhitespace(index + 1);
      }
      return failure('INVALID_JSON', 'Operator procedure array is unterminated.');
    }
    if (character === '"') return jsonStringEnd(text, index);
    while (index < text.length && !/[\s,}\]]/u.test(text[index] ?? '')) index += 1;
    return index;
  };
  scanValue(0);
}

function exactRecord(value: unknown, keys: readonly string[], label: string): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return failure('INVALID_SHAPE', `${label} must be an object.`);
  }
  const record = value as JsonRecord;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    return failure('INVALID_SHAPE', `${label} contains missing or unknown fields.`);
  }
  return record;
}

function boundedArray(value: unknown, minimum: number, maximum: number, label: string): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    return failure('INVALID_BOUND', `${label} must contain ${minimum} through ${maximum} items.`);
  }
  return value;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    return failure('INVALID_SHAPE', `${label} must be a bounded lowercase identifier.`);
  }
  return safeText(value, 64, label);
}

function safeText(value: unknown, maximum: number, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    [...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || code === 127;
    })
  ) {
    return failure('INVALID_BOUND', `${label} must be bounded canonical text.`);
  }
  for (const [pattern, reason] of [
    [COMMAND_PATTERN, 'an executable command'],
    [MUTABLE_SECRET_PATTERN, 'mutable secret material'],
    [FORBIDDEN_ENDPOINT_PATTERN, 'a runtime administration or control surface'],
    [MUTABLE_BINDING_PATTERN, 'a mutable runtime binding'],
    [PROVIDER_SWITCH_PATTERN, 'provider switching'],
    [PAYMENT_PATTERN, 'a payment or account upgrade'],
    [UNBOUNDED_PATTERN, 'an unbounded instruction'],
    [URL_PATTERN, 'an undeclared network destination'],
  ] as const) {
    if (pattern.test(value)) {
      return failure('UNSAFE_INSTRUCTION', `${label} contains ${reason}.`);
    }
  }
  return value;
}

function exactStringArray(value: unknown, expected: readonly string[], label: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length !== expected.length ||
    value.some((entry, index) => entry !== expected[index])
  ) {
    return failure('INVALID_SEMANTICS', `${label} must match the declared closed vocabulary.`);
  }
  return value as string[];
}

function declaredReason(
  value: unknown,
  declaredRuntime: ReadonlySet<string>,
  declaredOperations: ReadonlySet<string>,
  label: string,
): RuntimePolicyReasonCode | OperationsReasonCode {
  if (
    typeof value !== 'string' ||
    (!RUNTIME_REASON_SET.has(value) && !OPERATIONS_REASON_SET.has(value))
  ) {
    return failure('INVALID_REASON', `${label} is not a stable policy or operations reason.`);
  }
  if (!declaredRuntime.has(value) && !declaredOperations.has(value)) {
    return failure('INVALID_REASON', `${label} is not declared by this procedure.`);
  }
  return value as RuntimePolicyReasonCode | OperationsReasonCode;
}

function parseEvidence(
  value: unknown,
  declaredRuntime: ReadonlySet<string>,
  declaredOperations: ReadonlySet<string>,
  label: string,
): OperatorProcedure['entryEvidence'][number] {
  const record = exactRecord(value, EVIDENCE_KEYS, label);
  const evidenceId = identifier(record.evidenceId, `${label}.evidenceId`);
  if (
    typeof record.source !== 'string' ||
    !EVIDENCE_SOURCES.has(record.source as OperatorEvidenceSource)
  ) {
    return failure('INVALID_SHAPE', `${label}.source is not allowed.`);
  }
  const source = record.source as OperatorEvidenceSource;
  const reasonCode = declaredReason(
    record.reasonCode,
    declaredRuntime,
    declaredOperations,
    `${label}.reasonCode`,
  );
  if (record.required !== true) {
    return failure('INVALID_SEMANTICS', `${label} must be required entry evidence.`);
  }
  const sourceUsesOperations = source === 'operations-v1';
  if (
    (sourceUsesOperations && !OPERATIONS_REASON_SET.has(reasonCode)) ||
    (!sourceUsesOperations && !RUNTIME_REASON_SET.has(reasonCode))
  ) {
    return failure('INVALID_REASON', `${label}.source and reasonCode use different vocabularies.`);
  }
  return {
    evidenceId,
    source,
    reasonCode,
    required: true,
    observation: safeText(record.observation, 320, `${label}.observation`),
  };
}

function positiveInteger(value: unknown, maximum: number, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    return failure('INVALID_BOUND', `${label} must be an integer from 1 through ${maximum}.`);
  }
  return value;
}

function parseActions(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): OperatorAction[] {
  const actions = boundedArray(value, minimum, maximum, label);
  const identifiers = new Set<string>();
  return actions.map((entry, index) => {
    const actionLabel = `${label}[${index}]`;
    const record = exactRecord(entry, ACTION_KEYS, actionLabel);
    const sequence = positiveInteger(record.sequence, maximum, `${actionLabel}.sequence`);
    if (sequence !== index + 1) {
      return failure('INVALID_SEMANTICS', `${label} sequences must be contiguous and ordered.`);
    }
    const actionId = identifier(record.actionId, `${actionLabel}.actionId`);
    if (identifiers.has(actionId)) {
      return failure('INVALID_SEMANTICS', `${label} action IDs must be unique.`);
    }
    identifiers.add(actionId);
    if (
      typeof record.actionType !== 'string' ||
      !ACTION_TYPES.has(record.actionType as OperatorActionType)
    ) {
      return failure('INVALID_SHAPE', `${actionLabel}.actionType is not allowed.`);
    }
    const actionType = record.actionType as OperatorActionType;
    const expectedAuthority: OperatorActionAuthority = READ_ONLY_ACTION_TYPES.has(actionType)
      ? 'read-only-local'
      : 'separate-explicit-approval';
    if (record.authority !== expectedAuthority) {
      return failure(
        'INVALID_SEMANTICS',
        `${actionLabel}.authority does not match its action type.`,
      );
    }
    return {
      sequence,
      actionId,
      actionType,
      authority: expectedAuthority,
      instruction: safeText(record.instruction, 320, `${actionLabel}.instruction`),
      maximumAttempts: positiveInteger(
        record.maximumAttempts,
        MAX_OPERATOR_ACTION_ATTEMPTS,
        `${actionLabel}.maximumAttempts`,
      ),
      maximumDurationMinutes: positiveInteger(
        record.maximumDurationMinutes,
        MAX_OPERATOR_ACTION_MINUTES,
        `${actionLabel}.maximumDurationMinutes`,
      ),
    };
  });
}

function definitionFor(procedureId: string): OperatorProcedureDefinition {
  const definition = OPERATOR_PROCEDURE_DEFINITIONS.find(
    (candidate) => candidate.procedureId === procedureId,
  );
  if (!definition) return failure('INVALID_SEMANTICS', 'The procedure ID is not declared.');
  return definition;
}

export function parseOperatorProcedure(
  value: unknown,
  expectedProcedureId?: OperatorProcedureId,
): OperatorProcedure {
  const record = exactRecord(value, PROCEDURE_KEYS, 'Operator procedure');
  if (record.schemaVersion !== OPERATOR_PROCEDURE_SCHEMA_VERSION) {
    return failure('INVALID_SHAPE', 'Operator procedure schemaVersion is invalid.');
  }
  const procedureId = identifier(record.procedureId, 'Operator procedure procedureId');
  const definition = definitionFor(procedureId);
  if (expectedProcedureId !== undefined && procedureId !== expectedProcedureId) {
    return failure('INVALID_SEMANTICS', 'Operator procedure ID does not match its selected file.');
  }
  if (record.title !== definition.title) {
    return failure('INVALID_SEMANTICS', 'Operator procedure title does not match its identity.');
  }
  safeText(record.title, 96, 'Operator procedure title');
  safeText(record.purpose, 320, 'Operator procedure purpose');

  const boundary = exactRecord(
    record.documentationBoundary,
    BOUNDARY_KEYS,
    'Operator procedure documentationBoundary',
  );
  if (
    boundary.mode !== 'local-documentation-only' ||
    boundary.executionClaim !== 'none' ||
    boundary.runtimeControlPlane !== 'forbidden'
  ) {
    return failure(
      'INVALID_SEMANTICS',
      'Operator procedure must remain local documentation with no execution claim or control plane.',
    );
  }

  const vocabulary = exactRecord(
    record.reasonVocabulary,
    VOCABULARY_KEYS,
    'Operator procedure reasonVocabulary',
  );
  if (
    !Array.isArray(vocabulary.runtimePolicy) ||
    vocabulary.runtimePolicy.some(
      (reason) => typeof reason !== 'string' || !RUNTIME_REASON_SET.has(reason),
    ) ||
    !Array.isArray(vocabulary.operations) ||
    vocabulary.operations.some(
      (reason) => typeof reason !== 'string' || !OPERATIONS_REASON_SET.has(reason),
    )
  ) {
    return failure('INVALID_REASON', 'Operator procedure declares an unknown reason.');
  }
  const runtimePolicy = exactStringArray(
    vocabulary.runtimePolicy,
    definition.runtimePolicyReasons,
    'Operator procedure runtime-policy reasons',
  ) as RuntimePolicyReasonCode[];
  const operations = exactStringArray(
    vocabulary.operations,
    definition.operationsReasons,
    'Operator procedure operations reasons',
  ) as OperationsReasonCode[];
  const declaredRuntime = new Set<string>(runtimePolicy);
  const declaredOperations = new Set<string>(operations);

  const entryEvidence = boundedArray(record.entryEvidence, 2, 8, 'entryEvidence').map(
    (entry, index) =>
      parseEvidence(entry, declaredRuntime, declaredOperations, `entryEvidence[${index}]`),
  );
  if (!entryEvidence.some(({ source }) => source === 'operations-v1')) {
    return failure('INVALID_SEMANTICS', 'Entry evidence must include operations.v1.');
  }
  if (!entryEvidence.some(({ reasonCode }) => RUNTIME_REASON_SET.has(reasonCode))) {
    return failure('INVALID_SEMANTICS', 'Entry evidence must include the runtime-policy reason.');
  }
  const evidenceIds = new Set(entryEvidence.map(({ evidenceId }) => evidenceId));
  if (evidenceIds.size !== entryEvidence.length) {
    return failure('INVALID_SEMANTICS', 'Entry evidence IDs must be unique.');
  }

  const boundedActions = parseActions(record.boundedActions, 'boundedActions', 2, 8);
  const rollbackActions = parseActions(record.rollbackActions, 'rollbackActions', 1, 4);
  if (
    !rollbackActions.some(
      ({ actionType }) =>
        actionType === 'preserve-current-release' || actionType === 'restore-approved-policy',
    )
  ) {
    return failure(
      'INVALID_SEMANTICS',
      'Rollback actions must preserve the current release or restore an approved policy.',
    );
  }
  const allActionIds = [
    ...boundedActions.map(({ actionId }) => actionId),
    ...rollbackActions.map(({ actionId }) => actionId),
  ];
  if (new Set(allActionIds).size !== allActionIds.length) {
    return failure('INVALID_SEMANTICS', 'Action IDs must be unique across the procedure.');
  }

  const stopConditions = boundedArray(record.stopConditions, 2, 8, 'stopConditions').map(
    (entry, index) => {
      const label = `stopConditions[${index}]`;
      const stop = exactRecord(entry, STOP_KEYS, label);
      const conditionId = identifier(stop.conditionId, `${label}.conditionId`);
      if (
        typeof stop.outcome !== 'string' ||
        !STOP_OUTCOMES.has(stop.outcome as OperatorStopOutcome)
      ) {
        return failure('INVALID_SHAPE', `${label}.outcome is invalid.`);
      }
      return {
        conditionId,
        outcome: stop.outcome as OperatorStopOutcome,
        reasonCode: declaredReason(
          stop.reasonCode,
          declaredRuntime,
          declaredOperations,
          `${label}.reasonCode`,
        ),
        observation: safeText(stop.observation, 320, `${label}.observation`),
      };
    },
  );
  if (
    new Set(stopConditions.map(({ conditionId }) => conditionId)).size !== stopConditions.length
  ) {
    return failure('INVALID_SEMANTICS', 'Stop condition IDs must be unique.');
  }
  if (!stopConditions.some(({ outcome }) => outcome === 'halt')) {
    return failure('INVALID_SEMANTICS', 'Every procedure requires a halting stop condition.');
  }
  if (!stopConditions.some(({ outcome }) => outcome === 'ready-for-receipt')) {
    return failure('INVALID_SEMANTICS', 'Every procedure requires a receipt-ready stop condition.');
  }

  const usedReasons = new Set<string>([
    ...entryEvidence.map(({ reasonCode }) => reasonCode),
    ...stopConditions.map(({ reasonCode }) => reasonCode),
  ]);
  for (const reason of [...runtimePolicy, ...operations]) {
    if (!usedReasons.has(reason)) {
      return failure('INVALID_SEMANTICS', `Declared reason ${reason} is not used by evidence.`);
    }
  }

  const receipt = exactRecord(
    record.verificationReceipt,
    RECEIPT_KEYS,
    'Operator procedure verificationReceipt',
  );
  if (
    receipt.schemaVersion !== OPERATOR_RECEIPT_SCHEMA_VERSION ||
    receipt.status !== 'template-only-not-executed' ||
    receipt.privacy !== 'aggregate-only-no-aircraft-request-client-or-event-data'
  ) {
    return failure(
      'INVALID_SEMANTICS',
      'Verification receipt must remain an aggregate-only unexecuted template.',
    );
  }
  exactStringArray(
    receipt.requiredFields,
    OPERATOR_RECEIPT_REQUIRED_FIELDS,
    'Operator receipt requiredFields',
  );
  exactStringArray(
    receipt.resultValues,
    OPERATOR_RECEIPT_RESULT_VALUES,
    'Operator receipt resultValues',
  );

  return value as OperatorProcedure;
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function parseCanonicalRunbookJson(text: string, label: string): unknown {
  if (text.startsWith('\uFEFF') || text.includes('\0')) {
    return failure('NONCANONICAL_JSON', `${label} must be BOM-free NUL-free UTF-8 JSON.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return failure('INVALID_JSON', `${label} is not valid JSON.`);
  }
  assertNoDuplicateJsonFields(text);
  if (text !== `${text.trim()}\n`) {
    return failure(
      'NONCANONICAL_JSON',
      `${label} must have one final newline and no surrounding whitespace.`,
    );
  }
  return parsed;
}

async function readBoundedJsonFile(
  path: string,
  maximumBytes: number,
  label: string,
): Promise<Readonly<{ value: unknown; bytes: number; sha256: string }>> {
  const before = await lstat(path).catch(() => undefined);
  if (
    before === undefined ||
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size < 2 ||
    before.size > maximumBytes
  ) {
    return failure('INVALID_FILE_SET', `${label} must be a bounded regular file.`);
  }
  const contents = await readFile(path);
  if (contents.byteLength !== before.size) {
    return failure('HASH_MISMATCH', `${label} changed while it was read.`);
  }
  let text: string;
  try {
    text = UTF8.decode(contents);
  } catch {
    return failure('NONCANONICAL_JSON', `${label} must be strict UTF-8 JSON.`);
  }
  return Object.freeze({
    value: parseCanonicalRunbookJson(text, label),
    bytes: contents.byteLength,
    sha256: sha256(contents),
  });
}

function parseRunbookManifest(value: unknown): Readonly<OperatorRunbookManifestV1> {
  const manifest = exactRecord(value, MANIFEST_KEYS, 'Operator runbook manifest');
  if (
    manifest.schemaVersion !== OPERATOR_RUNBOOK_MANIFEST_SCHEMA_VERSION ||
    manifest.mode !== 'closed-synthetic-rehearsal-only' ||
    manifest.privacy !== 'aggregate-only-no-aircraft-request-client-or-event-data' ||
    manifest.procedureCount !== OPERATOR_PROCEDURE_DEFINITIONS.length ||
    !Array.isArray(manifest.procedures) ||
    manifest.procedures.length !== OPERATOR_PROCEDURE_DEFINITIONS.length
  ) {
    return failure('INVALID_SEMANTICS', 'Operator runbook manifest is outside the closed policy.');
  }
  const procedures = manifest.procedures.map((value, index) => {
    const label = `Operator runbook manifest procedures[${index}]`;
    const procedure = exactRecord(value, MANIFEST_PROCEDURE_KEYS, label);
    const definition = OPERATOR_PROCEDURE_DEFINITIONS[index];
    if (
      definition === undefined ||
      procedure.procedureId !== definition.procedureId ||
      procedure.path !== definition.fileName ||
      typeof procedure.bytes !== 'number' ||
      !Number.isSafeInteger(procedure.bytes) ||
      procedure.bytes < 2 ||
      procedure.bytes > MAX_OPERATOR_PROCEDURE_BYTES ||
      typeof procedure.sha256 !== 'string' ||
      !SHA256_PATTERN.test(procedure.sha256)
    ) {
      return failure('INVALID_SEMANTICS', `${label} is not the selected procedure identity.`);
    }
    return Object.freeze({
      procedureId: definition.procedureId,
      path: definition.fileName,
      bytes: procedure.bytes,
      sha256: procedure.sha256,
    });
  });
  return Object.freeze({
    schemaVersion: OPERATOR_RUNBOOK_MANIFEST_SCHEMA_VERSION,
    mode: 'closed-synthetic-rehearsal-only',
    privacy: 'aggregate-only-no-aircraft-request-client-or-event-data',
    procedureCount: procedures.length,
    procedures: Object.freeze(procedures),
  });
}

function assertExactRunbookFileSet(
  entries: readonly {
    readonly name: string;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  }[],
): void {
  const expectedFiles = [
    OPERATOR_RUNBOOK_MANIFEST_FILE,
    ...OPERATOR_PROCEDURE_DEFINITIONS.map(({ fileName }) => fileName),
  ].sort();
  const actualFiles = entries.map(({ name }) => name).sort();
  if (
    entries.some((entry) => !entry.isFile() || entry.isSymbolicLink()) ||
    actualFiles.length !== expectedFiles.length ||
    actualFiles.some((file, index) => file !== expectedFiles[index])
  ) {
    failure(
      'INVALID_FILE_SET',
      `Operator procedure directory must contain exactly ${expectedFiles.length} declared files.`,
    );
  }
}

export async function verifyRunbookBundle(
  directory = resolve('docs', 'operations'),
): Promise<Readonly<VerifiedRunbookBundle>> {
  const root = resolve(directory);
  const rootInfo = await lstat(root).catch(() => undefined);
  if (rootInfo === undefined || !rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    return failure('INVALID_DIRECTORY', 'Operator procedure path must be a regular directory.');
  }
  assertExactRunbookFileSet(await readdir(root, { withFileTypes: true }));
  const manifestDocument = await readBoundedJsonFile(
    join(root, OPERATOR_RUNBOOK_MANIFEST_FILE),
    MAX_OPERATOR_MANIFEST_BYTES,
    'Operator runbook manifest',
  );
  const manifest = parseRunbookManifest(manifestDocument.value);
  const verified = await Promise.all(
    OPERATOR_PROCEDURE_DEFINITIONS.map(async (definition, index) => {
      const document = await readBoundedJsonFile(
        join(root, definition.fileName),
        MAX_OPERATOR_PROCEDURE_BYTES,
        `Operator procedure ${definition.procedureId}`,
      );
      const selected = manifest.procedures[index];
      if (
        selected === undefined ||
        selected.bytes !== document.bytes ||
        selected.sha256 !== document.sha256
      ) {
        return failure(
          'HASH_MISMATCH',
          `Operator procedure ${definition.procedureId} does not match the closed manifest.`,
        );
      }
      return Object.freeze({
        procedure: parseOperatorProcedure(document.value, definition.procedureId),
        identity: selected,
      });
    }),
  );
  assertExactRunbookFileSet(await readdir(root, { withFileTypes: true }));
  return Object.freeze({
    root,
    manifest,
    manifestIdentity: Object.freeze({
      bytes: manifestDocument.bytes,
      sha256: manifestDocument.sha256,
    }),
    procedures: Object.freeze(verified.map(({ procedure }) => procedure)),
    procedureIdentities: Object.freeze(verified.map(({ identity }) => identity)),
  });
}

export async function verifyRunbookDirectory(
  directory = resolve('docs', 'operations'),
): Promise<readonly OperatorProcedure[]> {
  return (await verifyRunbookBundle(directory)).procedures;
}

export const verifyOperatorProcedure = parseOperatorProcedure;
export const verifyRunbooks = verifyRunbookDirectory;

function isMainModule(): boolean {
  const invoked = process.argv[1];
  return invoked !== undefined && resolve(invoked) === resolve(fileURLToPath(import.meta.url));
}

if (isMainModule()) {
  try {
    const arguments_ = process.argv.slice(2);
    if (arguments_.length > 1) {
      failure('INVALID_DIRECTORY', 'Runbook verification accepts at most one directory.');
    }
    const bundle = await verifyRunbookBundle(arguments_[0]);
    console.log(
      `Runbook policy passed for ${bundle.procedures.length} manifest-bound local procedures. No procedure was executed.`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Runbook policy verification failed.');
    process.exitCode = 1;
  }
}
