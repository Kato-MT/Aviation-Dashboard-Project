export const STREAM_PROTOCOL_VERSION = '1.0.0' as const;

export type StreamMessageType = 'hello' | 'telemetry' | 'heartbeat' | 'end';

export interface StreamEnvelope {
  protocolVersion: typeof STREAM_PROTOCOL_VERSION;
  type: StreamMessageType;
  sourceId: string;
  sequence: number;
  timestamp: string;
}

export interface HelloMessage extends StreamEnvelope {
  type: 'hello';
  schemaVersion: string;
  profileId: string;
  units: Record<string, string>;
  capabilities: string[];
}

export interface TelemetryMessage extends StreamEnvelope {
  type: 'telemetry';
  measurements: Record<string, number | null>;
  qualityFlags: string[];
}

export interface HeartbeatMessage extends StreamEnvelope {
  type: 'heartbeat';
  status: 'nominal' | 'degraded';
  uptimeMs: number;
  queueDepth: number;
  droppedMessages: number;
}

export interface EndMessage extends StreamEnvelope {
  type: 'end';
  reason: 'complete' | 'operator_stop' | 'source_error';
  finalSequence: number;
}

export type StreamMessage = HelloMessage | TelemetryMessage | HeartbeatMessage | EndMessage;

export interface ProtocolParseResult {
  ok: boolean;
  message?: StreamMessage;
  errors: string[];
}

const SOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function validateEnvelope(value: Record<string, unknown>, errors: string[]): void {
  if (value.protocolVersion !== STREAM_PROTOCOL_VERSION) {
    errors.push(`Unsupported protocolVersion: expected ${STREAM_PROTOCOL_VERSION}.`);
  }
  if (
    value.type !== 'hello' &&
    value.type !== 'telemetry' &&
    value.type !== 'heartbeat' &&
    value.type !== 'end'
  ) {
    errors.push('type must be hello, telemetry, heartbeat, or end.');
  }
  if (typeof value.sourceId !== 'string' || !SOURCE_ID_PATTERN.test(value.sourceId)) {
    errors.push('sourceId must be a safe identifier between 1 and 128 characters.');
  }
  if (!Number.isSafeInteger(value.sequence) || (value.sequence as number) < 0) {
    errors.push('sequence must be a non-negative safe integer.');
  }
  if (
    typeof value.timestamp !== 'string' ||
    value.timestamp.trim() === '' ||
    !Number.isFinite(Date.parse(value.timestamp))
  ) {
    errors.push('timestamp must be a valid ISO-8601 timestamp.');
  }
}

function validateStringRecord(
  value: unknown,
  fieldName: string,
  errors: string[],
): value is Record<string, string> {
  if (!isRecord(value)) {
    errors.push(`${fieldName} must be an object.`);
    return false;
  }
  const invalid = Object.entries(value).some(
    ([key, entry]) => key.trim() === '' || typeof entry !== 'string' || entry.trim() === '',
  );
  if (invalid) {
    errors.push(`${fieldName} must contain only non-empty string keys and values.`);
    return false;
  }
  return true;
}

function validateStringArray(
  value: unknown,
  fieldName: string,
  errors: string[],
): value is string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== 'string' || entry.trim() === '')
  ) {
    errors.push(`${fieldName} must be an array of non-empty strings.`);
    return false;
  }
  return true;
}

export function parseStreamMessage(input: string | unknown): ProtocolParseResult {
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
      if (typeof value.schemaVersion !== 'string' || value.schemaVersion.trim() === '') {
        errors.push('schemaVersion must be a non-empty string.');
      }
      if (typeof value.profileId !== 'string' || value.profileId.trim() === '') {
        errors.push('profileId must be a non-empty string.');
      }
      validateStringRecord(value.units, 'units', errors);
      validateStringArray(value.capabilities, 'capabilities', errors);
      break;
    case 'telemetry': {
      if (!isRecord(value.measurements)) {
        errors.push('measurements must be an object.');
      } else {
        for (const [channel, measurement] of Object.entries(value.measurements)) {
          if (channel.trim() === '') {
            errors.push('measurement channel names cannot be blank.');
          }
          if (measurement !== null && !isFiniteNumber(measurement)) {
            errors.push(`measurements.${channel} must be finite or null.`);
          }
        }
      }
      validateStringArray(value.qualityFlags, 'qualityFlags', errors);
      break;
    }
    case 'heartbeat':
      if (value.status !== 'nominal' && value.status !== 'degraded') {
        errors.push('heartbeat status must be nominal or degraded.');
      }
      if (!isFiniteNumber(value.uptimeMs) || value.uptimeMs < 0) {
        errors.push('uptimeMs must be a non-negative finite number.');
      }
      if (!Number.isSafeInteger(value.queueDepth) || (value.queueDepth as number) < 0) {
        errors.push('queueDepth must be a non-negative safe integer.');
      }
      if (!Number.isSafeInteger(value.droppedMessages) || (value.droppedMessages as number) < 0) {
        errors.push('droppedMessages must be a non-negative safe integer.');
      }
      break;
    case 'end':
      if (
        value.reason !== 'complete' &&
        value.reason !== 'operator_stop' &&
        value.reason !== 'source_error'
      ) {
        errors.push('end reason is invalid.');
      }
      if (!Number.isSafeInteger(value.finalSequence) || (value.finalSequence as number) < 0) {
        errors.push('finalSequence must be a non-negative safe integer.');
      }
      break;
    default:
      break;
  }

  return errors.length === 0
    ? { ok: true, message: value as unknown as StreamMessage, errors }
    : { ok: false, errors };
}

export function serializeStreamMessage(message: StreamMessage): string {
  const result = parseStreamMessage(message);
  if (!result.ok) {
    throw new Error(`Cannot serialize invalid stream message: ${result.errors.join(' ')}`);
  }
  return JSON.stringify(message);
}
