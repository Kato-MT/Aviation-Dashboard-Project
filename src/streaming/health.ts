import type { HeartbeatMessage, StreamMessage } from './protocol';

export type ConnectionStatus =
  'idle' | 'connecting' | 'healthy' | 'degraded' | 'stale' | 'disconnected' | 'ended';

export interface SourceHealth {
  sourceId: string;
  status: ConnectionStatus;
  lastMessageAt?: string;
  lastHeartbeatAt?: string;
  lastSequence?: number;
  receivedMessages: number;
  duplicateMessages: number;
  outOfOrderMessages: number;
  missingMessages: number;
  remoteQueueDepth: number;
  remoteDroppedMessages: number;
  localDroppedMessages: number;
  reconnectAttempts: number;
  heartbeatAgeMs?: number;
}

interface MutableSourceHealth extends SourceHealth {
  lastMessageEpoch?: number;
  lastHeartbeatEpoch?: number;
}

export interface HealthMonitorOptions {
  staleAfterMs: number;
  disconnectedAfterMs: number;
}

export class StreamHealthMonitor {
  private readonly options: HealthMonitorOptions;
  private readonly sources = new Map<string, MutableSourceHealth>();

  constructor(options: Partial<HealthMonitorOptions> = {}) {
    this.options = {
      staleAfterMs: options.staleAfterMs ?? 5_000,
      disconnectedAfterMs: options.disconnectedAfterMs ?? 15_000,
    };
    if (
      this.options.staleAfterMs <= 0 ||
      this.options.disconnectedAfterMs <= this.options.staleAfterMs
    ) {
      throw new RangeError(
        'Health thresholds must be positive and disconnectedAfterMs must be larger.',
      );
    }
  }

  markConnecting(sourceId: string): void {
    this.getOrCreate(sourceId).status = 'connecting';
  }

  markDisconnected(sourceId: string, reconnectAttempts = 0): void {
    const source = this.getOrCreate(sourceId);
    source.status = 'disconnected';
    source.reconnectAttempts = reconnectAttempts;
  }

  recordLocalDrop(sourceId: string, count = 1): void {
    const source = this.getOrCreate(sourceId);
    source.localDroppedMessages += Math.max(0, count);
    if (source.status === 'healthy') {
      source.status = 'degraded';
    }
  }

  observe(message: StreamMessage, receivedAt = Date.now()): SourceHealth {
    const source = this.getOrCreate(message.sourceId);
    source.receivedMessages += 1;
    source.lastMessageAt = new Date(receivedAt).toISOString();
    source.lastMessageEpoch = receivedAt;

    if (source.lastSequence !== undefined) {
      if (message.sequence === source.lastSequence) {
        source.duplicateMessages += 1;
      } else if (message.sequence < source.lastSequence) {
        source.outOfOrderMessages += 1;
      } else if (message.sequence > source.lastSequence + 1) {
        source.missingMessages += message.sequence - source.lastSequence - 1;
      }
    }
    source.lastSequence = Math.max(source.lastSequence ?? -1, message.sequence);

    if (message.type === 'heartbeat') {
      this.observeHeartbeat(source, message, receivedAt);
    } else if (message.type === 'end') {
      source.status = 'ended';
    } else if (source.status !== 'degraded') {
      source.status = 'healthy';
    }

    if (
      source.duplicateMessages > 0 ||
      source.outOfOrderMessages > 0 ||
      source.missingMessages > 0 ||
      source.localDroppedMessages > 0 ||
      source.remoteDroppedMessages > 0
    ) {
      if (source.status === 'healthy') {
        source.status = 'degraded';
      }
    }
    return this.toSnapshot(source, receivedAt);
  }

  snapshot(now = Date.now()): SourceHealth[] {
    return [...this.sources.values()].map((source) => {
      if (source.status !== 'ended' && source.status !== 'disconnected') {
        const reference = source.lastHeartbeatEpoch ?? source.lastMessageEpoch;
        if (reference !== undefined) {
          const age = now - reference;
          if (age >= this.options.disconnectedAfterMs) {
            source.status = 'disconnected';
          } else if (age >= this.options.staleAfterMs) {
            source.status = 'stale';
          }
        }
      }
      return this.toSnapshot(source, now);
    });
  }

  private observeHeartbeat(
    source: MutableSourceHealth,
    heartbeat: HeartbeatMessage,
    receivedAt: number,
  ): void {
    source.lastHeartbeatAt = new Date(receivedAt).toISOString();
    source.lastHeartbeatEpoch = receivedAt;
    source.remoteQueueDepth = heartbeat.queueDepth;
    source.remoteDroppedMessages = heartbeat.droppedMessages;
    source.status = heartbeat.status === 'nominal' ? 'healthy' : 'degraded';
  }

  private getOrCreate(sourceId: string): MutableSourceHealth {
    let source = this.sources.get(sourceId);
    if (!source) {
      source = {
        sourceId,
        status: 'idle',
        receivedMessages: 0,
        duplicateMessages: 0,
        outOfOrderMessages: 0,
        missingMessages: 0,
        remoteQueueDepth: 0,
        remoteDroppedMessages: 0,
        localDroppedMessages: 0,
        reconnectAttempts: 0,
      };
      this.sources.set(sourceId, source);
    }
    return source;
  }

  private toSnapshot(source: MutableSourceHealth, now: number): SourceHealth {
    const snapshot: SourceHealth = {
      sourceId: source.sourceId,
      status: source.status,
      receivedMessages: source.receivedMessages,
      duplicateMessages: source.duplicateMessages,
      outOfOrderMessages: source.outOfOrderMessages,
      missingMessages: source.missingMessages,
      remoteQueueDepth: source.remoteQueueDepth,
      remoteDroppedMessages: source.remoteDroppedMessages,
      localDroppedMessages: source.localDroppedMessages,
      reconnectAttempts: source.reconnectAttempts,
      ...(source.lastMessageAt === undefined ? {} : { lastMessageAt: source.lastMessageAt }),
      ...(source.lastHeartbeatAt === undefined ? {} : { lastHeartbeatAt: source.lastHeartbeatAt }),
      ...(source.lastSequence === undefined ? {} : { lastSequence: source.lastSequence }),
      ...(source.lastHeartbeatEpoch === undefined
        ? {}
        : { heartbeatAgeMs: Math.max(0, now - source.lastHeartbeatEpoch) }),
    };
    return snapshot;
  }
}
