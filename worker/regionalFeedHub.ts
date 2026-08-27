import { DurableObject } from 'cloudflare:workers';

import { LiveProviderError } from '../src/live/provider';
import {
  LIVE_STREAM_PROTOCOL_VERSION,
  serializeLiveStreamMessage,
  type FeedHealthMessage,
  type LiveHelloMessage,
  type LiveStreamErrorMessage,
} from '../src/live/protocol';
import { createAdsbLolProvider } from '../src/live/providers/adsbLol';
import { getRegionConfig } from '../src/live/regions';
import {
  AIRSPACE_SCHEMA_VERSION,
  type AirspaceSnapshot,
  type LiveFeedHealth,
  type ProviderSnapshot,
} from '../src/live/types';
import type { WorkerEnv } from './env';
import { recordFeedMetric, removeExpiredFeedMetrics } from './metrics';

const POLL_INTERVAL_MS = 10_000;
const PROVIDER_TIMEOUT_MS = 8_000;
const CIRCUIT_BREAKER_FAILURES = 3;
const CIRCUIT_BREAKER_MS = 60_000;
const STATE_KEYS = {
  regionId: 'state:regionId',
  sequence: 'state:sequence',
  consecutiveFailures: 'state:consecutiveFailures',
  circuitOpenUntil: 'state:circuitOpenUntil',
  nextRetryAt: 'state:nextRetryAt',
  lastSuccessAt: 'state:lastSuccessAt',
  lastProviderGeneratedAt: 'state:lastProviderGeneratedAt',
  lastMetricCleanupAt: 'state:lastMetricCleanupAt',
} as const;

interface PersistedState {
  regionId?: string | undefined;
  sequence: number;
  consecutiveFailures: number;
  circuitOpenUntil?: number | undefined;
  nextRetryAt?: number | undefined;
  lastSuccessAt?: string | undefined;
  lastProviderGeneratedAt?: string | undefined;
  lastMetricCleanupAt?: number | undefined;
}

function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
    },
  });
}

function retryDelayMs(failures: number, providerError: LiveProviderError | undefined): number {
  if (providerError?.retryAfterSeconds !== undefined) {
    return Math.min(Math.max(providerError.retryAfterSeconds * 1_000, POLL_INTERVAL_MS), 60_000);
  }
  return Math.min(20_000 * 2 ** Math.max(0, failures - 1), 60_000);
}

function addProviderTimeRegression(snapshot: ProviderSnapshot): ProviderSnapshot {
  return {
    ...snapshot,
    aircraft: snapshot.aircraft.map((aircraft) => ({
      ...aircraft,
      qualityFlags: aircraft.qualityFlags.includes('provider-time-regression')
        ? aircraft.qualityFlags
        : [...aircraft.qualityFlags, 'provider-time-regression'],
    })),
  };
}

export class RegionalFeedHub extends DurableObject<WorkerEnv> {
  private state: PersistedState = { sequence: 0, consecutiveFailures: 0 };
  private latestSnapshot: AirspaceSnapshot | undefined;
  private latestHealth: LiveFeedHealth | undefined;
  private pollPromise: Promise<void> | undefined;
  private readonly ready: Promise<void>;

  constructor(context: DurableObjectState, env: WorkerEnv) {
    super(context, env);
    this.ready = this.ctx.blockConcurrencyWhile(async () => {
      const stored = await this.ctx.storage.get([
        STATE_KEYS.regionId,
        STATE_KEYS.sequence,
        STATE_KEYS.consecutiveFailures,
        STATE_KEYS.circuitOpenUntil,
        STATE_KEYS.nextRetryAt,
        STATE_KEYS.lastSuccessAt,
        STATE_KEYS.lastProviderGeneratedAt,
        STATE_KEYS.lastMetricCleanupAt,
      ]);
      this.state = {
        regionId: stored.get(STATE_KEYS.regionId) as string | undefined,
        sequence: (stored.get(STATE_KEYS.sequence) as number | undefined) ?? 0,
        consecutiveFailures:
          (stored.get(STATE_KEYS.consecutiveFailures) as number | undefined) ?? 0,
        circuitOpenUntil: stored.get(STATE_KEYS.circuitOpenUntil) as number | undefined,
        nextRetryAt: stored.get(STATE_KEYS.nextRetryAt) as number | undefined,
        lastSuccessAt: stored.get(STATE_KEYS.lastSuccessAt) as string | undefined,
        lastProviderGeneratedAt: stored.get(STATE_KEYS.lastProviderGeneratedAt) as
          string | undefined,
        lastMetricCleanupAt: stored.get(STATE_KEYS.lastMetricCleanupAt) as number | undefined,
      };
    });
  }

  override async fetch(request: Request): Promise<Response> {
    await this.ready;
    const regionId = request.headers.get('x-region-id') ?? this.state.regionId;
    if (!regionId || !getRegionConfig(regionId)) {
      return jsonResponse({ error: 'REGION_NOT_FOUND', message: 'Unknown region.' }, 404);
    }
    if (this.state.regionId && this.state.regionId !== regionId) {
      return jsonResponse({ error: 'REGION_MISMATCH', message: 'Region identity mismatch.' }, 409);
    }
    if (!this.state.regionId) {
      this.state.regionId = regionId;
      await this.ctx.storage.put(STATE_KEYS.regionId, regionId);
    }

    const pathname = new URL(request.url).pathname;
    if (pathname === '/stream') return this.connectWebSocket(request, regionId);
    if (pathname === '/snapshot') return this.snapshot(regionId);
    if (pathname === '/health') return jsonResponse(this.health(regionId));
    return jsonResponse({ error: 'NOT_FOUND', message: 'Unknown regional-feed route.' }, 404);
  }

  override async alarm(): Promise<void> {
    await this.ready;
    if (this.ctx.getWebSockets().length === 0) return;
    await this.pollAndSchedule();
  }

  override webSocketMessage(socket: WebSocket, message: ArrayBuffer | string): void {
    if (message === 'ping') {
      socket.send('pong');
      return;
    }
    const error: LiveStreamErrorMessage = {
      type: 'error',
      protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
      code: 'PROTOCOL_ERROR',
      message: 'This read-only stream accepts only the ping keepalive message.',
      recoverable: true,
    };
    socket.send(serializeLiveStreamMessage(error));
  }

  override async webSocketClose(): Promise<void> {
    if (this.ctx.getWebSockets().length === 0) {
      await this.ctx.storage.deleteAlarm();
    }
  }

  override async webSocketError(): Promise<void> {
    if (this.ctx.getWebSockets().length === 0) {
      await this.ctx.storage.deleteAlarm();
    }
  }

  private connectWebSocket(request: Request, regionId: string): Response {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return jsonResponse(
        { error: 'UPGRADE_REQUIRED', message: 'WebSocket upgrade required.' },
        426,
      );
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ regionId });

    const hello: LiveHelloMessage = {
      type: 'hello',
      protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
      schemaVersion: AIRSPACE_SCHEMA_VERSION,
      regionId,
      providerId: 'adsb-lol',
      pollIntervalMs: POLL_INTERVAL_MS,
      generatedAt: new Date().toISOString(),
    };
    server.send(serializeLiveStreamMessage(hello));
    if (this.latestSnapshot) {
      server.send(
        serializeLiveStreamMessage({
          type: 'airspace.snapshot',
          protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
          snapshot: this.latestSnapshot,
        }),
      );
    }
    if (this.latestHealth) {
      server.send(
        serializeLiveStreamMessage({
          type: 'feed.health',
          protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
          health: this.latestHealth,
        }),
      );
    }
    this.ctx.waitUntil(this.pollAndSchedule());
    return new Response(null, { status: 101, webSocket: client });
  }

  private async snapshot(regionId: string): Promise<Response> {
    if (!this.latestSnapshot) await this.poll();
    if (!this.latestSnapshot) {
      return jsonResponse(
        {
          error: 'UPSTREAM_UNAVAILABLE',
          health: this.health(regionId),
        },
        503,
      );
    }
    return jsonResponse(this.latestSnapshot);
  }

  private health(regionId: string): LiveFeedHealth {
    return (
      this.latestHealth ?? {
        schemaVersion: AIRSPACE_SCHEMA_VERSION,
        regionId,
        providerId: 'adsb-lol',
        status: 'offline',
        checkedAt: new Date().toISOString(),
        ...(this.state.lastSuccessAt ? { lastSuccessAt: this.state.lastSuccessAt } : {}),
        consecutiveFailures: this.state.consecutiveFailures,
        message: 'No live snapshot has been received in this runtime session.',
      }
    );
  }

  private async pollAndSchedule(): Promise<void> {
    await this.poll();
    if (this.ctx.getWebSockets().length === 0) return;
    const now = Date.now();
    const nextPollAt = Math.max(
      now + POLL_INTERVAL_MS,
      this.state.circuitOpenUntil ?? 0,
      this.state.nextRetryAt ?? 0,
      this.latestHealth?.retryAt ? Date.parse(this.latestHealth.retryAt) : 0,
    );
    await this.ctx.storage.setAlarm(nextPollAt);
  }

  private async poll(): Promise<void> {
    if (this.pollPromise) return this.pollPromise;
    this.pollPromise = this.executePoll().finally(() => {
      this.pollPromise = undefined;
    });
    return this.pollPromise;
  }

  private async executePoll(): Promise<void> {
    const regionId = this.state.regionId;
    if (!regionId) return;
    const region = getRegionConfig(regionId);
    if (!region) return;

    const startedAt = Date.now();
    const blockedUntil = Math.max(this.state.nextRetryAt ?? 0, this.state.circuitOpenUntil ?? 0);
    if (blockedUntil > startedAt) {
      this.publishHealth({
        schemaVersion: AIRSPACE_SCHEMA_VERSION,
        regionId,
        providerId: 'adsb-lol',
        status: 'degraded',
        checkedAt: new Date(startedAt).toISOString(),
        ...(this.state.lastSuccessAt ? { lastSuccessAt: this.state.lastSuccessAt } : {}),
        consecutiveFailures: this.state.consecutiveFailures,
        retryAt: new Date(blockedUntil).toISOString(),
        message: this.state.circuitOpenUntil
          ? 'Live provider circuit breaker is open; retry is scheduled.'
          : 'Live provider backoff is active; retry is scheduled.',
      });
      return;
    }

    const provider = createAdsbLolProvider({ baseUrl: this.env.LIVE_PROVIDER_BASE_URL });
    try {
      let providerSnapshot = await provider.fetchRegion(
        region,
        AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      );
      if (
        this.state.lastProviderGeneratedAt &&
        Date.parse(providerSnapshot.providerGeneratedAt) <
          Date.parse(this.state.lastProviderGeneratedAt)
      ) {
        providerSnapshot = addProviderTimeRegression(providerSnapshot);
      }

      this.state.sequence += 1;
      this.state.consecutiveFailures = 0;
      this.state.circuitOpenUntil = undefined;
      this.state.nextRetryAt = undefined;
      const lastSuccessAt = new Date().toISOString();
      this.state.lastSuccessAt = lastSuccessAt;
      this.state.lastProviderGeneratedAt = providerSnapshot.providerGeneratedAt;
      const latestSnapshot: AirspaceSnapshot = {
        schemaVersion: AIRSPACE_SCHEMA_VERSION,
        providerId: providerSnapshot.providerId,
        regionId,
        sequence: this.state.sequence,
        generatedAt: providerSnapshot.receivedAt,
        providerGeneratedAt: providerSnapshot.providerGeneratedAt,
        aircraft: providerSnapshot.aircraft,
        validation: providerSnapshot.validation,
      };
      this.latestSnapshot = latestSnapshot;
      await this.ctx.storage.put({
        [STATE_KEYS.sequence]: this.state.sequence,
        [STATE_KEYS.consecutiveFailures]: 0,
        [STATE_KEYS.lastSuccessAt]: lastSuccessAt,
        [STATE_KEYS.lastProviderGeneratedAt]: providerSnapshot.providerGeneratedAt,
      });
      await this.ctx.storage.delete(STATE_KEYS.circuitOpenUntil);
      await this.ctx.storage.delete(STATE_KEYS.nextRetryAt);
      await recordFeedMetric(this.ctx.storage, {
        timestampMs: startedAt,
        success: true,
        rateLimited: false,
        latencyMs: Date.now() - startedAt,
        aircraftCount: latestSnapshot.aircraft.length,
        invalidFieldCount: latestSnapshot.validation.invalidFields,
      });
      await this.cleanupMetricsIfDue(startedAt);
      this.broadcast({
        type: 'airspace.snapshot',
        protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
        snapshot: latestSnapshot,
      });
      this.publishHealth({
        schemaVersion: AIRSPACE_SCHEMA_VERSION,
        regionId,
        providerId: 'adsb-lol',
        status: 'live',
        checkedAt: new Date().toISOString(),
        lastSuccessAt,
        lastSnapshotAt: latestSnapshot.generatedAt,
        upstreamLatencyMs: Date.now() - startedAt,
        consecutiveFailures: 0,
        message: 'Live regional surveillance feed is current.',
      });
    } catch (error) {
      const providerError = error instanceof LiveProviderError ? error : undefined;
      this.state.consecutiveFailures += 1;
      const delayMs = retryDelayMs(this.state.consecutiveFailures, providerError);
      const retryAtMs = Date.now() + delayMs;
      this.state.nextRetryAt = retryAtMs;
      if (this.state.consecutiveFailures >= CIRCUIT_BREAKER_FAILURES) {
        this.state.circuitOpenUntil = Math.max(retryAtMs, Date.now() + CIRCUIT_BREAKER_MS);
      }
      await this.ctx.storage.put({
        [STATE_KEYS.consecutiveFailures]: this.state.consecutiveFailures,
        [STATE_KEYS.nextRetryAt]: retryAtMs,
        ...(this.state.circuitOpenUntil
          ? { [STATE_KEYS.circuitOpenUntil]: this.state.circuitOpenUntil }
          : {}),
      });
      await recordFeedMetric(this.ctx.storage, {
        timestampMs: startedAt,
        success: false,
        rateLimited: providerError?.code === 'UPSTREAM_RATE_LIMITED',
        latencyMs: Date.now() - startedAt,
        aircraftCount: 0,
        invalidFieldCount: 0,
      });
      const retryAt = new Date(this.state.circuitOpenUntil ?? retryAtMs).toISOString();
      this.publishHealth({
        schemaVersion: AIRSPACE_SCHEMA_VERSION,
        regionId,
        providerId: 'adsb-lol',
        status: 'degraded',
        checkedAt: new Date().toISOString(),
        ...(this.state.lastSuccessAt ? { lastSuccessAt: this.state.lastSuccessAt } : {}),
        ...(this.latestSnapshot ? { lastSnapshotAt: this.latestSnapshot.generatedAt } : {}),
        upstreamLatencyMs: Date.now() - startedAt,
        consecutiveFailures: this.state.consecutiveFailures,
        retryAt,
        message: 'The live provider is temporarily unavailable; retry is scheduled.',
      });
      this.broadcast({
        type: 'error',
        protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
        code: 'UPSTREAM_UNAVAILABLE',
        message: 'The live provider is temporarily unavailable.',
        recoverable: true,
        retryAt,
      });
    }
  }

  private publishHealth(health: LiveFeedHealth): void {
    this.latestHealth = health;
    const message: FeedHealthMessage = {
      type: 'feed.health',
      protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
      health,
    };
    this.broadcast(message);
  }

  private broadcast(message: Parameters<typeof serializeLiveStreamMessage>[0]): void {
    const serialized = serializeLiveStreamMessage(message);
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(serialized);
      } catch {
        socket.close(1011, 'stream send failed');
      }
    }
  }

  private async cleanupMetricsIfDue(nowMs: number): Promise<void> {
    const lastCleanup = this.state.lastMetricCleanupAt ?? 0;
    if (nowMs - lastCleanup < 24 * 60 * 60 * 1_000) return;
    await removeExpiredFeedMetrics(this.ctx.storage, nowMs);
    this.state.lastMetricCleanupAt = nowMs;
    await this.ctx.storage.put(STATE_KEYS.lastMetricCleanupAt, nowMs);
  }
}
