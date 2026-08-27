import { BoundedExponentialBackoff } from '../streaming/backoff';
import { LIVE_STREAM_PROTOCOL_VERSION, parseLiveStreamMessage } from './protocol';
import type { LiveStreamMessage } from './protocol';
import type { LiveFeedHealth } from './types';

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
export type LiveTransportStatus = 'connecting' | 'open' | 'reconnecting' | 'offline' | 'stopped';

export interface LiveAirspaceClientOptions {
  regionId: string;
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
  onMessage: (message: LiveStreamMessage) => void;
  onStatus: (status: LiveTransportStatus) => void;
  onProtocolError?: (errors: readonly string[], raw: unknown) => void;
  onError?: (message: string) => void;
}

const OPEN_STATE = 1;

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

export class LiveAirspaceClient {
  private readonly options: LiveAirspaceClientOptions;
  private readonly apiBaseUrl: string;
  private readonly backoff: BoundedExponentialBackoff;
  private socket?: LiveSocket | undefined;
  private reconnectTimer?: ReturnType<typeof setTimeout> | undefined;
  private keepaliveTimer?: ReturnType<typeof setInterval> | undefined;
  private stopped = true;
  private hasOpened = false;
  private generation = 0;

  constructor(options: LiveAirspaceClientOptions) {
    if (!options.regionId.trim()) throw new TypeError('regionId must be a non-empty string.');
    this.options = options;
    this.apiBaseUrl = trimSlash(options.apiBaseUrl ?? '/api/v1');
    const reconnect = options.reconnect ?? {};
    this.backoff = new BoundedExponentialBackoff({
      initialDelayMs: reconnect.initialDelayMs ?? 500,
      maximumDelayMs: reconnect.maximumDelayMs ?? 30_000,
      multiplier: reconnect.multiplier ?? 2,
      jitterRatio: reconnect.jitterRatio ?? 0.2,
      maximumAttempts: Number.MAX_SAFE_INTEGER,
    });
    if ((options.keepaliveMs ?? 30_000) < 1_000) {
      throw new RangeError('keepaliveMs must be at least 1000 milliseconds.');
    }
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.hasOpened = false;
    this.generation += 1;
    this.options.onStatus('connecting');
    void this.loadInitialSnapshot(this.generation);
    this.connect();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.generation += 1;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.reconnectTimer = undefined;
    this.keepaliveTimer = undefined;
    this.detachSocket(1000, 'client stop');
    this.options.onStatus('stopped');
  }

  private async loadInitialSnapshot(generation: number): Promise<void> {
    const fetcher = this.options.fetcher ?? fetch;
    try {
      const response = await fetcher(this.snapshotEndpoint(), {
        headers: { accept: 'application/json' },
      });
      const value = (await response.json()) as unknown;
      if (!response.ok) {
        const health = this.extractHealth(value);
        if (health) {
          this.deliver({
            type: 'feed.health',
            protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
            health,
          });
        }
        throw new Error(`Snapshot request failed with HTTP ${response.status}.`);
      }
      const parsed = parseLiveStreamMessage({
        type: 'airspace.snapshot',
        protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
        snapshot: value,
      });
      if (!parsed.ok || !parsed.message) {
        this.options.onProtocolError?.(parsed.errors, value);
        return;
      }
      if (!this.stopped && generation === this.generation) this.deliver(parsed.message);
    } catch (error) {
      if (!this.stopped && generation === this.generation)
        this.options.onError?.(errorMessage(error));
    }
  }

  private connect(): void {
    if (this.stopped) return;
    const factory = this.options.socketFactory ?? this.defaultSocketFactory;
    try {
      const socket = factory(socketUrl(this.streamEndpoint()));
      this.socket = socket;
      this.attachSocket(socket);
    } catch (error) {
      this.options.onError?.(errorMessage(error));
      this.scheduleReconnect();
    }
  }

  private readonly handleOpen = (): void => {
    this.hasOpened = true;
    this.backoff.reset();
    this.options.onStatus('open');
    this.keepaliveTimer = setInterval(() => {
      if (this.socket?.readyState === OPEN_STATE) this.socket.send('ping');
    }, this.options.keepaliveMs ?? 30_000);
  };

  private readonly handleMessage = (event: LiveSocketEvent): void => {
    if (event.data === 'pong') return;
    if (typeof event.data !== 'string') {
      this.options.onProtocolError?.(['WebSocket payload must be text JSON.'], event.data);
      return;
    }
    const parsed = parseLiveStreamMessage(event.data);
    if (!parsed.ok || !parsed.message) {
      this.options.onProtocolError?.(parsed.errors, event.data);
      return;
    }
    this.deliver(parsed.message);
  };

  private readonly handleClose = (): void => {
    this.clearSocketTimers();
    this.socket = undefined;
    this.scheduleReconnect();
  };

  private readonly handleError = (): void => {
    if (this.socket?.readyState !== OPEN_STATE) this.socket?.close();
  };

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.options.onStatus(this.hasOpened ? 'reconnecting' : 'offline');
    const delay = this.backoff.nextDelay();
    if (delay === null) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.options.onStatus('reconnecting');
      this.connect();
    }, delay);
  }

  private attachSocket(socket: LiveSocket): void {
    socket.addEventListener('open', this.handleOpen);
    socket.addEventListener('message', this.handleMessage);
    socket.addEventListener('close', this.handleClose);
    socket.addEventListener('error', this.handleError);
  }

  private detachSocket(code?: number, reason?: string): void {
    if (!this.socket) return;
    this.socket.removeEventListener('open', this.handleOpen);
    this.socket.removeEventListener('message', this.handleMessage);
    this.socket.removeEventListener('close', this.handleClose);
    this.socket.removeEventListener('error', this.handleError);
    this.socket.close(code, reason);
    this.socket = undefined;
  }

  private clearSocketTimers(): void {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = undefined;
  }

  private deliver(message: LiveStreamMessage): void {
    if (!this.stopped) this.options.onMessage(message);
  }

  private snapshotEndpoint(): string {
    return `${this.apiBaseUrl}/airspace/${encodeURIComponent(this.options.regionId)}/snapshot`;
  }

  private streamEndpoint(): string {
    return `${this.apiBaseUrl}/airspace/${encodeURIComponent(this.options.regionId)}/stream`;
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
