import { BoundedExponentialBackoff } from '../streaming/backoff';
import type { ClockReading, ServerTimeSample } from './clock';
import { parseLiveServerFrame, serializeLiveAcknowledgment } from './delivery';
import { LiveFeedOrder, sameLiveFeed } from './ordering';
import { cancelLiveResponse, readBoundedLiveText, withLiveRequestDeadline } from './http';
import { LIVE_STREAM_PROTOCOL_VERSION, parseLiveStreamMessage } from './protocol';
import type { LiveStreamMessage } from './protocol';
import {
  DEFAULT_LIVE_PROVIDER_ID,
  type LiveFeedBinding,
  type LiveFeedHealth,
  type LiveTransportStatus,
} from './types';
import { isCanonicalTimestamp, isFiniteNumber, isSafeInteger } from './validation';

export interface LiveSocketEvent {
  data?: unknown;
}

export interface LiveSocket {
  readonly readyState: number;
  addEventListener(type: string, listener: (event: LiveSocketEvent) => void): void;
  removeEventListener(type: string, listener: (event: LiveSocketEvent) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type LiveSocketFactory = (url: string) => LiveSocket;
export type { LiveTransportStatus } from './types';

export interface LiveAirspaceClientOptions {
  regionId: string;
  providerId?: string;
  apiBaseUrl?: string;
  fetcher?: typeof fetch;
  socketFactory?: LiveSocketFactory;
  reconnect?: {
    initialDelayMs?: number;
    maximumDelayMs?: number;
    multiplier?: number;
    jitterRatio?: number;
  };
  keepaliveMs?: number;
  bootstrapTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  pongTimeoutMs?: number;
  readClock?: () => ClockReading;
  onTimeSample?: (sample: ServerTimeSample) => void;
  onFeedBinding?: (binding: Readonly<LiveFeedBinding>) => void;
  onMessage: (message: LiveStreamMessage) => void;
  onStatus: (status: LiveTransportStatus) => void;
  onProtocolError?: (errors: readonly string[], raw: unknown) => void;
  onError?: (message: string) => void;
}

interface Connection {
  socket: LiveSocket;
  generation: number;
  opened: boolean;
  receivedHello: boolean;
  startedAt: ClockReading;
  binding?: Readonly<LiveFeedBinding> | undefined;
  pendingPing?:
    { requestId: string; sent: ClockReading; binding: Readonly<LiveFeedBinding> } | undefined;
  listeners: Map<string, (event: LiveSocketEvent) => void>;
  handshakeTimer?: ReturnType<typeof setTimeout> | undefined;
  keepaliveTimer?: ReturnType<typeof setInterval> | undefined;
  pongTimer?: ReturnType<typeof setTimeout> | undefined;
}

const OPEN_STATE = 1;
const MAX_TIMER_MS = 2_147_483_647;

function trimSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function socketUrl(httpUrl: string): string {
  const runtimeLocation = (globalThis as { location?: { href?: string } }).location?.href;
  const url = new URL(httpUrl, runtimeLocation ?? 'http://localhost');
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : 'The live airspace request failed.';
}

function timerOption(value: number, name: string, minimum = 1_000): number {
  if (!isSafeInteger(value, minimum, MAX_TIMER_MS)) {
    throw new RangeError(
      name + ' must be a timer-safe integer of at least ' + minimum + ' milliseconds.',
    );
  }
  return value;
}

export class LiveAirspaceClient {
  private readonly options: LiveAirspaceClientOptions;
  private readonly apiBaseUrl: string;
  private readonly backoff: BoundedExponentialBackoff;
  private readonly maximumReconnectMs: number;
  private readonly keepaliveMs: number;
  private readonly bootstrapTimeoutMs: number;
  private readonly handshakeTimeoutMs: number;
  private readonly pongTimeoutMs: number;
  private readonly order: LiveFeedOrder;
  private connection?: Connection | undefined;
  private bootstrapController?: AbortController | undefined;
  private reconnectTimer?: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  private hasOpened = false;
  private generation = 0;
  private pingSequence = 0;
  private handshakeRevision = 0;

  constructor(options: LiveAirspaceClientOptions) {
    if (!options.regionId.trim()) throw new TypeError('regionId must be a non-empty string.');
    this.options = { ...options };
    this.order = new LiveFeedOrder(options.regionId, options.providerId);
    this.apiBaseUrl = trimSlash(options.apiBaseUrl ?? '/api/v1');
    const reconnect = options.reconnect ?? {};
    const initialDelayMs = timerOption(reconnect.initialDelayMs ?? 500, 'initialDelayMs', 1);
    this.maximumReconnectMs = timerOption(reconnect.maximumDelayMs ?? 30_000, 'maximumDelayMs', 1);
    const multiplier = reconnect.multiplier ?? 2;
    const jitterRatio = reconnect.jitterRatio ?? 0.2;
    if (!isFiniteNumber(multiplier, 1) || !isFiniteNumber(jitterRatio, 0, 1)) {
      throw new RangeError(
        'Reconnect multiplier and jitterRatio must be finite and within their bounds.',
      );
    }
    this.backoff = new BoundedExponentialBackoff({
      initialDelayMs,
      maximumDelayMs: this.maximumReconnectMs,
      multiplier,
      jitterRatio,
      maximumAttempts: Number.MAX_SAFE_INTEGER,
    });
    this.keepaliveMs = timerOption(options.keepaliveMs ?? 30_000, 'keepaliveMs');
    this.bootstrapTimeoutMs = timerOption(
      options.bootstrapTimeoutMs ?? 10_000,
      'bootstrapTimeoutMs',
    );
    this.handshakeTimeoutMs = timerOption(
      options.handshakeTimeoutMs ?? 10_000,
      'handshakeTimeoutMs',
    );
    this.pongTimeoutMs = timerOption(options.pongTimeoutMs ?? 10_000, 'pongTimeoutMs');
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.hasOpened = false;
    this.order.reset();
    this.handshakeRevision += 1;
    this.backoff.reset();
    const generation = ++this.generation;
    const controller = new AbortController();
    this.bootstrapController = controller;
    this.options.onStatus('connecting');
    if (!this.isActive(generation)) return;
    void this.loadInitialSnapshot(generation, controller.signal);
    this.connect(generation);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    const generation = ++this.generation;
    const controller = this.bootstrapController;
    const connection = this.connection;
    const reconnectTimer = this.reconnectTimer;
    // Detach old resources before abort/close can synchronously start another activation.
    this.bootstrapController = undefined;
    this.connection = undefined;
    this.reconnectTimer = undefined;
    if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
    if (connection) this.retireConnection(connection, 1000, 'client stop');
    controller?.abort();
    if (this.stopped && this.generation === generation) this.options.onStatus('stopped');
  }

  private isActive(generation: number): boolean {
    return !this.stopped && generation === this.generation;
  }

  private owns(connection: Connection): boolean {
    return this.connection === connection && this.isActive(connection.generation);
  }

  private async loadInitialSnapshot(generation: number, signal: AbortSignal): Promise<void> {
    const fetcher = this.options.fetcher ?? fetch;
    const handshakeRevision = this.handshakeRevision;
    try {
      const sent = this.readClock();
      const result = await withLiveRequestDeadline(
        async (requestSignal) => {
          const response = await fetcher(this.snapshotEndpoint(), {
            headers: { accept: 'application/json' },
            signal: requestSignal,
            cache: 'no-store',
          });
          if (!this.isActive(generation) || requestSignal.aborted) {
            cancelLiveResponse(response);
            return undefined;
          }
          const body = await readBoundedLiveText(response, { signal: requestSignal });
          if (!this.isActive(generation)) return undefined;
          let value: unknown;
          try {
            value = JSON.parse(body);
          } catch {
            // JSON parser messages can contain upstream content. Preserve HTTP failures without it.
            if (response.ok) throw new Error('The snapshot response is not valid JSON.');
          }
          return {
            value,
            ok: response.ok,
            status: response.status,
            serverAt: response.headers.get('x-airspace-server-time'),
            received: this.readClock(),
          };
        },
        { timeoutMs: this.bootstrapTimeoutMs, signal },
      );
      if (!this.isActive(generation) || !result) return;
      const sample = isCanonicalTimestamp(result.serverAt)
        ? { sent, received: result.received, serverAt: result.serverAt }
        : undefined;

      if (!result.ok) {
        if (this.handshakeRevision !== handshakeRevision) return;
        const health = this.extractHealth(result.value);
        if (health) {
          const delivered = this.deliver(
            {
              type: 'feed.health',
              protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
              health,
            },
            generation,
            sample,
          );
          if (!delivered) return;
        }
        if (this.isActive(generation) && this.handshakeRevision === handshakeRevision) {
          this.options.onError?.('Snapshot request failed with HTTP ' + result.status + '.');
        }
        return;
      }
      const parsed = parseLiveStreamMessage({
        type: 'airspace.snapshot',
        protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
        snapshot: result.value,
      });
      if (!this.isActive(generation)) return;
      if (!parsed.ok || !parsed.message) {
        if (this.handshakeRevision === handshakeRevision)
          this.options.onProtocolError?.(parsed.errors, result.value);
        return;
      }
      this.deliver(
        parsed.message,
        generation,
        sample,
        false,
        this.handshakeRevision === handshakeRevision,
      );
    } catch (error) {
      if (this.isActive(generation) && this.handshakeRevision === handshakeRevision)
        this.options.onError?.(errorMessage(error));
    }
  }

  private connect(generation: number): void {
    if (!this.isActive(generation)) return;
    const factory = this.options.socketFactory ?? this.defaultSocketFactory;
    try {
      const startedAt = this.readClock();
      const socket = factory(socketUrl(this.streamEndpoint()));
      const connection: Connection = {
        socket,
        generation,
        opened: false,
        receivedHello: false,
        startedAt,
        listeners: new Map(),
      };
      if (!this.isActive(generation)) {
        this.retireConnection(connection, 1000, 'superseded connection');
        return;
      }
      this.connection = connection;
      connection.listeners = new Map([
        ['open', () => this.handleOpen(connection)],
        ['message', (event: LiveSocketEvent) => this.handleMessage(connection, event)],
        ['close', () => this.failConnection(connection)],
        [
          'error',
          () => {
            if (this.owns(connection) && connection.socket.readyState !== OPEN_STATE) {
              this.failConnection(connection, 'The live connection could not open.');
            }
          },
        ],
      ]);
      for (const [type, listener] of connection.listeners) socket.addEventListener(type, listener);
      this.armHandshakeDeadline(connection, 'The live connection did not open in time.');
      if (socket.readyState === OPEN_STATE) this.handleOpen(connection);
    } catch (error) {
      if (!this.isActive(generation)) return;
      try {
        if (this.connection?.generation === generation) {
          this.retireConnection(this.connection, 1000, 'connection setup failed');
        }
        this.options.onError?.(errorMessage(error));
      } finally {
        this.scheduleReconnect(generation);
      }
    }
  }

  private handleOpen(connection: Connection): void {
    if (!this.owns(connection) || connection.opened) return;
    connection.opened = true;
    this.hasOpened = true;
    this.armHandshakeDeadline(connection, 'The live stream did not send its hello in time.');
    connection.keepaliveTimer = setInterval(() => this.sendKeepalive(connection), this.keepaliveMs);
    this.options.onStatus('open');
  }

  private handleMessage(connection: Connection, event: LiveSocketEvent): void {
    if (!this.owns(connection)) return;
    if (typeof event.data !== 'string') {
      this.options.onProtocolError?.(['WebSocket payload must be text JSON.'], event.data);
      return;
    }
    const parsed = parseLiveServerFrame(event.data);
    if (!parsed.ok || !parsed.message) {
      this.options.onProtocolError?.(parsed.errors, event.data);
      return;
    }
    if (parsed.message.type === 'hello') {
      if (
        parsed.message.regionId !== this.options.regionId ||
        parsed.message.providerId !== (this.options.providerId ?? DEFAULT_LIVE_PROVIDER_ID)
      ) {
        this.options.onProtocolError?.(
          ['The live hello does not match the requested provider and region.'],
          event.data,
        );
        this.failConnection(connection, 'The live stream returned the wrong provider or region.');
        return;
      }
      const firstHello = !connection.receivedHello;
      if (!firstHello && !sameLiveFeed(connection.binding, parsed.message)) {
        this.options.onProtocolError?.(
          ['A feed epoch change requires a new connection hello.'],
          event.data,
        );
        this.failConnection(connection, 'The live stream changed identity without reconnecting.');
        return;
      }
      connection.receivedHello = true;
      connection.binding = {
        providerId: parsed.message.providerId,
        regionId: parsed.message.regionId,
        feedEpoch: parsed.message.feedEpoch,
      };
      if (firstHello) this.handshakeRevision += 1;
      const delivered = this.deliver(
        parsed.message,
        connection.generation,
        firstHello
          ? {
              sent: connection.startedAt,
              received: this.readClock(),
              serverAt: parsed.message.generatedAt,
            }
          : undefined,
        firstHello,
      );
      if (!delivered || !this.owns(connection)) return;
      this.backoff.reset();
      if (connection.handshakeTimer !== undefined) clearTimeout(connection.handshakeTimer);
      connection.handshakeTimer = undefined;
      return;
    } else if (!connection.receivedHello) {
      this.options.onProtocolError?.(['The live stream must send hello before data.'], event.data);
      this.failConnection(connection, 'The live stream sent data before its hello.');
      return;
    }
    if (!sameLiveFeed(connection.binding, this.order.binding)) return;
    const delivery = parsed.message;
    if (!sameLiveFeed(connection.binding, delivery)) {
      this.options.onProtocolError?.(['The delivery does not match the active feed.'], event.data);
      return;
    }
    for (const message of delivery.messages) {
      if (!this.owns(connection) || !sameLiveFeed(connection.binding, this.order.binding)) return;
      if (message.type !== 'pong') {
        // Valid HTTP-first duplicates still receive an ACK without being republished.
        this.deliver(message, connection.generation);
        continue;
      }
      const pending = connection.pendingPing;
      if (
        !pending ||
        message.requestId !== pending.requestId ||
        !sameLiveFeed(pending.binding, message) ||
        !sameLiveFeed(connection.binding, message)
      ) {
        this.options.onProtocolError?.(
          ['The pong does not match the pending keepalive.'],
          event.data,
        );
        continue;
      }
      if (connection.pongTimer !== undefined) clearTimeout(connection.pongTimer);
      connection.pongTimer = undefined;
      connection.pendingPing = undefined;
      this.options.onTimeSample?.({
        sent: pending.sent,
        received: this.readClock(),
        serverAt: message.generatedAt,
      });
    }
    // Observers may synchronously stop/restart the client or retire this socket.
    if (!this.owns(connection) || !sameLiveFeed(connection.binding, this.order.binding)) return;
    if (connection.socket.readyState !== OPEN_STATE) {
      this.failConnection(connection, 'The live connection closed before acknowledgment.');
      return;
    }
    try {
      connection.socket.send(serializeLiveAcknowledgment(delivery));
    } catch {
      this.failConnection(connection, 'The live connection could not acknowledge its delivery.');
    }
  }

  private armHandshakeDeadline(connection: Connection, message: string): void {
    if (connection.handshakeTimer !== undefined) clearTimeout(connection.handshakeTimer);
    connection.handshakeTimer = setTimeout(() => {
      this.failConnection(connection, message);
    }, this.handshakeTimeoutMs);
  }

  private sendKeepalive(connection: Connection): void {
    if (!this.owns(connection)) return;
    if (!connection.receivedHello || !connection.binding) return;
    if (connection.socket.readyState !== OPEN_STATE) {
      this.failConnection(connection, 'The live connection is no longer open.');
      return;
    }
    if (connection.pongTimer !== undefined) return;
    this.pingSequence = (this.pingSequence + 1) % Number.MAX_SAFE_INTEGER;
    const requestId = 'ping-' + this.pingSequence;
    try {
      connection.pendingPing = { requestId, sent: this.readClock(), binding: connection.binding };
      connection.pongTimer = setTimeout(() => {
        this.failConnection(connection, 'The live connection did not answer its keepalive.');
      }, this.pongTimeoutMs);
      connection.socket.send(
        JSON.stringify({ type: 'ping', protocolVersion: LIVE_STREAM_PROTOCOL_VERSION, requestId }),
      );
    } catch {
      this.failConnection(connection, 'The live connection could not send its keepalive.');
    }
  }

  private failConnection(connection: Connection, message?: string): void {
    if (!this.owns(connection)) return;
    const generation = connection.generation;
    try {
      this.retireConnection(connection, 1000, 'connection recovery');
      if (message && this.isActive(generation)) this.options.onError?.(message);
    } finally {
      // Observers may fail, but must not strand a retired connection without recovery.
      this.scheduleReconnect(generation);
    }
  }

  private retireConnection(connection: Connection, code: number, reason: string): void {
    if (this.connection === connection) this.connection = undefined;
    if (connection.handshakeTimer !== undefined) clearTimeout(connection.handshakeTimer);
    if (connection.keepaliveTimer !== undefined) clearInterval(connection.keepaliveTimer);
    if (connection.pongTimer !== undefined) clearTimeout(connection.pongTimer);
    connection.handshakeTimer = undefined;
    connection.keepaliveTimer = undefined;
    connection.pongTimer = undefined;
    connection.pendingPing = undefined;
    for (const [type, listener] of connection.listeners) {
      connection.socket.removeEventListener(type, listener);
    }
    connection.listeners.clear();
    try {
      connection.socket.close(code, reason);
    } catch {
      if (this.isActive(connection.generation)) {
        this.options.onError?.('The previous live connection could not close normally.');
      }
    }
  }

  private scheduleReconnect(generation: number): void {
    if (!this.isActive(generation) || this.reconnectTimer !== undefined) return;
    const nextDelay = this.backoff.nextDelay();
    if (nextDelay === null) return;
    this.reconnectTimer = setTimeout(
      () => {
        if (!this.isActive(generation)) return;
        this.reconnectTimer = undefined;
        try {
          this.options.onStatus('reconnecting');
        } finally {
          this.connect(generation);
        }
      },
      Math.min(nextDelay, this.maximumReconnectMs),
    );
    this.options.onStatus(this.hasOpened ? 'reconnecting' : 'offline');
  }

  private deliver(
    message: LiveStreamMessage,
    generation: number,
    sample?: ServerTimeSample,
    allowEpochChange = false,
    reportBindingMismatch = true,
  ): boolean {
    if (!this.isActive(generation)) return false;
    const binding =
      message.type === 'airspace.snapshot'
        ? message.snapshot
        : message.type === 'feed.health'
          ? message.health
          : message.type === 'hello'
            ? message
            : undefined;
    if (
      binding &&
      (binding.regionId !== this.options.regionId ||
        binding.providerId !== (this.options.providerId ?? DEFAULT_LIVE_PROVIDER_ID))
    ) {
      if (reportBindingMismatch)
        this.options.onProtocolError?.(
          ['The live message does not match the requested provider and region.'],
          message,
        );
      return false;
    }
    const previous = this.order.binding;
    const accepted =
      message.type === 'airspace.snapshot'
        ? this.order.acceptSnapshot(message.snapshot)
        : message.type === 'feed.health'
          ? this.order.acceptHealth(message.health)
          : message.type === 'hello'
            ? this.order.acceptHello(message, allowEpochChange)
            : true;
    if (!accepted) return false;
    const revision = this.order.revision;
    if (this.order.binding && !sameLiveFeed(previous, this.order.binding)) {
      this.options.onFeedBinding?.(this.order.binding);
    }
    if (!this.isActive(generation) || this.order.revision !== revision) return false;
    if (sample) this.options.onTimeSample?.(sample);
    if (!this.isActive(generation) || this.order.revision !== revision) return false;
    this.options.onMessage(message);
    return true;
  }

  private snapshotEndpoint(): string {
    return this.apiBaseUrl + '/airspace/' + encodeURIComponent(this.options.regionId) + '/snapshot';
  }

  private streamEndpoint(): string {
    return this.apiBaseUrl + '/airspace/' + encodeURIComponent(this.options.regionId) + '/stream';
  }

  private readClock(): ClockReading {
    return this.options.readClock?.() ?? { monotonicMs: performance.now(), wallMs: Date.now() };
  }

  private extractHealth(value: unknown): LiveFeedHealth | undefined {
    if (typeof value !== 'object' || value === null || !('health' in value)) return undefined;
    const parsed = parseLiveStreamMessage({
      type: 'feed.health',
      protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
      health: (value as { health: unknown }).health,
    });
    return parsed.ok && parsed.message?.type === 'feed.health' ? parsed.message.health : undefined;
  }

  private readonly defaultSocketFactory: LiveSocketFactory = (url) => {
    if (typeof WebSocket === 'undefined') throw new Error('WebSocket is not available.');
    return new WebSocket(url) as unknown as LiveSocket;
  };
}
