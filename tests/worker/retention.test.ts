import { env } from 'cloudflare:workers';
import {
  evictDurableObject,
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
} from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import worker, { RegionalFeedHub } from '../../worker/index';
import type { WorkerEnv } from '../../worker/env';
import { resetRequestAdmissionForTests } from '../../worker/admission';
import {
  feedMetricExpiryAt,
  METRIC_CLEANUP_BATCH_SIZE,
  METRIC_CLEANUP_RETRY_KEY,
  METRIC_CLEANUP_RETRY_MS,
  METRIC_LAST_CLEANUP_KEY,
  METRIC_RETENTION_MS,
  recordFeedMetric,
} from '../../worker/metrics';
import { POLL_INTERVAL_MS } from '../../worker/polling';
import { RUNTIME_POLICY_CHECK_INTERVAL_MS } from '../../worker/regionalFeedHub';
import { deliveriesSettled, nextFrame, setAutomaticAcknowledgments } from './liveSocket';
import type { ViewerAttachment } from '../../worker/delivery';
import type { AirspaceSnapshot } from '../../src/live/types';
import { compileRuntimePolicy, runtimePolicyInputFromBindings } from '../../src/live/runtimePolicy';
import { CURRENT_SUCCESS_KV_ROWS } from '../../tools/live/capacityModel';

const workerEnv = env as WorkerEnv;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
let clock: number;
let unexpectedEgress: number;
const sockets: WebSocket[] = [];
const stub = () => workerEnv.REGION_FEEDS.getByName('atlanta');
const observation = (timestampMs: number) => ({
  timestampMs,
  success: true,
  rateLimited: false,
  latencyMs: 300,
  aircraftCount: 3,
  invalidFieldCount: 0,
});
const keyAt = (timestampMs: number) =>
  'metrics:' + new Date(timestampMs).toISOString().slice(0, 13) + ':00:00.000Z';

function providerResponse(): Response {
  return Response.json({ now: clock, ac: [] });
}

async function snapshotRequest(): Promise<{ status: number; body: unknown }> {
  const response = await worker.fetch(
    new Request('https://workbench.test/api/v1/airspace/atlanta/snapshot'),
    workerEnv,
  );
  return { status: response.status, body: await response.json() };
}

async function initialize(): Promise<void> {
  const response = await stub().fetch(
    new Request('https://regional-feed.internal/health', { headers: { 'x-region-id': 'atlanta' } }),
  );
  await response.json();
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
  const received = nextFrame(socket, 'airspace.snapshot');
  socket.accept();
  const frame = await received;
  expect((await snapshotRequest()).body).toEqual(frame.snapshot);
  await deliveriesSettled(stub());
  return { socket, snapshot: frame.snapshot };
}

async function alarmAt(): Promise<number | null> {
  return runInDurableObject(stub(), (_instance, state) => state.storage.getAlarm());
}

async function metricKeys(): Promise<string[]> {
  return runInDurableObject(stub(), async (_instance, state) => [
    ...(await state.storage.list({ prefix: 'metrics:' })).keys(),
  ]);
}

async function control(): Promise<Record<string, unknown>> {
  return runInDurableObject(stub(), async (_instance, state) =>
    Object.fromEntries(
      [...(await state.storage.list({ prefix: 'state:' })).entries()].filter(
        ([key]) => key !== METRIC_LAST_CLEANUP_KEY && key !== METRIC_CLEANUP_RETRY_KEY,
      ),
    ),
  );
}

async function seed(timestampMs: number): Promise<void> {
  await runInDurableObject(stub(), (_instance, state) =>
    recordFeedMetric(state.storage, observation(timestampMs)),
  );
}

type TransactionOperation = 'put' | 'list' | 'delete' | 'setAlarm';

function failOnceInsideTransaction(
  storage: DurableObjectStorage,
  method: TransactionOperation,
  matches: (args: readonly unknown[]) => boolean = () => true,
) {
  let triggered = false;
  const original = storage.transaction.bind(storage);
  const intercept: typeof storage.transaction = (callback) =>
    original(async (transaction) => {
      const operation = transaction[method].bind(transaction);
      const replacement = (...args: unknown[]) => {
        if (!triggered && matches(args)) {
          triggered = true;
          return Promise.reject(new Error('Controlled transactional ' + method + ' failure'));
        }
        return Reflect.apply(operation, transaction, args);
      };
      // The operation names have different overloads; the test preserves every
      // argument and return value except its single explicitly injected rejection.
      const spy = vi.spyOn(transaction, method).mockImplementation(replacement as never);
      try {
        return await callback(transaction);
      } finally {
        spy.mockRestore();
      }
    });
  const spy = vi.spyOn(storage, 'transaction').mockImplementation(intercept);
  return { triggered: () => triggered, restore: () => spy.mockRestore() };
}

beforeEach(() => {
  resetRequestAdmissionForTests();
  // Keep all manual alarm deadlines ahead of the actual workerd clock, including
  // the oldest backlogged test hour. Only the test's explicit alarm calls run them.
  clock = Math.ceil(Date.now() / HOUR) * HOUR + 60 * DAY;
  unexpectedEgress = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  vi.spyOn(Math, 'random').mockReturnValue(0);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      unexpectedEgress += 1;
      throw new Error('Unexpected external request in retention tests.');
    }),
  );
});

afterEach(async () => {
  try {
    for (const socket of sockets.splice(0)) socket.close(1000, 'Retention test complete');
    await reset();
    expect(unexpectedEgress).toBe(0);
  } finally {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});

describe('independent aggregate retention', () => {
  it.each(['success', 'failure'] as const)(
    'expires a REST-only %s hour at exactly 30 days without another provider call',
    async (outcome) => {
      const fetchMock = vi.fn(async () =>
        outcome === 'success' ? providerResponse() : new Response(null, { status: 503 }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const startedAt = clock;
      expect((await snapshotRequest()).status).toBe(outcome === 'success' ? 200 : 503);
      const before = await control();
      const expiry = feedMetricExpiryAt(startedAt);
      expect(await alarmAt()).toBe(expiry);
      clock = expiry - 1;
      expect(await runDurableObjectAlarm(stub())).toBe(true);
      expect(await metricKeys()).toEqual([keyAt(startedAt)]);
      expect(await alarmAt()).toBe(expiry);
      clock = expiry;
      expect(await runDurableObjectAlarm(stub())).toBe(true);
      expect(await metricKeys()).toEqual([]);
      expect(await alarmAt()).toBeNull();
      expect(await control()).toEqual(before);
      expect(
        await runInDurableObject(stub(), (_instance, state) =>
          state.storage.get(METRIC_LAST_CLEANUP_KEY),
        ),
      ).toBe(expiry);
      clock += 1;
      expect(await runDurableObjectAlarm(stub())).toBe(false);
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  it('advances to the next retained hour instead of a daily cleanup window', async () => {
    const fetchMock = vi.fn(async () => providerResponse());
    vi.stubGlobal('fetch', fetchMock);
    const firstHour = clock;
    await snapshotRequest();
    clock += HOUR;
    await snapshotRequest();
    expect(await alarmAt()).toBe(feedMetricExpiryAt(firstHour));
    clock = feedMetricExpiryAt(firstHour);
    await runDurableObjectAlarm(stub());
    expect(await metricKeys()).toEqual([keyAt(firstHour + HOUR)]);
    expect(await alarmAt()).toBe(clock + HOUR);
    clock += HOUR;
    await runDurableObjectAlarm(stub());
    expect(await metricKeys()).toEqual([]);
    expect(await alarmAt()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('services an earlier expiry and a long backoff without moving or bypassing provider deadlines', async () => {
    clock -= 5_000;
    const startedAt = clock;
    const fetchMock = vi.fn(async () => providerResponse());
    vi.stubGlobal('fetch', fetchMock);
    const viewer = await connectedViewer();
    const firstExpiry = startedAt + 5_000;
    await seed(firstExpiry - METRIC_RETENTION_MS);
    expect(await alarmAt()).toBe(firstExpiry);
    clock = firstExpiry;
    await runDurableObjectAlarm(stub());
    expect(await alarmAt()).toBe(startedAt + RUNTIME_POLICY_CHECK_INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect((await control())['state:sequence']).toBe(viewer.snapshot.sequence);

    clock = startedAt + POLL_INTERVAL_MS;
    fetchMock.mockImplementation(
      async () => new Response(null, { status: 429, headers: { 'retry-after': '172800' } }),
    );
    const failed = nextFrame(viewer.socket, 'error');
    await runDurableObjectAlarm(stub());
    await failed;
    const retryAt = (await control())['state:nextRetryAt'];
    expect(retryAt).toBe(clock + 2 * DAY);
    const secondExpiry = firstExpiry + HOUR;
    await seed(secondExpiry - METRIC_RETENTION_MS);
    expect(await alarmAt()).toBe(clock + RUNTIME_POLICY_CHECK_INTERVAL_MS);
    clock = secondExpiry;
    await runDurableObjectAlarm(stub());
    expect(await alarmAt()).toBe(clock + RUNTIME_POLICY_CHECK_INTERVAL_MS);
    expect((await control())['state:nextRetryAt']).toBe(retryAt);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((await control())['state:consecutiveFailures']).toBe(1);
  });

  it('expires old metrics and records a coarse hibernation-loss signal for a blocked feed', async () => {
    const fetchMock = vi.fn(
      async () => new Response(null, { status: 429, headers: { 'retry-after': '9'.repeat(100) } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const socket = await unacceptedSocket();
    const failure = nextFrame(socket, 'error');
    socket.accept();
    expect((await failure).recoverable).toBe(false);
    expect((await snapshotRequest()).status).toBe(503);
    const before = await control();
    const expiry = feedMetricExpiryAt(clock);
    await evictDurableObject(stub(), { webSockets: 'hibernate' });
    clock = expiry;
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect(await metricKeys()).toEqual([keyAt(clock)]);
    expect(
      await runInDurableObject(stub(), (_instance, state) =>
        state.storage.get<Record<string, unknown>>(keyAt(clock)),
      ),
    ).toMatchObject({ pollCount: 0, deliveryHibernationLossCount: 1 });
    expect(await alarmAt()).toBe(clock + RUNTIME_POLICY_CHECK_INTERVAL_MS);
    expect(await control()).toEqual(before);
    expect(fetchMock).toHaveBeenCalledOnce();
  }, 40_000);

  it('keeps expiry after a socket error closes the last active viewer', async () => {
    const fetchMock = vi.fn(async () => providerResponse());
    vi.stubGlobal('fetch', fetchMock);
    await connectedViewer();
    const expiry = feedMetricExpiryAt(clock);
    await runInDurableObject(stub(), async (instance, state) => {
      await instance.webSocketError(state.getWebSockets()[0]!);
    });
    expect(await alarmAt()).toBe(expiry);
    clock = expiry;
    await runDurableObjectAlarm(stub());
    expect(await metricKeys()).toEqual([]);
    expect(await alarmAt()).toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('allows a reconstructed disabled coordinator to clean metrics without a provider', async () => {
    await initialize();
    const hour = clock - METRIC_RETENTION_MS;
    await seed(hour);
    const disabledBindings = {
      ...workerEnv,
      LIVE_PROVIDER_MODE: 'disabled',
      RUNTIME_PROVIDER_GATE_STATUS: 'closed',
      RUNTIME_PROVIDER_GATE_VALUE: 'source-disabled',
    };
    const disabledPolicy = await compileRuntimePolicy(
      runtimePolicyInputFromBindings(disabledBindings, false),
    );
    await runInDurableObject(stub(), async (_instance, state) => {
      const disabled = new RegionalFeedHub(state, {
        ...disabledBindings,
        RUNTIME_POLICY_ID: disabledPolicy.policyId,
      });
      await disabled.alarm();
    });
    expect(await metricKeys()).toEqual([]);
    expect(await alarmAt()).toBeNull();
    expect(unexpectedEgress).toBe(0);
  });

  it('repairs a legacy missing alarm on cold activation without fetching a provider', async () => {
    const fetchMock = vi.fn(async () => providerResponse());
    vi.stubGlobal('fetch', fetchMock);
    await snapshotRequest();
    const expiry = feedMetricExpiryAt(clock);
    await runInDurableObject(stub(), (_instance, state) => state.storage.deleteAlarm());
    await evictDurableObject(stub());
    await initialize();
    expect(await alarmAt()).toBe(expiry);
    clock = expiry;
    await runDurableObjectAlarm(stub());
    expect(await metricKeys()).toEqual([]);
    expect(fetchMock).toHaveBeenCalledOnce();
  }, 40_000);

  it('does not write another alarm for unchanged joins, REST reads or scheduling calls', async () => {
    const fetchMock = vi.fn(async () => providerResponse());
    vi.stubGlobal('fetch', fetchMock);
    await connectedViewer();
    const deadline = await alarmAt();
    let alarmWrites = 0;
    await runInDurableObject(stub(), (_instance, state) => {
      const original = state.storage.transaction.bind(state.storage);
      const intercept: typeof state.storage.transaction = (callback) =>
        original(async (transaction) => {
          const setAlarm = transaction.setAlarm.bind(transaction);
          const spy = vi.spyOn(transaction, 'setAlarm').mockImplementation((...args) => {
            alarmWrites += 1;
            return setAlarm(...args);
          });
          try {
            return await callback(transaction);
          } finally {
            spy.mockRestore();
          }
        });
      vi.spyOn(state.storage, 'transaction').mockImplementation(intercept);
    });
    await connectedViewer();
    await snapshotRequest();
    await snapshotRequest();
    expect(await alarmAt()).toBe(deadline);
    expect(alarmWrites).toBe(0);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('matches the capacity model with nine KV rows and one alarm write for a scheduled success', async () => {
    const fetchMock = vi.fn(async () => providerResponse());
    vi.stubGlobal('fetch', fetchMock);
    const viewer = await connectedViewer();
    // Keep the provider-poll capacity measurement independent from the
    // connection's already-recorded acknowledgment aggregate.
    await runInDurableObject(stub(), (instance) =>
      (
        instance as unknown as {
          flushDeliveryMetrics(force?: boolean): Promise<void>;
        }
      ).flushDeliveryMetrics(true),
    );
    let kvRows = 0;
    let alarmWrites = 0;
    const countPut = (args: readonly unknown[]) => {
      kvRows += typeof args[0] === 'string' ? 1 : Object.keys(args[0] as object).length;
    };
    await runInDurableObject(stub(), (_instance, state) => {
      const originalPut = state.storage.put.bind(state.storage);
      const put = (...args: unknown[]) => {
        countPut(args);
        return Reflect.apply(originalPut, state.storage, args) as Promise<void>;
      };
      vi.spyOn(state.storage, 'put').mockImplementation(put as typeof state.storage.put);
      const original = state.storage.transaction.bind(state.storage);
      const intercept: typeof state.storage.transaction = (callback) =>
        original(async (transaction) => {
          const originalTransactionPut = transaction.put.bind(transaction);
          const transactionPut = (...args: unknown[]) => {
            countPut(args);
            return Reflect.apply(originalTransactionPut, transaction, args) as Promise<void>;
          };
          const putSpy = vi
            .spyOn(transaction, 'put')
            .mockImplementation(transactionPut as typeof transaction.put);
          const setAlarm = transaction.setAlarm.bind(transaction);
          const alarmSpy = vi.spyOn(transaction, 'setAlarm').mockImplementation((...args) => {
            alarmWrites += 1;
            return setAlarm(...args);
          });
          try {
            return await callback(transaction);
          } finally {
            putSpy.mockRestore();
            alarmSpy.mockRestore();
          }
        });
      vi.spyOn(state.storage, 'transaction').mockImplementation(intercept);
    });
    clock += POLL_INTERVAL_MS;
    const delivered = nextFrame(viewer.socket, 'airspace.snapshot');
    await runDurableObjectAlarm(stub());
    await delivered;
    expect(kvRows).toBe(CURRENT_SUCCESS_KV_ROWS);
    expect(alarmWrites).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('deletes at most 128 overdue hourly rows per alarm and immediately schedules the remainder', async () => {
    await initialize();
    const lastHour = clock - METRIC_RETENTION_MS;
    await seed(lastHour);
    await runInDurableObject(stub(), async (_instance, state) => {
      const template = await state.storage.get<Record<string, unknown>>(keyAt(lastHour));
      const older = Object.fromEntries(
        Array.from({ length: METRIC_CLEANUP_BATCH_SIZE }, (_, index) => {
          const hour = lastHour - (index + 1) * HOUR;
          return [keyAt(hour), { ...template, hour: new Date(hour).toISOString() }];
        }),
      );
      await state.storage.put(older);
    });
    expect((await metricKeys()).length).toBe(METRIC_CLEANUP_BATCH_SIZE + 1);
    await runDurableObjectAlarm(stub());
    expect(await metricKeys()).toEqual([keyAt(lastHour)]);
    expect(await alarmAt()).toBe(clock);
    await runDurableObjectAlarm(stub());
    expect(await metricKeys()).toEqual([]);
    expect(await alarmAt()).toBeNull();
    expect(unexpectedEgress).toBe(0);
  });
});

describe('transactional expiry and recovery', () => {
  it('does not rearm an overdue loop when cleanup and its durable retry both fail', async () => {
    await initialize();
    const oldHour = clock - METRIC_RETENTION_MS;
    await seed(oldHour);
    let alarmWrites = 0;
    let restore = () => {};
    await runInDurableObject(stub(), (_instance, state) => {
      const original = state.storage.transaction.bind(state.storage);
      const intercept: typeof state.storage.transaction = (callback) =>
        original(async (transaction) => {
          const put = transaction.put.bind(transaction);
          const replacementPut = (...args: unknown[]) =>
            args[0] === METRIC_CLEANUP_RETRY_KEY
              ? Promise.reject(new Error('Controlled retry storage failure'))
              : (Reflect.apply(put, transaction, args) as Promise<void>);
          const putSpy = vi
            .spyOn(transaction, 'put')
            .mockImplementation(replacementPut as typeof transaction.put);
          const deleteSpy = vi
            .spyOn(transaction, 'delete')
            .mockRejectedValue(new Error('Controlled cleanup deletion failure'));
          const setAlarm = transaction.setAlarm.bind(transaction);
          const alarmSpy = vi.spyOn(transaction, 'setAlarm').mockImplementation((...args) => {
            alarmWrites += 1;
            return setAlarm(...args);
          });
          try {
            return await callback(transaction);
          } finally {
            putSpy.mockRestore();
            deleteSpy.mockRestore();
            alarmSpy.mockRestore();
          }
        });
      const spy = vi.spyOn(state.storage, 'transaction').mockImplementation(intercept);
      restore = () => spy.mockRestore();
    });
    await expect(runDurableObjectAlarm(stub())).rejects.toThrow(
      'Metric maintenance failed and recovery scheduling did not complete.',
    );
    expect(alarmWrites).toBe(0);
    expect(await metricKeys()).toEqual([keyAt(oldHour)]);
    restore();
    await evictDurableObject(stub());
    await initialize();
    await runDurableObjectAlarm(stub());
    expect(await metricKeys()).toEqual([]);
    expect(unexpectedEgress).toBe(0);
  }, 40_000);

  it('arms the existing REST-first reservation when a viewer joins during the pending fetch', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchMock = vi.fn(async () => {
      await pending;
      return providerResponse();
    });
    vi.stubGlobal('fetch', fetchMock);
    const firstResponse = snapshotRequest();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(await alarmAt()).toBeNull();
    const socket = await unacceptedSocket();
    const firstFrame = nextFrame(socket, 'airspace.snapshot');
    socket.accept();
    expect(await alarmAt()).toBe(clock + POLL_INTERVAL_MS);
    release();
    const [response, frame] = await Promise.all([firstResponse, firstFrame]);
    expect(response.body).toEqual(frame.snapshot);
    expect(fetchMock).toHaveBeenCalledOnce();
    await evictDurableObject(stub(), { webSockets: 'hibernate' });
    clock += POLL_INTERVAL_MS;
    const resumed = nextFrame(socket, 'airspace.snapshot');
    await runDurableObjectAlarm(stub());
    expect((await resumed).snapshot.sequence).toBe(frame.snapshot.sequence + 1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  }, 40_000);

  it('does not repeat a failed metric read or extend its retry during normal polling', async () => {
    const fetchMock = vi.fn(async () => providerResponse());
    vi.stubGlobal('fetch', fetchMock);
    const viewer = await connectedViewer();
    await seed(clock - METRIC_RETENTION_MS);
    let reads = 0;
    let restore = () => {};
    await runInDurableObject(stub(), (_instance, state) => {
      const original = state.storage.transaction.bind(state.storage);
      const intercept: typeof state.storage.transaction = (callback) =>
        original(async (transaction) => {
          const list = transaction.list.bind(transaction);
          const spy = vi.spyOn(transaction, 'list').mockImplementation((options) => {
            if (options?.prefix === 'metrics:') {
              reads += 1;
              return Promise.reject(new Error('Persistent controlled metric read failure'));
            }
            return list(options);
          });
          try {
            return await callback(transaction);
          } finally {
            spy.mockRestore();
          }
        });
      const spy = vi.spyOn(state.storage, 'transaction').mockImplementation(intercept);
      restore = () => spy.mockRestore();
    });
    await expect(runDurableObjectAlarm(stub())).rejects.toThrow(
      'Persistent controlled metric read failure',
    );
    const retryAt = clock + METRIC_CLEANUP_RETRY_MS;
    expect(await alarmAt()).toBe(clock + POLL_INTERVAL_MS);
    expect((await snapshotRequest()).status).toBe(200);
    clock += POLL_INTERVAL_MS;
    const next = nextFrame(viewer.socket, 'airspace.snapshot');
    await runDurableObjectAlarm(stub());
    expect((await next).snapshot.sequence).toBe(viewer.snapshot.sequence + 1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(reads).toBe(1);
    expect(
      await runInDurableObject(stub(), (_instance, state) =>
        state.storage.get(METRIC_CLEANUP_RETRY_KEY),
      ),
    ).toBe(retryAt);
    restore();
    clock = retryAt;
    await runDurableObjectAlarm(stub());
    expect(await metricKeys()).toEqual([keyAt(clock)]);
    expect(
      await runInDurableObject(stub(), (_instance, state) =>
        state.storage.get(METRIC_CLEANUP_RETRY_KEY),
      ),
    ).toBeUndefined();
  });

  it('preserves the earlier poll alarm after publication rescheduling fails and the object is evicted', async () => {
    const fetchMock = vi.fn(async () => providerResponse());
    vi.stubGlobal('fetch', fetchMock);
    const viewer = await connectedViewer();
    setAutomaticAcknowledgments(viewer.socket, false);
    clock += POLL_INTERVAL_MS;
    let injected = false;
    await runInDurableObject(stub(), (instance, state) => {
      const hub = instance as unknown as { scheduleNextAlarm(): Promise<void> };
      const original = hub.scheduleNextAlarm.bind(hub);
      vi.spyOn(hub, 'scheduleNextAlarm').mockImplementation(() => {
        const sent = state
          .getWebSockets()
          .some((socket) => (socket.deserializeAttachment() as ViewerAttachment).outstanding?.sent);
        if (sent && !injected) {
          injected = true;
          return Promise.reject(new Error('Controlled stop before final alarm reconciliation'));
        }
        return original();
      });
    });
    const committed = nextFrame(viewer.socket, 'airspace.snapshot');
    await expect(runDurableObjectAlarm(stub())).rejects.toThrow(
      'Controlled stop before final alarm reconciliation',
    );
    const afterCommit = (await committed).snapshot;
    expect(injected).toBe(true);
    expect(afterCommit.sequence).toBe(viewer.snapshot.sequence + 1);
    const nextPoll = clock + POLL_INTERVAL_MS;
    expect(await alarmAt()).toBe(nextPoll);
    expect(await metricKeys()).toEqual([keyAt(clock)]);
    setAutomaticAcknowledgments(viewer.socket, true);
    await deliveriesSettled(stub());
    await evictDurableObject(stub(), { webSockets: 'hibernate' });
    clock = nextPoll - 1;
    await runDurableObjectAlarm(stub());
    expect(await alarmAt()).toBe(nextPoll);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    clock = nextPoll;
    const resumed = nextFrame(viewer.socket, 'airspace.snapshot');
    await runDurableObjectAlarm(stub());
    expect((await resumed).snapshot).toMatchObject({
      feedEpoch: afterCommit.feedEpoch,
      sequence: afterCommit.sequence + 1,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  }, 40_000);

  it.each(['put', 'list', 'setAlarm'] as const)(
    'rolls back a metric insertion and its alarm after a transactional %s failure',
    async (operation) => {
      await initialize();
      await runInDurableObject(stub(), async (_instance, state) => {
        const fault = failOnceInsideTransaction(state.storage, operation);
        await expect(recordFeedMetric(state.storage, observation(clock))).rejects.toThrow(
          'Controlled transactional ' + operation + ' failure',
        );
        expect(fault.triggered()).toBe(true);
        fault.restore();
        expect(await state.storage.list({ prefix: 'metrics:' })).toEqual(new Map());
        expect(await state.storage.getAlarm()).toBeNull();
        await recordFeedMetric(state.storage, observation(clock));
        expect(await state.storage.getAlarm()).toBe(feedMetricExpiryAt(clock));
      });
    },
  );

  it('retains a newer committed hour and alarm if arming an earlier inserted hour fails', async () => {
    await initialize();
    await seed(clock);
    const before = await alarmAt();
    await runInDurableObject(stub(), async (_instance, state) => {
      const fault = failOnceInsideTransaction(state.storage, 'setAlarm');
      await expect(recordFeedMetric(state.storage, observation(clock - HOUR))).rejects.toThrow(
        'Controlled transactional setAlarm failure',
      );
      expect(fault.triggered()).toBe(true);
      fault.restore();
    });
    expect(await metricKeys()).toEqual([keyAt(clock)]);
    expect(await alarmAt()).toBe(before);
  });

  it.each(['list', 'delete', 'put', 'setAlarm'] as const)(
    'rolls back failed cleanup %s, preserves a bounded retry across eviction, and recovers',
    async (operation) => {
      await initialize();
      const oldHour = clock - METRIC_RETENTION_MS;
      await seed(oldHour);
      await seed(oldHour + HOUR);
      const before = await control();
      await runInDurableObject(stub(), async (_instance, state) => {
        failOnceInsideTransaction(state.storage, operation, (args) =>
          operation === 'list'
            ? (args[0] as { limit?: number } | undefined)?.limit === METRIC_CLEANUP_BATCH_SIZE
            : operation === 'put'
              ? args[0] === METRIC_LAST_CLEANUP_KEY
              : true,
        );
      });
      await expect(runDurableObjectAlarm(stub())).rejects.toThrow(
        'Controlled transactional ' + operation + ' failure',
      );
      expect(await metricKeys()).toEqual([keyAt(oldHour), keyAt(oldHour + HOUR)]);
      expect(await control()).toEqual(before);
      const retryAt = clock + METRIC_CLEANUP_RETRY_MS;
      expect(await alarmAt()).toBe(retryAt);
      expect(
        await runInDurableObject(stub(), (_instance, state) =>
          state.storage.get(METRIC_LAST_CLEANUP_KEY),
        ),
      ).toBeUndefined();
      await evictDurableObject(stub());
      clock = retryAt - 1;
      await initialize();
      expect(await alarmAt()).toBe(retryAt);
      await runDurableObjectAlarm(stub());
      expect(await metricKeys()).toHaveLength(2);
      expect(await alarmAt()).toBe(retryAt);
      clock = retryAt;
      await runDurableObjectAlarm(stub());
      expect(await metricKeys()).toEqual([keyAt(oldHour + HOUR)]);
      expect(await alarmAt()).toBe(oldHour + METRIC_RETENTION_MS + HOUR);
      expect(await control()).toEqual(before);
      expect(
        await runInDurableObject(stub(), (_instance, state) =>
          state.storage.get(METRIC_CLEANUP_RETRY_KEY),
        ),
      ).toBeUndefined();
      expect(unexpectedEgress).toBe(0);
    },
    40_000,
  );
});
