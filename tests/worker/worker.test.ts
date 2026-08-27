import { env } from 'cloudflare:workers';
import { reset, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import worker from '../../worker/index';
import type { WorkerEnv } from '../../worker/env';

const workerEnv = env as WorkerEnv;
const providerNow = Date.parse('2026-08-27T12:00:00.000Z');

function providerResponse(): Response {
  return Response.json({
    now: providerNow,
    ac: [
      {
        hex: 'a1b2c3',
        flight: 'DAL123',
        lat: 33.64,
        lon: -84.43,
        alt_baro: 12_000,
        gs: 320,
        track: 180,
        baro_rate: 500,
        seen: 1,
        seen_pos: 2,
      },
    ],
  });
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await reset();
});

describe('edge API', () => {
  it('publishes only the fixed regional presets', async () => {
    const response = await worker.fetch(
      new Request('https://workbench.test/api/v1/regions'),
      workerEnv,
    );
    const body = (await response.json()) as { regions: Array<{ id: string }> };

    expect(response.status).toBe(200);
    expect(body.regions.map(({ id }) => id)).toEqual([
      'atlanta',
      'savannah-statesboro',
      'central-georgia',
    ]);
  });

  it('rejects arbitrary regions and unsupported methods', async () => {
    const unknown = await worker.fetch(
      new Request('https://workbench.test/api/v1/airspace/worldwide/snapshot'),
      workerEnv,
    );
    expect(unknown.status).toBe(404);

    const method = await worker.fetch(
      new Request('https://workbench.test/api/v1/regions', { method: 'POST' }),
      workerEnv,
    );
    expect(method.status).toBe(405);
    expect(method.headers.get('allow')).toBe('GET, OPTIONS');
  });

  it('returns a normalized snapshot and stores only aggregate observations', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => providerResponse()),
    );

    const response = await worker.fetch(
      new Request('https://workbench.test/api/v1/airspace/atlanta/snapshot'),
      workerEnv,
    );
    const snapshot = (await response.json()) as {
      schemaVersion: string;
      aircraft: Array<{ aircraftId: string }>;
    };

    expect(response.status).toBe(200);
    expect(snapshot.schemaVersion).toBe('airspace.v1');
    expect(snapshot.aircraft).toEqual([expect.objectContaining({ aircraftId: 'a1b2c3' })]);

    const stub = workerEnv.REGION_FEEDS.getByName('atlanta');
    const keys = await runInDurableObject(stub, async (_instance, state) =>
      [...(await state.storage.list()).keys()].sort(),
    );
    expect(keys).toContain('state:sequence');
    expect(keys.some((key) => key.startsWith('metrics:'))).toBe(true);
    expect(keys.some((key) => /a1b2c3|DAL123/.test(key))).toBe(false);
  });

  it('reports health without starting an upstream poll', async () => {
    const fetchMock = vi.fn(async () => providerResponse());
    vi.stubGlobal('fetch', fetchMock);

    const response = await worker.fetch(
      new Request('https://workbench.test/api/v1/health'),
      workerEnv,
    );
    const body = (await response.json()) as { regions: Array<{ status: string }> };

    expect(response.status).toBe(200);
    expect(body.regions).toHaveLength(3);
    expect(body.regions.every(({ status }) => status === 'offline')).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('blocks websocket upgrades from an unrelated origin', async () => {
    const response = await worker.fetch(
      new Request('https://workbench.test/api/v1/airspace/atlanta/stream', {
        headers: { origin: 'https://unrelated.example', upgrade: 'websocket' },
      }),
      workerEnv,
    );
    expect(response.status).toBe(403);
  });

  it('fans one in-flight provider poll out to multiple regional viewers', async () => {
    let releaseProvider: ((response: Response) => void) | undefined;
    const providerPending = new Promise<Response>((resolve) => {
      releaseProvider = resolve;
    });
    const fetchMock = vi.fn(async () => providerPending);
    vi.stubGlobal('fetch', fetchMock);

    const connect = async (): Promise<WebSocket> => {
      const response = await worker.fetch(
        new Request('https://workbench.test/api/v1/airspace/atlanta/stream', {
          headers: { origin: 'https://workbench.test', upgrade: 'websocket' },
        }),
        workerEnv,
      );
      expect(response.status).toBe(101);
      expect(response.webSocket).toBeDefined();
      response.webSocket?.accept();
      return response.webSocket as WebSocket;
    };

    const first = await connect();
    const second = await connect();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    releaseProvider?.(providerResponse());
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    first.close(1000, 'test complete');
    second.close(1000, 'test complete');
  });

  it('honors provider backoff instead of allowing snapshot requests to hammer upstream', async () => {
    const fetchMock = vi.fn(
      async () => new Response('', { status: 429, headers: { 'retry-after': '30' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const url = 'https://workbench.test/api/v1/airspace/atlanta/snapshot';

    const first = await worker.fetch(new Request(url), workerEnv);
    const second = await worker.fetch(new Request(url), workerEnv);

    expect(first.status).toBe(503);
    expect(second.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = (await second.json()) as { health: { retryAt?: string } };
    expect(body.health.retryAt).toBeDefined();
  });

  it('does not schedule background polling for a snapshot-only request', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => providerResponse()),
    );
    await worker.fetch(
      new Request('https://workbench.test/api/v1/airspace/atlanta/snapshot'),
      workerEnv,
    );

    const stub = workerEnv.REGION_FEEDS.getByName('atlanta');
    expect(await runDurableObjectAlarm(stub)).toBe(false);
  });
});
