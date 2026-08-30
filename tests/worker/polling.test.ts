import { env } from 'cloudflare:workers';
import {
  evictDurableObject,
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
} from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import worker from '../../worker/index';
import type { WorkerEnv } from '../../worker/env';
import { resetRequestAdmissionForTests } from '../../worker/admission';
import { POLL_INTERVAL_MS } from '../../worker/polling';
import { RUNTIME_POLICY_CHECK_INTERVAL_MS } from '../../worker/regionalFeedHub';
import { feedMetricExpiryAt } from '../../worker/metrics';
import type { RegionalDelivery } from '../../worker/delivery';
import { deliveriesSettled, nextFrame } from './liveSocket';
import type { AirspaceSnapshot, LiveFeedHealth } from '../../src/live/types';

const workerEnv = env as WorkerEnv;
let clock: number;
let unexpectedEgress: number;
const sockets: WebSocket[] = [];
const stub = () => workerEnv.REGION_FEEDS.getByName('atlanta');
const snapshotRequest = (region = 'atlanta') =>
  worker.fetch(new Request(`https://workbench.test/api/v1/airspace/${region}/snapshot`), workerEnv);

function providerResponse(): Response {
  return Response.json({
    now: clock,
    ac: [
      {
        hex: 'a1b2c3',
        flight: 'DAL123',
        lat: 33.64,
        lon: -84.43,
        alt_baro: 12_000,
        baro_rate: 0,
        seen: 1,
        seen_pos: 2,
      },
    ],
  });
}

async function unacceptedSocket(): Promise<WebSocket> {
  const response = await worker.fetch(
    new Request('https://workbench.test/api/v1/airspace/atlanta/stream', {
      headers: { origin: 'https://workbench.test', upgrade: 'websocket' },
    }),
    workerEnv,
  );
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  sockets.push(socket);
  return socket;
}

async function connectedViewer(): Promise<{ socket: WebSocket; snapshot: AirspaceSnapshot }> {
  const socket = await unacceptedSocket();
  const delivered = nextFrame(socket, 'airspace.snapshot');
  const healthy = nextFrame(socket, 'feed.health', (frame) => frame.health.status === 'live');
  socket.accept();
  const [frame] = await Promise.all([delivered, healthy]);
  // A cache hit also drains the shared scheduling path without issuing a new poll.
  const cached = await snapshotRequest();
  expect(cached.status).toBe(200);
  expect(await cached.json()).toEqual(frame.snapshot);
  await deliveriesSettled(stub());
  return { socket, snapshot: frame.snapshot };
}

async function persisted(): Promise<Record<string, unknown>> {
  return runInDurableObject(stub(), async (_instance, state) =>
    Object.fromEntries(await state.storage.list()),
  );
}

async function alarmAt(): Promise<number | null> {
  return runInDurableObject(stub(), (_instance, state) => state.storage.getAlarm());
}

async function currentHealth(): Promise<LiveFeedHealth> {
  const response = await worker.fetch(
    new Request('https://workbench.test/api/v1/health'),
    workerEnv,
  );
  const body = (await response.json()) as { regions: LiveFeedHealth[] };
  return body.regions.find((health) => health.regionId === 'atlanta')!;
}

beforeEach(() => {
  resetRequestAdmissionForTests();
  clock = Math.floor(Date.now() / 1_000) * 1_000;
  unexpectedEgress = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      unexpectedEgress += 1;
      throw new Error('Unexpected outbound request in the controlled polling suite.');
    }),
  );
});

afterEach(async () => {
  try {
    for (const socket of sockets.splice(0)) socket.close(1000, 'Polling test complete');
    await reset();
    expect(unexpectedEgress).toBe(0);
  } finally {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});

describe('durable shared polling', () => {
  it('reserves durably before fetch and shares one in-flight poll across REST and joins', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchMock = vi.fn(async () => {
      await pending;
      return providerResponse();
    });
    vi.stubGlobal('fetch', fetchMock);
    const socket = await unacceptedSocket();
    const delivered = nextFrame(socket, 'airspace.snapshot');
    socket.accept();
    const reservation = await persisted();
    expect(reservation['state:nextPollAt']).toBe(clock + POLL_INTERVAL_MS);
    expect(await alarmAt()).toBe(clock + POLL_INTERVAL_MS);
    expect(reservation['state:sequence'] ?? 0).toBe(0);
    expect(Object.keys(reservation).some((key) => key.startsWith('metrics:'))).toBe(false);
    const first = snapshotRequest();
    const second = snapshotRequest();
    const joined = await unacceptedSocket();
    joined.accept();
    expect(fetchMock).toHaveBeenCalledOnce();
    release();
    const [a, b, frame] = await Promise.all([first, second, delivered]);
    const snapshot = await a.json();
    expect(await b.json()).toEqual(snapshot);
    expect(frame.snapshot).toEqual(snapshot);
    expect(frame.snapshot.sequence).toBe(1);
    expect(frame.snapshot.aircraft[0]).toMatchObject({
      onGround: null,
      verticalRateFeetPerMinute: 0,
      verticalRateBasis: 'barometric',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does not postpone cadence for sequential joins or an early alarm', async () => {
    const fetchMock = vi.fn(async () => providerResponse());
    vi.stubGlobal('fetch', fetchMock);
    const first = await connectedViewer();
    const deadline = clock + POLL_INTERVAL_MS;
    expect(await alarmAt()).toBe(deadline);
    clock += 1_000;
    const second = await connectedViewer();
    expect(second.snapshot).toEqual(first.snapshot);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(await alarmAt()).toBe(deadline);
    clock += 1_000;
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(await alarmAt()).toBe(deadline);
    clock = deadline;
    const delivered = nextFrame(first.socket, 'airspace.snapshot');
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect((await delivered).snapshot.sequence).toBe(first.snapshot.sequence + 1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await alarmAt()).toBe(deadline + POLL_INTERVAL_MS);
  });

  it('refreshes due REST snapshots once and retains only maintenance alarms without viewers', async () => {
    const fetchMock = vi.fn(async () => providerResponse());
    vi.stubGlobal('fetch', fetchMock);
    const initial = (await (await snapshotRequest()).json()) as AirspaceSnapshot;
    clock += POLL_INTERVAL_MS - 1;
    expect(await (await snapshotRequest()).json()).toEqual(initial);
    expect(fetchMock).toHaveBeenCalledOnce();
    clock += 1;
    const responses = await Promise.all([snapshotRequest(), snapshotRequest(), snapshotRequest()]);
    const snapshots = (await Promise.all(
      responses.map((response) => response.json()),
    )) as AirspaceSnapshot[];
    expect(snapshots[0]?.sequence).toBe(initial.sequence + 1);
    expect(
      snapshots.every((snapshot) => JSON.stringify(snapshot) === JSON.stringify(snapshots[0])),
    ).toBe(true);
    expect(snapshots[0]?.generatedAt).not.toBe(initial.generatedAt);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await alarmAt()).toBe(feedMetricExpiryAt(Date.parse(initial.generatedAt)));
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const serialized = JSON.stringify(await persisted());
    for (const forbidden of ['a1b2c3', 'DAL123', '33.64', '-84.43', '"aircraft":', '"position":']) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(serialized).toContain('aircraftCountSum');
  });

  it('keeps independent cadence reservations for different regions', async () => {
    const fetchMock = vi.fn(async () => providerResponse());
    vi.stubGlobal('fetch', fetchMock);
    await snapshotRequest();
    await snapshotRequest('central-georgia');
    await snapshotRequest();
    await snapshotRequest('central-georgia');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retains a warm snapshot without rewriting timestamps when a due refresh fails', async () => {
    const fetchMock = vi.fn(async () => providerResponse());
    vi.stubGlobal('fetch', fetchMock);
    const initial = await (await snapshotRequest()).json();
    clock += POLL_INTERVAL_MS;
    fetchMock.mockImplementation(async () => new Response(null, { status: 503 }));
    const failedRefresh = await snapshotRequest();
    expect(failedRefresh.status).toBe(200);
    expect(await failedRefresh.json()).toEqual(initial);
    expect(await currentHealth()).toMatchObject({ status: 'degraded', consecutiveFailures: 1 });
    clock += 1_000;
    expect(await (await snapshotRequest()).json()).toEqual(initial);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const maintenance = feedMetricExpiryAt(Date.parse(initial.generatedAt));
    expect(await alarmAt()).toBe(maintenance);
  });

  it('respects a cold eviction cooldown without storing or returning an aircraft cache', async () => {
    const fetchMock = vi.fn(async () => providerResponse());
    vi.stubGlobal('fetch', fetchMock);
    const initial = (await (await snapshotRequest()).json()) as AirspaceSnapshot;
    const deadline = clock + POLL_INTERVAL_MS;
    await evictDurableObject(stub());
    clock += 1_000;
    const health = await currentHealth();
    expect(health).toMatchObject({
      feedEpoch: initial.feedEpoch,
      status: 'connecting',
      retryAt: new Date(deadline).toISOString(),
    });
    expect(health).not.toHaveProperty('lastSnapshotAt');
    const cold = await snapshotRequest();
    expect(cold.status).toBe(503);
    expect(cold.headers.get('retry-after')).toBe('9');
    expect(await cold.json()).toMatchObject({
      error: 'SNAPSHOT_PENDING',
      health: { status: 'connecting' },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(await alarmAt()).toBe(feedMetricExpiryAt(Date.parse(initial.generatedAt)));
    const socket = await unacceptedSocket();
    const waiting = nextFrame(socket, 'feed.health');
    socket.accept();
    expect((await waiting).health).toMatchObject({
      status: 'connecting',
      retryAt: new Date(deadline).toISOString(),
    });
    await snapshotRequest();
    expect(await alarmAt()).toBe(deadline);
    clock = deadline;
    const delivered = nextFrame(socket, 'airspace.snapshot');
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect((await delivered).snapshot).toMatchObject({
      feedEpoch: initial.feedEpoch,
      sequence: initial.sequence + 1,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  }, 40_000);

  it.each(['seconds', 'http-date'])(
    'persists a long %s retry deadline across eviction and early alarms',
    async (format) => {
      const deadline = clock + 300_000;
      const header = format === 'seconds' ? '300' : new Date(deadline).toUTCString();
      const fetchMock = vi.fn(
        async () => new Response(null, { status: 429, headers: { 'retry-after': header } }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const first = await snapshotRequest();
      expect(first.status).toBe(503);
      expect(first.headers.get('retry-after')).toBe('300');
      const original = ((await first.json()) as { health: LiveFeedHealth }).health;
      expect(original.retryAt).toBe(new Date(deadline).toISOString());
      expect((await persisted())['state:nextRetryAt']).toBe(deadline);
      await evictDurableObject(stub());
      clock += 61_000;
      expect(await currentHealth()).toMatchObject({
        feedEpoch: original.feedEpoch,
        status: 'degraded',
        consecutiveFailures: 1,
        retryAt: original.retryAt,
      });
      const cold = await snapshotRequest();
      expect(cold.status).toBe(503);
      expect(cold.headers.get('retry-after')).toBe('239');
      expect(fetchMock).toHaveBeenCalledOnce();
      const socket = await unacceptedSocket();
      const waiting = nextFrame(socket, 'feed.health');
      socket.accept();
      expect((await waiting).health.retryAt).toBe(original.retryAt);
      await snapshotRequest();
      expect(await alarmAt()).toBe(clock + RUNTIME_POLICY_CHECK_INTERVAL_MS);
      expect(await runDurableObjectAlarm(stub())).toBe(true);
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(await alarmAt()).toBe(clock + RUNTIME_POLICY_CHECK_INTERVAL_MS);
      clock = deadline;
      fetchMock.mockImplementation(async () => providerResponse());
      const delivered = nextFrame(socket, 'airspace.snapshot');
      expect(await runDurableObjectAlarm(stub())).toBe(true);
      expect((await delivered).snapshot.feedEpoch).toBe(original.feedEpoch);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(await persisted()).toMatchObject({
        'state:consecutiveFailures': 0,
        'state:nextRetryAt': 0,
        'state:circuitOpenUntil': 0,
        'state:retryBlocked': false,
      });
    },
    40_000,
  );

  it('preserves an unrepresentable retry block across hibernation and cancels polling alarms', async () => {
    const fetchMock = vi.fn(async () => providerResponse());
    vi.stubGlobal('fetch', fetchMock);
    const viewer = await connectedViewer();
    clock += POLL_INTERVAL_MS;
    fetchMock.mockImplementation(
      async () =>
        new Response(null, {
          status: 429,
          headers: { 'retry-after': '9'.repeat(100) },
        }),
    );
    const failed = nextFrame(viewer.socket, 'error');
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect(await failed).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE', recoverable: false });
    const maintenance = feedMetricExpiryAt(Date.parse(viewer.snapshot.generatedAt));
    // The automatic ACK clears its attachment before asynchronous alarm reconciliation returns.
    await vi.waitFor(async () =>
      expect(await alarmAt()).toBe(clock + RUNTIME_POLICY_CHECK_INTERVAL_MS),
    );
    expect((await persisted())['state:retryBlocked']).toBe(true);
    expect(await (await snapshotRequest()).json()).toEqual(viewer.snapshot);
    await evictDurableObject(stub(), { webSockets: 'hibernate' });
    clock += 86_400_000;
    const health = await currentHealth();
    expect(health).toMatchObject({ status: 'degraded', feedEpoch: viewer.snapshot.feedEpoch });
    expect(health.message).toContain('paused');
    expect(health.retryAt).toBeUndefined();
    const cold = await snapshotRequest();
    expect(cold.status).toBe(503);
    expect(cold.headers.get('retry-after')).toBeNull();
    expect(await cold.json()).toMatchObject({ error: 'POLLING_PAUSED' });
    const joined = await unacceptedSocket();
    const waiting = nextFrame(joined, 'feed.health');
    joined.accept();
    expect((await waiting).health.message).toContain('paused');
    await snapshotRequest();
    expect(await alarmAt()).toBe(clock + RUNTIME_POLICY_CHECK_INTERVAL_MS);
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect(await alarmAt()).toBe(clock + RUNTIME_POLICY_CHECK_INTERVAL_MS);
    expect(maintenance).toBeGreaterThan(clock + RUNTIME_POLICY_CHECK_INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  }, 40_000);

  it('keeps the completion backoff floor when a provider asks for an immediate retry', async () => {
    const fetchMock = vi.fn(
      async () => new Response(null, { status: 429, headers: { 'retry-after': '0' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const failedAt = clock;
    const response = await snapshotRequest();
    expect(response.headers.get('retry-after')).toBe('21');
    expect((await persisted())['state:nextRetryAt']).toBe(failedAt + 21_000);
    clock += 20_999;
    await snapshotRequest();
    expect(fetchMock).toHaveBeenCalledOnce();
    clock += 1;
    await snapshotRequest();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((await persisted())['state:nextRetryAt']).toBe(clock + 42_000);
  });

  it('stops provider polling after the last close but retains the maintenance alarm and reservation', async () => {
    const fetchMock = vi.fn(async () => providerResponse());
    vi.stubGlobal('fetch', fetchMock);
    const viewer = await connectedViewer();
    const deadline = clock + POLL_INTERVAL_MS;
    const closed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Close handshake timed out.')), 2_000);
      viewer.socket.addEventListener(
        'close',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
    viewer.socket.close(1000, 'Last viewer left');
    await closed;
    const maintenance = feedMetricExpiryAt(Date.parse(viewer.snapshot.generatedAt));
    expect(await alarmAt()).toBe(maintenance);
    expect((await persisted())['state:nextPollAt']).toBe(deadline);
    clock = deadline;
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect(await alarmAt()).toBe(maintenance);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each(['reservation', 'success-state', 'metrics', 'publication'])(
    'does not relabel an internal %s failure as a provider outage',
    async (stage) => {
      const fetchMock = vi.fn(async () => providerResponse());
      vi.stubGlobal('fetch', fetchMock);
      await currentHealth();
      const message = 'Controlled internal ' + stage + ' failure';
      await runInDurableObject(stub(), (instance, state) => {
        if (stage === 'publication') {
          vi.spyOn(
            (instance as unknown as { delivery: RegionalDelivery }).delivery,
            'publish',
          ).mockImplementation(() => {
            throw new Error(message);
          });
          return;
        }
        if (stage === 'metrics' || stage === 'reservation') {
          const originalTransaction = state.storage.transaction.bind(state.storage);
          const intercept: typeof state.storage.transaction = (callback) =>
            originalTransaction(async (transaction) => {
              const originalPut = transaction.put.bind(transaction);
              const put = (...args: unknown[]): Promise<void> =>
                (
                  stage === 'reservation'
                    ? args[0] === 'state:nextPollAt'
                    : typeof args[0] === 'string' && args[0].startsWith('metrics:')
                )
                  ? Promise.reject(new Error(message))
                  : (Reflect.apply(originalPut, transaction, args) as Promise<void>);
              const spy = vi
                .spyOn(transaction, 'put')
                .mockImplementation(put as typeof transaction.put);
              try {
                return await callback(transaction);
              } finally {
                spy.mockRestore();
              }
            });
          vi.spyOn(state.storage, 'transaction').mockImplementation(intercept);
          return;
        }
        const original = state.storage.put.bind(state.storage);
        const put = (...args: unknown[]): Promise<void> => {
          const key = args[0];
          const fail = typeof key === 'object' && key !== null && 'state:sequence' in key;
          if (fail) return Promise.reject(new Error(message));
          return Reflect.apply(original, state.storage, args) as Promise<void>;
        };
        vi.spyOn(state.storage, 'put').mockImplementation(put as typeof state.storage.put);
      });
      const failure = await snapshotRequest();
      expect(failure.status).toBe(500);
      expect(await failure.json()).toEqual({
        error: 'INTERNAL_ERROR',
        message: 'The Live Airspace service is temporarily unavailable.',
      });
      expect(failure.headers.get('content-security-policy')).toContain("default-src 'none'");
      expect(failure.headers.get('x-content-type-options')).toBe('nosniff');
      expect(JSON.stringify(await persisted())).not.toContain(message);
      expect(fetchMock).toHaveBeenCalledTimes(stage === 'reservation' ? 0 : 1);
      const state = await persisted();
      expect(state['state:consecutiveFailures'] ?? 0).toBe(0);
      expect(state['state:nextRetryAt'] ?? 0).toBe(0);
      expect(state['state:circuitOpenUntil'] ?? 0).toBe(0);
      expect((await currentHealth()).message).not.toContain('provider backoff');
    },
  );
});
