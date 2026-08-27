import { AIRSPACE_SCHEMA_VERSION } from './types';
import type { AirspaceSnapshot, LiveFeedHealth } from './types';

export const LIVE_STREAM_PROTOCOL_VERSION = '1.0.0' as const;

export type LiveStreamErrorCode =
  'REGION_NOT_FOUND' | 'UPSTREAM_UNAVAILABLE' | 'PROTOCOL_ERROR' | 'INTERNAL_ERROR';

export interface LiveHelloMessage {
  type: 'hello';
  protocolVersion: typeof LIVE_STREAM_PROTOCOL_VERSION;
  schemaVersion: typeof AIRSPACE_SCHEMA_VERSION;
  regionId: string;
  providerId: string;
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

export type LiveStreamMessage =
  LiveHelloMessage | AirspaceSnapshotMessage | FeedHealthMessage | LiveStreamErrorMessage;

export interface LiveProtocolParseResult {
  ok: boolean;
  message?: LiveStreamMessage | undefined;
  errors: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && Number.isFinite(Date.parse(value));
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validateEnvelope(value: Record<string, unknown>, errors: string[]): void {
  if (value.protocolVersion !== LIVE_STREAM_PROTOCOL_VERSION) {
    errors.push(`protocolVersion must be ${LIVE_STREAM_PROTOCOL_VERSION}.`);
  }
  if (
    value.type !== 'hello' &&
    value.type !== 'airspace.snapshot' &&
    value.type !== 'feed.health' &&
    value.type !== 'error'
  ) {
    errors.push('type must be hello, airspace.snapshot, feed.health, or error.');
  }
}

function validateAircraft(value: unknown, index: number, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`snapshot.aircraft[${index}] must be an object.`);
    return;
  }
  if (typeof value.aircraftId !== 'string' || value.aircraftId.trim() === '') {
    errors.push(`snapshot.aircraft[${index}].aircraftId must be a non-empty string.`);
  }
  if (!isIsoTimestamp(value.lastContactAt) || !isIsoTimestamp(value.observedAt)) {
    errors.push(`snapshot.aircraft[${index}] must contain valid contact timestamps.`);
  }
  if (typeof value.contactAgeSeconds !== 'number' || value.contactAgeSeconds < 0) {
    errors.push(`snapshot.aircraft[${index}].contactAgeSeconds must be non-negative.`);
  }
  if (!Array.isArray(value.qualityFlags)) {
    errors.push(`snapshot.aircraft[${index}].qualityFlags must be an array.`);
  }
  if (value.position !== undefined) {
    if (
      !isRecord(value.position) ||
      typeof value.position.latitude !== 'number' ||
      typeof value.position.longitude !== 'number'
    ) {
      errors.push(`snapshot.aircraft[${index}].position must contain numeric coordinates.`);
    }
  }
}

function validateSnapshot(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push('snapshot must be an object.');
    return;
  }
  if (value.schemaVersion !== AIRSPACE_SCHEMA_VERSION) {
    errors.push(`snapshot.schemaVersion must be ${AIRSPACE_SCHEMA_VERSION}.`);
  }
  if (typeof value.providerId !== 'string' || typeof value.regionId !== 'string') {
    errors.push('snapshot providerId and regionId must be strings.');
  }
  if (!isNonNegativeInteger(value.sequence)) {
    errors.push('snapshot.sequence must be a non-negative safe integer.');
  }
  if (!isIsoTimestamp(value.generatedAt) || !isIsoTimestamp(value.providerGeneratedAt)) {
    errors.push('snapshot timestamps must be valid ISO-8601 values.');
  }
  if (!Array.isArray(value.aircraft)) {
    errors.push('snapshot.aircraft must be an array.');
  } else {
    value.aircraft.forEach((aircraft, index) => validateAircraft(aircraft, index, errors));
  }
  if (!isRecord(value.validation)) {
    errors.push('snapshot.validation must be an object.');
  }
}

function validateHealth(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push('health must be an object.');
    return;
  }
  if (value.schemaVersion !== AIRSPACE_SCHEMA_VERSION) {
    errors.push(`health.schemaVersion must be ${AIRSPACE_SCHEMA_VERSION}.`);
  }
  if (typeof value.providerId !== 'string' || typeof value.regionId !== 'string') {
    errors.push('health providerId and regionId must be strings.');
  }
  if (!isIsoTimestamp(value.checkedAt)) {
    errors.push('health.checkedAt must be a valid ISO-8601 value.');
  }
  if (!isNonNegativeInteger(value.consecutiveFailures)) {
    errors.push('health.consecutiveFailures must be a non-negative safe integer.');
  }
  if (typeof value.message !== 'string' || typeof value.status !== 'string') {
    errors.push('health status and message must be strings.');
  }
}

export function parseLiveStreamMessage(input: string | unknown): LiveProtocolParseResult {
  let value: unknown = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input) as unknown;
    } catch {
      return { ok: false, errors: ['Message is not valid JSON.'] };
    }
  }
  if (!isRecord(value)) {
    return { ok: false, errors: ['Message must be a JSON object.'] };
  }

  const errors: string[] = [];
  validateEnvelope(value, errors);
  switch (value.type) {
    case 'hello':
      if (value.schemaVersion !== AIRSPACE_SCHEMA_VERSION) {
        errors.push(`schemaVersion must be ${AIRSPACE_SCHEMA_VERSION}.`);
      }
      if (
        typeof value.regionId !== 'string' ||
        typeof value.providerId !== 'string' ||
        !isNonNegativeInteger(value.pollIntervalMs) ||
        !isIsoTimestamp(value.generatedAt)
      ) {
        errors.push('hello fields are invalid.');
      }
      break;
    case 'airspace.snapshot':
      validateSnapshot(value.snapshot, errors);
      break;
    case 'feed.health':
      validateHealth(value.health, errors);
      break;
    case 'error':
      if (
        typeof value.code !== 'string' ||
        typeof value.message !== 'string' ||
        typeof value.recoverable !== 'boolean'
      ) {
        errors.push('error fields are invalid.');
      }
      if (value.retryAt !== undefined && !isIsoTimestamp(value.retryAt)) {
        errors.push('error.retryAt must be a valid ISO-8601 value when provided.');
      }
      break;
    default:
      break;
  }

  return errors.length === 0
    ? { ok: true, message: value as unknown as LiveStreamMessage, errors }
    : { ok: false, errors };
}

export function serializeLiveStreamMessage(message: LiveStreamMessage): string {
  const result = parseLiveStreamMessage(message);
  if (!result.ok) {
    throw new Error(`Cannot serialize invalid live stream message: ${result.errors.join(' ')}`);
  }
  return JSON.stringify(message);
}
