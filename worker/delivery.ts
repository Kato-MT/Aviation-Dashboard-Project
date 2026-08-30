import {
  MAX_LIVE_CONTROL_BYTES,
  MAX_LIVE_HANDSHAKE_BYTES,
  encodeLiveDelivery,
  liveDeliveryBytes,
  parseLiveAcknowledgment,
  prepareLivePayload,
  type PreparedLivePayload,
} from '../src/live/delivery';
import { sameLiveFeed } from '../src/live/ordering';
import { LIVE_STREAM_PROTOCOL_VERSION, parseLivePing } from '../src/live/protocol';
import type { LiveFeedBinding } from '../src/live/types';
import { MAX_OPERATIONS_COUNTER } from '../src/operations/contract';
import {
  MAX_LIVE_MESSAGE_BYTES,
  exceedsUtf8ByteLimit,
  isJsonRecord,
  isLiveIdentifier,
  isSafeInteger,
} from '../src/live/validation';
import { validPollTimestamp } from './polling';
import {
  MAX_REGIONAL_VIEWERS,
  MAX_REGIONAL_DELIVERY_BYTES,
  LIVE_DELIVERY_ACK_TIMEOUT_MS,
  MIN_LIVE_PING_INTERVAL_MS,
  MAX_VIEWER_ATTACHMENT_BYTES,
  LIVE_CONTROL_WINDOW_MS,
  MAX_SOCKET_CONTROLS_PER_WINDOW,
  MAX_REGIONAL_CONTROL_BURST,
  REGIONAL_CONTROL_REFILL_PER_SECOND,
} from './deliveryPolicy';
export {
  MAX_REGIONAL_VIEWERS,
  MAX_REGIONAL_DELIVERY_BYTES,
  LIVE_DELIVERY_ACK_TIMEOUT_MS,
  MIN_LIVE_PING_INTERVAL_MS,
  MAX_VIEWER_ATTACHMENT_BYTES,
  LIVE_CONTROL_WINDOW_MS,
  MAX_SOCKET_CONTROLS_PER_WINDOW,
  MAX_REGIONAL_CONTROL_BURST,
  REGIONAL_CONTROL_REFILL_PER_SECOND,
} from './deliveryPolicy';

const OPEN_STATE = 1;
export const DELIVERY_METRIC_FLUSH_INTERVAL_MS = 60_000;
const sizingDeliveryId = '00000000-0000-4000-8000-000000000000';
const stateKinds = ['airspace.snapshot', 'feed.health', 'error'] as const;
type StateKind = (typeof stateKinds)[number];
const stateBits: Record<StateKind, number> = {
  'airspace.snapshot': 1,
  'feed.health': 2,
  error: 4,
};

export interface DeliverySocket {
  readonly readyState: number;
  send(message: string): void;
  close(code: number, reason: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

export interface DeliveryOperationalCounters {
  acknowledgmentCount: number;
  timeoutCount: number;
  sendFailureCount: number;
  invalidControlCount: number;
  hibernationLossCount: number;
}

export interface ViewerAttachment extends LiveFeedBinding {
  attachmentVersion: 'delivery.v1';
  pending: number;
  lastTurn: number;
  pendingPingId?: string;
  lastPingAt?: number;
  controlWindowStartedAt?: number;
  controlCount?: number;
  outstanding?: {
    deliveryId: string;
    expiresAt: number;
    bytes: number;
    sent: boolean;
  };
}

const attachmentKeys = new Set([
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
]);
const outstandingKeys = new Set(['deliveryId', 'expiresAt', 'bytes', 'sent']);

/** Attachments survive hibernation; only explicitly bounded control metadata belongs here. */
export function readViewerAttachment(
  socket: DeliverySocket,
  binding: LiveFeedBinding,
): ViewerAttachment | undefined {
  const value = socket.deserializeAttachment();
  if (
    !isJsonRecord(value) ||
    value.attachmentVersion !== 'delivery.v1' ||
    !isLiveIdentifier(value.providerId) ||
    !isLiveIdentifier(value.regionId) ||
    !isLiveIdentifier(value.feedEpoch) ||
    !sameLiveFeed(value as unknown as LiveFeedBinding, binding) ||
    !isSafeInteger(value.pending, 0, 7) ||
    !isSafeInteger(value.lastTurn) ||
    Object.keys(value).some((key) => !attachmentKeys.has(key)) ||
    (value.lastPingAt !== undefined && !validPollTimestamp(value.lastPingAt)) ||
    (value.controlWindowStartedAt === undefined) !== (value.controlCount === undefined) ||
    (value.controlWindowStartedAt !== undefined &&
      (!validPollTimestamp(value.controlWindowStartedAt) ||
        !isSafeInteger(value.controlCount, 1, MAX_SOCKET_CONTROLS_PER_WINDOW))) ||
    (value.pendingPingId !== undefined &&
      (!isLiveIdentifier(value.pendingPingId) || value.lastPingAt === undefined))
  )
    return undefined;
  if (value.outstanding !== undefined) {
    const outstanding = value.outstanding;
    if (
      !isJsonRecord(outstanding) ||
      !isLiveIdentifier(outstanding.deliveryId) ||
      !validPollTimestamp(outstanding.expiresAt) ||
      !isSafeInteger(outstanding.bytes, 1, MAX_LIVE_MESSAGE_BYTES) ||
      typeof outstanding.sent !== 'boolean' ||
      Object.keys(outstanding).some((key) => !outstandingKeys.has(key))
    )
      return undefined;
  }
  if (exceedsUtf8ByteLimit(JSON.stringify(value), MAX_VIEWER_ATTACHMENT_BYTES)) return undefined;
  return value as unknown as ViewerAttachment;
}

interface DeliveryHooks {
  sockets(): DeliverySocket[];
  binding(): LiveFeedBinding;
  schedule(): Promise<void>;
}

interface Reservation {
  socket: DeliverySocket;
  deliveryId: string;
  messages: readonly PreparedLivePayload[];
  pingId?: string;
}

/** One shared latest state, one receipt window per viewer, and one regional byte ledger. */
export class RegionalDelivery {
  private latest: Partial<Record<StateKind, PreparedLivePayload>> = {};
  private flushPromise: Promise<void> | undefined;
  private flushRequested = false;
  private regionalControlTokens = MAX_REGIONAL_CONTROL_BURST;
  private regionalControlRefilledAt: number | undefined;
  private operationalCounters: DeliveryOperationalCounters = this.emptyOperationalCounters();
  private operationalObservedAt: number | undefined;
  private operationalFlushAt: number | undefined;

  constructor(private readonly hooks: DeliveryHooks) {}

  canAccept(): boolean {
    // Closing sockets still consume capacity until the runtime detaches them.
    return this.hooks.sockets().length < MAX_REGIONAL_VIEWERS;
  }

  initialize(socket: DeliverySocket): void {
    let lastTurn = 0;
    for (const attached of this.hooks.sockets()) {
      const value = readViewerAttachment(attached, this.hooks.binding());
      if (value) lastTurn = Math.max(lastTurn, value.lastTurn);
    }
    socket.serializeAttachment({
      attachmentVersion: 'delivery.v1',
      ...this.hooks.binding(),
      pending: this.availableMask(),
      lastTurn,
    } satisfies ViewerAttachment);
  }

  prime(messages: readonly PreparedLivePayload[]): void {
    this.updateState(messages, false, false);
  }

  assertPublishable(message: PreparedLivePayload): void {
    if (!stateKinds.includes(message.type as StateKind))
      throw new Error('Shared delivery state cannot contain transport control messages.');
    if (
      liveDeliveryBytes(this.hooks.binding(), sizingDeliveryId, [message]) > MAX_LIVE_MESSAGE_BYTES
    )
      throw new Error('The shared payload cannot fit in a bounded live delivery.');
  }

  async publish(messages: readonly PreparedLivePayload[], clearError = false): Promise<void> {
    this.updateState(messages, clearError, true);
    await this.flush();
  }

  expire(): void {
    const now = Date.now();
    for (const socket of this.hooks.sockets()) {
      if (socket.readyState !== OPEN_STATE) continue;
      const value = readViewerAttachment(socket, this.hooks.binding());
      if (!value) socket.close(1012, 'Feed identity changed; reconnect.');
      else if (value.outstanding && value.outstanding.expiresAt <= now) this.closeTimedOut(socket);
    }
  }

  /** Coarse, in-memory counters are persisted only by the regional coordinator. */
  operationalSnapshot(): DeliveryOperationalCounters {
    return { ...this.operationalCounters };
  }

  nextOperationalFlushAt(): number | undefined {
    return this.operationalFlushAt;
  }

  operationalObservedAtMs(): number | undefined {
    return this.operationalObservedAt;
  }

  takeOperationalCounters(nowMs: number, force = false): DeliveryOperationalCounters | undefined {
    if (!validPollTimestamp(nowMs)) throw new RangeError('Invalid delivery metric clock.');
    if (
      !this.hasOperationalCounters() ||
      (!force && (this.operationalFlushAt === undefined || this.operationalFlushAt > nowMs))
    ) {
      return undefined;
    }
    const counters = this.operationalSnapshot();
    this.operationalCounters = this.emptyOperationalCounters();
    this.operationalObservedAt = undefined;
    this.operationalFlushAt = undefined;
    return counters;
  }

  restoreOperationalCounters(
    delta: DeliveryOperationalCounters,
    nowMs: number,
    observedAtMs = nowMs,
  ): void {
    if (!validPollTimestamp(nowMs) || !validPollTimestamp(observedAtMs)) {
      throw new RangeError('Invalid delivery metric clock.');
    }
    for (const key of Object.keys(delta) as Array<keyof DeliveryOperationalCounters>) {
      const value = delta[key];
      if (!Number.isSafeInteger(value) || value < 0 || value > MAX_OPERATIONS_COUNTER) {
        throw new Error('The delivery metric delta is invalid.');
      }
      this.operationalCounters[key] = Math.min(
        MAX_OPERATIONS_COUNTER,
        this.operationalCounters[key] + value,
      );
    }
    this.operationalObservedAt = Math.min(this.operationalObservedAt ?? Infinity, observedAtMs);
    this.armOperationalFlush(nowMs);
  }

  noteHibernationRecovery(): void {
    if (this.hooks.sockets().length > 0) this.recordOperational('hibernationLossCount');
  }

  nextDeadline(): number | undefined {
    let deadline: number | undefined;
    for (const socket of this.hooks.sockets()) {
      if (socket.readyState !== OPEN_STATE) continue;
      const outstanding = readViewerAttachment(socket, this.hooks.binding())?.outstanding;
      if (outstanding) deadline = Math.min(deadline ?? Infinity, outstanding.expiresAt);
    }
    return deadline;
  }

  async control(socket: DeliverySocket, message: unknown): Promise<void> {
    if (socket.readyState !== OPEN_STATE) return;
    if (typeof message !== 'string' || exceedsUtf8ByteLimit(message, MAX_LIVE_CONTROL_BYTES)) {
      this.recordOperational('invalidControlCount');
      socket.close(1008, 'Invalid or excessive live control messages.');
      await this.hooks.schedule();
      return;
    }
    const value = readViewerAttachment(socket, this.hooks.binding());
    if (!value) {
      this.recordOperational('invalidControlCount');
      socket.close(1012, 'Feed identity changed; reconnect.');
      await this.hooks.schedule();
      return;
    }
    const now = Date.now();
    if (!validPollTimestamp(now) || !this.admitSocketControl(value, now)) {
      this.recordOperational('invalidControlCount');
      socket.close(1008, 'Invalid or excessive live control messages.');
      await this.hooks.schedule();
      return;
    }
    socket.serializeAttachment(value);
    if (!this.admitRegionalControl(now)) {
      this.recordOperational('invalidControlCount');
      socket.close(1013, 'Regional live control capacity is temporarily full.');
      await this.hooks.schedule();
      return;
    }
    this.expire();
    if (socket.readyState !== OPEN_STATE) {
      await this.flush();
      await this.hooks.schedule();
      return;
    }
    const ack = parseLiveAcknowledgment(message);
    if (ack) {
      if (
        !sameLiveFeed(value, ack) ||
        !value.outstanding?.sent ||
        value.outstanding.deliveryId !== ack.deliveryId
      ) {
        this.recordOperational('invalidControlCount');
        socket.close(1008, 'Invalid live delivery acknowledgment.');
      } else {
        delete value.outstanding;
        socket.serializeAttachment(value);
        // ACKs remain memory-only until unrelated regional work or an existing
        // alarm provides a batching opportunity. They never create per-ACK writes.
        this.recordOperational('acknowledgmentCount', false);
      }
    } else {
      const ping = parseLivePing(message);
      if (
        !ping ||
        value.pendingPingId !== undefined ||
        (value.lastPingAt !== undefined && now - value.lastPingAt < MIN_LIVE_PING_INTERVAL_MS)
      ) {
        this.recordOperational('invalidControlCount');
        socket.close(1008, 'Invalid or excessive live control messages.');
      } else {
        value.pendingPingId = ping.requestId;
        value.lastPingAt = now;
        socket.serializeAttachment(value);
      }
    }
    await this.flush();
    await this.hooks.schedule();
  }

  private admitSocketControl(value: ViewerAttachment, now: number): boolean {
    if (
      value.controlWindowStartedAt === undefined ||
      value.controlCount === undefined ||
      now - value.controlWindowStartedAt >= LIVE_CONTROL_WINDOW_MS
    ) {
      value.controlWindowStartedAt = now;
      value.controlCount = 1;
      return true;
    }
    if (
      now < value.controlWindowStartedAt ||
      value.controlCount >= MAX_SOCKET_CONTROLS_PER_WINDOW
    ) {
      return false;
    }
    value.controlCount += 1;
    return true;
  }

  private admitRegionalControl(now: number): boolean {
    if (this.regionalControlRefilledAt === undefined) this.regionalControlRefilledAt = now;
    if (now < this.regionalControlRefilledAt) return false;
    this.regionalControlTokens = Math.min(
      MAX_REGIONAL_CONTROL_BURST,
      this.regionalControlTokens +
        ((now - this.regionalControlRefilledAt) / 1_000) * REGIONAL_CONTROL_REFILL_PER_SECOND,
    );
    this.regionalControlRefilledAt = now;
    if (this.regionalControlTokens < 1) return false;
    this.regionalControlTokens -= 1;
    return true;
  }

  private emptyOperationalCounters(): DeliveryOperationalCounters {
    return {
      acknowledgmentCount: 0,
      timeoutCount: 0,
      sendFailureCount: 0,
      invalidControlCount: 0,
      hibernationLossCount: 0,
    };
  }

  private hasOperationalCounters(): boolean {
    return Object.values(this.operationalCounters).some((value) => value > 0);
  }

  private armOperationalFlush(nowMs: number): void {
    const deadline = nowMs + DELIVERY_METRIC_FLUSH_INTERVAL_MS;
    if (!validPollTimestamp(nowMs) || !validPollTimestamp(deadline)) return;
    this.operationalFlushAt ??= deadline;
  }

  private recordOperational(key: keyof DeliveryOperationalCounters, armFlush = true): void {
    const now = Date.now();
    this.operationalCounters[key] = Math.min(
      MAX_OPERATIONS_COUNTER,
      this.operationalCounters[key] + 1,
    );
    if (validPollTimestamp(now)) this.operationalObservedAt ??= now;
    if (armFlush) this.armOperationalFlush(now);
  }

  private closeTimedOut(socket: DeliverySocket): void {
    this.recordOperational('timeoutCount');
    socket.close(1008, 'Live delivery acknowledgment timed out.');
  }

  flush(): Promise<void> {
    this.flushRequested = true;
    this.flushPromise ??= Promise.resolve()
      .then(() => this.flushLoop())
      .finally(() => {
        this.flushPromise = undefined;
        // A caller may enqueue work between the final loop and this promise's cleanup.
        if (this.flushRequested) return this.flush();
      });
    return this.flushPromise;
  }

  private availableMask(): number {
    return stateKinds.reduce((mask, kind) => mask | (this.latest[kind] ? stateBits[kind] : 0), 0);
  }

  private updateState(
    messages: readonly PreparedLivePayload[],
    clearError: boolean,
    notify: boolean,
  ): void {
    let changed = 0;
    const next = { ...this.latest };
    for (const message of messages) {
      // Fail before accepting state that cannot fit even by itself in a delivery.
      this.assertPublishable(message);
      const kind = message.type as StateKind;
      next[kind] = message;
      changed |= stateBits[kind];
    }
    if (clearError) delete next.error;
    this.latest = next;
    if (!notify) return;
    for (const socket of this.hooks.sockets()) {
      if (socket.readyState !== OPEN_STATE) continue;
      const value = readViewerAttachment(socket, this.hooks.binding());
      if (!value) {
        socket.close(1012, 'Feed identity changed; reconnect.');
        continue;
      }
      value.pending |= changed;
      if (clearError) value.pending &= ~stateBits.error;
      socket.serializeAttachment(value);
    }
  }

  private reserve(): Reservation[] {
    const sockets = this.hooks.sockets();
    const binding = this.hooks.binding();
    // Reserve all connection slots up front; late joins cannot enlarge a saturated ledger.
    let used = MAX_REGIONAL_VIEWERS * MAX_LIVE_HANDSHAKE_BYTES;
    let turn = 0;
    const ready: Array<{ socket: DeliverySocket; value: ViewerAttachment }> = [];
    for (const socket of sockets) {
      const value = readViewerAttachment(socket, binding);
      // An invalid attachment cannot silently free a possibly occupied transport window.
      used += value ? (value.outstanding?.bytes ?? 0) : MAX_LIVE_MESSAGE_BYTES;
      if (!value) continue;
      turn = Math.max(turn, value.lastTurn);
      if (
        socket.readyState === OPEN_STATE &&
        !value.outstanding &&
        (value.pending || value.pendingPingId)
      )
        ready.push({ socket, value });
    }
    ready.sort((left, right) => left.value.lastTurn - right.value.lastTurn);
    if (!ready.length) return [];
    if (turn > Number.MAX_SAFE_INTEGER - MAX_REGIONAL_VIEWERS)
      throw new Error('The live delivery scheduling ordinal is exhausted.');
    const reservations: Reservation[] = [];
    const now = Date.now();
    const expiresAt = now + LIVE_DELIVERY_ACK_TIMEOUT_MS;
    if (!validPollTimestamp(now) || !validPollTimestamp(expiresAt))
      throw new Error('The live delivery deadline cannot be represented.');
    for (const { socket, value } of ready) {
      const deliveryId = crypto.randomUUID();
      const messages: PreparedLivePayload[] = [];
      const pingId = value.pendingPingId;
      if (pingId) messages.push(this.pong(pingId, now));
      let sentMask = 0;
      for (const kind of stateKinds) {
        const payload = this.latest[kind];
        if (!(value.pending & stateBits[kind]) || !payload) continue;
        if (liveDeliveryBytes(binding, deliveryId, [...messages, payload]) > MAX_LIVE_MESSAGE_BYTES)
          continue;
        messages.push(payload);
        sentMask |= stateBits[kind];
      }
      value.pending &= this.availableMask();
      if (messages.length === 0) {
        socket.serializeAttachment(value);
        continue;
      }
      const bytes = liveDeliveryBytes(binding, deliveryId, messages);
      // Do not let small/fast viewers repeatedly jump ahead of an older large delivery.
      if (used + bytes > MAX_REGIONAL_DELIVERY_BYTES) break;
      used += bytes;
      value.pending &= ~sentMask;
      delete value.pendingPingId;
      value.lastTurn = ++turn;
      value.outstanding = { deliveryId, expiresAt, bytes, sent: false };
      socket.serializeAttachment(value);
      reservations.push({ socket, deliveryId, messages, ...(pingId ? { pingId } : {}) });
    }
    return reservations;
  }

  private pong(requestId: string, now: number): PreparedLivePayload {
    return prepareLivePayload({
      type: 'pong',
      protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
      ...this.hooks.binding(),
      requestId,
      generatedAt: new Date(now).toISOString(),
    });
  }

  private async flushLoop(): Promise<void> {
    while (this.flushRequested) {
      this.flushRequested = false;
      this.expire();
      const reservations = this.reserve();
      if (!reservations.length) continue;
      try {
        // No bytes enter a transport buffer without a durable expiry wakeup.
        await this.hooks.schedule();
      } catch (error) {
        for (const { socket } of reservations)
          if (socket.readyState === OPEN_STATE)
            socket.close(1011, 'The delivery deadline could not be committed.');
        throw error;
      }
      for (const { socket, deliveryId, messages, pingId } of reservations) {
        if (socket.readyState !== OPEN_STATE) continue;
        const value = readViewerAttachment(socket, this.hooks.binding());
        if (!value) {
          socket.close(1012, 'Feed identity changed; reconnect.');
          continue;
        }
        if (!value.outstanding || value.outstanding.deliveryId !== deliveryId) continue;
        const now = Date.now();
        if (value.outstanding.expiresAt <= now) {
          this.closeTimedOut(socket);
          continue;
        }
        const payloads = pingId
          ? messages.map((message) => (message.type === 'pong' ? this.pong(pingId, now) : message))
          : messages;
        const encoded = encodeLiveDelivery(this.hooks.binding(), deliveryId, payloads);
        if (encoded.bytes !== value.outstanding.bytes)
          throw new Error('The reserved delivery byte count changed before sending.');
        value.outstanding.sent = true;
        socket.serializeAttachment(value);
        try {
          socket.send(encoded.wire);
        } catch {
          this.recordOperational('sendFailureCount');
          socket.close(1011, 'Live delivery send failed.');
        }
      }
    }
  }
}
