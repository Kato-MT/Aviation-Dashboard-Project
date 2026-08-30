import { parseLiveSource, type LiveSourceDescriptor } from '../live/source';
import type { RegionId } from '../live/regions';
import { isCanonicalTimestamp, isJsonRecord } from '../live/validation';

export const OPERATIONS_SCHEMA_VERSION = 'operations.v1' as const;
export const OPERATIONS_REGION_IDS = Object.freeze([
  'atlanta',
  'savannah-statesboro',
  'central-georgia',
] as const satisfies readonly RegionId[]);
export const OPERATIONS_RETENTION_DAYS = 30 as const;
export const MAX_OPERATIONS_COUNTER = 4_294_967_295;
export const MAX_OPERATIONS_AGE_SECONDS = 4_294_967_295;
export const OPERATIONS_CURRENT_MAX_SECONDS = 15;
export const OPERATIONS_DELAYED_MAX_SECONDS = 45;
export const OPERATIONS_STALE_MAX_SECONDS = 119;

export const OPERATIONS_REASON_CODES = Object.freeze([
  'APPLICATION_AVAILABLE',
  'APPLICATION_PARTIAL_REGIONS',
  'APPLICATION_UNAVAILABLE',
  'REGION_AVAILABLE',
  'REGION_READ_UNAVAILABLE',
  'PROVIDER_LIVE',
  'PROVIDER_DEGRADED',
  'PROVIDER_DISABLED',
  'PROVIDER_CONNECTING',
  'PROVIDER_EMPTY',
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_RETRYING',
  'PROVIDER_UNAVAILABLE',
  'DELIVERY_HEALTHY',
  'DELIVERY_DEGRADED_TIMEOUTS',
  'DELIVERY_DEGRADED_SEND_FAILURES',
  'DELIVERY_DEGRADED_INVALID_CONTROLS',
  'DELIVERY_HIBERNATION_LOSS_POSSIBLE',
  'DELIVERY_UNAVAILABLE',
  'ADMISSION_ACCEPTING',
  'ADMISSION_LIMITED_RATE',
  'ADMISSION_LIMITED_CAPACITY',
  'ADMISSION_UNAVAILABLE',
  'FRESHNESS_CURRENT',
  'FRESHNESS_DELAYED',
  'FRESHNESS_STALE',
  'FRESHNESS_EXPIRED',
  'FRESHNESS_EMPTY',
  'FRESHNESS_UNAVAILABLE',
] as const);

export type OperationsReasonCode = (typeof OPERATIONS_REASON_CODES)[number];
export type OperationsAccounting = 'exact' | 'best-effort';
export type OperationsApplicationState = 'available' | 'partial' | 'unavailable';
export type OperationsAvailabilityState = 'available' | 'unavailable';
export type OperationsProviderState =
  | 'live'
  | 'degraded'
  | 'disabled'
  | 'connecting'
  | 'empty'
  | 'rate-limited'
  | 'retrying'
  | 'unavailable';
export type OperationsDeliveryState = 'healthy' | 'degraded' | 'unavailable';
export type OperationsAdmissionState = 'accepting' | 'limited' | 'unavailable';
export type OperationsFreshnessState =
  'current' | 'delayed' | 'stale' | 'expired' | 'empty' | 'unavailable';

export interface OperationsClassification<State extends string> {
  readonly state: State;
  readonly reasonCodes: readonly OperationsReasonCode[];
}

export interface OperationsIdentity {
  readonly applicationVersion: string;
  readonly releaseSha: string;
  readonly source: Readonly<LiveSourceDescriptor>;
  readonly policyId: string;
}

export interface OperationsProviderCounters {
  readonly accounting: OperationsAccounting;
  readonly pollCount: number;
  readonly successCount: number;
  readonly failureCount: number;
  readonly rateLimitCount: number;
}

export interface OperationsValidationCounters {
  readonly accounting: OperationsAccounting;
  readonly acceptedSnapshotCount: number;
  readonly rejectedSnapshotCount: number;
  readonly invalidFieldCount: number;
}

export interface OperationsDeliveryCounters {
  readonly accounting: OperationsAccounting;
  readonly acknowledgmentCount: number;
  readonly timeoutCount: number;
  readonly sendFailureCount: number;
  readonly invalidControlCount: number;
  readonly hibernationLossCount: number;
}

export interface OperationsAdmissionCounters {
  readonly accounting: OperationsAccounting;
  readonly acceptedCount: number;
  readonly rateLimitRejectionCount: number;
  readonly capacityRejectionCount: number;
}

export interface OperationsAggregateWindow {
  readonly startedAt: string;
  readonly provider: OperationsProviderCounters;
  readonly validation: OperationsValidationCounters;
  readonly delivery: OperationsDeliveryCounters;
}

export interface OperationsAggregateWindows {
  readonly currentHour: OperationsAggregateWindow;
  readonly trailing24Hours: OperationsAggregateWindow;
}

export interface OperationsAdmissionWindow {
  readonly startedAt: string;
  readonly counters: OperationsAdmissionCounters;
}

export interface OperationsAdmissionWindows {
  readonly currentHour: OperationsAdmissionWindow;
  readonly trailing24Hours: OperationsAdmissionWindow;
}

export interface OperationsAdmission extends OperationsClassification<OperationsAdmissionState> {
  readonly scope: 'worker-isolate';
  readonly windows: OperationsAdmissionWindows;
}

export interface OperationsFreshness extends OperationsClassification<OperationsFreshnessState> {
  readonly observationAgeSeconds: number | null;
}

export interface RegionOperations {
  readonly regionId: RegionId;
  readonly availability: OperationsClassification<OperationsAvailabilityState>;
  readonly provider: OperationsClassification<OperationsProviderState>;
  readonly delivery: OperationsClassification<OperationsDeliveryState>;
  readonly freshness: OperationsFreshness;
  readonly windows: OperationsAggregateWindows | null;
}

export interface OperationsLimitations {
  readonly regionScope: 'three-fixed-georgia-regions';
  readonly retentionDays: 30;
  readonly deliveryAccounting: 'best-effort-summary';
  readonly trailingWindowAccounting: 'best-effort-complete-hour-buckets';
  readonly admissionScope: 'worker-isolate';
  readonly globalAvailabilityProof: 'not-provided';
  readonly platformProcessing: 'outside-application-storage';
}

export interface OperationsProjection {
  readonly schemaVersion: typeof OPERATIONS_SCHEMA_VERSION;
  readonly identity: OperationsIdentity;
  readonly checkedAt: string;
  readonly application: OperationsClassification<OperationsApplicationState>;
  readonly admission: OperationsAdmission;
  readonly limitations: OperationsLimitations;
  readonly regions: readonly [RegionOperations, RegionOperations, RegionOperations];
}

export const OPERATIONS_LIMITATIONS: Readonly<OperationsLimitations> = Object.freeze({
  regionScope: 'three-fixed-georgia-regions',
  retentionDays: OPERATIONS_RETENTION_DAYS,
  deliveryAccounting: 'best-effort-summary',
  trailingWindowAccounting: 'best-effort-complete-hour-buckets',
  admissionScope: 'worker-isolate',
  globalAvailabilityProof: 'not-provided',
  platformProcessing: 'outside-application-storage',
});

export type OperationsContractErrorCode =
  | 'FORBIDDEN_FIELD'
  | 'INVALID_SHAPE'
  | 'INVALID_IDENTITY'
  | 'INVALID_TIMESTAMP'
  | 'INVALID_CLASSIFICATION'
  | 'INVALID_COUNTER'
  | 'INVALID_WINDOW'
  | 'INVALID_REGION_SET'
  | 'INCONSISTENT_APPLICATION';

const errorMessages: Readonly<Record<OperationsContractErrorCode, string>> = Object.freeze({
  FORBIDDEN_FIELD: 'Operations evidence contains a forbidden or unbounded value.',
  INVALID_SHAPE: 'Operations evidence does not match the closed operations.v1 shape.',
  INVALID_IDENTITY: 'Operations evidence contains an invalid release-bound identity.',
  INVALID_TIMESTAMP: 'Operations evidence contains an invalid canonical timestamp.',
  INVALID_CLASSIFICATION: 'Operations evidence contains an invalid state or reason classification.',
  INVALID_COUNTER: 'Operations evidence contains an invalid or inconsistent bounded counter.',
  INVALID_WINDOW: 'Operations evidence contains an invalid aggregate window.',
  INVALID_REGION_SET: 'Operations evidence must contain the exact ordered regional set.',
  INCONSISTENT_APPLICATION: 'Operations application state does not match regional availability.',
});

export class OperationsContractError extends Error {
  readonly code: OperationsContractErrorCode;

  constructor(code: OperationsContractErrorCode) {
    super(errorMessages[code]);
    this.name = 'OperationsContractError';
    this.code = code;
  }
}

const reasonCodeSet = new Set<string>(OPERATIONS_REASON_CODES);
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const policyIdPattern = /^[0-9a-f]{64}$/u;
const absoluteUrlPattern = /^[a-z][a-z0-9+.-]*:\/\//iu;
const ipv4Pattern = /^(?:\d{1,3}\.){3}\d{1,3}$/u;
const ipv6Pattern = /^[0-9a-f]*:[0-9a-f:]+$/iu;
const MAX_PRIVACY_SCAN_DEPTH = 16;
const MAX_PRIVACY_SCAN_NODES = 4_096;
const MAX_OPERATIONS_TEXT_CHARACTERS = 128;

const forbiddenKeyFragments = Object.freeze([
  'aircraft',
  'callsign',
  'registration',
  'latitude',
  'longitude',
  'coordinate',
  'providerpayload',
  'rawpayload',
  'ipaddress',
  'useragent',
  'clientid',
  'clientidentifier',
  'requestid',
  'fullurl',
  'requesturl',
] as const);

function reasons(...values: OperationsReasonCode[]): readonly OperationsReasonCode[] {
  return Object.freeze(values);
}

const applicationReasons: Readonly<
  Record<OperationsApplicationState, readonly OperationsReasonCode[]>
> = Object.freeze({
  available: reasons('APPLICATION_AVAILABLE'),
  partial: reasons('APPLICATION_PARTIAL_REGIONS'),
  unavailable: reasons('APPLICATION_UNAVAILABLE'),
});
const availabilityReasons: Readonly<
  Record<OperationsAvailabilityState, readonly OperationsReasonCode[]>
> = Object.freeze({
  available: reasons('REGION_AVAILABLE'),
  unavailable: reasons('REGION_READ_UNAVAILABLE'),
});
const providerReasons: Readonly<Record<OperationsProviderState, readonly OperationsReasonCode[]>> =
  Object.freeze({
    live: reasons('PROVIDER_LIVE'),
    degraded: reasons('PROVIDER_DEGRADED'),
    disabled: reasons('PROVIDER_DISABLED'),
    connecting: reasons('PROVIDER_CONNECTING'),
    empty: reasons('PROVIDER_EMPTY'),
    'rate-limited': reasons('PROVIDER_RATE_LIMITED'),
    retrying: reasons('PROVIDER_RETRYING'),
    unavailable: reasons('PROVIDER_UNAVAILABLE'),
  });
const deliveryReasons: Readonly<Record<OperationsDeliveryState, readonly OperationsReasonCode[]>> =
  Object.freeze({
    healthy: reasons('DELIVERY_HEALTHY'),
    degraded: reasons(
      'DELIVERY_DEGRADED_TIMEOUTS',
      'DELIVERY_DEGRADED_SEND_FAILURES',
      'DELIVERY_DEGRADED_INVALID_CONTROLS',
      'DELIVERY_HIBERNATION_LOSS_POSSIBLE',
    ),
    unavailable: reasons('DELIVERY_UNAVAILABLE'),
  });
const admissionReasons: Readonly<
  Record<OperationsAdmissionState, readonly OperationsReasonCode[]>
> = Object.freeze({
  accepting: reasons('ADMISSION_ACCEPTING'),
  limited: reasons('ADMISSION_LIMITED_RATE', 'ADMISSION_LIMITED_CAPACITY'),
  unavailable: reasons('ADMISSION_UNAVAILABLE'),
});
const freshnessReasons: Readonly<
  Record<OperationsFreshnessState, readonly OperationsReasonCode[]>
> = Object.freeze({
  current: reasons('FRESHNESS_CURRENT'),
  delayed: reasons('FRESHNESS_DELAYED'),
  stale: reasons('FRESHNESS_STALE'),
  expired: reasons('FRESHNESS_EXPIRED'),
  empty: reasons('FRESHNESS_EMPTY'),
  unavailable: reasons('FRESHNESS_UNAVAILABLE'),
});

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function isIpv4(value: string): boolean {
  if (!ipv4Pattern.test(value)) return false;
  return value.split('.').every((part) => Number(part) <= 255);
}

function normalizedKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/gu, '');
}

/** Reject privacy-sensitive keys and values before any contract value is accepted or retained. */
export function assertOperationsPrivacy(value: unknown): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const visited = new WeakSet<object>();
  let nodes = 0;
  while (stack.length > 0) {
    const entry = stack.pop()!;
    nodes += 1;
    if (nodes > MAX_PRIVACY_SCAN_NODES || entry.depth > MAX_PRIVACY_SCAN_DEPTH) {
      throw new OperationsContractError('FORBIDDEN_FIELD');
    }
    if (typeof entry.value === 'string') {
      if (
        codePointLength(entry.value) > MAX_OPERATIONS_TEXT_CHARACTERS ||
        absoluteUrlPattern.test(entry.value) ||
        isIpv4(entry.value) ||
        (entry.value.includes(':') && ipv6Pattern.test(entry.value))
      ) {
        throw new OperationsContractError('FORBIDDEN_FIELD');
      }
      continue;
    }
    if (typeof entry.value !== 'object' || entry.value === null) continue;
    if (visited.has(entry.value)) throw new OperationsContractError('FORBIDDEN_FIELD');
    visited.add(entry.value);
    if (Array.isArray(entry.value)) {
      if (entry.value.length > MAX_PRIVACY_SCAN_NODES) {
        throw new OperationsContractError('FORBIDDEN_FIELD');
      }
      for (let index = 0; index < entry.value.length; index += 1) {
        if (!Object.hasOwn(entry.value, index)) {
          throw new OperationsContractError('INVALID_SHAPE');
        }
        stack.push({ value: entry.value[index], depth: entry.depth + 1 });
      }
      continue;
    }
    if (!isJsonRecord(entry.value)) throw new OperationsContractError('INVALID_SHAPE');
    for (const key of Reflect.ownKeys(entry.value)) {
      if (typeof key !== 'string' || codePointLength(key) > 64) {
        throw new OperationsContractError('FORBIDDEN_FIELD');
      }
      const descriptor = Object.getOwnPropertyDescriptor(entry.value, key);
      if (!descriptor?.enumerable || !('value' in descriptor)) {
        throw new OperationsContractError('INVALID_SHAPE');
      }
      const normalized = normalizedKey(key);
      if (
        forbiddenKeyFragments.some((fragment) => normalized.includes(fragment)) ||
        normalized.endsWith('trail') ||
        normalized.endsWith('trails')
      ) {
        throw new OperationsContractError('FORBIDDEN_FIELD');
      }
      stack.push({ value: descriptor.value, depth: entry.depth + 1 });
    }
  }
}

function exactRecord(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!isJsonRecord(value)) throw new OperationsContractError('INVALID_SHAPE');
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== 'string' || !fields.includes(key)) ||
    fields.some((field) => !Object.hasOwn(value, field))
  ) {
    throw new OperationsContractError('INVALID_SHAPE');
  }
  return value;
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !identifierPattern.test(value)) {
    throw new OperationsContractError('INVALID_IDENTITY');
  }
  return value;
}

function canonicalTimestamp(value: unknown): string {
  if (!isCanonicalTimestamp(value)) throw new OperationsContractError('INVALID_TIMESTAMP');
  return value;
}

function boundedCounter(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_OPERATIONS_COUNTER
  ) {
    throw new OperationsContractError('INVALID_COUNTER');
  }
  return value;
}

function assertBoundedTotal(values: readonly number[]): void {
  let total = 0;
  for (const value of values) {
    if (value > MAX_OPERATIONS_COUNTER - total) {
      throw new OperationsContractError('INVALID_COUNTER');
    }
    total += value;
  }
}

function parseReasonCodes(
  value: unknown,
  permitted: readonly OperationsReasonCode[],
): readonly OperationsReasonCode[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) {
    throw new OperationsContractError('INVALID_CLASSIFICATION');
  }
  const reasons: OperationsReasonCode[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      throw new OperationsContractError('INVALID_CLASSIFICATION');
    }
    const reason = value[index];
    if (
      typeof reason !== 'string' ||
      !reasonCodeSet.has(reason) ||
      !permitted.includes(reason as OperationsReasonCode) ||
      reasons.includes(reason as OperationsReasonCode)
    ) {
      throw new OperationsContractError('INVALID_CLASSIFICATION');
    }
    reasons.push(reason as OperationsReasonCode);
  }
  return reasons;
}

function parseClassification<State extends string>(
  value: unknown,
  reasonsByState: Readonly<Record<State, readonly OperationsReasonCode[]>>,
): OperationsClassification<State> {
  const record = exactRecord(value, ['state', 'reasonCodes']);
  if (typeof record.state !== 'string' || !Object.hasOwn(reasonsByState, record.state)) {
    throw new OperationsContractError('INVALID_CLASSIFICATION');
  }
  const state = record.state as State;
  const reasonCodes = parseReasonCodes(record.reasonCodes, reasonsByState[state]);
  return { state, reasonCodes };
}

function parseIdentity(value: unknown): OperationsIdentity {
  const record = exactRecord(value, ['applicationVersion', 'releaseSha', 'source', 'policyId']);
  const source = parseLiveSource(record.source);
  if (!source || typeof record.policyId !== 'string' || !policyIdPattern.test(record.policyId)) {
    throw new OperationsContractError('INVALID_IDENTITY');
  }
  return {
    applicationVersion: identifier(record.applicationVersion),
    releaseSha: identifier(record.releaseSha),
    source,
    policyId: record.policyId,
  };
}

function accounting(value: unknown, expected: OperationsAccounting): OperationsAccounting {
  if (value !== expected) throw new OperationsContractError('INVALID_COUNTER');
  return expected;
}

function parseProviderCounters(
  value: unknown,
  expectedAccounting: OperationsAccounting,
): OperationsProviderCounters {
  const record = exactRecord(value, [
    'accounting',
    'pollCount',
    'successCount',
    'failureCount',
    'rateLimitCount',
  ]);
  const result: OperationsProviderCounters = {
    accounting: accounting(record.accounting, expectedAccounting),
    pollCount: boundedCounter(record.pollCount),
    successCount: boundedCounter(record.successCount),
    failureCount: boundedCounter(record.failureCount),
    rateLimitCount: boundedCounter(record.rateLimitCount),
  };
  assertBoundedTotal([result.successCount, result.failureCount]);
  if (
    result.successCount + result.failureCount !== result.pollCount ||
    result.rateLimitCount > result.failureCount
  ) {
    throw new OperationsContractError('INVALID_COUNTER');
  }
  return result;
}

function parseValidationCounters(
  value: unknown,
  expectedAccounting: OperationsAccounting,
): OperationsValidationCounters {
  const record = exactRecord(value, [
    'accounting',
    'acceptedSnapshotCount',
    'rejectedSnapshotCount',
    'invalidFieldCount',
  ]);
  const result: OperationsValidationCounters = {
    accounting: accounting(record.accounting, expectedAccounting),
    acceptedSnapshotCount: boundedCounter(record.acceptedSnapshotCount),
    rejectedSnapshotCount: boundedCounter(record.rejectedSnapshotCount),
    invalidFieldCount: boundedCounter(record.invalidFieldCount),
  };
  assertBoundedTotal([
    result.acceptedSnapshotCount,
    result.rejectedSnapshotCount,
    result.invalidFieldCount,
  ]);
  return result;
}

function parseDeliveryCounters(value: unknown): OperationsDeliveryCounters {
  const record = exactRecord(value, [
    'accounting',
    'acknowledgmentCount',
    'timeoutCount',
    'sendFailureCount',
    'invalidControlCount',
    'hibernationLossCount',
  ]);
  const result: OperationsDeliveryCounters = {
    accounting: accounting(record.accounting, 'best-effort'),
    acknowledgmentCount: boundedCounter(record.acknowledgmentCount),
    timeoutCount: boundedCounter(record.timeoutCount),
    sendFailureCount: boundedCounter(record.sendFailureCount),
    invalidControlCount: boundedCounter(record.invalidControlCount),
    hibernationLossCount: boundedCounter(record.hibernationLossCount),
  };
  assertBoundedTotal([
    result.acknowledgmentCount,
    result.timeoutCount,
    result.sendFailureCount,
    result.invalidControlCount,
    result.hibernationLossCount,
  ]);
  return result;
}

function parseAdmissionCounters(value: unknown): OperationsAdmissionCounters {
  const record = exactRecord(value, [
    'accounting',
    'acceptedCount',
    'rateLimitRejectionCount',
    'capacityRejectionCount',
  ]);
  const result: OperationsAdmissionCounters = {
    accounting: accounting(record.accounting, 'best-effort'),
    acceptedCount: boundedCounter(record.acceptedCount),
    rateLimitRejectionCount: boundedCounter(record.rateLimitRejectionCount),
    capacityRejectionCount: boundedCounter(record.capacityRejectionCount),
  };
  assertBoundedTotal([
    result.acceptedCount,
    result.rateLimitRejectionCount,
    result.capacityRejectionCount,
  ]);
  return result;
}

function parseAggregateWindow(
  value: unknown,
  expectedAccounting: OperationsAccounting,
): OperationsAggregateWindow {
  const record = exactRecord(value, ['startedAt', 'provider', 'validation', 'delivery']);
  const provider = parseProviderCounters(record.provider, expectedAccounting);
  const validation = parseValidationCounters(record.validation, expectedAccounting);
  if (validation.acceptedSnapshotCount + validation.rejectedSnapshotCount > provider.pollCount) {
    throw new OperationsContractError('INVALID_COUNTER');
  }
  return {
    startedAt: canonicalTimestamp(record.startedAt),
    provider,
    validation,
    delivery: parseDeliveryCounters(record.delivery),
  };
}

export function operationsWindowStarts(checkedAt: string): {
  currentHour: string;
  trailing24Hours: string;
} {
  const checkedAtMs = Date.parse(checkedAt);
  const currentHourMs = checkedAtMs - (checkedAtMs % (60 * 60 * 1_000));
  return {
    currentHour: new Date(currentHourMs).toISOString(),
    trailing24Hours: new Date(checkedAtMs - 24 * 60 * 60 * 1_000).toISOString(),
  };
}

function counterValues(value: object): readonly number[] {
  return Object.entries(value)
    .filter(([, entry]) => typeof entry === 'number')
    .map(([, entry]) => entry as number);
}

function assertWindowIncludesCurrent(
  current: OperationsAggregateWindow,
  trailing: OperationsAggregateWindow,
): void {
  const pairs: ReadonlyArray<readonly [object, object]> = [
    [current.provider, trailing.provider],
    [current.validation, trailing.validation],
    [current.delivery, trailing.delivery],
  ];
  for (const [currentGroup, trailingGroup] of pairs) {
    const currentValues = counterValues(currentGroup);
    const trailingValues = counterValues(trailingGroup);
    if (
      currentValues.length !== trailingValues.length ||
      currentValues.some((value, index) => value > trailingValues[index]!)
    ) {
      throw new OperationsContractError('INVALID_WINDOW');
    }
  }
}

function parseAggregateWindows(value: unknown, checkedAt: string): OperationsAggregateWindows {
  const record = exactRecord(value, ['currentHour', 'trailing24Hours']);
  const currentHour = parseAggregateWindow(record.currentHour, 'exact');
  const trailing24Hours = parseAggregateWindow(record.trailing24Hours, 'best-effort');
  const expected = operationsWindowStarts(checkedAt);
  if (
    currentHour.startedAt !== expected.currentHour ||
    trailing24Hours.startedAt !== expected.trailing24Hours
  ) {
    throw new OperationsContractError('INVALID_WINDOW');
  }
  assertWindowIncludesCurrent(currentHour, trailing24Hours);
  return { currentHour, trailing24Hours };
}

function parseAdmissionWindow(value: unknown): OperationsAdmissionWindow {
  const record = exactRecord(value, ['startedAt', 'counters']);
  return {
    startedAt: canonicalTimestamp(record.startedAt),
    counters: parseAdmissionCounters(record.counters),
  };
}

function parseAdmissionWindows(value: unknown, checkedAt: string): OperationsAdmissionWindows {
  const record = exactRecord(value, ['currentHour', 'trailing24Hours']);
  const currentHour = parseAdmissionWindow(record.currentHour);
  const trailing24Hours = parseAdmissionWindow(record.trailing24Hours);
  const expected = operationsWindowStarts(checkedAt);
  if (
    currentHour.startedAt !== expected.currentHour ||
    trailing24Hours.startedAt !== expected.trailing24Hours
  ) {
    throw new OperationsContractError('INVALID_WINDOW');
  }
  const currentValues = counterValues(currentHour.counters);
  const trailingValues = counterValues(trailing24Hours.counters);
  if (currentValues.some((value, index) => value > trailingValues[index]!)) {
    throw new OperationsContractError('INVALID_WINDOW');
  }
  return { currentHour, trailing24Hours };
}

function parseAdmission(value: unknown, checkedAt: string): OperationsAdmission {
  const record = exactRecord(value, ['state', 'reasonCodes', 'scope', 'windows']);
  if (record.scope !== 'worker-isolate') {
    throw new OperationsContractError('INVALID_CLASSIFICATION');
  }
  const classification = parseClassification(
    { state: record.state, reasonCodes: record.reasonCodes },
    admissionReasons,
  );
  return {
    ...classification,
    scope: 'worker-isolate',
    windows: parseAdmissionWindows(record.windows, checkedAt),
  };
}

function parseFreshness(value: unknown): OperationsFreshness {
  const record = exactRecord(value, ['state', 'reasonCodes', 'observationAgeSeconds']);
  const classification = parseClassification(
    { state: record.state, reasonCodes: record.reasonCodes },
    freshnessReasons,
  );
  const age = record.observationAgeSeconds;
  if (classification.state === 'empty' || classification.state === 'unavailable') {
    if (age !== null) throw new OperationsContractError('INVALID_CLASSIFICATION');
  } else if (
    typeof age !== 'number' ||
    !Number.isSafeInteger(age) ||
    age < 0 ||
    age > MAX_OPERATIONS_AGE_SECONDS
  ) {
    throw new OperationsContractError('INVALID_CLASSIFICATION');
  }
  if (typeof age === 'number') {
    const expectedState: OperationsFreshnessState =
      age <= OPERATIONS_CURRENT_MAX_SECONDS
        ? 'current'
        : age <= OPERATIONS_DELAYED_MAX_SECONDS
          ? 'delayed'
          : age <= OPERATIONS_STALE_MAX_SECONDS
            ? 'stale'
            : 'expired';
    if (classification.state !== expectedState) {
      throw new OperationsContractError('INVALID_CLASSIFICATION');
    }
  }
  return { ...classification, observationAgeSeconds: age as number | null };
}

function parseRegion(
  value: unknown,
  expectedRegionId: RegionId,
  checkedAt: string,
): RegionOperations {
  const record = exactRecord(value, [
    'regionId',
    'availability',
    'provider',
    'delivery',
    'freshness',
    'windows',
  ]);
  if (record.regionId !== expectedRegionId) {
    throw new OperationsContractError('INVALID_REGION_SET');
  }
  const availability = parseClassification(record.availability, availabilityReasons);
  const provider = parseClassification(record.provider, providerReasons);
  const delivery = parseClassification(record.delivery, deliveryReasons);
  const freshness = parseFreshness(record.freshness);
  if (
    (availability.state === 'unavailable' && record.windows !== null) ||
    (availability.state === 'available' && record.windows === null)
  ) {
    throw new OperationsContractError('INVALID_WINDOW');
  }
  if (
    availability.state === 'unavailable' &&
    (provider.state !== 'unavailable' ||
      delivery.state !== 'unavailable' ||
      freshness.state !== 'unavailable')
  ) {
    throw new OperationsContractError('INVALID_CLASSIFICATION');
  }
  return {
    regionId: expectedRegionId,
    availability,
    provider,
    delivery,
    freshness,
    windows: record.windows === null ? null : parseAggregateWindows(record.windows, checkedAt),
  };
}

function parseLimitations(value: unknown): OperationsLimitations {
  const record = exactRecord(value, [
    'regionScope',
    'retentionDays',
    'deliveryAccounting',
    'trailingWindowAccounting',
    'admissionScope',
    'globalAvailabilityProof',
    'platformProcessing',
  ]);
  for (const [key, expected] of Object.entries(OPERATIONS_LIMITATIONS)) {
    if (record[key] !== expected) throw new OperationsContractError('INVALID_SHAPE');
  }
  return { ...OPERATIONS_LIMITATIONS };
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

/** Parse one regional read independently so a failed region cannot erase successful peers. */
export function parseRegionOperations(
  value: unknown,
  expectedRegionId: RegionId,
  checkedAt: string,
): Readonly<RegionOperations> {
  assertOperationsPrivacy(value);
  if (!isCanonicalTimestamp(checkedAt)) throw new OperationsContractError('INVALID_TIMESTAMP');
  return deepFreeze(parseRegion(value, expectedRegionId, checkedAt));
}

/** Parse, semantically validate, clone, and deeply freeze an operations.v1 projection. */
export function parseOperationsProjection(value: unknown): Readonly<OperationsProjection> {
  assertOperationsPrivacy(value);
  const record = exactRecord(value, [
    'schemaVersion',
    'identity',
    'checkedAt',
    'application',
    'admission',
    'limitations',
    'regions',
  ]);
  if (record.schemaVersion !== OPERATIONS_SCHEMA_VERSION) {
    throw new OperationsContractError('INVALID_SHAPE');
  }
  const checkedAt = canonicalTimestamp(record.checkedAt);
  if (!Array.isArray(record.regions) || record.regions.length !== OPERATIONS_REGION_IDS.length) {
    throw new OperationsContractError('INVALID_REGION_SET');
  }
  const regions = OPERATIONS_REGION_IDS.map((regionId, index) => {
    if (!Object.hasOwn(record.regions as unknown[], index)) {
      throw new OperationsContractError('INVALID_REGION_SET');
    }
    return parseRegion((record.regions as unknown[])[index], regionId, checkedAt);
  }) as [RegionOperations, RegionOperations, RegionOperations];
  const application = parseClassification(record.application, applicationReasons);
  const availableRegions = regions.filter(
    ({ availability }) => availability.state === 'available',
  ).length;
  const expectedApplicationState: OperationsApplicationState =
    availableRegions === regions.length
      ? 'available'
      : availableRegions === 0
        ? 'unavailable'
        : 'partial';
  if (application.state !== expectedApplicationState) {
    throw new OperationsContractError('INCONSISTENT_APPLICATION');
  }
  return deepFreeze({
    schemaVersion: OPERATIONS_SCHEMA_VERSION,
    identity: parseIdentity(record.identity),
    checkedAt,
    application,
    admission: parseAdmission(record.admission, checkedAt),
    limitations: parseLimitations(record.limitations),
    regions,
  });
}
