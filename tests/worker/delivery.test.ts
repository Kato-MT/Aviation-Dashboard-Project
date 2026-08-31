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
import { REQUEST_ADMISSION_POLICY, resetRequestAdmissionForTests } from '../../worker/admission';
import { POLL_INTERVAL_MS } from '../../worker/polling';
import { RUNTIME_POLICY_CHECK_INTERVAL_MS } from '../../worker/regionalFeedHub';
import {
  MAX_REGIONAL_VIEWERS,
  LIVE_DELIVERY_ACK_TIMEOUT_MS,
  readViewerAttachment,
  type ViewerAttachment,
} from '../../worker/delivery';
import {
  parseLiveServerFrame,
  serializeLiveAcknowledgment,
  type LiveDeliveryMessage,
  type LiveServerFrame,
} from '../../src/live/delivery';
import { LIVE_STREAM_PROTOCOL_VERSION } from '../../src/live/protocol';
import type { AirspaceSnapshot } from '../../src/live/types';
import { deliveriesSettled, nextClose } from './liveSocket';

const workerEnv = env as WorkerEnv;
const sockets: WebSocket[] = [];
const stub = () => workerEnv.REGION_FEEDS.getByName('atlanta');
let clock: number;
let unexpectedEgress: number;

function nextWireFrame<T extends LiveServerFrame['type']>(
  socket: WebSocket,
  type: T,
): Promise<Extract<LiveServerFrame, { type: T }>> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeEventListener('message', receive);
      socket.removeEventListener('close', closed);
    };
    const receive = (event: MessageEvent) => {
      const parsed = parseLiveServerFrame(event.data);
      if (!parsed.ok) {
        cleanup();
        reject(new Error(parsed.errors.join(' ')));
      } else if (parsed.message.type === type) {
        cleanup();
        resolve(parsed.message as Extract<LiveServerFrame, { type: T }>);
      }
    };
    const closed = () => {
      cleanup();
      reject(new Error('Socket closed before the expected frame.'));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Wire frame timed out.'));
    }, 2_000);
    socket.addEventListener('message', receive);
    socket.addEventListener('close', closed);
  });
}

function streamRequest(): Promise<Response> {
  return worker.fetch(
    new Request('https://workbench.test/api/v1/airspace/atlanta/stream', {
      headers: { origin: 'https://workbench.test', upgrade: 'websocket' },
    }),
    workerEnv,
  );
}

async function stalledViewer(): Promise<{ socket: WebSocket; frame: LiveDeliveryMessage }> {
  const response = await streamRequest();
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  sockets.push(socket);
  const hello = nextWireFrame(socket, 'hello');
  const delivered = nextWireFrame(socket, 'delivery');
  socket.accept();
  const [identity, frame] = await Promise.all([hello, delivered]);
  expect(frame).toMatchObject({
    providerId: identity.providerId,
    regionId: identity.regionId,
    feedEpoch: identity.feedEpoch,
  });
  return { socket, frame };
}

async function cacheSnapshot(): Promise<AirspaceSnapshot> {
  const response = await worker.fetch(
    new Request('https://workbench.test/api/v1/airspace/atlanta/snapshot'),
    workerEnv,
  );
  expect(response.status).toBe(200);
  return response.json();
}

function successfulProvider() {
  const fetcher = vi.fn(async () =>
    Response.json({
      now: clock,
      ac: [
        { hex: 'a1b2c3', lat: 33.64, lon: -84.43, alt_baro: 12_000, gs: 320, seen: 0, seen_pos: 0 },
      ],
    }),
  );
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
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
      throw new Error('Unmocked egress is forbidden in delivery tests.');
    }),
  );
});

afterEach(async () => {
  try {
    for (const socket of sockets.splice(0)) socket.close(1000, 'Delivery test finished');
    await reset();
    expect(unexpectedEgress).toBe(0);
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

describe('actual Worker delivery windows', () => {
  it.each([false, true])(
    'counts actual ACK alarm changes with provider backoff=%s',
    async (backoff) => {
      if (backoff) {
        vi.stubGlobal(
          'fetch',
          vi.fn(async () => new Response('', { status: 429, headers: { 'retry-after': '300' } })),
        );
        const response = await worker.fetch(
          new Request('https://workbench.test/api/v1/airspace/atlanta/snapshot'),
          workerEnv,
        );
        expect(response.status).toBe(503);
        await response.json();
      } else {
        successfulProvider();
        await cacheSnapshot();
      }
      let writes = 0;
      await runInDurableObject(stub(), (_instance, state) => {
        const transaction = state.storage.transaction.bind(state.storage);
        const intercept: typeof state.storage.transaction = (callback) =>
          transaction(async (tx) => {
            const setAlarm = tx.setAlarm.bind(tx);
            const spy = vi.spyOn(tx, 'setAlarm').mockImplementation((...args) => {
              writes += 1;
              return setAlarm(...args);
            });
            try {
              return await callback(tx);
            } finally {
              spy.mockRestore();
            }
          });
        vi.spyOn(state.storage, 'transaction').mockImplementation(intercept);
      });
      const viewer = await stalledViewer();
      expect(writes).toBe(1);
      expect(await runInDurableObject(stub(), (_instance, state) => state.storage.getAlarm())).toBe(
        clock + LIVE_DELIVERY_ACK_TIMEOUT_MS,
      );
      viewer.socket.send(serializeLiveAcknowledgment(viewer.frame));
      await deliveriesSettled(stub());
      const deadline = await runInDurableObject(stub(), (_instance, state) =>
        state.storage.getAlarm(),
      );
      expect(deadline).toBe(clock + RUNTIME_POLICY_CHECK_INTERVAL_MS);
      expect(writes).toBe(2);
    },
  );

  it('accepts 25 attached sockets and returns a bounded 503 for viewer 26', async () => {
    const fetcher = successfulProvider();
    await cacheSnapshot();
    for (let index = 0; index < MAX_REGIONAL_VIEWERS; index++) await stalledViewer();
    const response = await streamRequest();
    expect(response.status).toBe(503);
    expect(response.webSocket).toBeNull();
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({ error: 'VIEWER_CAPACITY' });
    expect(body.length).toBeLessThan(512);
    expect(
      await runInDurableObject(stub(), (_instance, state) => state.getWebSockets().length),
    ).toBe(MAX_REGIONAL_VIEWERS);
    expect(fetcher).toHaveBeenCalledOnce();
  }, 20_000);

  it('bounds a full-region reconnect storm and recovers after one slot and token refill', async () => {
    resetRequestAdmissionForTests(() => clock);
    const fetcher = successfulProvider();
    const viewers: Array<Awaited<ReturnType<typeof stalledViewer>>> = [];
    for (let index = 0; index < MAX_REGIONAL_VIEWERS; index++) {
      viewers.push(await stalledViewer());
    }
    expect(fetcher).toHaveBeenCalledOnce();

    const remainingStreamBurst = REQUEST_ADMISSION_POLICY.stream.burst - MAX_REGIONAL_VIEWERS;
    for (let index = 0; index < remainingStreamBurst; index++) {
      const response = await streamRequest();
      expect(response.status).toBe(503);
      expect(response.webSocket).toBeNull();
      const body = await response.text();
      expect(body.length).toBeLessThan(512);
      expect(JSON.parse(body)).toMatchObject({ error: 'VIEWER_CAPACITY' });
    }

    const rejected = await streamRequest();
    expect(rejected.status).toBe(429);
    expect(rejected.webSocket).toBeNull();
    expect(rejected.headers.get('retry-after')).toBe('1');
    const rejectedBody = await rejected.text();
    expect(rejectedBody.length).toBeLessThan(512);
    expect(JSON.parse(rejectedBody)).toMatchObject({
      error: 'STREAM_ADMISSION_LIMIT',
      admission: { scope: 'worker-isolate', retryAfterSeconds: 1 },
    });
    expect(
      await runInDurableObject(stub(), (_instance, state) => state.getWebSockets().length),
    ).toBe(MAX_REGIONAL_VIEWERS);
    expect(fetcher).toHaveBeenCalledOnce();

    viewers[0]!.socket.close(1000, 'Reconnect storm recovery');
    await vi.waitFor(async () => {
      expect(
        await runInDurableObject(stub(), (_instance, state) => state.getWebSockets().length),
      ).toBe(MAX_REGIONAL_VIEWERS - 1);
    });

    clock += Math.ceil(1_000 / REQUEST_ADMISSION_POLICY.stream.refillPerSecond);
    await stalledViewer();
    expect(
      await runInDurableObject(stub(), (_instance, state) => state.getWebSockets().length),
    ).toBe(MAX_REGIONAL_VIEWERS);
    expect(fetcher).toHaveBeenCalledOnce();
  }, 40_000);

  it('restores an outstanding receipt window after genuine hibernating eviction', async () => {
    const fetcher = successfulProvider();
    const first = await cacheSnapshot();
    const viewer = await stalledViewer();
    const attachment = await runInDurableObject(
      stub(),
      (_instance, state) => state.getWebSockets()[0]!.deserializeAttachment() as ViewerAttachment,
    );
    expect(attachment.outstanding).toMatchObject({
      deliveryId: viewer.frame.deliveryId,
      sent: true,
    });
    expect(attachment.outstanding!.expiresAt).toBe(clock + LIVE_DELIVERY_ACK_TIMEOUT_MS);
    await evictDurableObject(stub(), { webSockets: 'hibernate' });
    const restored = await runInDurableObject(stub(), (_instance, state) => {
      const socket = state.getWebSockets()[0]!;
      return readViewerAttachment(socket, viewer.frame);
    });
    expect(restored).toEqual(attachment);
    viewer.socket.send(serializeLiveAcknowledgment(viewer.frame));
    await deliveriesSettled(stub());
    expect(fetcher).toHaveBeenCalledOnce();
    const pong = nextWireFrame(viewer.socket, 'delivery');
    viewer.socket.send(
      JSON.stringify({
        type: 'ping',
        protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
        requestId: 'after-hibernation',
      }),
    );
    const answer = await pong;
    expect(answer.messages).toEqual([
      expect.objectContaining({
        type: 'pong',
        requestId: 'after-hibernation',
        feedEpoch: first.feedEpoch,
      }),
    ]);
    viewer.socket.send(serializeLiveAcknowledgment(answer));
    await deliveriesSettled(stub());
    clock += LIVE_DELIVERY_ACK_TIMEOUT_MS;
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
    clock += POLL_INTERVAL_MS - LIVE_DELIVERY_ACK_TIMEOUT_MS;
    const resumed = nextWireFrame(viewer.socket, 'delivery');
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect((await resumed).messages).toContainEqual(
      expect.objectContaining({
        type: 'airspace.snapshot',
        snapshot: expect.objectContaining({
          sequence: first.sequence + 1,
          feedEpoch: first.feedEpoch,
        }),
      }),
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  }, 40_000);

  it('recovers mixed sent and reserved-unsent receipts after genuine hibernation', async () => {
    const fetcher = successfulProvider();
    const initial = await cacheSnapshot();
    const first = await stalledViewer();
    const second = await stalledViewer();
    await runInDurableObject(stub(), (_instance, state) => {
      const server = state.getWebSockets().find((socket) => {
        const attachment = socket.deserializeAttachment() as ViewerAttachment;
        return attachment.outstanding?.deliveryId === second.frame.deliveryId;
      });
      if (!server) throw new Error('Expected the second attached viewer.');
      const attachment = server.deserializeAttachment() as ViewerAttachment;
      server.serializeAttachment({
        ...attachment,
        outstanding: { ...attachment.outstanding!, sent: false },
      } satisfies ViewerAttachment);
    });

    await evictDurableObject(stub(), { webSockets: 'hibernate' });
    const restored = await runInDurableObject(stub(), (_instance, state) =>
      state.getWebSockets().map((socket) => {
        const attachment = socket.deserializeAttachment() as ViewerAttachment;
        return {
          deliveryId: attachment.outstanding?.deliveryId,
          sent: attachment.outstanding?.sent,
        };
      }),
    );
    expect(restored).toEqual(
      expect.arrayContaining([
        { deliveryId: first.frame.deliveryId, sent: true },
        { deliveryId: second.frame.deliveryId, sent: false },
      ]),
    );

    first.socket.send(serializeLiveAcknowledgment(first.frame));
    await vi.waitFor(async () => {
      const receipts = await runInDurableObject(stub(), (_instance, state) =>
        state.getWebSockets().map((socket) => {
          const attachment = socket.deserializeAttachment() as ViewerAttachment;
          return attachment.outstanding;
        }),
      );
      expect(receipts).toHaveLength(2);
      expect(receipts).toEqual(
        expect.arrayContaining([undefined, expect.objectContaining({ sent: false })]),
      );
    });

    const closed = nextClose(second.socket);
    clock += LIVE_DELIVERY_ACK_TIMEOUT_MS;
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect((await closed).code).toBe(1008);
    expect(fetcher).toHaveBeenCalledOnce();

    clock += POLL_INTERVAL_MS - LIVE_DELIVERY_ACK_TIMEOUT_MS;
    const resumed = nextWireFrame(first.socket, 'delivery');
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect((await resumed).messages).toContainEqual(
      expect.objectContaining({
        type: 'airspace.snapshot',
        snapshot: expect.objectContaining({
          feedEpoch: initial.feedEpoch,
          sequence: initial.sequence + 1,
        }),
      }),
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  }, 40_000);

  it('expires a stalled viewer during long provider backoff without polling early', async () => {
    const fetcher = vi.fn(
      async () => new Response('', { status: 429, headers: { 'retry-after': '300' } }),
    );
    vi.stubGlobal('fetch', fetcher);
    const viewer = await stalledViewer();
    const failure = nextWireFrame(viewer.socket, 'delivery');
    viewer.socket.send(serializeLiveAcknowledgment(viewer.frame));
    const frame = await failure;
    expect(frame.messages.some((message) => message.type === 'error')).toBe(true);
    const retryAt = await runInDurableObject(stub(), (_instance, state) =>
      state.storage.get<number>('state:nextRetryAt'),
    );
    expect(retryAt).toBe(clock + 300_000);
    expect(await runInDurableObject(stub(), (_instance, state) => state.storage.getAlarm())).toBe(
      clock + LIVE_DELIVERY_ACK_TIMEOUT_MS,
    );
    const closed = nextClose(viewer.socket);
    clock += LIVE_DELIVERY_ACK_TIMEOUT_MS;
    await runDurableObjectAlarm(stub());
    expect((await closed).code).toBe(1008);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(
      await runInDurableObject(stub(), (_instance, state) =>
        state.storage.get<number>('state:nextRetryAt'),
      ),
    ).toBe(retryAt);
  });

  it('does not release a different actual socket using a stolen acknowledgment token', async () => {
    const fetcher = successfulProvider();
    await cacheSnapshot();
    const first = await stalledViewer();
    const second = await stalledViewer();
    const closed = nextClose(first.socket);
    first.socket.send(serializeLiveAcknowledgment(second.frame));
    expect((await closed).code).toBe(1008);
    const outstanding = await runInDurableObject(stub(), (_instance, state) =>
      state
        .getWebSockets()
        .filter((socket) => socket.readyState === WebSocket.OPEN)
        .map((socket) => (socket.deserializeAttachment() as ViewerAttachment).outstanding),
    );
    expect(outstanding).toEqual([expect.objectContaining({ deliveryId: second.frame.deliveryId })]);
    second.socket.send(serializeLiveAcknowledgment(second.frame));
    await deliveriesSettled(stub());
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
