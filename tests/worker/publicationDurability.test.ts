import { env } from 'cloudflare:workers';
import {
  evictDurableObject,
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
} from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AirspaceSnapshot, LiveFeedHealth } from '../../src/live/types';
import { resetRequestAdmissionForTests } from '../../worker/admission';
import type { RegionalDelivery, ViewerAttachment } from '../../worker/delivery';
import type { WorkerEnv } from '../../worker/env';
import worker from '../../worker/index';
import { POLL_INTERVAL_MS } from '../../worker/polling';
import { deliveriesSettled, nextFrame } from './liveSocket';

const workerEnv = env as WorkerEnv;
const stub = () => workerEnv.REGION_FEEDS.getByName('atlanta');
const snapshotRequest = () =>
  worker.fetch(new Request('https://workbench.test/api/v1/airspace/atlanta/snapshot'), workerEnv);

let clock: number;
let unexpectedEgress: number;
const sockets: WebSocket[] = [];

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
        seen: 1,
        seen_pos: 2,
      },
    ],
  });
}

async function currentHealth(): Promise<LiveFeedHealth> {
  const response = await worker.fetch(
    new Request('https://workbench.test/api/v1/health'),
    workerEnv,
  );
  const body = (await response.json()) as { regions: LiveFeedHealth[] };
  return body.regions.find((health) => health.regionId === 'atlanta')!;
}

async function persisted(): Promise<Record<string, unknown>> {
  return runInDurableObject(stub(), async (_instance, state) =>
    Object.fromEntries(await state.storage.list()),
  );
}

async function alarmAt(): Promise<number | null> {
  return runInDurableObject(stub(), (_instance, state) => state.storage.getAlarm());
}

async function attachedViewer(): Promise<ViewerAttachment> {
  return runInDurableObject(
    stub(),
    (_instance, state) => state.getWebSockets()[0]!.deserializeAttachment() as ViewerAttachment,
  );
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
  socket.accept();
  const snapshot = (await delivered).snapshot;
  await deliveriesSettled(stub());
  return { socket, snapshot };
}

type PublicationFailureStage = 'reservation' | 'success-state' | 'metrics' | 'publication';

async function failNextStage(stage: PublicationFailureStage, message: string): Promise<() => void> {
  let restore = () => {};
  await runInDurableObject(stub(), (instance, state) => {
    if (stage === 'publication') {
      const spy = vi
        .spyOn((instance as unknown as { delivery: RegionalDelivery }).delivery, 'publish')
        .mockImplementation(() => {
          throw new Error(message);
        });
      restore = () => spy.mockRestore();
      return;
    }
    if (stage === 'success-state') {
      const original = state.storage.put.bind(state.storage);
      const spy = vi.spyOn(state.storage, 'put').mockImplementation((...args: unknown[]) => {
        const key = args[0];
        if (typeof key === 'object' && key !== null && 'state:sequence' in key) {
          return Promise.reject(new Error(message));
        }
        return Reflect.apply(original, state.storage, args) as Promise<void>;
      });
      restore = () => spy.mockRestore();
      return;
    }

    const originalTransaction = state.storage.transaction.bind(state.storage);
    const spy = vi.spyOn(state.storage, 'transaction').mockImplementation((callback) =>
      originalTransaction(async (transaction) => {
        const originalPut = transaction.put.bind(transaction);
        const putSpy = vi.spyOn(transaction, 'put').mockImplementation((...args: unknown[]) => {
          const key = args[0];
          const shouldFail =
            stage === 'reservation'
              ? key === 'state:nextPollAt'
              : typeof key === 'string' && key.startsWith('metrics:');
          return shouldFail
            ? Promise.reject(new Error(message))
            : (Reflect.apply(originalPut, transaction, args) as Promise<void>);
        });
        try {
          return await callback(transaction);
        } finally {
          putSpy.mockRestore();
        }
      }),
    );
    restore = () => spy.mockRestore();
  });
  return restore;
}

async function seedSequence(sequence: number): Promise<void> {
  await currentHealth();
  await runInDurableObject(stub(), async (_instance, state) => {
    await state.storage.put({ 'state:sequence': sequence, 'state:nextPollAt': clock });
    await state.storage.setAlarm(clock);
  });
  await evictDurableObject(stub());
}

beforeEach(() => {
  resetRequestAdmissionForTests();
  clock = Math.floor(Date.now() / 1_000) * 1_000;
  unexpectedEgress = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      unexpectedEgress += 1;
      throw new Error('Unexpected outbound request in the controlled publication suite.');
    }),
  );
});

afterEach(async () => {
  try {
    for (const socket of sockets.splice(0)) socket.close(1000, 'Publication test complete');
    await reset();
    expect(unexpectedEgress).toBe(0);
  } finally {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});

describe('durable regional publication', () => {
  it('resumes a committed pre-fetch reservation once after cold restart', async () => {
    const fetchMock = vi.fn(async () => providerResponse());
    vi.stubGlobal('fetch', fetchMock);
    await currentHealth();
    const deadline = clock + POLL_INTERVAL_MS;
    await runInDurableObject(stub(), async (_instance, state) => {
      await state.storage.put({ 'state:sequence': 0, 'state:nextPollAt': deadline });
      await state.storage.setAlarm(deadline);
    });
    await evictDurableObject(stub());

    const socket = await unacceptedSocket();
    const delivered = nextFrame(socket, 'airspace.snapshot');
    socket.accept();
    expect(fetchMock).not.toHaveBeenCalled();
    await deliveriesSettled(stub());
    expect(await alarmAt()).toBe(deadline);

    await evictDurableObject(stub(), { webSockets: 'hibernate' });
    clock = deadline - 1;
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await alarmAt()).toBe(deadline);
    clock = deadline;
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect((await delivered).snapshot.sequence).toBe(1);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect((await persisted())['state:sequence']).toBe(1);
  });

  it.each([
    ['reservation', 1, 1, 2],
    ['success-state', 2, 1, 2],
    ['metrics', 2, 2, 3],
    ['publication', 2, 2, 3],
  ] as const)(
    'recovers from a %s boundary without escaping or reusing a sequence',
    async (stage, expectedFetchesAfterFailure, committedAfterFailure, recoveredSequence) => {
      const fetchMock = vi.fn(async () => providerResponse());
      vi.stubGlobal('fetch', fetchMock);
      const viewer = await connectedViewer();
      expect(viewer.snapshot.sequence).toBe(1);
      const message = `Controlled ${stage} publication boundary`;
      const restore = await failNextStage(stage, message);

      clock += POLL_INTERVAL_MS;
      await expect(runDurableObjectAlarm(stub())).rejects.toThrow(message);
      expect(fetchMock).toHaveBeenCalledTimes(expectedFetchesAfterFailure);
      expect((await persisted())['state:sequence']).toBe(committedAfterFailure);
      expect((await attachedViewer()).outstanding).toBeUndefined();
      restore();

      await evictDurableObject(stub(), { webSockets: 'hibernate' });
      clock += POLL_INTERVAL_MS;
      const response = await snapshotRequest();
      expect(response.status).toBe(200);
      const recovered = (await response.json()) as AirspaceSnapshot;
      expect(recovered.sequence).toBe(recoveredSequence);
      expect((await persisted())['state:sequence']).toBe(recoveredSequence);
    },
    40_000,
  );

  it('does not duplicate a provider request or sequence for the same due alarm', async () => {
    const fetchMock = vi.fn(async () => providerResponse());
    vi.stubGlobal('fetch', fetchMock);
    const viewer = await connectedViewer();
    const deadline = clock + POLL_INTERVAL_MS;
    clock = deadline;
    const delivered = nextFrame(
      viewer.socket,
      'airspace.snapshot',
      (frame) => frame.snapshot.sequence === 2,
    );
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect((await delivered).snapshot.sequence).toBe(2);
    await deliveriesSettled(stub());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((await persisted())['state:sequence']).toBe(2);
    const nextDeadline = deadline + POLL_INTERVAL_MS;
    expect(await alarmAt()).toBe(nextDeadline);

    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((await persisted())['state:sequence']).toBe(2);
    expect(await alarmAt()).toBe(nextDeadline);
  });

  it('pauses a cold feed exhausted at the maximum safe sequence before provider I/O', async () => {
    const fetchMock = vi.fn(async () => providerResponse());
    vi.stubGlobal('fetch', fetchMock);
    await seedSequence(Number.MAX_SAFE_INTEGER);

    const response = await snapshotRequest();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: 'POLLING_PAUSED',
      health: {
        status: 'degraded',
      },
    });
    const health = await currentHealth();
    expect(health).toMatchObject({ status: 'degraded', consecutiveFailures: 0 });
    expect(health.message).toMatch(/sequence.*exhausted/iu);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await alarmAt()).toBeNull();

    const state = await persisted();
    expect(state['state:sequence']).toBe(Number.MAX_SAFE_INTEGER);
    expect(state['state:sequenceExhausted']).toBeUndefined();
    expect(state['state:retryBlocked'] ?? false).toBe(false);

    await evictDurableObject(stub());
    const repeated = await snapshotRequest();
    expect(repeated.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('publishes the final safe sequence once and remains durably paused after eviction', async () => {
    const fetchMock = vi.fn(async () => providerResponse());
    vi.stubGlobal('fetch', fetchMock);
    await seedSequence(Number.MAX_SAFE_INTEGER - 1);

    const socket = await unacceptedSocket();
    const finalSnapshot = nextFrame(socket, 'airspace.snapshot');
    const finalHealth = nextFrame(
      socket,
      'feed.health',
      (frame) => frame.health.status === 'degraded',
    );
    socket.accept();
    const [snapshotFrame, healthFrame] = await Promise.all([finalSnapshot, finalHealth]);
    expect(snapshotFrame.snapshot.sequence).toBe(Number.MAX_SAFE_INTEGER);
    expect(healthFrame.health.message).toMatch(/sequence.*exhausted/iu);
    await deliveriesSettled(stub());
    expect(fetchMock).toHaveBeenCalledOnce();

    const health = await currentHealth();
    expect(health.status).toBe('degraded');
    expect(health.message).toMatch(/sequence.*exhausted/iu);
    expect((await persisted())['state:sequence']).toBe(Number.MAX_SAFE_INTEGER);

    const repeated = await snapshotRequest();
    expect(repeated.status).toBe(200);
    await repeated.arrayBuffer();
    expect(fetchMock).toHaveBeenCalledOnce();
    await evictDurableObject(stub(), { webSockets: 'hibernate' });
    const cold = await snapshotRequest();
    expect(cold.status).toBe(503);
    expect(await cold.json()).toMatchObject({ error: 'POLLING_PAUSED' });
    expect(fetchMock).toHaveBeenCalledOnce();
  }, 40_000);
});
