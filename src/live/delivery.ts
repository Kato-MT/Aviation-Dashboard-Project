import { sameLiveFeed } from './ordering';
import {
  LIVE_STREAM_PROTOCOL_VERSION,
  parseLiveStreamMessage,
  serializeLiveStreamMessage,
  type LiveHelloMessage,
  type LiveStreamMessage,
} from './protocol';
import type { LiveFeedBinding } from './types';
import {
  MAX_LIVE_MESSAGE_BYTES,
  exceedsUtf8ByteLimit,
  isJsonRecord,
  isLiveIdentifier,
} from './validation';
import { RUNTIME_POLICY_LIMITS } from './runtimePolicyLimits';

export const MAX_LIVE_CONTROL_BYTES: number = RUNTIME_POLICY_LIMITS.delivery.maximumControlBytes;
export const MAX_LIVE_HANDSHAKE_BYTES: number =
  RUNTIME_POLICY_LIMITS.delivery.maximumHandshakeBytes;
export const MAX_LIVE_DELIVERY_MESSAGES: number =
  RUNTIME_POLICY_LIMITS.delivery.maximumMessagesPerDelivery;

export type LiveDeliveryPayload = Exclude<LiveStreamMessage, LiveHelloMessage>;

export interface LiveDeliveryMessage extends LiveFeedBinding {
  type: 'delivery';
  protocolVersion: typeof LIVE_STREAM_PROTOCOL_VERSION;
  deliveryId: string;
  messages: LiveDeliveryPayload[];
}

export interface LiveAcknowledgment extends LiveFeedBinding {
  type: 'ack';
  protocolVersion: typeof LIVE_STREAM_PROTOCOL_VERSION;
  deliveryId: string;
}

export type LiveServerFrame = LiveHelloMessage | LiveDeliveryMessage;

export type LiveFrameParseResult =
  | { ok: true; message: LiveServerFrame; errors: [] }
  | { ok: false; message?: undefined; errors: string[] };

const bindingFields = ['providerId', 'regionId', 'feedEpoch'] as const;
const acknowledgmentFields = new Set(['type', 'protocolVersion', 'deliveryId', ...bindingFields]);
const deliveryFields = new Set([...acknowledgmentFields, 'messages']);

function validBinding(value: Record<string, unknown>): boolean {
  return bindingFields.every((field) => isLiveIdentifier(value[field]));
}

function payloadBinding(message: LiveDeliveryPayload): LiveFeedBinding | undefined {
  if (message.type === 'airspace.snapshot') return message.snapshot;
  if (message.type === 'feed.health') return message.health;
  if (message.type === 'pong') return message;
  return undefined;
}

const preparedBrand = Symbol('validated live payload');
const preparedPayloads = new WeakSet<PreparedLivePayload>();

export interface PreparedLivePayload {
  readonly [preparedBrand]: true;
  readonly type: LiveDeliveryPayload['type'];
  readonly wire: string;
  readonly bytes: number;
  readonly binding?: Readonly<LiveFeedBinding>;
}

/** Validate and serialize shared state once, not once per viewer. */
export function prepareLivePayload(message: LiveDeliveryPayload): PreparedLivePayload {
  const wire = serializeLiveStreamMessage(message);
  const serialized = JSON.parse(wire) as LiveStreamMessage;
  if (serialized.type === 'hello' || serialized.type !== message.type)
    throw new Error('A prepared payload cannot change its message type during serialization.');
  const binding = payloadBinding(serialized);
  const prepared: PreparedLivePayload = Object.freeze({
    [preparedBrand]: true as const,
    type: serialized.type,
    wire,
    bytes: new TextEncoder().encode(wire).byteLength,
    ...(binding
      ? {
          binding: Object.freeze({
            providerId: binding.providerId,
            regionId: binding.regionId,
            feedEpoch: binding.feedEpoch,
          }),
        }
      : {}),
  });
  preparedPayloads.add(prepared);
  return prepared;
}

function preparedHeader(
  binding: LiveFeedBinding,
  deliveryId: string,
  messages: readonly PreparedLivePayload[],
): string {
  if (
    !validBinding(binding as unknown as Record<string, unknown>) ||
    !isLiveIdentifier(deliveryId) ||
    messages.length < 1 ||
    messages.length > MAX_LIVE_DELIVERY_MESSAGES
  )
    throw new Error('Cannot encode an invalid live delivery.');
  const types = new Set<string>();
  for (const payload of messages) {
    if (
      !preparedPayloads.has(payload) ||
      types.has(payload.type) ||
      (payload.binding && !sameLiveFeed(binding, payload.binding))
    )
      throw new Error('Delivery requires unique, validated payloads with matching feed bindings.');
    types.add(payload.type);
  }
  return (
    JSON.stringify({
      type: 'delivery',
      protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
      providerId: binding.providerId,
      regionId: binding.regionId,
      feedEpoch: binding.feedEpoch,
      deliveryId,
    }).slice(0, -1) + ',"messages":['
  );
}

export function liveDeliveryBytes(
  binding: LiveFeedBinding,
  deliveryId: string,
  messages: readonly PreparedLivePayload[],
): number {
  const header = preparedHeader(binding, deliveryId, messages);
  return (
    new TextEncoder().encode(header).byteLength +
    messages.reduce((total, message) => total + message.bytes, 0) +
    messages.length -
    1 +
    2
  );
}

export function encodeLiveDelivery(
  binding: LiveFeedBinding,
  deliveryId: string,
  messages: readonly PreparedLivePayload[],
): { wire: string; bytes: number } {
  const header = preparedHeader(binding, deliveryId, messages);
  const bytes =
    new TextEncoder().encode(header).byteLength +
    messages.reduce((total, message) => total + message.bytes, 0) +
    messages.length -
    1 +
    2;
  if (bytes > MAX_LIVE_MESSAGE_BYTES)
    throw new Error('Cannot encode a delivery above the UTF-8 byte limit.');
  return { wire: header + messages.map((message) => message.wire).join(',') + ']}', bytes };
}

/** Validate the whole delivery before a caller dispatches any contained message. */
export function parseLiveServerFrame(input: unknown): LiveFrameParseResult {
  let value: unknown = input;
  if (typeof input === 'string') {
    if (exceedsUtf8ByteLimit(input))
      return { ok: false, errors: ['Delivery exceeds the UTF-8 byte limit.'] };
    try {
      value = JSON.parse(input) as unknown;
    } catch {
      return { ok: false, errors: ['Delivery is not valid JSON.'] };
    }
  }
  if (!isJsonRecord(value)) return { ok: false, errors: ['Delivery must be a JSON object.'] };
  if (value.type === 'hello') {
    const parsed = parseLiveStreamMessage(value);
    if (!parsed.ok || parsed.message?.type !== 'hello') return { ok: false, errors: parsed.errors };
    if (typeof input === 'string' && exceedsUtf8ByteLimit(input, MAX_LIVE_HANDSHAKE_BYTES))
      return { ok: false, errors: ['Hello exceeds the handshake byte limit.'] };
    return { ok: true, message: parsed.message, errors: [] };
  }
  if (
    value.type !== 'delivery' ||
    value.protocolVersion !== LIVE_STREAM_PROTOCOL_VERSION ||
    !isLiveIdentifier(value.deliveryId) ||
    !validBinding(value) ||
    Object.keys(value).some((key) => !deliveryFields.has(key))
  ) {
    return { ok: false, errors: ['Expected a versioned, feed-bound delivery envelope.'] };
  }
  if (
    !Array.isArray(value.messages) ||
    value.messages.length < 1 ||
    value.messages.length > MAX_LIVE_DELIVERY_MESSAGES
  ) {
    return { ok: false, errors: ['Delivery must contain one to four payloads.'] };
  }
  const binding = value as unknown as LiveFeedBinding;
  const types = new Set<string>();
  for (const raw of value.messages) {
    // Contained payloads are objects, never encoded JSON or another transport frame.
    if (!isJsonRecord(raw))
      return { ok: false, errors: ['Delivery payloads must be JSON objects.'] };
    const parsed = parseLiveStreamMessage(raw);
    if (!parsed.ok || !parsed.message) return { ok: false, errors: parsed.errors };
    if (parsed.message.type === 'hello' || types.has(parsed.message.type))
      return { ok: false, errors: ['Delivery payload types must be unique and cannot be hello.'] };
    types.add(parsed.message.type);
    const innerBinding = payloadBinding(parsed.message);
    if (innerBinding && !sameLiveFeed(binding, innerBinding))
      return { ok: false, errors: ['Delivery payload does not match its outer feed binding.'] };
  }
  return { ok: true, message: value as unknown as LiveDeliveryMessage, errors: [] };
}

export function serializeLiveServerFrame(message: LiveServerFrame): string {
  const parsed = parseLiveServerFrame(message);
  if (!parsed.ok) throw new Error('Cannot serialize live delivery: ' + parsed.errors.join(' '));
  const wire = JSON.stringify(message);
  if (typeof wire !== 'string') throw new Error('Live delivery must serialize to a JSON value.');
  // Includes metadata bytes and any programmatic toJSON transformation.
  const serialized = parseLiveServerFrame(wire);
  if (!serialized.ok)
    throw new Error('Cannot serialize live delivery output: ' + serialized.errors.join(' '));
  return wire;
}

export function parseLiveAcknowledgment(input: unknown): LiveAcknowledgment | undefined {
  if (typeof input !== 'string' || exceedsUtf8ByteLimit(input, MAX_LIVE_CONTROL_BYTES))
    return undefined;
  let value: unknown;
  try {
    value = JSON.parse(input) as unknown;
  } catch {
    return undefined;
  }
  if (
    !isJsonRecord(value) ||
    value.type !== 'ack' ||
    value.protocolVersion !== LIVE_STREAM_PROTOCOL_VERSION ||
    !isLiveIdentifier(value.deliveryId) ||
    !validBinding(value) ||
    Object.keys(value).some((key) => !acknowledgmentFields.has(key))
  ) {
    return undefined;
  }
  return value as unknown as LiveAcknowledgment;
}

export function serializeLiveAcknowledgment(delivery: LiveDeliveryMessage): string {
  const wire = JSON.stringify({
    type: 'ack',
    protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
    providerId: delivery.providerId,
    regionId: delivery.regionId,
    feedEpoch: delivery.feedEpoch,
    deliveryId: delivery.deliveryId,
  } satisfies LiveAcknowledgment);
  if (!parseLiveAcknowledgment(wire)) throw new Error('Cannot serialize invalid acknowledgment.');
  return wire;
}
