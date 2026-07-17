import { BoundedExponentialBackoff, type BackoffOptions } from './backoff';
import { BoundedQueue, type QueueOverflowStrategy } from './boundedQueue';
import { StreamHealthMonitor, type SourceHealth } from './health';
import { parseStreamMessage, type StreamMessage } from './protocol';

export interface WebSocketEventLike {
  data?: unknown;
  code?: number;
  reason?: string;
}

export interface WebSocketLike {
  readonly readyState: number;
  addEventListener(type: string, listener: (event: WebSocketEventLike) => void): void;
  removeEventListener(type: string, listener: (event: WebSocketEventLike) => void): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface StreamClientOptions {
  url: string;
  queueCapacity: number;
  queueOverflowStrategy: QueueOverflowStrategy;
  drainBatchSize: number;
  backoff: Partial<BackoffOptions>;
  heartbeatStaleAfterMs: number;
  heartbeatDisconnectedAfterMs: number;
  webSocketFactory?: WebSocketFactory;
  onMessage: (message: StreamMessage) => void;
  onProtocolError?: (errors: string[], raw: unknown) => void;
  onHealth?: (health: SourceHealth[]) => void;
  onQueuePressure?: (droppedMessages: number) => void;
  onReconnectExhausted?: () => void;
}

const OPEN_STATE = 1;

export class ReconnectingStreamClient {
  private readonly options: StreamClientOptions;
  private readonly queue: BoundedQueue<StreamMessage>;
  private readonly health: StreamHealthMonitor;
  private readonly backoff: BoundedExponentialBackoff;
  private socket: WebSocketLike | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private healthTimer: ReturnType<typeof setInterval> | undefined;
  private stopped = true;
  private drainScheduled = false;
  private readonly knownSources = new Set<string>();
  private readonly endedSources = new Set<string>();

  constructor(options: StreamClientOptions) {
    this.options = options;
    if (!Number.isSafeInteger(options.drainBatchSize) || options.drainBatchSize < 1) {
      throw new RangeError('drainBatchSize must be a positive safe integer.');
    }
    this.queue = new BoundedQueue(options.queueCapacity, options.queueOverflowStrategy);
    this.health = new StreamHealthMonitor({
      staleAfterMs: options.heartbeatStaleAfterMs,
      disconnectedAfterMs: options.heartbeatDisconnectedAfterMs,
    });
    this.backoff = new BoundedExponentialBackoff(options.backoff);
  }

  start(): void {
    if (!this.stopped) {
      return;
    }
    this.stopped = false;
    this.knownSources.clear();
    this.endedSources.clear();
    this.connect();
    this.healthTimer = setInterval(() => this.publishHealth(), 1_000);
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = undefined;
    }
    this.detachSocket(1000, 'operator stop');
    this.queue.clear();
  }

  getQueueSnapshot() {
    return this.queue.snapshot();
  }

  private connect(): void {
    if (this.stopped) {
      return;
    }
    const factory = this.options.webSocketFactory ?? this.defaultFactory;
    try {
      this.socket = factory(this.options.url);
      this.attachSocket(this.socket);
    } catch {
      this.scheduleReconnect();
    }
  }

  private readonly handleOpen = (): void => {
    this.backoff.reset();
  };

  private readonly handleMessage = (event: WebSocketEventLike): void => {
    const raw = event.data;
    if (typeof raw !== 'string') {
      this.options.onProtocolError?.(['WebSocket payload must be text JSON.'], raw);
      return;
    }
    const parsed = parseStreamMessage(raw);
    if (!parsed.ok || !parsed.message) {
      this.options.onProtocolError?.(parsed.errors, raw);
      return;
    }
    const result = this.queue.push(parsed.message);
    if (parsed.message.type === 'hello') {
      this.knownSources.add(parsed.message.sourceId);
      this.endedSources.delete(parsed.message.sourceId);
    } else if (parsed.message.type === 'end') {
      this.knownSources.add(parsed.message.sourceId);
      this.endedSources.add(parsed.message.sourceId);
    }
    if (result.dropped !== undefined) {
      this.health.recordLocalDrop(result.dropped.sourceId);
      this.options.onQueuePressure?.(result.totalDropped);
    }
    this.scheduleDrain();
  };

  private readonly handleClose = (): void => {
    for (const source of this.health.snapshot()) {
      if (source.status !== 'ended') {
        this.health.markDisconnected(source.sourceId, this.backoff.attempts);
      }
    }
    this.publishHealth();
    if (
      this.knownSources.size > 0 &&
      [...this.knownSources].every((sourceId) => this.endedSources.has(sourceId))
    ) {
      return;
    }
    this.scheduleReconnect();
  };

  private readonly handleError = (): void => {
    if (this.socket?.readyState !== OPEN_STATE) {
      this.socket?.close();
    }
  };

  private drainQueue(): void {
    this.drainScheduled = false;
    if (this.stopped) {
      return;
    }
    for (const message of this.queue.drain(this.options.drainBatchSize)) {
      this.health.observe(message);
      this.options.onMessage(message);
    }
    this.publishHealth();
    if (this.queue.length > 0) {
      this.scheduleDrain();
    }
  }

  private scheduleDrain(): void {
    if (this.drainScheduled) {
      return;
    }
    this.drainScheduled = true;
    queueMicrotask(() => this.drainQueue());
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) {
      return;
    }
    const delay = this.backoff.nextDelay();
    if (delay === null) {
      this.options.onReconnectExhausted?.();
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
  }

  private attachSocket(socket: WebSocketLike): void {
    socket.addEventListener('open', this.handleOpen);
    socket.addEventListener('message', this.handleMessage);
    socket.addEventListener('close', this.handleClose);
    socket.addEventListener('error', this.handleError);
  }

  private detachSocket(code?: number, reason?: string): void {
    if (!this.socket) {
      return;
    }
    this.socket.removeEventListener('open', this.handleOpen);
    this.socket.removeEventListener('message', this.handleMessage);
    this.socket.removeEventListener('close', this.handleClose);
    this.socket.removeEventListener('error', this.handleError);
    this.socket.close(code, reason);
    this.socket = undefined;
  }

  private publishHealth(): void {
    this.options.onHealth?.(this.health.snapshot());
  }

  private readonly defaultFactory: WebSocketFactory = (url) => {
    if (typeof WebSocket === 'undefined') {
      throw new Error('WebSocket is not available in this environment.');
    }
    return new WebSocket(url) as unknown as WebSocketLike;
  };
}
