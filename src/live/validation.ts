import { RUNTIME_POLICY_LIMITS } from './runtimePolicyLimits';

export const MAX_LIVE_MESSAGE_BYTES: number = RUNTIME_POLICY_LIMITS.protocol.maximumMessageBytes;
export const MAX_LIVE_AIRCRAFT: number = RUNTIME_POLICY_LIMITS.protocol.maximumAircraft;
export const MAX_LIVE_PROTOCOL_ERRORS: number =
  RUNTIME_POLICY_LIMITS.protocol.maximumValidationErrors;
export const MAX_LIVE_FUTURE_OFFSET_MS: number =
  RUNTIME_POLICY_LIMITS.protocol.maximumFutureOffsetMs;

const timestampPattern =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/u;

export function isJsonRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !timestampPattern.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

export function isLiveIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/u.test(value);
}

export function isBoundedText(value: unknown, maxLength: number): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength * 2 ||
    value.trim() !== value
  ) {
    return false;
  }
  const characters = Array.from(value);
  return (
    characters.length <= maxLength &&
    characters.every((character) => {
      const code = character.charCodeAt(0);
      return code >= 0x20 && code !== 0x7f;
    })
  );
}

export function isFiniteNumber(
  value: unknown,
  minimum = -Infinity,
  maximum = Infinity,
): value is number {
  return (
    typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
  );
}

export function isSafeInteger(
  value: unknown,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum
  );
}

export function exceedsUtf8ByteLimit(value: string, maxBytes = MAX_LIVE_MESSAGE_BYTES): boolean {
  // UTF-8 is never shorter than a string's UTF-16 code-unit count.
  return value.length > maxBytes || new TextEncoder().encode(value).byteLength > maxBytes;
}
