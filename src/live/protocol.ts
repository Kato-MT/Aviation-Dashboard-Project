import { AIRSPACE_SCHEMA_VERSION } from './types';
import type { AirspaceSnapshot, LiveFeedBinding, LiveFeedHealth } from './types';
import {
  MAX_LIVE_AIRCRAFT,
  MAX_LIVE_FUTURE_OFFSET_MS,
  MAX_LIVE_PROTOCOL_ERRORS,
  exceedsUtf8ByteLimit,
  isBoundedText,
  isCanonicalTimestamp,
  isFiniteNumber,
  isJsonRecord,
  isLiveIdentifier,
  isSafeInteger,
} from './validation';

export const LIVE_STREAM_PROTOCOL_VERSION = '1.0.0' as const;

export type LiveStreamErrorCode =
  'REGION_NOT_FOUND' | 'UPSTREAM_UNAVAILABLE' | 'PROTOCOL_ERROR' | 'INTERNAL_ERROR';

export interface LiveHelloMessage extends LiveFeedBinding {
  type: 'hello';
  protocolVersion: typeof LIVE_STREAM_PROTOCOL_VERSION;
  schemaVersion: typeof AIRSPACE_SCHEMA_VERSION;
  pollIntervalMs: number;
  generatedAt: string;
}

export interface AirspaceSnapshotMessage {
  type: 'airspace.snapshot';
  protocolVersion: typeof LIVE_STREAM_PROTOCOL_VERSION;
  snapshot: AirspaceSnapshot;
}

export interface FeedHealthMessage {
  type: 'feed.health';
  protocolVersion: typeof LIVE_STREAM_PROTOCOL_VERSION;
  health: LiveFeedHealth;
}

export interface LiveStreamErrorMessage {
  type: 'error';
  protocolVersion: typeof LIVE_STREAM_PROTOCOL_VERSION;
  code: LiveStreamErrorCode;
  message: string;
  recoverable: boolean;
  retryAt?: string | undefined;
}

export interface LivePingMessage {
  type: 'ping';
  protocolVersion: typeof LIVE_STREAM_PROTOCOL_VERSION;
  requestId: string;
}

export interface LivePongMessage extends LiveFeedBinding {
  type: 'pong';
  protocolVersion: typeof LIVE_STREAM_PROTOCOL_VERSION;
  requestId: string;
  generatedAt: string;
}

export type LiveStreamMessage =
  | LiveHelloMessage
  | AirspaceSnapshotMessage
  | FeedHealthMessage
  | LiveStreamErrorMessage
  | LivePongMessage;

export interface LiveProtocolParseResult {
  ok: boolean;
  message?: LiveStreamMessage | undefined;
  errors: string[];
}

const errorCodes = new Set<string>([
  'REGION_NOT_FOUND',
  'UPSTREAM_UNAVAILABLE',
  'PROTOCOL_ERROR',
  'INTERNAL_ERROR',
]);
const feedStatuses = new Set<string>([
  'connecting',
  'live',
  'degraded',
  'stale',
  'reconnecting',
  'offline',
]);
const qualityFlags = new Set<string>([
  'missing-position',
  'stale-position',
  'stale-contact',
  'provider-time-regression',
  'time-uncertain',
]);
const aircraftFields = new Set([
  'aircraftId',
  'identifierKind',
  'callsign',
  'registration',
  'aircraftType',
  'category',
  'position',
  'barometricAltitudeFeet',
  'geometricAltitudeFeet',
  'groundSpeedKnots',
  'trackDegrees',
  'verticalRateFeetPerMinute',
  'verticalRateBasis',
  'onGround',
  'sourceType',
  'observedAt',
  'lastContactAt',
  'lastPositionAt',
  'contactAgeSeconds',
  'positionAgeSeconds',
  'qualityFlags',
]);
const snapshotFields = new Set([
  'schemaVersion',
  'providerId',
  'feedEpoch',
  'regionId',
  'sequence',
  'generatedAt',
  'providerGeneratedAt',
  'aircraft',
  'validation',
]);
const healthFields = new Set([
  'schemaVersion',
  'regionId',
  'providerId',
  'feedEpoch',
  'status',
  'checkedAt',
  'lastSuccessAt',
  'lastSnapshotAt',
  'upstreamLatencyMs',
  'consecutiveFailures',
  'retryAt',
  'message',
]);
const validationFields = new Set([
  'receivedAircraft',
  'acceptedAircraft',
  'rejectedAircraft',
  'duplicateAircraft',
  'invalidFields',
]);
const positionFields = new Set(['latitude', 'longitude']);
const helloFields = new Set([
  'type',
  'protocolVersion',
  'schemaVersion',
  'regionId',
  'providerId',
  'feedEpoch',
  'pollIntervalMs',
  'generatedAt',
]);
const snapshotMessageFields = new Set(['type', 'protocolVersion', 'snapshot']);
const healthMessageFields = new Set(['type', 'protocolVersion', 'health']);
const errorMessageFields = new Set([
  'type',
  'protocolVersion',
  'code',
  'message',
  'recoverable',
  'retryAt',
]);
const pingFields = new Set(['type', 'protocolVersion', 'requestId']);
const pongFields = new Set([
  'type',
  'protocolVersion',
  'requestId',
  'generatedAt',
  'providerId',
  'regionId',
  'feedEpoch',
]);

export function parseLivePing(input: unknown): LivePingMessage | undefined {
  if (typeof input !== 'string' || exceedsUtf8ByteLimit(input, 512)) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    return undefined;
  }
  if (
    !isJsonRecord(value) ||
    value.type !== 'ping' ||
    value.protocolVersion !== LIVE_STREAM_PROTOCOL_VERSION ||
    !isLiveIdentifier(value.requestId) ||
    Object.keys(value).some((key) => !pingFields.has(key))
  ) {
    return undefined;
  }
  return value as unknown as LivePingMessage;
}

function addError(errors: string[], message: string): void {
  if (errors.length < MAX_LIVE_PROTOCOL_ERRORS) errors.push(message);
}

function validateKeys(
  value: Record<string, unknown>,
  allowed: Set<string>,
  path: string,
  errors: string[],
): void {
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) {
      addError(errors, path + ' contains unsupported properties.');
      return;
    }
  }
}

function validateEnvelope(value: Record<string, unknown>, errors: string[]): void {
  if (value.protocolVersion !== LIVE_STREAM_PROTOCOL_VERSION) {
    addError(errors, 'protocolVersion must be ' + LIVE_STREAM_PROTOCOL_VERSION + '.');
  }
  if (
    value.type !== 'hello' &&
    value.type !== 'airspace.snapshot' &&
    value.type !== 'feed.health' &&
    value.type !== 'error' &&
    value.type !== 'pong'
  ) {
    addError(errors, 'type must be hello, airspace.snapshot, feed.health, error, or pong.');
  }
}

function hasValidQualityFlags(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > qualityFlags.size) return false;
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index++) {
    const flag: unknown = value[index];
    if (
      !Object.hasOwn(value, index) ||
      typeof flag !== 'string' ||
      !qualityFlags.has(flag) ||
      seen.has(flag)
    ) {
      return false;
    }
    seen.add(flag);
  }
  return true;
}

function validateAircraft(value: unknown, index: number, errors: string[]): void {
  const path = 'snapshot.aircraft[' + index + ']';
  if (!isJsonRecord(value)) {
    addError(errors, path + ' must be an object.');
    return;
  }
  validateKeys(value, aircraftFields, path, errors);
  if (typeof value.aircraftId !== 'string' || !/^~?[0-9a-f]{6}$/u.test(value.aircraftId)) {
    addError(errors, path + '.aircraftId must be a normalized surveillance identifier.');
  }
  if (
    (value.identifierKind !== 'icao24' && value.identifierKind !== 'other') ||
    (typeof value.aircraftId === 'string' &&
      (value.identifierKind === 'other') !== value.aircraftId.startsWith('~'))
  ) {
    addError(errors, path + '.identifierKind must match the surveillance identifier.');
  }
  for (const field of ['callsign', 'registration', 'aircraftType', 'category', 'sourceType']) {
    if (
      value[field] !== undefined &&
      !isBoundedText(value[field], field === 'sourceType' ? 32 : 16)
    ) {
      addError(errors, path + '.' + field + ' must be bounded, non-empty, trimmed text.');
    }
  }
  if (!isCanonicalTimestamp(value.lastContactAt) || !isCanonicalTimestamp(value.observedAt)) {
    addError(errors, path + ' must contain valid contact timestamps.');
  }
  if (value.lastPositionAt !== undefined && !isCanonicalTimestamp(value.lastPositionAt)) {
    addError(errors, path + '.lastPositionAt must be a canonical UTC timestamp.');
  }
  const uncertainTime =
    Array.isArray(value.qualityFlags) && value.qualityFlags.includes('time-uncertain');
  const minimumAge = uncertainTime ? -MAX_LIVE_FUTURE_OFFSET_MS / 1_000 : 0;
  if (!isFiniteNumber(value.contactAgeSeconds, minimumAge)) {
    addError(
      errors,
      path + '.contactAgeSeconds must be finite and within the declared time tolerance.',
    );
  }
  if (
    value.positionAgeSeconds !== undefined &&
    !isFiniteNumber(value.positionAgeSeconds, minimumAge)
  ) {
    addError(
      errors,
      path + '.positionAgeSeconds must be finite and within the declared time tolerance.',
    );
  }
  if (typeof value.onGround !== 'boolean' && value.onGround !== null) {
    addError(errors, path + '.onGround must be a boolean or explicit null.');
  }
  if (
    (value.verticalRateFeetPerMinute !== undefined) !== (value.verticalRateBasis !== undefined) ||
    (value.verticalRateBasis !== undefined &&
      value.verticalRateBasis !== 'barometric' &&
      value.verticalRateBasis !== 'geometric')
  ) {
    addError(
      errors,
      path + ' must provide a vertical rate and its barometric/geometric basis together.',
    );
  }
  for (const field of [
    'barometricAltitudeFeet',
    'geometricAltitudeFeet',
    'verticalRateFeetPerMinute',
  ]) {
    if (value[field] !== undefined && !isFiniteNumber(value[field])) {
      addError(errors, path + '.' + field + ' must be finite when provided.');
    }
  }
  if (value.groundSpeedKnots !== undefined && !isFiniteNumber(value.groundSpeedKnots, 0)) {
    addError(errors, path + '.groundSpeedKnots must be finite and non-negative.');
  }
  if (
    value.trackDegrees !== undefined &&
    (!isFiniteNumber(value.trackDegrees, 0, 360) || value.trackDegrees === 360)
  ) {
    addError(errors, path + '.trackDegrees must be finite and in [0, 360).');
  }
  if (!hasValidQualityFlags(value.qualityFlags)) {
    addError(errors, path + '.qualityFlags must contain unique recognized quality flags.');
  }
  const hasPosition = value.position !== undefined;
  if (
    hasPosition !== (value.lastPositionAt !== undefined) ||
    hasPosition !== (value.positionAgeSeconds !== undefined)
  ) {
    addError(
      errors,
      path + ' must provide coordinates, position timestamp and position age together.',
    );
  }
  if (value.position !== undefined) {
    if (
      !isJsonRecord(value.position) ||
      !isFiniteNumber(value.position.latitude, -90, 90) ||
      !isFiniteNumber(value.position.longitude, -180, 180)
    ) {
      addError(errors, path + '.position must contain valid latitude and longitude.');
    } else {
      validateKeys(value.position, positionFields, path + '.position', errors);
    }
  }
}

function validateSummary(
  value: unknown,
  aircraftCount: number | undefined,
  errors: string[],
): void {
  if (!isJsonRecord(value)) {
    addError(errors, 'snapshot.validation must be an object.');
    return;
  }
  validateKeys(value, validationFields, 'snapshot.validation', errors);
  let valid = true;
  for (const field of validationFields) {
    if (
      !isSafeInteger(
        value[field],
        0,
        field === 'invalidFields' ? Number.MAX_SAFE_INTEGER : MAX_LIVE_AIRCRAFT,
      )
    ) {
      valid = false;
      addError(
        errors,
        'snapshot.validation.' + field + ' must be a bounded non-negative safe integer.',
      );
    }
  }
  if (!valid) return;
  if (aircraftCount !== undefined && value.acceptedAircraft !== aircraftCount) {
    addError(errors, 'snapshot.validation.acceptedAircraft must equal the aircraft count.');
  }
  if (
    value.receivedAircraft !==
    (value.acceptedAircraft as number) +
      (value.rejectedAircraft as number) +
      (value.duplicateAircraft as number)
  ) {
    addError(errors, 'snapshot.validation totals must partition received aircraft.');
  }
}

function validateAircraftTimes(
  value: Record<string, unknown>,
  index: number,
  receivedAtMs: number,
  providerAtMs: number,
  errors: string[],
): void {
  const path = 'snapshot.aircraft[' + index + ']';
  if (isCanonicalTimestamp(value.lastContactAt)) {
    const contactAtMs = Date.parse(value.lastContactAt);
    if (value.observedAt !== value.lastContactAt) {
      addError(errors, path + '.observedAt must retain its contact-time basis.');
    }
    if (contactAtMs > providerAtMs) {
      addError(errors, path + '.lastContactAt cannot follow the provider snapshot.');
    }
    if (value.contactAgeSeconds !== (receivedAtMs - contactAtMs) / 1_000) {
      addError(errors, path + '.contactAgeSeconds must match the immutable receipt time.');
    }
  }
  if (isCanonicalTimestamp(value.lastPositionAt)) {
    const positionAtMs = Date.parse(value.lastPositionAt);
    if (positionAtMs > providerAtMs) {
      addError(errors, path + '.lastPositionAt cannot follow the provider snapshot.');
    }
    if (value.positionAgeSeconds !== (receivedAtMs - positionAtMs) / 1_000) {
      addError(errors, path + '.positionAgeSeconds must match the immutable receipt time.');
    }
  }
  if (
    providerAtMs > receivedAtMs &&
    (!Array.isArray(value.qualityFlags) || !value.qualityFlags.includes('time-uncertain'))
  ) {
    addError(errors, path + ' must declare uncertainty for a future provider clock.');
  }
}

function validateSnapshot(value: unknown, errors: string[]): void {
  if (!isJsonRecord(value)) {
    addError(errors, 'snapshot must be an object.');
    return;
  }
  validateKeys(value, snapshotFields, 'snapshot', errors);
  if (value.schemaVersion !== AIRSPACE_SCHEMA_VERSION) {
    addError(errors, 'snapshot.schemaVersion must be ' + AIRSPACE_SCHEMA_VERSION + '.');
  }
  if (!isLiveIdentifier(value.providerId) || !isLiveIdentifier(value.regionId)) {
    addError(errors, 'snapshot providerId and regionId must be valid identifiers.');
  }
  if (!isLiveIdentifier(value.feedEpoch))
    addError(errors, 'snapshot.feedEpoch must be a valid identifier.');
  if (!isSafeInteger(value.sequence)) {
    addError(errors, 'snapshot.sequence must be a non-negative safe integer.');
  }
  const receivedAtMs = isCanonicalTimestamp(value.generatedAt)
    ? Date.parse(value.generatedAt)
    : undefined;
  const providerAtMs = isCanonicalTimestamp(value.providerGeneratedAt)
    ? Date.parse(value.providerGeneratedAt)
    : undefined;
  if (receivedAtMs === undefined || providerAtMs === undefined) {
    addError(errors, 'snapshot timestamps must be valid canonical UTC values.');
  } else if (providerAtMs - receivedAtMs > MAX_LIVE_FUTURE_OFFSET_MS) {
    addError(errors, 'snapshot provider time exceeds the future-clock tolerance.');
  }
  if (!Array.isArray(value.aircraft)) {
    addError(errors, 'snapshot.aircraft must be an array.');
  } else if (value.aircraft.length > MAX_LIVE_AIRCRAFT) {
    addError(errors, 'snapshot.aircraft exceeds the record limit.');
  } else {
    const identities = new Set<string>();
    for (
      let index = 0;
      index < value.aircraft.length && errors.length < MAX_LIVE_PROTOCOL_ERRORS;
      index++
    ) {
      const aircraft: unknown = value.aircraft[index];
      validateAircraft(aircraft, index, errors);
      if (isJsonRecord(aircraft) && typeof aircraft.aircraftId === 'string') {
        if (receivedAtMs !== undefined && providerAtMs !== undefined) {
          validateAircraftTimes(aircraft, index, receivedAtMs, providerAtMs, errors);
        }
        if (identities.has(aircraft.aircraftId)) {
          addError(errors, 'snapshot.aircraft must contain unique aircraft identities.');
        }
        identities.add(aircraft.aircraftId);
      }
    }
  }
  validateSummary(
    value.validation,
    Array.isArray(value.aircraft) ? value.aircraft.length : undefined,
    errors,
  );
}

function validateHealth(value: unknown, errors: string[]): void {
  if (!isJsonRecord(value)) {
    addError(errors, 'health must be an object.');
    return;
  }
  validateKeys(value, healthFields, 'health', errors);
  if (value.schemaVersion !== AIRSPACE_SCHEMA_VERSION) {
    addError(errors, 'health.schemaVersion must be ' + AIRSPACE_SCHEMA_VERSION + '.');
  }
  if (!isLiveIdentifier(value.providerId) || !isLiveIdentifier(value.regionId)) {
    addError(errors, 'health providerId and regionId must be valid identifiers.');
  }
  if (!isLiveIdentifier(value.feedEpoch))
    addError(errors, 'health.feedEpoch must be a valid identifier.');
  if (!isCanonicalTimestamp(value.checkedAt)) {
    addError(errors, 'health.checkedAt must be a canonical UTC timestamp.');
  }
  if (!isSafeInteger(value.consecutiveFailures)) {
    addError(errors, 'health.consecutiveFailures must be a non-negative safe integer.');
  }
  if (
    typeof value.status !== 'string' ||
    !feedStatuses.has(value.status) ||
    !isBoundedText(value.message, 512)
  ) {
    addError(errors, 'health must contain a recognized status and bounded message.');
  }
  for (const field of ['lastSuccessAt', 'lastSnapshotAt', 'retryAt']) {
    if (value[field] !== undefined && !isCanonicalTimestamp(value[field])) {
      addError(errors, 'health.' + field + ' must be a canonical UTC timestamp.');
    }
  }
  if (value.upstreamLatencyMs !== undefined && !isFiniteNumber(value.upstreamLatencyMs, 0)) {
    addError(errors, 'health.upstreamLatencyMs must be finite and non-negative.');
  }
}

export function parseLiveStreamMessage(input: unknown): LiveProtocolParseResult {
  let value: unknown = input;
  if (typeof input === 'string') {
    if (exceedsUtf8ByteLimit(input)) {
      return { ok: false, errors: ['Message exceeds the UTF-8 byte limit.'] };
    }
    try {
      value = JSON.parse(input) as unknown;
    } catch {
      return { ok: false, errors: ['Message is not valid JSON.'] };
    }
  }
  if (!isJsonRecord(value)) {
    return { ok: false, errors: ['Message must be a JSON object.'] };
  }

  const errors: string[] = [];
  validateEnvelope(value, errors);
  switch (value.type) {
    case 'pong':
      validateKeys(value, pongFields, 'pong', errors);
      if (!isLiveIdentifier(value.requestId) || !isCanonicalTimestamp(value.generatedAt)) {
        addError(errors, 'pong must contain its request identifier and server time.');
      }
      if (
        !isLiveIdentifier(value.regionId) ||
        !isLiveIdentifier(value.providerId) ||
        !isLiveIdentifier(value.feedEpoch)
      ) {
        addError(errors, 'pong must contain its feed binding.');
      }
      break;
    case 'hello':
      validateKeys(value, helloFields, 'hello', errors);
      if (value.schemaVersion !== AIRSPACE_SCHEMA_VERSION) {
        addError(errors, 'schemaVersion must be ' + AIRSPACE_SCHEMA_VERSION + '.');
      }
      if (
        !isLiveIdentifier(value.regionId) ||
        !isLiveIdentifier(value.providerId) ||
        !isLiveIdentifier(value.feedEpoch) ||
        !isSafeInteger(value.pollIntervalMs, 1_000) ||
        !isCanonicalTimestamp(value.generatedAt)
      ) {
        addError(errors, 'hello fields are invalid.');
      }
      break;
    case 'airspace.snapshot':
      validateKeys(value, snapshotMessageFields, 'airspace.snapshot', errors);
      validateSnapshot(value.snapshot, errors);
      break;
    case 'feed.health':
      validateKeys(value, healthMessageFields, 'feed.health', errors);
      validateHealth(value.health, errors);
      break;
    case 'error':
      validateKeys(value, errorMessageFields, 'error', errors);
      if (
        typeof value.code !== 'string' ||
        !errorCodes.has(value.code) ||
        !isBoundedText(value.message, 512) ||
        typeof value.recoverable !== 'boolean'
      ) {
        addError(errors, 'error fields are invalid.');
      }
      if (value.retryAt !== undefined && !isCanonicalTimestamp(value.retryAt)) {
        addError(errors, 'error.retryAt must be a valid ISO-8601 value when provided.');
      }
      break;
  }

  return errors.length === 0
    ? { ok: true, message: value as unknown as LiveStreamMessage, errors }
    : { ok: false, errors };
}

export function serializeLiveStreamMessage(message: LiveStreamMessage): string {
  const result = parseLiveStreamMessage(message);
  if (!result.ok) {
    throw new Error('Cannot serialize invalid live stream message: ' + result.errors.join(' '));
  }
  const serialized = JSON.stringify(message);
  if (typeof serialized !== 'string') {
    throw new Error('Cannot serialize a live stream message without a JSON value.');
  }
  if (exceedsUtf8ByteLimit(serialized)) {
    throw new Error('Cannot serialize live stream message above the UTF-8 byte limit.');
  }
  // Programmatic toJSON hooks must not bypass validation of the actual wire payload.
  const wireResult = parseLiveStreamMessage(serialized);
  if (!wireResult.ok) {
    throw new Error('Cannot serialize invalid live stream output: ' + wireResult.errors.join(' '));
  }
  return serialized;
}
