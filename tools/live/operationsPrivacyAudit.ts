import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { TextDecoder } from 'node:util';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import mapManifest from '../../maps/manifest.json';
import rollbackManifest from '../../rollback/v2.2.0/manifest.json';
import runtimePolicySchema from '../../schemas/runtime-policy-v1.schema.json';
import {
  MAX_OPERATIONS_COUNTER,
  OPERATIONS_REGION_IDS,
  assertOperationsPrivacy,
  parseOperationsProjection,
} from '../../src/operations/contract';
import {
  MAX_LIVE_MESSAGE_BYTES,
  isCanonicalTimestamp,
  isJsonRecord,
  isLiveIdentifier,
  isSafeInteger,
} from '../../src/live/validation';
import {
  MAX_SOCKET_CONTROLS_PER_WINDOW,
  MAX_VIEWER_ATTACHMENT_BYTES,
} from '../../worker/deliveryPolicy';
import { validPollTimestamp } from '../../worker/polling';
import { assertPrivacySafeTextArtifact } from './runtimePolicyArtifact';

export const OPERATIONS_PRIVACY_INVENTORY_VERSION = 'operations-privacy-inventory.v1' as const;
export const OPERATIONS_PRIVACY_AUDIT_VERSION = 'operations-privacy-audit.v1' as const;
export const G2_EVIDENCE_MANIFEST_VERSION = 'g2-evidence-manifest.v1' as const;
export const G2_AGGREGATE_RECEIPT_VERSION = 'g2-aggregate-receipt.v1' as const;
export const G2_EVIDENCE_POLICY = 'aggregate-only-no-capture' as const;
export const PRIVACY_TREE_IDENTITY_VERSION = 'sha256-file-inventory.v1' as const;
export const G2_RETAINED_FILES = Object.freeze([
  'g2-aggregate-receipt.json',
  'g2-evidence-manifest.json',
] as const);

const MAX_SCAN_DEPTH = 20;
const MAX_SCAN_NODES = 8_192;
const MAX_STATIC_ARTIFACT_SCAN_NODES = 65_536;
const MAX_TREE_FILES = 8_192;
const MAX_TEXT_BYTES = 32 * 1024 * 1024;
const MAX_OPAQUE_BYTES = 512 * 1024 * 1024;
const UTF8 = new TextDecoder('utf-8', { fatal: true });
const PRIVACY_SCHEMA_VALIDATOR = new Ajv2020({ allErrors: true, strict: true });
addFormats(PRIVACY_SCHEMA_VALIDATOR);
const validateRuntimePolicy = PRIVACY_SCHEMA_VALIDATOR.compile(runtimePolicySchema);
const SHA256 = /^[0-9a-f]{64}$/u;
const SOURCE_HEAD = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const IPV4 = /(?:^|[^0-9])(?:\d{1,3}\.){3}\d{1,3}(?:$|[^0-9])/u;
const IPV6 = /(?:^|[\s[(])(?:[0-9a-f]{0,4}:){2,}[0-9a-f:]{0,39}(?:$|[\s\])])/iu;
const COMPLETE_URL = /(?:^|[\s"'`(])(?:[a-z][a-z0-9+.-]*:\/\/|\/\/)[^\s"'`<>()]+/iu;
const AIRCRAFT_IDENTIFIER = /(?:^|[^0-9a-f])(?:[0-9a-f]{6})(?:$|[^0-9a-f])/iu;
const REGISTRATION =
  /(?:^|[^A-Z0-9])(?:N\d{1,5}[A-Z]{0,2}|[CG]-[A-Z]{4}|D-[A-Z]{4}|F-[A-Z]{4}|G-[A-Z]{4})(?:$|[^A-Z0-9])/u;
const CALLSIGN = /(?:^|[^A-Z0-9])(?:[A-Z]{3}\d{1,4})(?:$|[^A-Z0-9])/u;
const COORDINATE_PAIR =
  /(?:^|[^0-9])[-+]?\d{1,3}\.\d{3,}\s*[,/]\s*[-+]?\d{1,3}\.\d{3,}(?:$|[^0-9])/u;
const USER_AGENT = /\b(?:Mozilla\/5\.0|PostmanRuntime\/|curl\/\d|Wget\/\d)\b/iu;
const RAW_PROVIDER_PAYLOAD = /["'](?:ac|aircraft|states)["']\s*:\s*\[/iu;
const CLIENT_SENTINEL = /\bclient[-_.]?(?:id|identifier|sentinel)[-_.:]/iu;
const REQUEST_SENTINEL = /\brequest[-_.]?(?:id|metadata|headers?|body|sentinel)[-_.:]/iu;
const STRUCTURED_FORBIDDEN_KEY =
  /^(?:aircraft(?:id|identifier)?|icao24|callsign|registration|lat|lon|lng|long|latitude|longitude|coordinates?|position|trail(?:point)?s?|providerpayload|rawpayload|ipaddress|useragent|client(?:id|identifier)|request(?:id|metadata|headers?|body)|fullurl|requesturl)$/u;
const ALLOWED_AIRCRAFT_AGGREGATES = new Set([
  'aircraftCountSum',
  'aircraftCountMinimum',
  'aircraftCountMaximum',
]);
const FORBIDDEN_CAPTURE_PATH =
  /(?:^|\/)(?:screenshots?|traces?|videos?|har|request[-_]?bod(?:y|ies)|response[-_]?bod(?:y|ies))(?:\/|$)|\.(?:png|jpe?g|gif|webp|bmp|ico|mp4|webm|mov|avi|har|trace)$/iu;
const TEXT_EVIDENCE_PATH =
  /(?:\.(?:c?js|mjs|css|html?|json|map|md|sha256|svg|txt|xml)|(?:^|\/)(?:\.assetsignore|_headers|_redirects))$/iu;
const DURABLE_STATE_KEYS = new Set([
  'state:regionId',
  'state:providerId',
  'state:feedEpoch',
  'state:sequence',
  'state:consecutiveFailures',
  'state:nextPollAt',
  'state:circuitOpenUntil',
  'state:nextRetryAt',
  'state:retryBlocked',
  'state:lastSuccessAt',
  'state:lastProviderGeneratedAt',
  'state:metricCleanupRetryAt',
  'state:lastMetricCleanupAt',
]);
const METRIC_KEYS = Object.freeze([
  'metricsVersion',
  'hour',
  'pollCount',
  'successCount',
  'failureCount',
  'rateLimitCount',
  'acceptedSnapshotCount',
  'rejectedSnapshotCount',
  'invalidFieldCount',
  'deliveryAcknowledgmentCount',
  'deliveryTimeoutCount',
  'deliverySendFailureCount',
  'deliveryInvalidControlCount',
  'deliveryHibernationLossCount',
  'aircraftCountSum',
  'aircraftCountMinimum',
  'aircraftCountMaximum',
  'latencyBuckets',
] as const);
const LATENCY_BUCKET_KEYS = Object.freeze([
  'under250Ms',
  'under500Ms',
  'under1000Ms',
  'under2500Ms',
  'over2500Ms',
] as const);
const ATTACHMENT_KEYS = Object.freeze([
  'attachmentVersion',
  'providerId',
  'regionId',
  'feedEpoch',
  'pending',
  'lastTurn',
  'pendingPingId',
  'lastPingAt',
  'controlWindowStartedAt',
  'controlCount',
  'outstanding',
] as const);
const OUTSTANDING_KEYS = Object.freeze(['deliveryId', 'expiresAt', 'bytes', 'sent'] as const);

type PinnedArtifactIdentity = Readonly<{ bytes: number; sha256: string }>;
const PINNED_ARTIFACT_IDENTITIES = new Map<string, PinnedArtifactIdentity>();

function pinOpaque(path: string, bytes: number, digest: string): void {
  PINNED_ARTIFACT_IDENTITIES.set(path, Object.freeze({ bytes, sha256: digest }));
}

for (const asset of mapManifest.assets) {
  const suffix = `map_assets/${mapManifest.id}/${asset.path}`;
  pinOpaque(suffix, asset.bytes, asset.sha256);
  pinOpaque(`artifact/${suffix}`, asset.bytes, asset.sha256);
}
for (const file of rollbackManifest.runtimeFiles) {
  if (/\.woff2?$/iu.test(file.path)) {
    pinOpaque(`client/${file.path}`, file.bytes, file.sha256);
    pinOpaque(`artifact/client/${file.path}`, file.bytes, file.sha256);
  }
  pinOpaque(`client/Aviation-Dashboard-Project/${file.path}`, file.bytes, file.sha256);
  pinOpaque(`artifact/client/Aviation-Dashboard-Project/${file.path}`, file.bytes, file.sha256);
  if (file.path === rollbackManifest.runtimePolicy.entryPath) {
    pinOpaque('client/v2.html', file.bytes, file.sha256);
    pinOpaque('artifact/client/v2.html', file.bytes, file.sha256);
  }
}
pinOpaque(
  'evidence/rollback-v2.2.0/pages-build.tar.gz',
  rollbackManifest.archive.bytes,
  rollbackManifest.archive.sha256,
);
pinOpaque(
  'rollback/v2.2.0/pages-build.tar.gz',
  rollbackManifest.archive.bytes,
  rollbackManifest.archive.sha256,
);

export type OperationsPrivacyAuditErrorCode =
  | 'FORBIDDEN_VALUE'
  | 'HASH_MISMATCH'
  | 'INVALID_G2_EVIDENCE'
  | 'INVALID_INVENTORY'
  | 'UNDECLARED_FILE'
  | 'UNKNOWN_FIELD'
  | 'UNSAFE_NODE';

export class OperationsPrivacyAuditError extends Error {
  readonly code: OperationsPrivacyAuditErrorCode;

  constructor(code: OperationsPrivacyAuditErrorCode, message: string) {
    super(message);
    this.name = 'OperationsPrivacyAuditError';
    this.code = code;
  }
}

export interface NamedAggregateArtifact {
  readonly path: (typeof G2_RETAINED_FILES)[number];
  readonly value: unknown;
}

export interface AggregateArtifactSet {
  readonly artifacts: readonly NamedAggregateArtifact[];
}

export interface G2ExpectedIdentity {
  readonly candidateId: string;
  readonly policyId: string;
  readonly sourceHead: string;
}

export interface AggregateEvidenceDirectoryDeclaration {
  readonly root: string;
  readonly mode: 'empty' | 'g2-bundle';
}

export interface BrowserStorageSnapshot {
  readonly localStorage: readonly never[];
  readonly sessionStorage: readonly never[];
  readonly cookies: readonly never[];
  readonly indexedDbDatabases: readonly never[];
  readonly cacheStorageKeys: readonly never[];
  readonly opfsEntries: readonly never[];
  readonly serviceWorkers: readonly never[];
}

export interface ScreenshotMetadata {
  readonly files: readonly never[];
  readonly outputDirectory: AggregateEvidenceDirectoryDeclaration;
}

export interface PrivacyTreeFileRule {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface PrivacyTreeDeclaration {
  readonly root: string;
  readonly files: readonly PrivacyTreeFileRule[];
}

export interface PrivacyTreeExpectedIdentity {
  readonly schemaVersion: typeof PRIVACY_TREE_IDENTITY_VERSION;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly sha256: string;
}

export interface OperationsPrivacyTreeSelections {
  readonly retainedCandidates: readonly PrivacyTreeExpectedIdentity[];
  readonly releases: readonly PrivacyTreeExpectedIdentity[];
}

export interface OperationsPrivacyInventoryV1 {
  readonly schemaVersion: typeof OPERATIONS_PRIVACY_INVENTORY_VERSION;
  readonly apiValues: readonly unknown[];
  readonly durableObjectStorageValues: readonly unknown[];
  readonly hibernationAttachments: readonly unknown[];
  readonly browserStorage: BrowserStorageSnapshot;
  readonly browserDownloads: AggregateEvidenceDirectoryDeclaration;
  readonly reports: AggregateEvidenceDirectoryDeclaration;
  readonly testResults: AggregateEvidenceDirectoryDeclaration;
  readonly screenshotMetadata: ScreenshotMetadata;
  readonly retainedCandidates: readonly PrivacyTreeDeclaration[];
  readonly releases: readonly PrivacyTreeDeclaration[];
}

export interface G2EvidenceManifestV1 {
  readonly schemaVersion: typeof G2_EVIDENCE_MANIFEST_VERSION;
  readonly auditSchemaVersion: typeof OPERATIONS_PRIVACY_AUDIT_VERSION;
  readonly evidencePolicy: typeof G2_EVIDENCE_POLICY;
  readonly candidateId: string;
  readonly policyId: string;
  readonly sourceHead: string;
  readonly expectedFiles: typeof G2_RETAINED_FILES;
  readonly capture: {
    readonly screenshots: false;
    readonly traces: false;
    readonly video: false;
    readonly har: false;
    readonly responseBodies: false;
    readonly retries: 0;
    readonly detail: 'aggregate-only';
  };
}

export interface G2AggregateReceiptV1 {
  readonly schemaVersion: typeof G2_AGGREGATE_RECEIPT_VERSION;
  readonly evidencePolicy: typeof G2_EVIDENCE_POLICY;
  readonly candidateId: string;
  readonly policyId: string;
  readonly sourceHead: string;
  readonly result: 'fail' | 'pass';
  readonly regionScope: 'three-fixed-georgia-regions';
  readonly counters: {
    readonly requestCount: number;
    readonly regionCount: 3;
    readonly availableRegionCount: number;
    readonly emptyRegionCount: number;
    readonly nonemptyRegionCount: number;
    readonly failedRegionCount: number;
    readonly rateLimitCount: number;
  };
  readonly timing: {
    readonly durationMs: number;
    readonly maximumObservationAgeSeconds: number | null;
  };
  readonly limitations: readonly [
    'valid-empty-proves-connectivity-only',
    'nonempty-validated-observation-required-for-real-data-claim',
    'not-global-availability-proof',
  ];
}

export interface OperationsPrivacyAuditReceiptV1 {
  readonly schemaVersion: typeof OPERATIONS_PRIVACY_AUDIT_VERSION;
  readonly evidencePolicy: typeof G2_EVIDENCE_POLICY;
  readonly result: 'pass';
  readonly surfaces: {
    readonly apiValues: number;
    readonly durableObjectStorageValues: number;
    readonly hibernationAttachments: number;
    readonly browserStorageEntries: 0;
    readonly browserDownloadFiles: number;
    readonly reportFiles: number;
    readonly testResultFiles: number;
    readonly screenshotFiles: 0;
    readonly retainedCandidateFiles: number;
    readonly releaseFiles: number;
  };
}

type JsonRecord = Record<string, unknown>;

function failure(code: OperationsPrivacyAuditErrorCode, message: string): never {
  throw new OperationsPrivacyAuditError(code, message);
}

function record(value: unknown, label: string): JsonRecord {
  if (!isJsonRecord(value)) failure('INVALID_INVENTORY', `${label} must be a plain object.`);
  if (
    Reflect.ownKeys(value).some((key) => {
      if (typeof key !== 'string') return true;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return !descriptor?.enumerable || !('value' in descriptor);
    })
  ) {
    failure('INVALID_INVENTORY', `${label} must contain enumerable JSON data fields only.`);
  }
  return value;
}

function assertExactKeys(value: JsonRecord, keys: readonly string[], label: string): void {
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => typeof key !== 'string' || !keys.includes(key)) ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    failure('UNKNOWN_FIELD', `${label} is outside its exact field allowlist.`);
  }
}

function assertAllowedAndRequiredKeys(
  value: JsonRecord,
  allowed: readonly string[],
  required: readonly string[],
  label: string,
): void {
  const actual = Reflect.ownKeys(value);
  if (
    actual.some((key) => typeof key !== 'string' || !allowed.includes(key)) ||
    required.some((key) => !Object.hasOwn(value, key))
  ) {
    failure('UNKNOWN_FIELD', `${label} is outside its field allowlist.`);
  }
}

function assertBoundedInteger(
  value: unknown,
  label: string,
  maximum = MAX_OPERATIONS_COUNTER,
): void {
  if (!isSafeInteger(value, 0, maximum)) {
    failure('FORBIDDEN_VALUE', `${label} must be a bounded nonnegative integer.`);
  }
}

function assertTimestampNumber(value: unknown, label: string): void {
  if (!validPollTimestamp(value)) {
    failure('FORBIDDEN_VALUE', `${label} must be a valid bounded timestamp.`);
  }
}

function assertForbiddenScalarString(value: string, label: string): void {
  try {
    assertOperationsPrivacy(value);
    assertPrivacySafeTextArtifact(value, `${label}.txt`);
  } catch (error) {
    failure(
      'FORBIDDEN_VALUE',
      `${label} contains a forbidden URL, address, path, credential, or unbounded value: ${error instanceof Error ? error.message : 'privacy rejection'}`,
    );
  }
  if (
    IPV4.test(value) ||
    IPV6.test(value) ||
    COMPLETE_URL.test(value) ||
    AIRCRAFT_IDENTIFIER.test(value) ||
    REGISTRATION.test(value) ||
    CALLSIGN.test(value) ||
    COORDINATE_PAIR.test(value) ||
    USER_AGENT.test(value) ||
    RAW_PROVIDER_PAYLOAD.test(value) ||
    CLIENT_SENTINEL.test(value) ||
    REQUEST_SENTINEL.test(value)
  ) {
    failure('FORBIDDEN_VALUE', `${label} contains a forbidden operational sentinel.`);
  }
}

function assertBoundedScalarTree(value: unknown, label: string): void {
  const stack: Array<{ value: unknown; label: string; depth: number }> = [
    { value, label, depth: 0 },
  ];
  const visited = new WeakSet<object>();
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > MAX_SCAN_NODES || current.depth > MAX_SCAN_DEPTH) {
      failure('FORBIDDEN_VALUE', `${label} exceeds the bounded privacy scan.`);
    }
    if (typeof current.value === 'string') {
      assertForbiddenScalarString(current.value, current.label);
      continue;
    }
    if (typeof current.value !== 'object' || current.value === null) continue;
    if (visited.has(current.value)) {
      failure('FORBIDDEN_VALUE', `${current.label} contains a repeated or cyclic object.`);
    }
    visited.add(current.value);
    if (Array.isArray(current.value)) {
      if (current.value.length > MAX_SCAN_NODES) {
        failure('FORBIDDEN_VALUE', `${current.label} contains an unbounded array.`);
      }
      current.value.forEach((entry, index) =>
        stack.push({ value: entry, label: `${current.label}[${index}]`, depth: current.depth + 1 }),
      );
      continue;
    }
    if (!isJsonRecord(current.value)) {
      failure('FORBIDDEN_VALUE', `${current.label} must contain JSON values only.`);
    }
    const keys = Reflect.ownKeys(current.value);
    for (const key of keys) {
      if (typeof key !== 'string') {
        failure('FORBIDDEN_VALUE', `${current.label} contains a non-JSON field.`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(current.value, key);
      if (!descriptor?.enumerable || !('value' in descriptor)) {
        failure('FORBIDDEN_VALUE', `${current.label} contains a non-data field.`);
      }
      const entry = descriptor.value;
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, '');
      if (STRUCTURED_FORBIDDEN_KEY.test(normalized) && !ALLOWED_AIRCRAFT_AGGREGATES.has(key)) {
        failure('FORBIDDEN_VALUE', `${current.label}.${key} is a forbidden operational field.`);
      }
      stack.push({
        value: entry,
        label: `${current.label}.${key}`,
        depth: current.depth + 1,
      });
    }
  }
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (!isLiveIdentifier(value)) failure('FORBIDDEN_VALUE', `${label} is not a bounded identifier.`);
  assertForbiddenScalarString(value, label);
}

function assertMetricRow(value: unknown, key: string, label: string): void {
  const row = record(value, label);
  assertExactKeys(row, METRIC_KEYS, label);
  const expectedHour = key.slice('metrics:'.length);
  if (
    row.metricsVersion !== 'operations-metrics.v1' ||
    row.hour !== expectedHour ||
    !isCanonicalTimestamp(row.hour)
  ) {
    failure('FORBIDDEN_VALUE', `${label} has an invalid version or hour.`);
  }
  for (const counter of METRIC_KEYS.slice(2, -1)) {
    if (counter === 'aircraftCountMinimum' || counter === 'aircraftCountMaximum') {
      if (row[counter] !== null) assertBoundedInteger(row[counter], `${label}.${counter}`);
    } else {
      assertBoundedInteger(row[counter], `${label}.${counter}`);
    }
  }
  const buckets = record(row.latencyBuckets, `${label}.latencyBuckets`);
  assertExactKeys(buckets, LATENCY_BUCKET_KEYS, `${label}.latencyBuckets`);
  for (const key of LATENCY_BUCKET_KEYS) {
    assertBoundedInteger(buckets[key], `${label}.latencyBuckets.${key}`);
  }
  assertBoundedScalarTree(row, label);
}

export function assertDurableObjectStoragePrivacy(value: unknown): void {
  const storage = record(value, 'Durable Object storage');
  for (const [key, entry] of Object.entries(storage)) {
    if (key.startsWith('metrics:')) {
      assertMetricRow(entry, key, `Durable Object storage.${key}`);
      continue;
    }
    if (!DURABLE_STATE_KEYS.has(key)) {
      failure('UNKNOWN_FIELD', `Durable Object storage contains undeclared key ${key}.`);
    }
    const label = `Durable Object storage.${key}`;
    switch (key) {
      case 'state:regionId':
        if (!OPERATIONS_REGION_IDS.includes(entry as (typeof OPERATIONS_REGION_IDS)[number])) {
          failure('FORBIDDEN_VALUE', `${label} is not a declared region.`);
        }
        break;
      case 'state:providerId':
      case 'state:feedEpoch':
        assertIdentifier(entry, label);
        break;
      case 'state:retryBlocked':
        if (typeof entry !== 'boolean') failure('FORBIDDEN_VALUE', `${label} must be boolean.`);
        break;
      case 'state:lastSuccessAt':
      case 'state:lastProviderGeneratedAt':
        if (!isCanonicalTimestamp(entry)) {
          failure('FORBIDDEN_VALUE', `${label} must be a canonical timestamp.`);
        }
        assertForbiddenScalarString(entry, label);
        break;
      case 'state:sequence':
      case 'state:consecutiveFailures':
        assertBoundedInteger(entry, label);
        break;
      default:
        assertTimestampNumber(entry, label);
    }
  }
}

export function assertHibernationAttachmentPrivacy(value: unknown): void {
  const attachment = record(value, 'Hibernation attachment');
  const actualKeys = Object.keys(attachment);
  if (
    actualKeys.some((key) => !ATTACHMENT_KEYS.includes(key as (typeof ATTACHMENT_KEYS)[number]))
  ) {
    failure('UNKNOWN_FIELD', 'Hibernation attachment contains an undeclared field.');
  }
  for (const required of [
    'attachmentVersion',
    'providerId',
    'regionId',
    'feedEpoch',
    'pending',
    'lastTurn',
  ]) {
    if (!Object.hasOwn(attachment, required)) {
      failure('UNKNOWN_FIELD', `Hibernation attachment is missing ${required}.`);
    }
  }
  if (attachment.attachmentVersion !== 'delivery.v1') {
    failure('FORBIDDEN_VALUE', 'Hibernation attachment has an invalid version.');
  }
  assertIdentifier(attachment.providerId, 'Hibernation attachment.providerId');
  if (
    !OPERATIONS_REGION_IDS.includes(attachment.regionId as (typeof OPERATIONS_REGION_IDS)[number])
  ) {
    failure('FORBIDDEN_VALUE', 'Hibernation attachment.regionId is not declared.');
  }
  assertIdentifier(attachment.feedEpoch, 'Hibernation attachment.feedEpoch');
  assertBoundedInteger(attachment.pending, 'Hibernation attachment.pending', 7);
  if (!isSafeInteger(attachment.lastTurn)) {
    failure('FORBIDDEN_VALUE', 'Hibernation attachment.lastTurn must be a safe integer.');
  }
  if (attachment.pendingPingId !== undefined) {
    assertIdentifier(attachment.pendingPingId, 'Hibernation attachment.pendingPingId');
    if (attachment.lastPingAt === undefined) {
      failure('FORBIDDEN_VALUE', 'Hibernation attachment ping metadata is incomplete.');
    }
  }
  if (attachment.lastPingAt !== undefined) {
    assertTimestampNumber(attachment.lastPingAt, 'Hibernation attachment.lastPingAt');
  }
  if (
    (attachment.controlWindowStartedAt === undefined) !==
    (attachment.controlCount === undefined)
  ) {
    failure('FORBIDDEN_VALUE', 'Hibernation attachment control metadata is incomplete.');
  }
  if (attachment.controlWindowStartedAt !== undefined) {
    assertTimestampNumber(
      attachment.controlWindowStartedAt,
      'Hibernation attachment.controlWindowStartedAt',
    );
    if (!isSafeInteger(attachment.controlCount, 1, MAX_SOCKET_CONTROLS_PER_WINDOW)) {
      failure('FORBIDDEN_VALUE', 'Hibernation attachment.controlCount is out of bounds.');
    }
  }
  if (attachment.outstanding !== undefined) {
    const outstanding = record(attachment.outstanding, 'Hibernation attachment.outstanding');
    assertExactKeys(outstanding, OUTSTANDING_KEYS, 'Hibernation attachment.outstanding');
    assertIdentifier(outstanding.deliveryId, 'Hibernation attachment.outstanding.deliveryId');
    assertTimestampNumber(outstanding.expiresAt, 'Hibernation attachment.outstanding.expiresAt');
    if (!isSafeInteger(outstanding.bytes, 1, MAX_LIVE_MESSAGE_BYTES)) {
      failure('FORBIDDEN_VALUE', 'Hibernation attachment.outstanding.bytes is out of bounds.');
    }
    if (typeof outstanding.sent !== 'boolean') {
      failure('FORBIDDEN_VALUE', 'Hibernation attachment.outstanding.sent must be boolean.');
    }
  }
  if (Buffer.byteLength(JSON.stringify(attachment), 'utf8') > MAX_VIEWER_ATTACHMENT_BYTES) {
    failure('FORBIDDEN_VALUE', 'Hibernation attachment exceeds the bounded byte policy.');
  }
  assertBoundedScalarTree(attachment, 'Hibernation attachment');
}

function parseG2Manifest(value: unknown): G2EvidenceManifestV1 {
  const manifest = record(value, 'G2 evidence manifest');
  assertExactKeys(
    manifest,
    [
      'schemaVersion',
      'auditSchemaVersion',
      'evidencePolicy',
      'candidateId',
      'policyId',
      'sourceHead',
      'expectedFiles',
      'capture',
    ],
    'G2 evidence manifest',
  );
  const capture = record(manifest.capture, 'G2 evidence manifest.capture');
  assertExactKeys(
    capture,
    ['screenshots', 'traces', 'video', 'har', 'responseBodies', 'retries', 'detail'],
    'G2 evidence manifest.capture',
  );
  if (
    manifest.schemaVersion !== G2_EVIDENCE_MANIFEST_VERSION ||
    manifest.auditSchemaVersion !== OPERATIONS_PRIVACY_AUDIT_VERSION ||
    manifest.evidencePolicy !== G2_EVIDENCE_POLICY ||
    typeof manifest.candidateId !== 'string' ||
    !SHA256.test(manifest.candidateId) ||
    typeof manifest.policyId !== 'string' ||
    !SHA256.test(manifest.policyId) ||
    typeof manifest.sourceHead !== 'string' ||
    !SOURCE_HEAD.test(manifest.sourceHead) ||
    !Array.isArray(manifest.expectedFiles) ||
    JSON.stringify(manifest.expectedFiles) !== JSON.stringify(G2_RETAINED_FILES) ||
    capture.screenshots !== false ||
    capture.traces !== false ||
    capture.video !== false ||
    capture.har !== false ||
    capture.responseBodies !== false ||
    capture.retries !== 0 ||
    capture.detail !== 'aggregate-only'
  ) {
    failure('INVALID_G2_EVIDENCE', 'G2 evidence manifest is outside the no-capture policy.');
  }
  assertBoundedScalarTree(manifest, 'G2 evidence manifest');
  return manifest as unknown as G2EvidenceManifestV1;
}

function parseG2Receipt(value: unknown): G2AggregateReceiptV1 {
  const receipt = record(value, 'G2 aggregate receipt');
  assertExactKeys(
    receipt,
    [
      'schemaVersion',
      'evidencePolicy',
      'candidateId',
      'policyId',
      'sourceHead',
      'result',
      'regionScope',
      'counters',
      'timing',
      'limitations',
    ],
    'G2 aggregate receipt',
  );
  const counters = record(receipt.counters, 'G2 aggregate receipt.counters');
  assertExactKeys(
    counters,
    [
      'requestCount',
      'regionCount',
      'availableRegionCount',
      'emptyRegionCount',
      'nonemptyRegionCount',
      'failedRegionCount',
      'rateLimitCount',
    ],
    'G2 aggregate receipt.counters',
  );
  const timing = record(receipt.timing, 'G2 aggregate receipt.timing');
  assertExactKeys(
    timing,
    ['durationMs', 'maximumObservationAgeSeconds'],
    'G2 aggregate receipt.timing',
  );
  if (
    receipt.schemaVersion !== G2_AGGREGATE_RECEIPT_VERSION ||
    receipt.evidencePolicy !== G2_EVIDENCE_POLICY ||
    typeof receipt.candidateId !== 'string' ||
    !SHA256.test(receipt.candidateId) ||
    typeof receipt.policyId !== 'string' ||
    !SHA256.test(receipt.policyId) ||
    typeof receipt.sourceHead !== 'string' ||
    !SOURCE_HEAD.test(receipt.sourceHead) ||
    (receipt.result !== 'pass' && receipt.result !== 'fail') ||
    receipt.regionScope !== 'three-fixed-georgia-regions' ||
    counters.regionCount !== 3 ||
    !Array.isArray(receipt.limitations) ||
    JSON.stringify(receipt.limitations) !==
      JSON.stringify([
        'valid-empty-proves-connectivity-only',
        'nonempty-validated-observation-required-for-real-data-claim',
        'not-global-availability-proof',
      ])
  ) {
    failure('INVALID_G2_EVIDENCE', 'G2 aggregate receipt is outside the closed policy.');
  }
  for (const key of Object.keys(counters)) {
    assertBoundedInteger(counters[key], `G2 aggregate receipt.counters.${key}`);
  }
  assertBoundedInteger(timing.durationMs, 'G2 aggregate receipt.timing.durationMs', 3_600_000);
  if (timing.maximumObservationAgeSeconds !== null) {
    assertBoundedInteger(
      timing.maximumObservationAgeSeconds,
      'G2 aggregate receipt.timing.maximumObservationAgeSeconds',
    );
  }
  const classifiedRegions =
    (counters.availableRegionCount as number) + (counters.failedRegionCount as number);
  const observedRegions =
    (counters.emptyRegionCount as number) + (counters.nonemptyRegionCount as number);
  if (
    classifiedRegions !== 3 ||
    observedRegions !== (counters.availableRegionCount as number) ||
    (counters.requestCount as number) !== 1 ||
    (counters.rateLimitCount as number) > 3 ||
    ((counters.nonemptyRegionCount as number) === 0) !==
      (timing.maximumObservationAgeSeconds === null) ||
    (receipt.result === 'pass' &&
      ((counters.availableRegionCount as number) !== 3 ||
        (counters.nonemptyRegionCount as number) < 1 ||
        (counters.failedRegionCount as number) !== 0 ||
        (counters.rateLimitCount as number) !== 0 ||
        (timing.durationMs as number) < 1))
  ) {
    failure('INVALID_G2_EVIDENCE', 'G2 aggregate counters are internally inconsistent.');
  }
  assertBoundedScalarTree(receipt, 'G2 aggregate receipt');
  return receipt as unknown as G2AggregateReceiptV1;
}

function parseG2ExpectedIdentity(value: unknown): G2ExpectedIdentity {
  const expected = record(value, 'G2 expected identity');
  assertExactKeys(expected, ['candidateId', 'policyId', 'sourceHead'], 'G2 expected identity');
  if (
    typeof expected.candidateId !== 'string' ||
    !SHA256.test(expected.candidateId) ||
    typeof expected.policyId !== 'string' ||
    !SHA256.test(expected.policyId) ||
    typeof expected.sourceHead !== 'string' ||
    !SOURCE_HEAD.test(expected.sourceHead)
  ) {
    failure('INVALID_G2_EVIDENCE', 'G2 expected identity is invalid.');
  }
  return expected as unknown as G2ExpectedIdentity;
}

export function assertG2AggregateArtifacts(
  value: unknown,
  expectedIdentity?: G2ExpectedIdentity,
): {
  readonly manifest?: G2EvidenceManifestV1;
  readonly receipt?: G2AggregateReceiptV1;
} {
  const set = record(value, 'Aggregate artifact set');
  assertExactKeys(set, ['artifacts'], 'Aggregate artifact set');
  if (!Array.isArray(set.artifacts)) {
    failure('INVALID_G2_EVIDENCE', 'Aggregate artifact set must contain an artifacts array.');
  }
  if (set.artifacts.length === 0) return {};
  if (expectedIdentity === undefined) {
    failure('INVALID_G2_EVIDENCE', 'G2 evidence requires an external expected identity.');
  }
  const expected = parseG2ExpectedIdentity(expectedIdentity);
  if (set.artifacts.length !== G2_RETAINED_FILES.length) {
    failure('UNDECLARED_FILE', 'G2 evidence must contain the exact retained file set.');
  }
  const byPath = new Map<string, unknown>();
  for (const item of set.artifacts) {
    const artifact = record(item, 'Aggregate artifact');
    assertExactKeys(artifact, ['path', 'value'], 'Aggregate artifact');
    if (typeof artifact.path !== 'string' || !G2_RETAINED_FILES.includes(artifact.path as never)) {
      failure('UNDECLARED_FILE', 'G2 evidence contains an undeclared file.');
    }
    if (byPath.has(artifact.path)) failure('UNDECLARED_FILE', 'G2 evidence repeats a file.');
    byPath.set(artifact.path, artifact.value);
  }
  const manifest = parseG2Manifest(byPath.get('g2-evidence-manifest.json'));
  const receipt = parseG2Receipt(byPath.get('g2-aggregate-receipt.json'));
  if (
    manifest.candidateId !== receipt.candidateId ||
    manifest.policyId !== receipt.policyId ||
    manifest.sourceHead !== receipt.sourceHead ||
    manifest.candidateId !== expected.candidateId ||
    manifest.policyId !== expected.policyId ||
    manifest.sourceHead !== expected.sourceHead
  ) {
    failure('INVALID_G2_EVIDENCE', 'G2 manifest and receipt identities do not match.');
  }
  return { manifest, receipt };
}

function normalizedPath(path: string): string {
  return path.replaceAll('\\', '/');
}

function assertRelativeFilePath(path: unknown, label: string): asserts path is string {
  if (
    typeof path !== 'string' ||
    path.length < 1 ||
    path.length > 512 ||
    path !== normalizedPath(path) ||
    path.startsWith('/') ||
    path.endsWith('/') ||
    path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..') ||
    (FORBIDDEN_CAPTURE_PATH.test(path) && !PINNED_ARTIFACT_IDENTITIES.has(path))
  ) {
    failure('UNDECLARED_FILE', `${label} is not an allowed evidence path.`);
  }
  try {
    assertPrivacySafeTextArtifact(path, `${label}.txt`);
  } catch (error) {
    failure(
      'FORBIDDEN_VALUE',
      `${label} contains a forbidden path or credential sentinel: ${error instanceof Error ? error.message : 'privacy rejection'}`,
    );
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function privacyTreeExpectedIdentity(
  files: readonly PrivacyTreeFileRule[],
): PrivacyTreeExpectedIdentity {
  const ordered = [...files].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  const digest = createHash('sha256');
  digest.update(`${PRIVACY_TREE_IDENTITY_VERSION}\0`);
  let totalBytes = 0;
  const seen = new Set<string>();
  for (const value of ordered) {
    const file = record(value, 'Privacy tree identity file');
    assertExactKeys(file, ['path', 'sha256', 'bytes'], 'Privacy tree identity file');
    assertRelativeFilePath(file.path, 'Privacy tree identity file.path');
    if (
      typeof file.sha256 !== 'string' ||
      !SHA256.test(file.sha256) ||
      !isSafeInteger(file.bytes, 1, MAX_OPAQUE_BYTES) ||
      seen.has(file.path)
    ) {
      failure('INVALID_INVENTORY', 'Privacy tree identity contains an invalid file rule.');
    }
    seen.add(file.path);
    totalBytes += file.bytes;
    if (!Number.isSafeInteger(totalBytes)) {
      failure('INVALID_INVENTORY', 'Privacy tree identity total bytes overflowed.');
    }
    digest.update(file.path);
    digest.update('\0');
    digest.update(String(file.bytes));
    digest.update('\0');
    digest.update(file.sha256);
    digest.update('\0');
  }
  if (ordered.length === 0) {
    failure('INVALID_INVENTORY', 'Privacy tree identity must contain at least one file.');
  }
  return Object.freeze({
    schemaVersion: PRIVACY_TREE_IDENTITY_VERSION,
    fileCount: ordered.length,
    totalBytes,
    sha256: digest.digest('hex'),
  });
}

function parsePrivacyTreeExpectedIdentity(value: unknown): PrivacyTreeExpectedIdentity {
  const identity = record(value, 'Privacy tree expected identity');
  assertExactKeys(
    identity,
    ['schemaVersion', 'fileCount', 'totalBytes', 'sha256'],
    'Privacy tree expected identity',
  );
  if (
    identity.schemaVersion !== PRIVACY_TREE_IDENTITY_VERSION ||
    !isSafeInteger(identity.fileCount, 1, MAX_TREE_FILES) ||
    !isSafeInteger(identity.totalBytes, 1, Number.MAX_SAFE_INTEGER) ||
    typeof identity.sha256 !== 'string' ||
    !SHA256.test(identity.sha256)
  ) {
    failure('INVALID_INVENTORY', 'Privacy tree expected identity is malformed.');
  }
  return identity as unknown as PrivacyTreeExpectedIdentity;
}

const TRUSTED_STATIC_JSON_PATH =
  /^(?:(?:artifact\/)?(?:client\/runtime-policy\.json|airspace_worker\/(?:wrangler\.json|\.vite\/manifest\.json)|mock_provider\/wrangler\.json)|evidence\/(?:map-manifest|provenance|sbom\.cdx)\.json|evidence\/rollback-v2\.2\.0\/manifest\.json)$/u;
const DEPLOYABLE_TEXT_ROLE =
  /^(?:artifact\/)?(?:airspace_worker\/(?:index\.js|wrangler\.json|\.vite\/manifest\.json)|mock_provider\/(?:index\.js|wrangler\.json)|client\/(?:\.assetsignore|_headers|_redirects|index\.html|live\.html|runtime-policy\.json|assets\/(?:app\.js|(?:LabApp|OnlineEvidenceApp|ReplayApp|auto|jsx-runtime|live-main|liveChartRenderer|mapRenderer|maplibre-gl-worker|shared|types|validation)-[A-Za-z0-9_-]{8}\.(?:css|js))))$/u;
const MANIFEST_BOUND_MAP_ASSET_ROLE =
  /^(?:artifact\/)?map_assets\/[a-z0-9][a-z0-9._-]{0,127}\/.+\.(?:pbf|pmtiles)$/u;
const FIXED_PRIVACY_TREE_TEXT_PATHS = new Set([
  'checksums.sha256',
  'evidence/aggregate.json',
  'evidence/summary.txt',
  'evidence/map-manifest.json',
  'evidence/provenance.json',
  'evidence/sbom.cdx.json',
  'evidence/rollback-v2.2.0/manifest.json',
  'evidence/rollback-v2.2.0/release-checksums.sha256',
]);
const STRUCTURED_TEXT_ROLE =
  /^(?:(?:artifact\/)?client\/(?:\.assetsignore|_headers|_redirects)|checksums\.sha256|evidence\/rollback-v2\.2\.0\/release-checksums\.sha256)$/u;
const GENERATED_HEADER_NAMES = new Set([
  'Content-Security-Policy',
  'Cross-Origin-Opener-Policy',
  'Cross-Origin-Resource-Policy',
  'Permissions-Policy',
  'Referrer-Policy',
  'X-Content-Type-Options',
  'X-Frame-Options',
]);

function isDeclaredTextRole(path: string): boolean {
  return FIXED_PRIVACY_TREE_TEXT_PATHS.has(path) || DEPLOYABLE_TEXT_ROLE.test(path);
}

const AGGREGATE_JSON_FIELDS = Object.freeze({
  'candidate-aggregate.v1': Object.freeze(['schemaVersion', 'result']),
  'release-aggregate.v1': Object.freeze(['schemaVersion', 'result']),
} as const);

function assertAggregateOnlyJsonPrivacy(value: unknown, label: string): void {
  const document = record(value, label);
  const schemaVersion = document.schemaVersion;
  if (typeof schemaVersion !== 'string' || !Object.hasOwn(AGGREGATE_JSON_FIELDS, schemaVersion)) {
    failure('FORBIDDEN_VALUE', `${label} does not use a declared aggregate-only schema.`);
  }
  const fields = AGGREGATE_JSON_FIELDS[schemaVersion as keyof typeof AGGREGATE_JSON_FIELDS];
  assertExactKeys(document, fields, label);
  if (document.result !== 'pass' && document.result !== 'fail') {
    failure('FORBIDDEN_VALUE', `${label}.result is outside the aggregate-only vocabulary.`);
  }
  assertBoundedScalarTree(document, label);
}

function assertStructuredTextRole(value: string, label: string): void {
  if (Buffer.byteLength(value) > 2 * 1024 * 1024) {
    failure('FORBIDDEN_VALUE', `${label} exceeds its bounded structured-text role.`);
  }
  if (label === 'evidence/rollback-v2.2.0/release-checksums.sha256') {
    if (sha256(Buffer.from(value, 'utf8')) !== rollbackManifest.releaseChecksums.sha256) {
      failure('FORBIDDEN_VALUE', `${label} is not the pinned historical rollback checksum set.`);
    }
    return;
  }
  if (/(?:^|\/)client\/\.assetsignore$/u.test(label)) {
    if (value !== 'wrangler.json\n.dev.vars\n') {
      failure('FORBIDDEN_VALUE', `${label} is outside its exact content allowlist.`);
    }
    return;
  }
  if (/(?:^|\/)client\/_redirects$/u.test(label)) {
    if (
      value !==
      '/ /index.html 200\n/Aviation-Dashboard-Project/ /Aviation-Dashboard-Project/index.html 200\n'
    ) {
      failure('FORBIDDEN_VALUE', `${label} is outside its exact content allowlist.`);
    }
    return;
  }
  const lines = value.trimEnd().split(/\r?\n/u);
  if (lines.length > MAX_TREE_FILES || lines.some((line) => line.length > 2_048)) {
    failure('FORBIDDEN_VALUE', `${label} contains unbounded structured text.`);
  }
  if (/(?:^|\/)client\/_headers$/u.test(label)) {
    if (lines[0] !== '/*' || lines.length !== GENERATED_HEADER_NAMES.size + 1) {
      failure('FORBIDDEN_VALUE', `${label} is outside its exact header allowlist.`);
    }
    const observed = new Set<string>();
    for (const line of lines.slice(1)) {
      const match = /^ {2}([A-Za-z-]+):\s+.+$/u.exec(line);
      if (!match || !GENERATED_HEADER_NAMES.has(match[1]!) || observed.has(match[1]!)) {
        failure('FORBIDDEN_VALUE', `${label} is outside its exact header allowlist.`);
      }
      observed.add(match[1]!);
    }
    return;
  }
  for (const line of lines) {
    const match = /^([a-f0-9]{64}) {2}(.+)$/u.exec(line);
    if (!match) failure('FORBIDDEN_VALUE', `${label} is not a SHA-256 allowlist.`);
    assertRelativeFilePath(match[2], `${label} checksum path`);
  }
}

function exactObject(value: unknown, keys: readonly string[], label: string): JsonRecord {
  const object = record(value, label);
  assertExactKeys(object, keys, label);
  return object;
}

function assertExactArrayObjects(value: unknown, keys: readonly string[], label: string): void {
  if (!Array.isArray(value)) failure('INVALID_INVENTORY', `${label} must be an array.`);
  value.forEach((entry, index) => exactObject(entry, keys, `${label}[${index}]`));
}

function assertRollbackProvenanceFieldAllowlist(value: unknown, label: string): void {
  const rollback = exactObject(
    value,
    [
      'schemaVersion',
      'releaseTag',
      'sourceRevision',
      'publishedAt',
      'archive',
      'manifest',
      'releaseChecksums',
      'runtimePolicy',
      'runtimeFiles',
      'publicFiles',
      'excludedPublicSourceMaps',
      'excludedNonRuntimeFiles',
    ],
    label,
  );
  exactObject(
    rollback.archive,
    ['sourcePath', 'candidatePath', 'bytes', 'sha256'],
    `${label}.archive`,
  );
  exactObject(
    rollback.manifest,
    ['sourcePath', 'candidatePath', 'bytes', 'sha256'],
    `${label}.manifest`,
  );
  exactObject(
    rollback.releaseChecksums,
    ['sourcePath', 'candidatePath', 'bytes', 'sha256'],
    `${label}.releaseChecksums`,
  );
  exactObject(
    rollback.runtimePolicy,
    [
      'entryPath',
      'compatibilityUrl',
      'approvedBasePath',
      'excludeFromPublicRuntime',
      'retainOriginalArchiveAsEvidence',
    ],
    `${label}.runtimePolicy`,
  );
  assertExactArrayObjects(
    rollback.runtimeFiles,
    ['path', 'bytes', 'sha256'],
    `${label}.runtimeFiles`,
  );
  assertExactArrayObjects(
    rollback.publicFiles,
    ['path', 'bytes', 'sha256', 'candidatePaths'],
    `${label}.publicFiles`,
  );
  assertExactArrayObjects(
    rollback.excludedPublicSourceMaps,
    ['path', 'bytes', 'sha256'],
    `${label}.excludedPublicSourceMaps`,
  );
  assertExactArrayObjects(
    rollback.excludedNonRuntimeFiles,
    ['path', 'bytes', 'sha256'],
    `${label}.excludedNonRuntimeFiles`,
  );
}

function assertRetainedCandidateProvenanceFieldAllowlist(value: unknown, label: string): void {
  const provenance = exactObject(
    value,
    [
      'schemaVersion',
      'candidateId',
      'deterministic',
      'buildPerformed',
      'deploymentPerformed',
      'source',
      'application',
      'sourceArtifact',
      'retainedArtifact',
      'mapManifest',
      'replayScenarios',
      'rollback',
      'sbom',
      'checksums',
    ],
    label,
  );
  const source = exactObject(
    provenance.source,
    [
      'schemaVersion',
      'head',
      'dirty',
      'gitStatus',
      'trackedPatch',
      'trackedContent',
      'untrackedContent',
      'contentSha256',
    ],
    `${label}.source`,
  );
  exactObject(source.gitStatus, ['format', 'bytes', 'sha256'], `${label}.source.gitStatus`);
  exactObject(source.trackedPatch, ['format', 'bytes', 'sha256'], `${label}.source.trackedPatch`);
  exactObject(
    source.trackedContent,
    [
      'format',
      'objectFormat',
      'fileModeEnforced',
      'fileCount',
      'missingFileCount',
      'totalBytes',
      'executableModeMismatchCount',
      'indexMismatchCount',
      'sha256',
    ],
    `${label}.source.trackedContent`,
  );
  exactObject(
    source.untrackedContent,
    ['fileCount', 'totalBytes', 'sha256'],
    `${label}.source.untrackedContent`,
  );
  exactObject(
    provenance.application,
    [
      'applicationName',
      'packageVersion',
      'applicationVersion',
      'releaseSha',
      'buildTarget',
      'providerMode',
      'workerName',
      'mockProviderName',
      'clientRootEntrypoint',
      'clientDevelopmentEntrypoint',
      'workerEntrypoint',
      'mockProviderEntrypoint',
    ],
    `${label}.application`,
  );
  const sourceArtifact = exactObject(
    provenance.sourceArtifact,
    [
      'path',
      'fileCount',
      'totalBytes',
      'sha256',
      'omittedSourceMaps',
      'normalizedSourceMapReferences',
    ],
    `${label}.sourceArtifact`,
  );
  assertExactArrayObjects(
    sourceArtifact.omittedSourceMaps,
    ['path', 'bytes', 'sha256'],
    `${label}.sourceArtifact.omittedSourceMaps`,
  );
  assertExactArrayObjects(
    sourceArtifact.normalizedSourceMapReferences,
    ['path', 'sourceSha256', 'retainedSha256'],
    `${label}.sourceArtifact.normalizedSourceMapReferences`,
  );
  exactObject(
    provenance.retainedArtifact,
    ['path', 'fileCount', 'totalBytes', 'sha256'],
    `${label}.retainedArtifact`,
  );
  const candidateMap = exactObject(
    provenance.mapManifest,
    [
      'sourcePath',
      'candidatePath',
      'schemaVersion',
      'id',
      'assetCount',
      'totalBytes',
      'sha256',
      'basemapSha256',
      'payload',
    ],
    `${label}.mapManifest`,
  );
  exactObject(
    candidateMap.payload,
    ['sourcePath', 'candidatePath', 'fileCount', 'totalBytes', 'sha256'],
    `${label}.mapManifest.payload`,
  );
  assertExactArrayObjects(
    provenance.replayScenarios,
    ['schemaVersion', 'scenarioId', 'seed', 'generatorId', 'generatorVersion', 'canonicalSha256'],
    `${label}.replayScenarios`,
  );
  assertRollbackProvenanceFieldAllowlist(provenance.rollback, `${label}.rollback`);
  exactObject(
    provenance.sbom,
    ['sourcePath', 'candidatePath', 'format', 'specVersion', 'documentVersion', 'bytes', 'sha256'],
    `${label}.sbom`,
  );
  exactObject(
    provenance.checksums,
    ['path', 'algorithm', 'format', 'excludedPaths'],
    `${label}.checksums`,
  );
}

function assertExactJsonIdentity(value: unknown, expected: unknown, label: string): void {
  if (JSON.stringify(value) !== JSON.stringify(expected)) {
    failure('UNKNOWN_FIELD', `${label} is outside its fixed content allowlist.`);
  }
}

type MapManifestPrivacyIdentity = Readonly<{
  id: string;
  assets: readonly PrivacyTreeFileRule[];
}>;

function assertMapManifestFieldAllowlist(
  value: unknown,
  label: string,
): MapManifestPrivacyIdentity {
  if (JSON.stringify(value) === JSON.stringify(mapManifest)) {
    return Object.freeze({
      id: mapManifest.id,
      assets: Object.freeze(
        mapManifest.assets.map((asset) =>
          Object.freeze({ path: asset.path, bytes: asset.bytes, sha256: asset.sha256 }),
        ),
      ),
    });
  }

  const manifest = exactObject(value, ['schemaVersion', 'id', 'totalBytes', 'assets'], label);
  if (
    manifest.schemaVersion !== 'map-assets.v1' ||
    typeof manifest.id !== 'string' ||
    !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(manifest.id) ||
    !isSafeInteger(manifest.totalBytes, 1, MAX_OPAQUE_BYTES) ||
    !Array.isArray(manifest.assets) ||
    manifest.assets.length < 1 ||
    manifest.assets.length > MAX_TREE_FILES
  ) {
    failure('INVALID_INVENTORY', `${label} is outside the bounded map-manifest schema.`);
  }
  const paths = new Set<string>();
  let totalBytes = 0;
  let hasBasemap = false;
  const assets = manifest.assets.map((assetValue, index) => {
    const asset = exactObject(assetValue, ['path', 'bytes', 'sha256'], `${label}.assets[${index}]`);
    assertRelativeFilePath(asset.path, `${label}.assets[${index}].path`);
    if (
      !/^(?:[^/]+\/)*[^/]+\.(?:pbf|pmtiles)$/u.test(asset.path) ||
      !isSafeInteger(asset.bytes, 1, MAX_OPAQUE_BYTES) ||
      typeof asset.sha256 !== 'string' ||
      !SHA256.test(asset.sha256) ||
      paths.has(asset.path)
    ) {
      failure('INVALID_INVENTORY', `${label}.assets[${index}] is invalid.`);
    }
    paths.add(asset.path);
    totalBytes += asset.bytes;
    if (!Number.isSafeInteger(totalBytes)) {
      failure('INVALID_INVENTORY', `${label} total bytes overflowed.`);
    }
    if (asset.path === 'basemap.pmtiles') hasBasemap = true;
    return Object.freeze({ path: asset.path, bytes: asset.bytes, sha256: asset.sha256 });
  });
  if (!hasBasemap || totalBytes !== manifest.totalBytes) {
    failure('INVALID_INVENTORY', `${label} asset inventory is incomplete or mismatched.`);
  }
  return Object.freeze({ id: manifest.id, assets: Object.freeze(assets) });
}

function assertRuntimePolicyFieldAllowlist(value: unknown, label: string): void {
  const policy = exactObject(
    value,
    [
      'schemaVersion',
      'policyEpoch',
      'target',
      'deploymentClass',
      'release',
      'providerGate',
      'source',
      'origins',
      'routes',
      'headers',
      'featureGates',
      'admission',
      'limits',
      'artifact',
      'reasonCodes',
      'policyId',
    ],
    label,
  );
  if (!validateRuntimePolicy(policy)) {
    failure('UNKNOWN_FIELD', `${label} is outside the exact runtime-policy schema.`);
  }
}

function assertGeneratedManifestFieldAllowlist(value: unknown, label: string): void {
  const manifest = exactObject(value, ['virtual:cloudflare/worker-entry'], label);
  exactObject(
    manifest['virtual:cloudflare/worker-entry'],
    ['file', 'name', 'src', 'isEntry'],
    `${label}.virtual:cloudflare/worker-entry`,
  );
}

const AIRSPACE_WORKER_WRANGLER_KEYS = Object.freeze([
  'name',
  'main',
  'compatibility_date',
  'compatibility_flags',
  'rules',
  'assets',
  'limits',
  'vars',
  'durable_objects',
  'migrations',
  'r2_buckets',
  'services',
  'observability',
  'no_bundle',
] as const);
const MOCK_PROVIDER_WRANGLER_KEYS = Object.freeze([
  'name',
  'main',
  'compatibility_date',
  'compatibility_flags',
  'rules',
  'vars',
  'services',
  'observability',
  'no_bundle',
] as const);

function assertGeneratedWranglerFieldAllowlist(
  value: unknown,
  label: string,
  kind: 'airspace-worker' | 'mock-provider',
): void {
  const document = exactObject(
    value,
    kind === 'airspace-worker' ? AIRSPACE_WORKER_WRANGLER_KEYS : MOCK_PROVIDER_WRANGLER_KEYS,
    label,
  );
  assertExactArrayObjects(document.rules, ['type', 'globs'], `${label}.rules`);
  const observability = exactObject(
    document.observability,
    ['enabled', 'logs'],
    `${label}.observability`,
  );
  exactObject(observability.logs, ['enabled', 'invocation_logs'], `${label}.observability.logs`);
  if (!Array.isArray(document.services)) {
    failure('INVALID_INVENTORY', `${label}.services must be an array.`);
  }
  document.services.forEach((service, index) =>
    exactObject(service, ['binding', 'service'], `${label}.services[${index}]`),
  );
  if (kind === 'mock-provider') {
    exactObject(document.vars, ['MOCK_SCENARIO'], `${label}.vars`);
    return;
  }
  exactObject(
    document.assets,
    ['directory', 'binding', 'html_handling', 'not_found_handling', 'run_worker_first'],
    `${label}.assets`,
  );
  exactObject(document.limits, ['cpu_ms', 'subrequests'], `${label}.limits`);
  exactObject(
    document.vars,
    [
      'LIVE_PROVIDER_MODE',
      'LIVE_BUILD_TARGET',
      'LIVE_PROVIDER_BASE_URL',
      'ALLOWED_ORIGINS',
      'APP_VERSION',
      'RELEASE_SHA',
      'RUNTIME_POLICY_EPOCH',
      'RUNTIME_DEPLOYMENT_CLASS',
      'RUNTIME_RELEASE_STATUS',
      'RUNTIME_PROVIDER_GATE_STATUS',
      'RUNTIME_PROVIDER_GATE_VALUE',
      'RUNTIME_POLICY_ID',
    ],
    `${label}.vars`,
  );
  const durableObjects = exactObject(
    document.durable_objects,
    ['bindings'],
    `${label}.durable_objects`,
  );
  assertExactArrayObjects(
    durableObjects.bindings,
    ['name', 'class_name'],
    `${label}.durable_objects.bindings`,
  );
  assertExactArrayObjects(
    document.migrations,
    ['tag', 'new_sqlite_classes'],
    `${label}.migrations`,
  );
  assertExactArrayObjects(document.r2_buckets, ['binding', 'bucket_name'], `${label}.r2_buckets`);
}

function assertSbomFieldAllowlist(value: unknown, label: string): void {
  const sbom = record(value, label);
  assertAllowedAndRequiredKeys(
    sbom,
    [
      '$schema',
      'bomFormat',
      'specVersion',
      'serialNumber',
      'version',
      'metadata',
      'components',
      'dependencies',
    ],
    ['bomFormat', 'specVersion', 'version', 'components'],
    label,
  );
  if (
    sbom.bomFormat !== 'CycloneDX' ||
    typeof sbom.specVersion !== 'string' ||
    !/^\d+\.\d+$/u.test(sbom.specVersion) ||
    !isSafeInteger(sbom.version, 1, Number.MAX_SAFE_INTEGER)
  ) {
    failure('INVALID_INVENTORY', `${label} is not a supported CycloneDX document.`);
  }
  if (sbom.metadata !== undefined) {
    const metadata = exactObject(
      sbom.metadata,
      ['timestamp', 'tools', 'lifecycles', 'component'],
      `${label}.metadata`,
    );
    const tools = exactObject(metadata.tools, ['components'], `${label}.metadata.tools`);
    assertExactArrayObjects(
      tools.components,
      ['type', 'name', 'version'],
      `${label}.metadata.tools.components`,
    );
    assertExactArrayObjects(metadata.lifecycles, ['phase'], `${label}.metadata.lifecycles`);
    const metadataComponent = exactObject(
      metadata.component,
      ['type', 'name', 'version', 'purl', 'bom-ref', 'licenses', 'description'],
      `${label}.metadata.component`,
    );
    if (!Array.isArray(metadataComponent.licenses)) {
      failure('INVALID_INVENTORY', `${label}.metadata.component.licenses must be an array.`);
    }
    metadataComponent.licenses.forEach((licenseValue, licenseIndex) => {
      const licenseEntry = exactObject(
        licenseValue,
        ['license'],
        `${label}.metadata.component.licenses[${licenseIndex}]`,
      );
      exactObject(
        licenseEntry.license,
        ['id'],
        `${label}.metadata.component.licenses[${licenseIndex}].license`,
      );
    });
  }
  if (!Array.isArray(sbom.components)) {
    failure('INVALID_INVENTORY', `${label}.components must be an array.`);
  }
  sbom.components.forEach((componentValue, index) => {
    const componentLabel = `${label}.components[${index}]`;
    const component = record(componentValue, componentLabel);
    assertAllowedAndRequiredKeys(
      component,
      [
        'type',
        'bom-ref',
        'group',
        'name',
        'version',
        'purl',
        'scope',
        'properties',
        'externalReferences',
      ],
      ['type', 'bom-ref', 'name', 'version', 'purl', 'externalReferences'],
      componentLabel,
    );
    if (component.properties !== undefined) {
      assertExactArrayObjects(
        component.properties,
        ['name', 'value'],
        `${componentLabel}.properties`,
      );
    }
    if (!Array.isArray(component.externalReferences)) {
      failure('INVALID_INVENTORY', `${componentLabel}.externalReferences must be an array.`);
    }
    component.externalReferences.forEach((referenceValue, referenceIndex) => {
      const referenceLabel = `${componentLabel}.externalReferences[${referenceIndex}]`;
      const reference = exactObject(referenceValue, ['type', 'url', 'hashes'], referenceLabel);
      assertExactArrayObjects(reference.hashes, ['alg', 'content'], `${referenceLabel}.hashes`);
    });
  });
  if (sbom.dependencies !== undefined) {
    if (!Array.isArray(sbom.dependencies)) {
      failure('INVALID_INVENTORY', `${label}.dependencies must be an array.`);
    }
    sbom.dependencies.forEach((dependencyValue, index) => {
      const dependency = exactObject(
        dependencyValue,
        ['ref', 'dependsOn'],
        `${label}.dependencies[${index}]`,
      );
      if (!Array.isArray(dependency.dependsOn)) {
        failure('INVALID_INVENTORY', `${label}.dependencies[${index}].dependsOn must be an array.`);
      }
    });
  }
}

function assertStaticArtifactFieldAllowlist(value: unknown, label: string): void {
  if (label === 'evidence/provenance.json') {
    assertRetainedCandidateProvenanceFieldAllowlist(value, label);
    return;
  }
  if (label === 'evidence/map-manifest.json') {
    assertMapManifestFieldAllowlist(value, label);
    return;
  }
  if (label === 'evidence/rollback-v2.2.0/manifest.json') {
    assertExactJsonIdentity(value, rollbackManifest, label);
    return;
  }
  if (label === 'evidence/sbom.cdx.json') {
    assertSbomFieldAllowlist(value, label);
    return;
  }
  if (/^(?:artifact\/)?client\/runtime-policy\.json$/u.test(label)) {
    assertRuntimePolicyFieldAllowlist(value, label);
    return;
  }
  if (/^(?:artifact\/)?airspace_worker\/wrangler\.json$/u.test(label)) {
    assertGeneratedWranglerFieldAllowlist(value, label, 'airspace-worker');
    return;
  }
  if (/^(?:artifact\/)?mock_provider\/wrangler\.json$/u.test(label)) {
    assertGeneratedWranglerFieldAllowlist(value, label, 'mock-provider');
    return;
  }
  if (/^(?:artifact\/)?airspace_worker\/\.vite\/manifest\.json$/u.test(label)) {
    assertGeneratedManifestFieldAllowlist(value, label);
    return;
  }
  failure('INVALID_INVENTORY', `${label} has no fixed JSON content schema.`);
}

function assertStaticArtifactJsonPrivacy(value: unknown, label: string): void {
  assertStaticArtifactFieldAllowlist(value, label);
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > MAX_STATIC_ARTIFACT_SCAN_NODES || current.depth > MAX_SCAN_DEPTH) {
      failure('FORBIDDEN_VALUE', `${label} exceeds the bounded JSON scan.`);
    }
    if (Array.isArray(current.value)) {
      current.value.forEach((entry) => stack.push({ value: entry, depth: current.depth + 1 }));
      continue;
    }
    if (typeof current.value === 'string') {
      if (Array.from(current.value).length > 1_024) {
        failure('FORBIDDEN_VALUE', `${label} contains unbounded static artifact text.`);
      }
      try {
        assertPrivacySafeTextArtifact(current.value, `${label}.txt`);
      } catch (error) {
        failure(
          'FORBIDDEN_VALUE',
          `${label} contains forbidden static artifact text: ${error instanceof Error ? error.message : 'privacy rejection'}`,
        );
      }
      continue;
    }
    if (!isJsonRecord(current.value)) continue;
    for (const [key, entry] of Object.entries(current.value)) {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, '');
      if (Array.from(key).length > 64 || STRUCTURED_FORBIDDEN_KEY.test(normalized)) {
        failure('FORBIDDEN_VALUE', `${label} contains forbidden structured detail.`);
      }
      stack.push({ value: entry, depth: current.depth + 1 });
    }
  }
}

async function inventoryTree(root: string, allowedDirectories: Set<string>): Promise<string[]> {
  const rootStatus = await lstat(root).catch(() => undefined);
  if (!rootStatus?.isDirectory() || rootStatus.isSymbolicLink()) {
    failure('UNSAFE_NODE', 'Privacy tree root must be a real directory.');
  }
  const canonicalRoot = await realpath(root);
  const comparable = (value: string): string => {
    const normalized = normalizedPath(resolve(value)).normalize('NFC');
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  };
  if (comparable(canonicalRoot) !== comparable(root)) {
    failure('UNSAFE_NODE', 'Privacy tree root cannot traverse a symlink or junction.');
  }
  const files: string[] = [];
  const pending: Array<{ absolute: string; relative: string; depth: number }> = [
    { absolute: root, relative: '', depth: 0 },
  ];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    if (directory.depth > MAX_SCAN_DEPTH) failure('UNSAFE_NODE', 'Privacy tree is too deep.');
    const entries = await readdir(directory.absolute, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = directory.relative ? `${directory.relative}/${entry.name}` : entry.name;
      assertRelativeFilePath(relativePath, 'Privacy tree path');
      const absolutePath = resolve(directory.absolute, entry.name);
      const status = await lstat(absolutePath);
      if (status.isSymbolicLink()) failure('UNSAFE_NODE', `${relativePath} is a symbolic link.`);
      if (status.isDirectory()) {
        if (!allowedDirectories.has(relativePath)) {
          failure('UNDECLARED_FILE', `Privacy tree contains undeclared directory ${relativePath}.`);
        }
        pending.push({
          absolute: absolutePath,
          relative: relativePath,
          depth: directory.depth + 1,
        });
        continue;
      }
      if (!status.isFile()) failure('UNSAFE_NODE', `${relativePath} is not a regular file.`);
      files.push(relativePath);
      if (files.length > MAX_TREE_FILES) failure('UNSAFE_NODE', 'Privacy tree has too many files.');
    }
  }
  return files.sort();
}

function decodeStrictText(bytes: Buffer, label: string): string {
  if (
    (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) ||
    bytes.includes(0)
  ) {
    failure('FORBIDDEN_VALUE', `${label} is not BOM-free NUL-free UTF-8 text.`);
  }
  try {
    return UTF8.decode(bytes);
  } catch {
    failure('FORBIDDEN_VALUE', `${label} is not strict UTF-8 text.`);
  }
}

async function bindSelectedMapAssets(
  root: string,
  rules: ReadonlyMap<string, PrivacyTreeFileRule>,
): Promise<ReadonlySet<string>> {
  const selectedPaths = [...rules.keys()].filter(
    (path) => MANIFEST_BOUND_MAP_ASSET_ROLE.test(path) && !PINNED_ARTIFACT_IDENTITIES.has(path),
  );
  if (selectedPaths.length === 0) return new Set();

  const manifestRule = rules.get('evidence/map-manifest.json');
  if (manifestRule === undefined) {
    failure(
      'INVALID_INVENTORY',
      'Selected opaque map assets require the retained map-manifest evidence role.',
    );
  }
  const manifestBytes = await readFile(resolve(root, 'evidence', 'map-manifest.json'));
  if (
    manifestBytes.byteLength !== manifestRule.bytes ||
    sha256(manifestBytes) !== manifestRule.sha256
  ) {
    failure('HASH_MISMATCH', 'Map manifest changed before opaque map assets were bound.');
  }
  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(decodeStrictText(manifestBytes, 'evidence/map-manifest.json'));
  } catch {
    failure('INVALID_INVENTORY', 'Map manifest is not strict valid JSON.');
  }
  const manifest = assertMapManifestFieldAllowlist(manifestValue, 'evidence/map-manifest.json');
  const assets = new Map(manifest.assets.map((asset) => [asset.path, asset] as const));
  const selected = new Set<string>();
  for (const path of selectedPaths) {
    const match = /^(?:artifact\/)?map_assets\/([^/]+)\/(.+)$/u.exec(path);
    const asset = match?.[2] === undefined ? undefined : assets.get(match[2]);
    const rule = rules.get(path)!;
    if (
      match?.[1] !== manifest.id ||
      asset === undefined ||
      asset.bytes !== rule.bytes ||
      asset.sha256 !== rule.sha256
    ) {
      failure('HASH_MISMATCH', `${path} does not match the selected map manifest.`);
    }
    selected.add(path);
  }
  return selected;
}

export async function auditG2EvidenceDirectory(
  declaration: AggregateEvidenceDirectoryDeclaration,
  expectedIdentity?: G2ExpectedIdentity,
): Promise<number> {
  const runtimeDeclaration = record(declaration, 'Aggregate evidence directory declaration');
  assertExactKeys(runtimeDeclaration, ['root', 'mode'], 'Aggregate evidence directory declaration');
  if (
    typeof declaration.root !== 'string' ||
    (declaration.mode !== 'empty' && declaration.mode !== 'g2-bundle') ||
    (declaration.mode === 'g2-bundle' && expectedIdentity === undefined) ||
    (declaration.mode === 'empty' && expectedIdentity !== undefined)
  ) {
    failure(
      'INVALID_INVENTORY',
      'Aggregate evidence directory declaration or external expected identity is malformed.',
    );
  }
  const root = resolve(declaration.root);
  const files = await inventoryTree(root, new Set());
  if (declaration.mode === 'empty') {
    if (files.length !== 0) {
      failure('UNDECLARED_FILE', 'No-capture evidence directory must remain empty.');
    }
    return 0;
  }
  if (
    files.length !== G2_RETAINED_FILES.length ||
    files.some((path, index) => path !== G2_RETAINED_FILES[index])
  ) {
    failure('UNDECLARED_FILE', 'G2 evidence directory must contain the exact retained file set.');
  }
  const artifacts: Array<{ path: (typeof G2_RETAINED_FILES)[number]; value: unknown }> = [];
  const digests = new Map<string, string>();
  for (const path of G2_RETAINED_FILES) {
    const bytes = await readFile(resolve(root, path));
    if (bytes.byteLength > 64 * 1024) {
      failure('FORBIDDEN_VALUE', `${path} exceeds the bounded G2 evidence size.`);
    }
    const text = decodeStrictText(bytes, path);
    try {
      assertPrivacySafeTextArtifact(text, path);
    } catch (error) {
      failure(
        'FORBIDDEN_VALUE',
        `${path} failed artifact privacy inspection: ${error instanceof Error ? error.message : 'privacy rejection'}`,
      );
    }
    digests.set(path, sha256(bytes));
    artifacts.push({ path, value: JSON.parse(text) as unknown });
  }
  assertG2AggregateArtifacts({ artifacts }, expectedIdentity);
  const after = await inventoryTree(root, new Set());
  if (JSON.stringify(after) !== JSON.stringify(files)) {
    failure('UNDECLARED_FILE', 'G2 evidence directory changed during privacy inspection.');
  }
  for (const path of after) {
    if (sha256(await readFile(resolve(root, path))) !== digests.get(path)) {
      failure('HASH_MISMATCH', `${path} changed during privacy inspection.`);
    }
  }
  return files.length;
}

export async function auditPrivacyTree(
  declaration: PrivacyTreeDeclaration,
  expectedIdentity?: PrivacyTreeExpectedIdentity,
): Promise<number> {
  if (expectedIdentity === undefined) {
    failure(
      'INVALID_INVENTORY',
      'Privacy tree audit requires an externally supplied selected-tree identity.',
    );
  }
  const selectedIdentity = parsePrivacyTreeExpectedIdentity(expectedIdentity);
  const runtimeDeclaration = record(declaration, 'Privacy tree declaration');
  assertExactKeys(runtimeDeclaration, ['root', 'files'], 'Privacy tree declaration');
  if (typeof declaration.root !== 'string' || !Array.isArray(declaration.files)) {
    failure('INVALID_INVENTORY', 'Privacy tree declaration is malformed.');
  }
  if (declaration.files.length === 0) {
    failure('INVALID_INVENTORY', 'A declared privacy tree must contain at least one file rule.');
  }
  const rules = new Map<string, PrivacyTreeFileRule>();
  const allowedDirectories = new Set<string>();
  for (const ruleValue of declaration.files) {
    const rule = record(ruleValue, 'Privacy tree file rule');
    assertExactKeys(rule, ['path', 'sha256', 'bytes'], 'Privacy tree file rule');
    assertRelativeFilePath(rule.path, 'Privacy tree file rule.path');
    if (
      typeof rule.sha256 !== 'string' ||
      !SHA256.test(rule.sha256) ||
      !isSafeInteger(rule.bytes, 1, MAX_OPAQUE_BYTES) ||
      (!PINNED_ARTIFACT_IDENTITIES.has(rule.path) &&
        !isDeclaredTextRole(rule.path) &&
        !MANIFEST_BOUND_MAP_ASSET_ROLE.test(rule.path))
    ) {
      failure('INVALID_INVENTORY', `Privacy tree rule for ${rule.path} is invalid.`);
    }
    if (rules.has(rule.path)) failure('INVALID_INVENTORY', `Privacy tree repeats ${rule.path}.`);
    rules.set(rule.path, ruleValue);
    const segments = rule.path.split('/');
    for (let index = 1; index < segments.length; index += 1) {
      allowedDirectories.add(segments.slice(0, index).join('/'));
    }
  }
  const declaredIdentity = privacyTreeExpectedIdentity([...rules.values()]);
  if (
    declaredIdentity.fileCount !== selectedIdentity.fileCount ||
    declaredIdentity.totalBytes !== selectedIdentity.totalBytes ||
    declaredIdentity.sha256 !== selectedIdentity.sha256
  ) {
    failure('HASH_MISMATCH', 'Privacy tree does not match the externally selected identity.');
  }
  const files = await inventoryTree(resolve(declaration.root), allowedDirectories);
  if (
    files.length !== rules.size ||
    files.some((path) => !rules.has(path)) ||
    [...rules.keys()].some((path) => !files.includes(path))
  ) {
    failure('UNDECLARED_FILE', 'Privacy tree does not match its exact file allowlist.');
  }
  const selectedMapAssets = await bindSelectedMapAssets(resolve(declaration.root), rules);
  for (const path of files) {
    const rule = rules.get(path)!;
    const bytes = await readFile(resolve(declaration.root, ...path.split('/')));
    if (bytes.byteLength !== rule.bytes) {
      failure('HASH_MISMATCH', `${path} changed size after selection.`);
    }
    if (sha256(bytes) !== rule.sha256) failure('HASH_MISMATCH', `${path} changed after selection.`);
    const approved = PINNED_ARTIFACT_IDENTITIES.get(path);
    if (approved !== undefined) {
      if (approved.bytes !== bytes.byteLength || approved.sha256 !== rule.sha256) {
        failure('FORBIDDEN_VALUE', `${path} does not match its fixed pinned artifact identity.`);
      }
      continue;
    }
    if (selectedMapAssets.has(path)) continue;
    if (/\.(?:c?js|mjs)$/iu.test(path)) {
      if (bytes.byteLength > MAX_TEXT_BYTES) {
        failure('FORBIDDEN_VALUE', `${path} exceeds the bounded executable artifact size.`);
      }
      continue;
    }
    if (
      !isDeclaredTextRole(path) ||
      !TEXT_EVIDENCE_PATH.test(path) ||
      bytes.byteLength > MAX_TEXT_BYTES
    ) {
      failure('FORBIDDEN_VALUE', `${path} is not a declared bounded text role.`);
    }
    const text = decodeStrictText(bytes, path);
    try {
      assertPrivacySafeTextArtifact(text, path);
    } catch (error) {
      failure(
        'FORBIDDEN_VALUE',
        `${path} failed artifact privacy inspection: ${error instanceof Error ? error.message : 'privacy rejection'}`,
      );
    }
    if (
      /\.json$/iu.test(path) &&
      /["'](?:aircraftId|callsign|registration|latitude|longitude|coordinates?|position|providerPayload|rawPayload|requestId|requestMetadata|userAgent|clientId)["']\s*:\s*(?!null\b)/iu.test(
        text,
      )
    ) {
      failure('FORBIDDEN_VALUE', `${path} contains structured operational detail.`);
    }
    if (extname(path).toLowerCase() === '.json') {
      const parsed = JSON.parse(text) as unknown;
      if (TRUSTED_STATIC_JSON_PATH.test(path)) assertStaticArtifactJsonPrivacy(parsed, path);
      else assertAggregateOnlyJsonPrivacy(parsed, path);
    } else if (STRUCTURED_TEXT_ROLE.test(path)) {
      assertStructuredTextRole(text, path);
    } else if (!/\.(?:c?js|mjs|css|html?|map|svg)$/iu.test(path)) {
      assertForbiddenScalarString(text.trimEnd(), path);
    }
  }
  const after = await inventoryTree(resolve(declaration.root), allowedDirectories);
  if (JSON.stringify(after) !== JSON.stringify(files)) {
    failure('UNDECLARED_FILE', 'Privacy tree changed during inspection.');
  }
  for (const path of after) {
    const bytes = await readFile(resolve(declaration.root, ...path.split('/')));
    if (sha256(bytes) !== rules.get(path)!.sha256) {
      failure('HASH_MISMATCH', `${path} changed during privacy inspection.`);
    }
  }
  return files.length;
}

export function assertBrowserPersistencePrivacy(value: unknown): void {
  const browser = record(value, 'Browser storage');
  const keys = [
    'localStorage',
    'sessionStorage',
    'cookies',
    'indexedDbDatabases',
    'cacheStorageKeys',
    'opfsEntries',
    'serviceWorkers',
  ] as const;
  assertExactKeys(browser, keys, 'Browser storage');
  for (const key of keys) {
    if (!Array.isArray(browser[key]) || browser[key].length !== 0) {
      failure('FORBIDDEN_VALUE', `Operational browser persistence ${key} must remain empty.`);
    }
  }
}

async function auditScreenshotMetadata(value: unknown): Promise<0> {
  const screenshots = record(value, 'Screenshot metadata');
  assertExactKeys(screenshots, ['files', 'outputDirectory'], 'Screenshot metadata');
  if (!Array.isArray(screenshots.files) || screenshots.files.length !== 0) {
    failure('FORBIDDEN_VALUE', 'G2 screenshot metadata must remain empty.');
  }
  const outputDirectory = record(screenshots.outputDirectory, 'Screenshot output directory');
  if (outputDirectory.mode !== 'empty') {
    failure('FORBIDDEN_VALUE', 'G2 screenshot output must use an observed empty directory.');
  }
  const fileCount = await auditG2EvidenceDirectory(
    screenshots.outputDirectory as AggregateEvidenceDirectoryDeclaration,
  );
  if (fileCount !== 0) {
    failure('FORBIDDEN_VALUE', 'G2 screenshot output directory must remain empty.');
  }
  return 0;
}

function assertInventoryShape(value: unknown): asserts value is OperationsPrivacyInventoryV1 {
  const inventory = record(value, 'Operations privacy inventory');
  assertExactKeys(
    inventory,
    [
      'schemaVersion',
      'apiValues',
      'durableObjectStorageValues',
      'hibernationAttachments',
      'browserStorage',
      'browserDownloads',
      'reports',
      'testResults',
      'screenshotMetadata',
      'retainedCandidates',
      'releases',
    ],
    'Operations privacy inventory',
  );
  if (
    inventory.schemaVersion !== OPERATIONS_PRIVACY_INVENTORY_VERSION ||
    !Array.isArray(inventory.apiValues) ||
    !Array.isArray(inventory.durableObjectStorageValues) ||
    !Array.isArray(inventory.hibernationAttachments) ||
    !Array.isArray(inventory.retainedCandidates) ||
    !Array.isArray(inventory.releases)
  ) {
    failure('INVALID_INVENTORY', 'Operations privacy inventory is malformed or unversioned.');
  }
  if (
    inventory.apiValues.length === 0 ||
    inventory.durableObjectStorageValues.length === 0 ||
    inventory.hibernationAttachments.length === 0 ||
    inventory.retainedCandidates.length === 0 ||
    inventory.releases.length === 0
  ) {
    failure(
      'INVALID_INVENTORY',
      'Operations privacy evidence must exercise API, storage, attachment, candidate, and release surfaces.',
    );
  }
}

export async function auditOperationsPrivacy(
  value: unknown,
  expectedIdentity: G2ExpectedIdentity,
  expectedTrees?: OperationsPrivacyTreeSelections,
): Promise<OperationsPrivacyAuditReceiptV1> {
  assertInventoryShape(value);
  const selectedIdentity = parseG2ExpectedIdentity(expectedIdentity);
  if (expectedTrees === undefined) {
    failure(
      'INVALID_INVENTORY',
      'Operations privacy audit requires externally selected candidate and release identities.',
    );
  }
  const selectedTrees = record(expectedTrees, 'Operations privacy tree selections');
  assertExactKeys(
    selectedTrees,
    ['retainedCandidates', 'releases'],
    'Operations privacy tree selections',
  );
  if (
    !Array.isArray(selectedTrees.retainedCandidates) ||
    !Array.isArray(selectedTrees.releases) ||
    selectedTrees.retainedCandidates.length !== value.retainedCandidates.length ||
    selectedTrees.releases.length !== value.releases.length
  ) {
    failure('INVALID_INVENTORY', 'Operations privacy tree selections are incomplete.');
  }
  const retainedSelections = selectedTrees.retainedCandidates as PrivacyTreeExpectedIdentity[];
  const releaseSelections = selectedTrees.releases as PrivacyTreeExpectedIdentity[];
  for (const [index, apiValue] of value.apiValues.entries()) {
    const parsed = parseOperationsProjection(apiValue);
    assertBoundedScalarTree(parsed, `API value ${index}`);
  }
  value.durableObjectStorageValues.forEach(assertDurableObjectStoragePrivacy);
  value.hibernationAttachments.forEach(assertHibernationAttachmentPrivacy);
  assertBrowserPersistencePrivacy(value.browserStorage);
  const [browserDownloadFiles, reportFiles, testResultFiles, screenshotFiles] = await Promise.all([
    auditG2EvidenceDirectory(value.browserDownloads),
    auditG2EvidenceDirectory(
      value.reports,
      value.reports.mode === 'g2-bundle' ? selectedIdentity : undefined,
    ),
    auditG2EvidenceDirectory(
      value.testResults,
      value.testResults.mode === 'g2-bundle' ? selectedIdentity : undefined,
    ),
    auditScreenshotMetadata(value.screenshotMetadata),
  ]);
  const retainedCandidateFiles = (
    await Promise.all(
      value.retainedCandidates.map((tree, index) =>
        auditPrivacyTree(tree, retainedSelections[index] as PrivacyTreeExpectedIdentity),
      ),
    )
  ).reduce((sum, count) => sum + count, 0);
  const releaseFiles = (
    await Promise.all(
      value.releases.map((tree, index) =>
        auditPrivacyTree(tree, releaseSelections[index] as PrivacyTreeExpectedIdentity),
      ),
    )
  ).reduce((sum, count) => sum + count, 0);
  return Object.freeze({
    schemaVersion: OPERATIONS_PRIVACY_AUDIT_VERSION,
    evidencePolicy: G2_EVIDENCE_POLICY,
    result: 'pass',
    surfaces: Object.freeze({
      apiValues: value.apiValues.length,
      durableObjectStorageValues: value.durableObjectStorageValues.length,
      hibernationAttachments: value.hibernationAttachments.length,
      browserStorageEntries: 0,
      browserDownloadFiles,
      reportFiles,
      testResultFiles,
      screenshotFiles,
      retainedCandidateFiles,
      releaseFiles,
    }),
  });
}
