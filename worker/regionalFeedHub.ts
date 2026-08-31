import { DurableObject } from 'cloudflare:workers';

import { LiveProviderError, type LiveAircraftProvider } from '../src/live/provider';
import { LIVE_STREAM_PROTOCOL_VERSION, type LiveHelloMessage } from '../src/live/protocol';
import {
  prepareLivePayload,
  serializeLiveServerFrame,
  type PreparedLivePayload,
} from '../src/live/delivery';
import { getRegionConfig, type RegionId } from '../src/live/regions';
import { compileRuntimePolicyBindings, type RuntimePolicyV1 } from '../src/live/runtimePolicy';
import { classifyRegionOperations } from '../src/operations/classifier';
import {
  AIRSPACE_SCHEMA_VERSION,
  type AirspaceSnapshot,
  type LiveFeedBinding,
  type LiveFeedHealth,
  type ProviderSnapshot,
} from '../src/live/types';
import { isCanonicalTimestamp, isLiveIdentifier, isSafeInteger } from '../src/live/validation';
import type { WorkerEnv } from './env';
import {
  deferFeedMetricCleanup,
  METRIC_CLEANUP_RETRY_KEY,
  METRIC_LAST_CLEANUP_KEY,
  nextFeedMetricMaintenance,
  readRegionalOperationsWindows,
  recordDeliveryMetrics,
  recordFeedMetric,
  removeExpiredFeedMetrics,
  feedMetricExpiryAt,
} from './metrics';
import { providerForRuntimePolicy } from './providerConfig';
import type { LiveSourceDescriptor } from '../src/live/source';
import {
  POLL_INTERVAL_MS,
  pollDeadline,
  providerRetryPlan,
  validPollTimestamp,
  type PollControl,
} from './polling';
import { MAX_REGIONAL_VIEWERS, RegionalDelivery } from './delivery';
import { responseHeaders } from './responsePolicy';

const STATE_KEYS = {
  regionId: 'state:regionId',
  providerId: 'state:providerId',
  feedEpoch: 'state:feedEpoch',
  sequence: 'state:sequence',
  consecutiveFailures: 'state:consecutiveFailures',
  nextPollAt: 'state:nextPollAt',
  circuitOpenUntil: 'state:circuitOpenUntil',
  nextRetryAt: 'state:nextRetryAt',
  retryBlocked: 'state:retryBlocked',
  lastSuccessAt: 'state:lastSuccessAt',
  lastProviderGeneratedAt: 'state:lastProviderGeneratedAt',
} as const;

export const OPERATIONS_CHECKED_AT_HEADER = 'x-operations-checked-at';
export const RUNTIME_POLICY_CHECK_INTERVAL_MS = POLL_INTERVAL_MS;
export const RUNTIME_POLICY_DISABLED_CLOSE_CODE = 1008;
export const RUNTIME_POLICY_DISABLED_CLOSE_REASON = 'Live data disabled by runtime policy.';

type ProviderCondition = 'live' | 'failure' | 'rate-limited' | 'validation-rejected';

const SEQUENCE_EXHAUSTED_MESSAGE =
  'The regional feed sequence is exhausted; automatic polling is paused.';

interface PersistedState extends PollControl {
  regionId?: string | undefined;
  providerId: string;
  feedEpoch: string;
  sequence: number;
  consecutiveFailures: number;
  lastSuccessAt?: string | undefined;
  lastProviderGeneratedAt?: string | undefined;
  lastProviderCondition?: ProviderCondition | undefined;
}

function jsonResponse(value: unknown, status = 200, retryAt?: number): Response {
  const now = Date.now();
  return Response.json(value, {
    status,
    headers: responseHeaders({
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
      'x-airspace-server-time': new Date(now).toISOString(),
      ...(retryAt !== undefined
        ? { 'retry-after': String(Math.max(1, Math.ceil((retryAt - now) / 1_000))) }
        : {}),
    }),
  });
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
  private state: PersistedState = {
    providerId: '',
    feedEpoch: '',
    sequence: 0,
    consecutiveFailures: 0,
  };
  private latestSnapshot: AirspaceSnapshot | undefined;
  private latestSnapshotPayload: PreparedLivePayload | undefined;
  private latestHealth: LiveFeedHealth | undefined;
  private pollPromise: Promise<void> | undefined;
  private policyCheckPromise: Promise<boolean> | undefined;
  private readonly ready: Promise<void>;
  private source!: Readonly<LiveSourceDescriptor>;
  private provider: LiveAircraftProvider | undefined;
  private runtimePolicyId = '';
  private runtimePolicyEpoch = '';
  private runtimePolicyValid = true;
  private policyGeneration = 0;
  private nextRuntimePolicyCheckAt: number | undefined;
  private disabledStateCommitted = false;
  private readonly delivery: RegionalDelivery;

  constructor(context: DurableObjectState, env: WorkerEnv) {
    super(context, env);
    this.delivery = new RegionalDelivery({
      sockets: () => this.ctx.getWebSockets(),
      binding: () => this.feedBinding(this.state.regionId ?? ''),
      schedule: () => this.scheduleNextAlarm(),
    });
    this.ready = this.ctx.blockConcurrencyWhile(async () => {
      const policy = await compileRuntimePolicyBindings(env, env.MOCK_PROVIDER !== undefined);
      this.runtimePolicyId = policy.policyId;
      this.runtimePolicyEpoch = policy.policyEpoch;
      this.policyGeneration = 1;
      this.source = policy.source.descriptor;
      this.provider = providerForRuntimePolicy(policy, env);
      const stored = await this.ctx.storage.get([
        STATE_KEYS.regionId,
        STATE_KEYS.providerId,
        STATE_KEYS.feedEpoch,
        STATE_KEYS.sequence,
        STATE_KEYS.consecutiveFailures,
        STATE_KEYS.nextPollAt,
        STATE_KEYS.circuitOpenUntil,
        STATE_KEYS.nextRetryAt,
        STATE_KEYS.retryBlocked,
        STATE_KEYS.lastSuccessAt,
        STATE_KEYS.lastProviderGeneratedAt,
      ]);
      const storedEpoch = stored.get(STATE_KEYS.feedEpoch);
      const storedProvider = stored.get(STATE_KEYS.providerId);
      const sequence = stored.get(STATE_KEYS.sequence) ?? 0;
      const failures = stored.get(STATE_KEYS.consecutiveFailures) ?? 0;
      const retryBlocked = stored.get(STATE_KEYS.retryBlocked) ?? false;
      for (const key of [
        STATE_KEYS.nextPollAt,
        STATE_KEYS.nextRetryAt,
        STATE_KEYS.circuitOpenUntil,
      ]) {
        const value = stored.get(key);
        if (value !== undefined && !validPollTimestamp(value))
          throw new Error('The persisted poll deadline is invalid.');
      }
      if (
        (storedEpoch !== undefined && !isLiveIdentifier(storedEpoch)) ||
        (storedProvider !== undefined && storedProvider !== this.source.providerId) ||
        !isSafeInteger(sequence) ||
        !isSafeInteger(failures) ||
        typeof retryBlocked !== 'boolean'
      )
        throw new Error('The persisted regional feed identity is invalid.');
      const feedEpoch = typeof storedEpoch === 'string' ? storedEpoch : crypto.randomUUID();
      if (storedEpoch === undefined || storedProvider === undefined) {
        await this.ctx.storage.put({
          [STATE_KEYS.feedEpoch]: feedEpoch,
          [STATE_KEYS.providerId]: this.source.providerId,
        });
      }
      this.state = {
        providerId: this.source.providerId,
        feedEpoch,
        regionId: stored.get(STATE_KEYS.regionId) as string | undefined,
        sequence: sequence as number,
        consecutiveFailures: failures as number,
        nextPollAt: stored.get(STATE_KEYS.nextPollAt) as number | undefined,
        circuitOpenUntil: stored.get(STATE_KEYS.circuitOpenUntil) as number | undefined,
        nextRetryAt: stored.get(STATE_KEYS.nextRetryAt) as number | undefined,
        retryBlocked,
        lastSuccessAt: stored.get(STATE_KEYS.lastSuccessAt) as string | undefined,
        lastProviderGeneratedAt: stored.get(STATE_KEYS.lastProviderGeneratedAt) as
          string | undefined,
      };
      this.delivery.noteHibernationRecovery();
      if (this.source.mode === 'disabled') {
        await this.disableEstablishedSession();
        return;
      }
      this.armRuntimePolicyCheck();
      await this.ctx.storage.transaction(async (transaction) => {
        // A cold runtime can repair an orphaned legacy maintenance obligation,
        // but must not replace an already scheduled alarm or its retry.
        if ((await transaction.getAlarm()) === null) await this.reconcileAlarm(transaction);
      });
    });
  }

  override async fetch(request: Request): Promise<Response> {
    await this.ready;
    await this.checkRuntimePolicy();
    const pathname = new URL(request.url).pathname;
    const regionId = request.headers.get('x-region-id') ?? this.state.regionId;
    if (!regionId || !getRegionConfig(regionId)) {
      return jsonResponse({ error: 'REGION_NOT_FOUND', message: 'Unknown region.' }, 404);
    }
    if (this.state.regionId && this.state.regionId !== regionId) {
      return jsonResponse({ error: 'REGION_MISMATCH', message: 'Region identity mismatch.' }, 409);
    }
    if (!this.state.regionId && pathname !== '/operations') {
      this.state.regionId = regionId;
      await this.ctx.storage.put(STATE_KEYS.regionId, regionId);
    }

    if (pathname === '/stream') return this.connectWebSocket(request, regionId);
    if (pathname === '/snapshot') return this.snapshot(regionId);
    if (pathname === '/health') return jsonResponse(this.health(regionId));
    if (pathname === '/operations') return this.operations(request, regionId);
    return jsonResponse({ error: 'NOT_FOUND', message: 'Unknown regional-feed route.' }, 404);
  }

  override async alarm(): Promise<void> {
    await this.ready;
    if (!(await this.checkRuntimePolicy(true))) {
      // A disablement alarm may still discharge already-due aggregate retention
      // work, but reconcileAlarm keeps it from creating another wakeup.
      await this.maintainMetrics();
      return;
    }
    await this.pollAndSchedule(false);
  }

  override async webSocketMessage(socket: WebSocket, message: ArrayBuffer | string): Promise<void> {
    await this.ready;
    if (this.source.mode === 'disabled') {
      if (socket.readyState === WebSocket.OPEN) {
        socket.close(RUNTIME_POLICY_DISABLED_CLOSE_CODE, RUNTIME_POLICY_DISABLED_CLOSE_REASON);
      }
      return;
    }
    await this.delivery.control(socket, message);
  }

  override async webSocketClose(socket: WebSocket): Promise<void> {
    await this.ready;
    if (this.source.mode !== 'disabled') socket.close(1000, 'Viewer disconnected.');
    await this.delivery.flush();
    await this.scheduleNextAlarm();
  }

  override async webSocketError(socket: WebSocket): Promise<void> {
    await this.ready;
    if (this.source.mode !== 'disabled') socket.close(1011, 'Stream transport failed.');
    await this.delivery.flush();
    await this.scheduleNextAlarm();
  }

  private async connectWebSocket(request: Request, regionId: string): Promise<Response> {
    if (this.source.mode === 'disabled') {
      return jsonResponse({ error: 'LIVE_DISABLED', health: this.health(regionId) }, 503);
    }
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return jsonResponse(
        { error: 'UPGRADE_REQUIRED', message: 'WebSocket upgrade required.' },
        426,
      );
    }
    if (!this.delivery.canAccept()) {
      return jsonResponse(
        {
          error: 'VIEWER_CAPACITY',
          message: `This region already has its bounded limit of ${MAX_REGIONAL_VIEWERS} viewers.`,
        },
        503,
      );
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    this.armRuntimePolicyCheck();

    const initialHealth = this.health(regionId);
    this.delivery.prime([
      ...(this.latestSnapshotPayload ? [this.latestSnapshotPayload] : []),
      prepareLivePayload({
        type: 'feed.health',
        protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
        health: initialHealth,
      }),
    ]);
    this.delivery.initialize(server);

    const hello: LiveHelloMessage = {
      type: 'hello',
      feedEpoch: this.state.feedEpoch,
      protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
      schemaVersion: AIRSPACE_SCHEMA_VERSION,
      regionId,
      providerId: this.state.providerId,
      pollIntervalMs: POLL_INTERVAL_MS,
      generatedAt: new Date().toISOString(),
    };
    server.send(serializeLiveServerFrame(hello));
    try {
      // Initial data also uses the receipt window. Its timeout and the newly
      // required viewer-poll wakeup commit before the upgraded response escapes.
      await this.delivery.flush();
    } catch (error) {
      server.close(1011, 'The stream wakeup could not be committed.');
      throw error;
    }
    this.ctx.waitUntil(this.pollAndSchedule(false));
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: responseHeaders({ 'cache-control': 'no-store' }),
    });
  }

  private async snapshot(regionId: string): Promise<Response> {
    if (this.source.mode === 'disabled') {
      return jsonResponse({ error: 'LIVE_DISABLED', health: this.health(regionId) }, 503);
    }
    await this.pollAndSchedule();
    if (!this.provider) {
      return jsonResponse({ error: 'LIVE_DISABLED', health: this.health(regionId) }, 503);
    }
    if (!this.latestSnapshot) {
      const deadline = pollDeadline(this.state);
      return jsonResponse(
        {
          error:
            !this.hasSequenceCapacity() || this.state.retryBlocked
              ? 'POLLING_PAUSED'
              : this.state.consecutiveFailures > 0
                ? 'UPSTREAM_UNAVAILABLE'
                : 'SNAPSHOT_PENDING',
          health: this.health(regionId),
        },
        503,
        deadline !== undefined && deadline > Date.now() ? deadline : undefined,
      );
    }
    return jsonResponse(this.latestSnapshot);
  }

  private health(regionId: string): LiveFeedHealth {
    const now = Date.now();
    const deadline = pollDeadline(this.state);
    const retryAt =
      deadline !== undefined && deadline > now ? new Date(deadline).toISOString() : undefined;
    const base = {
      schemaVersion: AIRSPACE_SCHEMA_VERSION,
      ...this.feedBinding(regionId),
      checkedAt: new Date(now).toISOString(),
      ...(this.state.lastSuccessAt ? { lastSuccessAt: this.state.lastSuccessAt } : {}),
      ...(this.latestSnapshot ? { lastSnapshotAt: this.latestSnapshot.generatedAt } : {}),
      consecutiveFailures: this.state.consecutiveFailures,
    };
    if (this.source.mode === 'disabled') {
      return { ...base, status: 'offline', message: 'Live data is disabled by the server.' };
    }
    if (!this.hasSequenceCapacity()) {
      return {
        ...base,
        status: 'degraded',
        message: SEQUENCE_EXHAUSTED_MESSAGE,
      };
    }
    if (this.state.retryBlocked) {
      return {
        ...base,
        status: 'degraded',
        message: 'Automatic polling is paused pending operator review or corrected configuration.',
      };
    }
    if (this.state.consecutiveFailures > 0) {
      return {
        ...base,
        status: 'degraded',
        ...(retryAt ? { retryAt } : {}),
        message:
          (this.state.circuitOpenUntil ?? 0) > now
            ? 'Live provider circuit breaker is open; retry is scheduled.'
            : retryAt
              ? 'Live provider backoff is active; retry is scheduled.'
              : 'The live provider has not recovered; the next shared attempt is due.',
      };
    }
    if (this.latestSnapshot && this.latestHealth) return this.latestHealth;
    return {
      ...base,
      status: retryAt ? 'connecting' : 'offline',
      ...(retryAt ? { retryAt } : {}),
      message: retryAt
        ? 'No observation is cached in this runtime; waiting for the shared polling deadline.'
        : 'No observation has been received from the configured source in this session.',
    };
  }

  private async operations(request: Request, regionId: string): Promise<Response> {
    const requestedClock = request.headers.get(OPERATIONS_CHECKED_AT_HEADER);
    const checkedAt = requestedClock ?? new Date().toISOString();
    if (!isCanonicalTimestamp(checkedAt)) {
      return jsonResponse(
        { error: 'INVALID_OPERATIONS_CLOCK', message: 'A canonical operations clock is required.' },
        400,
      );
    }
    const windows = await readRegionalOperationsWindows(
      this.ctx.storage,
      checkedAt,
      this.delivery.operationalSnapshot(),
    );
    const currentDelivery = windows.trailing24Hours.delivery;
    const acceptedSnapshot = this.state.lastSuccessAt !== undefined;
    const rateLimited =
      this.state.consecutiveFailures > 0 &&
      (this.state.lastProviderCondition === 'rate-limited' ||
        (this.state.lastProviderCondition === undefined &&
          windows.currentHour.provider.rateLimitCount > 0));
    const retrying =
      this.state.consecutiveFailures > 0 &&
      !rateLimited &&
      !this.state.retryBlocked &&
      this.hasSequenceCapacity();
    const degraded = this.state.retryBlocked || !this.hasSequenceCapacity();
    const classified = classifyRegionOperations(
      {
        regionId: regionId as RegionId,
        readAvailable: true,
        provider: {
          available: true,
          enabled: this.source.mode !== 'disabled',
          connected: acceptedSnapshot || degraded,
          acceptedSnapshot: acceptedSnapshot || degraded,
          rateLimited,
          retrying,
          degraded,
        },
        delivery: {
          available: true,
          acknowledgmentCount: currentDelivery.acknowledgmentCount,
          timeoutCount: currentDelivery.timeoutCount,
          sendFailureCount: currentDelivery.sendFailureCount,
          invalidControlCount: currentDelivery.invalidControlCount,
          hibernationLossCount: currentDelivery.hibernationLossCount,
        },
        lastObservationAt: this.state.lastSuccessAt ?? null,
      },
      checkedAt,
    );
    return jsonResponse({ ...classified, windows });
  }

  private async checkRuntimePolicy(force = false): Promise<boolean> {
    const now = Date.now();
    if (
      !force &&
      this.source.mode !== 'disabled' &&
      this.nextRuntimePolicyCheckAt !== undefined &&
      now < this.nextRuntimePolicyCheckAt
    ) {
      return true;
    }
    if (this.policyCheckPromise) return this.policyCheckPromise;
    const pending = this.refreshRuntimePolicy(now);
    this.policyCheckPromise = pending;
    try {
      return await pending;
    } finally {
      if (this.policyCheckPromise === pending) this.policyCheckPromise = undefined;
    }
  }

  private async refreshRuntimePolicy(checkedAt: number): Promise<boolean> {
    let policy: Readonly<RuntimePolicyV1>;
    try {
      policy = await compileRuntimePolicyBindings(this.env, this.env.MOCK_PROVIDER !== undefined);
    } catch {
      return this.invalidateRuntimePolicy();
    }
    if (policy.source.descriptor.providerId !== this.state.providerId) {
      return this.invalidateRuntimePolicy();
    }
    const unchanged =
      this.runtimePolicyValid &&
      policy.policyId === this.runtimePolicyId &&
      policy.policyEpoch === this.runtimePolicyEpoch;
    if (unchanged) {
      if (policy.source.descriptor.mode === 'disabled') {
        if (!this.disabledStateCommitted) await this.disableEstablishedSession();
        return false;
      }
      this.armRuntimePolicyCheck(checkedAt);
      return true;
    }

    let provider: LiveAircraftProvider | undefined;
    try {
      provider = providerForRuntimePolicy(policy, this.env);
    } catch {
      return this.invalidateRuntimePolicy();
    }
    this.policyGeneration += 1;
    this.runtimePolicyId = policy.policyId;
    this.runtimePolicyEpoch = policy.policyEpoch;
    this.runtimePolicyValid = true;
    this.source = policy.source.descriptor;
    this.provider = provider;
    if (this.source.mode === 'disabled') {
      await this.disableEstablishedSession();
      return false;
    }
    this.disabledStateCommitted = false;
    this.armRuntimePolicyCheck(checkedAt);
    return true;
  }

  private async invalidateRuntimePolicy(): Promise<false> {
    if (this.runtimePolicyValid || this.source.mode !== 'disabled') this.policyGeneration += 1;
    this.runtimePolicyValid = false;
    this.source = Object.freeze({ ...this.source, mode: 'disabled' });
    this.provider = undefined;
    await this.disableEstablishedSession();
    return false;
  }

  private armRuntimePolicyCheck(now = Date.now()): void {
    const deadline = now + RUNTIME_POLICY_CHECK_INTERVAL_MS;
    if (!validPollTimestamp(now) || !validPollTimestamp(deadline)) {
      throw new Error('The runtime-policy check clock is invalid.');
    }
    this.nextRuntimePolicyCheckAt = deadline;
  }

  private async disableEstablishedSession(): Promise<void> {
    this.provider = undefined;
    this.nextRuntimePolicyCheckAt = undefined;
    this.latestSnapshot = undefined;
    this.latestSnapshotPayload = undefined;
    this.latestHealth = undefined;
    Object.assign(this.state, {
      consecutiveFailures: 0,
      nextPollAt: 0,
      nextRetryAt: 0,
      circuitOpenUntil: 0,
      retryBlocked: false,
      lastProviderCondition: undefined,
    });
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.close(RUNTIME_POLICY_DISABLED_CLOSE_CODE, RUNTIME_POLICY_DISABLED_CLOSE_REASON);
      }
    }
    if (this.disabledStateCommitted) return;
    this.disabledStateCommitted = true;
    try {
      await this.ctx.storage.transaction(async (transaction) => {
        await transaction.put({
          [STATE_KEYS.consecutiveFailures]: 0,
          [STATE_KEYS.nextPollAt]: 0,
          [STATE_KEYS.nextRetryAt]: 0,
          [STATE_KEYS.circuitOpenUntil]: 0,
          [STATE_KEYS.retryBlocked]: false,
        });
        if ((await transaction.getAlarm()) !== null) await transaction.deleteAlarm();
      });
    } catch (error) {
      this.disabledStateCommitted = false;
      throw error;
    }
  }

  private async pollAndSchedule(snapshotRequested = true): Promise<void> {
    // Maintenance owns its error/retry path. If the retry itself cannot commit,
    // leave the failure to the platform instead of rearming an overdue loop.
    this.delivery.expire();
    await this.maintainMetrics();
    try {
      if (snapshotRequested || this.hasViewers()) await this.poll();
      await this.flushDeliveryMetrics(true);
    } finally {
      await this.scheduleNextAlarm();
    }
  }

  private hasViewers(): boolean {
    return this.ctx.getWebSockets().some((socket) => socket.readyState === WebSocket.OPEN);
  }

  private async scheduleNextAlarm(): Promise<void> {
    await this.ctx.storage.transaction((transaction) => this.reconcileAlarm(transaction));
  }

  private async reconcileAlarm(transaction: DurableObjectTransaction): Promise<void> {
    const current = await transaction.getAlarm();
    if (this.source.mode === 'disabled') {
      if (current !== null) await transaction.deleteAlarm();
      return;
    }
    const policyCheck = this.hasViewers()
      ? (this.nextRuntimePolicyCheckAt ?? this.armAndReadRuntimePolicyCheck())
      : undefined;
    const polling =
      this.hasSequenceCapacity() && this.hasViewers() ? pollDeadline(this.state) : undefined;
    const maintenance = await nextFeedMetricMaintenance(transaction);
    const acknowledgment = this.delivery.nextDeadline();
    const deliveryMetrics = this.delivery.nextOperationalFlushAt();
    const deadlines = [policyCheck, polling, maintenance, acknowledgment, deliveryMetrics].filter(
      (value): value is number => value !== undefined,
    );
    const deadline = deadlines.length ? Math.min(...deadlines) : undefined;
    if (deadline === undefined) {
      if (current !== null) await transaction.deleteAlarm();
    } else {
      const now = Date.now();
      if (!validPollTimestamp(now)) throw new Error('The regional alarm clock is invalid.');
      const next = Math.max(now, deadline);
      // Joins and duplicate scheduling calls must not shift the shared deadline
      // or add another write for an unchanged alarm.
      if (current !== next) await transaction.setAlarm(next);
    }
  }

  private armAndReadRuntimePolicyCheck(): number {
    this.armRuntimePolicyCheck();
    return this.nextRuntimePolicyCheckAt!;
  }

  private async flushDeliveryMetrics(force = false): Promise<void> {
    const now = Date.now();
    const observedAt = this.delivery.operationalObservedAtMs() ?? now;
    const counters = this.delivery.takeOperationalCounters(now, force);
    if (!counters) return;
    if (feedMetricExpiryAt(observedAt) <= now) return;
    try {
      await recordDeliveryMetrics(this.ctx.storage, observedAt, counters);
    } catch (error) {
      this.delivery.restoreOperationalCounters(counters, now, observedAt);
      console.error('Delivery operations aggregate flush failed.', error);
    }
  }

  private async maintainMetrics(): Promise<void> {
    try {
      await this.ctx.storage.transaction(async (transaction) => {
        const now = Date.now();
        const deadline = await nextFeedMetricMaintenance(transaction);
        if (deadline === undefined || deadline > now) return;
        const removed = await removeExpiredFeedMetrics(transaction, now);
        if ((await transaction.get(METRIC_CLEANUP_RETRY_KEY)) !== undefined)
          await transaction.delete(METRIC_CLEANUP_RETRY_KEY);
        if (removed > 0) await transaction.put(METRIC_LAST_CLEANUP_KEY, now);
        // Deletion and its replacement alarm commit together. A large overdue
        // backlog is processed in bounded batches by subsequent alarms.
        await this.reconcileAlarm(transaction);
      });
    } catch (error) {
      try {
        await deferFeedMetricCleanup(this.ctx.storage, Date.now());
        await this.scheduleNextAlarm();
      } catch (retryError) {
        throw new AggregateError(
          [error, retryError],
          'Metric maintenance failed and recovery scheduling did not complete.',
          { cause: retryError },
        );
      }
      throw error;
    }
  }

  private async poll(): Promise<void> {
    if (this.pollPromise) return this.pollPromise;
    this.pollPromise = this.executePoll().finally(() => {
      this.pollPromise = undefined;
    });
    return this.pollPromise;
  }

  private async executePoll(): Promise<void> {
    if (!(await this.checkRuntimePolicy())) return;
    const policyGeneration = this.policyGeneration;
    const regionId = this.state.regionId;
    if (!regionId) return;
    const region = getRegionConfig(regionId);
    if (!region) return;
    // The persisted sequence itself is the durable terminal condition. Check it
    // before reserving another attempt or contacting the upstream provider.
    if (!this.hasSequenceCapacity()) return;

    const startedAt = Date.now();
    const deadline = pollDeadline(this.state);
    if (deadline === undefined || deadline > startedAt) return;

    const nextPollAt = startedAt + POLL_INTERVAL_MS;
    if (!validPollTimestamp(startedAt) || !validPollTimestamp(nextPollAt)) {
      this.state.retryBlocked = true;
      await this.ctx.storage.put(STATE_KEYS.retryBlocked, true);
      return;
    }

    // Commit the attempt reservation before any upstream I/O. A cold runtime has no
    // aircraft cache, but must respect its predecessor's attempt and retain the
    // viewer-poll wakeup even if execution ends before publication/rescheduling.
    this.state.nextPollAt = nextPollAt;
    await this.ctx.storage.transaction(async (transaction) => {
      await transaction.put(STATE_KEYS.nextPollAt, nextPollAt);
      await this.reconcileAlarm(transaction);
    });
    if (!this.isPolicyGenerationActive(policyGeneration)) return;
    const provider = this.provider;
    if (!provider) return;
    let providerSnapshot: ProviderSnapshot;
    try {
      // The adapter owns and releases its bounded eight-second request deadline.
      providerSnapshot = await provider.fetchRegion(region);
    } catch (error) {
      if (
        (await this.checkRuntimePolicy(true)) &&
        this.isPolicyGenerationActive(policyGeneration)
      ) {
        await this.providerFailed(regionId, startedAt, error, policyGeneration);
      }
      return;
    }
    // Deployment bindings can change while upstream I/O is pending. Recompile
    // before the response can affect durable state or established viewers.
    if (
      !(await this.checkRuntimePolicy(true)) ||
      !this.isPolicyGenerationActive(policyGeneration)
    ) {
      return;
    }

    // Internal normalization, persistence, metrics and publication faults must
    // propagate as internal faults, not increment the provider's failure counter.
    if (
      this.state.lastProviderGeneratedAt &&
      Date.parse(providerSnapshot.providerGeneratedAt) <
        Date.parse(this.state.lastProviderGeneratedAt)
    ) {
      providerSnapshot = addProviderTimeRegression(providerSnapshot);
    }
    const sequence = this.state.sequence + 1;
    if (!isSafeInteger(sequence)) throw new Error('The regional feed sequence is exhausted.');
    const lastSuccessAt = new Date(Date.now()).toISOString();
    const latestSnapshot: AirspaceSnapshot = {
      schemaVersion: AIRSPACE_SCHEMA_VERSION,
      feedEpoch: this.state.feedEpoch,
      providerId: providerSnapshot.providerId,
      regionId,
      sequence,
      generatedAt: providerSnapshot.receivedAt,
      providerGeneratedAt: providerSnapshot.providerGeneratedAt,
      aircraft: providerSnapshot.aircraft,
      validation: providerSnapshot.validation,
    };
    const snapshotMessage = prepareLivePayload({
      type: 'airspace.snapshot',
      protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
      snapshot: latestSnapshot,
    });
    this.delivery.assertPublishable(snapshotMessage);
    // Zero represents a cleared deadline, so success and retry reset commit atomically.
    await this.ctx.storage.put({
      [STATE_KEYS.sequence]: sequence,
      [STATE_KEYS.consecutiveFailures]: 0,
      [STATE_KEYS.nextRetryAt]: 0,
      [STATE_KEYS.circuitOpenUntil]: 0,
      [STATE_KEYS.retryBlocked]: false,
      [STATE_KEYS.lastSuccessAt]: lastSuccessAt,
      [STATE_KEYS.lastProviderGeneratedAt]: providerSnapshot.providerGeneratedAt,
    });
    if (!this.isPolicyGenerationActive(policyGeneration)) return;
    Object.assign(this.state, {
      sequence,
      consecutiveFailures: 0,
      nextRetryAt: 0,
      circuitOpenUntil: 0,
      retryBlocked: false,
      lastSuccessAt,
      lastProviderGeneratedAt: providerSnapshot.providerGeneratedAt,
      lastProviderCondition: 'live',
    });
    this.latestSnapshot = latestSnapshot;
    this.latestSnapshotPayload = snapshotMessage;
    const sequenceExhausted = !this.hasSequenceCapacity();
    this.latestHealth = {
      schemaVersion: AIRSPACE_SCHEMA_VERSION,
      ...this.feedBinding(regionId),
      status: sequenceExhausted ? 'degraded' : 'live',
      checkedAt: lastSuccessAt,
      lastSuccessAt,
      lastSnapshotAt: latestSnapshot.generatedAt,
      upstreamLatencyMs: Math.max(0, Date.now() - startedAt),
      consecutiveFailures: 0,
      message: sequenceExhausted
        ? SEQUENCE_EXHAUSTED_MESSAGE
        : this.source.synthetic
          ? 'The synthetic integration source responded.'
          : 'The regional surveillance source responded.',
    };
    await recordFeedMetric(this.ctx.storage, {
      timestampMs: startedAt,
      success: true,
      rateLimited: false,
      latencyMs: Math.max(0, Date.now() - startedAt),
      aircraftCount: latestSnapshot.aircraft.length,
      invalidFieldCount: latestSnapshot.validation.invalidFields,
      validationRejected: false,
    });
    if (!this.isPolicyGenerationActive(policyGeneration)) return;
    const healthMessage = prepareLivePayload({
      type: 'feed.health',
      protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
      health: this.latestHealth,
    });
    await this.delivery.publish([snapshotMessage, healthMessage], true);
  }

  private async providerFailed(
    regionId: string,
    startedAt: number,
    error: unknown,
    policyGeneration: number,
  ): Promise<void> {
    if (!this.isPolicyGenerationActive(policyGeneration)) return;
    const providerError = error instanceof LiveProviderError ? error : undefined;
    const validationRejected =
      providerError?.code === 'PAYLOAD_TOO_LARGE' ||
      providerError?.code === 'MALFORMED_JSON' ||
      providerError?.code === 'INVALID_PAYLOAD';
    const lastProviderCondition: ProviderCondition =
      providerError?.code === 'UPSTREAM_RATE_LIMITED'
        ? 'rate-limited'
        : validationRejected
          ? 'validation-rejected'
          : 'failure';
    const failures = Math.min(Number.MAX_SAFE_INTEGER, this.state.consecutiveFailures + 1);
    const plan = providerRetryPlan(failures, providerError, Date.now());
    Object.assign(this.state, plan, { consecutiveFailures: failures });
    await this.ctx.storage.put({
      [STATE_KEYS.consecutiveFailures]: failures,
      [STATE_KEYS.nextRetryAt]: plan.nextRetryAt ?? 0,
      [STATE_KEYS.circuitOpenUntil]: plan.circuitOpenUntil ?? 0,
      [STATE_KEYS.retryBlocked]: plan.retryBlocked ?? false,
    });
    if (!this.isPolicyGenerationActive(policyGeneration)) return;
    this.state.lastProviderCondition = lastProviderCondition;
    await recordFeedMetric(this.ctx.storage, {
      timestampMs: startedAt,
      success: false,
      rateLimited: providerError?.code === 'UPSTREAM_RATE_LIMITED',
      latencyMs: Math.max(0, Date.now() - startedAt),
      aircraftCount: 0,
      invalidFieldCount: 0,
      validationRejected,
    });
    if (!this.isPolicyGenerationActive(policyGeneration)) return;
    const health = this.health(regionId);
    this.latestHealth = {
      ...health,
      feedEpoch: this.state.feedEpoch,
      upstreamLatencyMs: Math.max(0, Date.now() - startedAt),
    };
    const healthMessage = prepareLivePayload({
      type: 'feed.health',
      protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
      health: this.latestHealth,
    });
    const errorMessage = prepareLivePayload({
      type: 'error',
      protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
      code: 'UPSTREAM_UNAVAILABLE',
      message: plan.retryBlocked
        ? 'Automatic provider polling is paused pending operator review.'
        : 'The live provider is temporarily unavailable.',
      recoverable: !plan.retryBlocked,
      ...(health.retryAt ? { retryAt: health.retryAt } : {}),
    });
    await this.delivery.publish([healthMessage, errorMessage]);
  }

  private isPolicyGenerationActive(generation: number): boolean {
    return generation === this.policyGeneration && this.source.mode !== 'disabled';
  }

  private feedBinding(regionId: string): LiveFeedBinding {
    return { regionId, providerId: this.state.providerId, feedEpoch: this.state.feedEpoch };
  }

  private hasSequenceCapacity(): boolean {
    return this.state.sequence < Number.MAX_SAFE_INTEGER;
  }
}
