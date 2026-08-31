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
import {
  RUNTIME_POLICY_CHECK_INTERVAL_MS,
  RUNTIME_POLICY_DISABLED_CLOSE_CODE,
  RUNTIME_POLICY_DISABLED_CLOSE_REASON,
  type RegionalFeedHub,
} from '../../worker/regionalFeedHub';
import { configuredProvider } from '../../worker/providerConfig';
import { feedMetricExpiryAt } from '../../worker/metrics';
import { REQUEST_ADMISSION_POLICY, resetRequestAdmissionForTests } from '../../worker/admission';
import { REGION_CONFIGS } from '../../src/live/regions';
import { LIVE_STREAM_PROTOCOL_VERSION, parseLiveStreamMessage } from '../../src/live/protocol';
import { compileRuntimePolicy } from '../../src/live/runtimePolicy';
import { parseOperationsProjection } from '../../src/operations/contract';
import type { AirspaceSnapshot, LiveFeedBinding, LiveFeedHealth } from '../../src/live/types';
import { deliveriesSettled, nextClose, nextFrame, nextSnapshot } from './liveSocket';

const workerEnv = env as WorkerEnv;
const providerNow = Date.parse('2026-08-27T12:00:00.000Z');
let unexpectedEgress = 0;

async function disabledWorkerEnv(): Promise<WorkerEnv> {
  const policy = await compileRuntimePolicy({
    target: 'live-staging',
    providerMode: 'disabled',
    providerBaseUrl: 'https://api.adsb.lol',
    mockBindingPresent: false,
    allowedOrigins: ['http://127.0.0.1:4173', 'http://localhost:4173'],
    deploymentClass: 'loopback',
    release: {
      applicationVersion: workerEnv.APP_VERSION,
      releaseSha: workerEnv.RELEASE_SHA,
      releaseStatus: 'unreleased',
      buildTarget: 'live-staging',
    },
    policyEpoch: 'r3-local-disabled-1',
    providerGate: { status: 'closed', reason: 'source-disabled' },
  });
  return {
    ...workerEnv,
    LIVE_PROVIDER_MODE: 'disabled',
    RUNTIME_POLICY_EPOCH: policy.policyEpoch,
    RUNTIME_RELEASE_STATUS: policy.release.releaseStatus,
    RUNTIME_PROVIDER_GATE_STATUS: policy.providerGate.status,
    RUNTIME_PROVIDER_GATE_VALUE:
      policy.providerGate.status === 'closed'
        ? policy.providerGate.reason
        : policy.providerGate.receiptSha256,
    RUNTIME_POLICY_ID: policy.policyId,
  };
}

async function replaceRegionalRuntimeEnv(
  stub: DurableObjectStub<RegionalFeedHub>,
  nextEnv: WorkerEnv,
): Promise<void> {
  await runInDurableObject(stub, (instance) => {
    (instance as unknown as { env: WorkerEnv }).env = nextEnv;
  });
}

function regionalRequest(pathname: '/health' | '/snapshot'): Request {
  return new Request(`https://regional-feed.internal${pathname}`, {
    headers: { 'x-region-id': 'atlanta' },
  });
}

function providerResponse(overrides: Record<string, unknown> = {}): Response {
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
        ...overrides,
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
  expect(response.webSocket).toBeDefined();
  return response.webSocket!;
}

beforeEach(() => {
  resetRequestAdmissionForTests();
  unexpectedEgress = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      unexpectedEgress += 1;
      throw new Error('Unexpected outbound request in the controlled Worker suite.');
    }),
  );
});

afterEach(async () => {
  try {
    await reset();
    expect(unexpectedEgress).toBe(0);
  } finally {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});

describe('edge API', () => {
  it('applies the checked security policy to API, preflight, and WebSocket responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => providerResponse()),
    );
    const websocketResponse = await worker.fetch(
      new Request('https://workbench.test/api/v1/airspace/atlanta/stream', {
        headers: { origin: 'https://workbench.test', upgrade: 'websocket' },
      }),
      workerEnv,
    );
    websocketResponse.webSocket?.accept();
    const responses = [
      await worker.fetch(
        new Request('https://workbench.test/api/v1/regions?unsupported=true'),
        workerEnv,
      ),
      await worker.fetch(
        new Request('https://workbench.test/api/v1/regions', {
          method: 'OPTIONS',
          headers: { origin: 'https://workbench.test' },
        }),
        workerEnv,
      ),
      websocketResponse,
    ];
    for (const response of responses) {
      expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
      expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      expect(response.headers.get('x-frame-options')).toBe('DENY');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      expect(response.headers.get('permissions-policy')).toContain('geolocation=()');
      expect(response.headers.get('cross-origin-opener-policy')).toBe('same-origin');
      expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin');
      expect(response.headers.has('strict-transport-security')).toBe(false);
    }
    responses[2]?.webSocket?.close(1000, 'Test complete.');
  });

  it.each(['snapshot', 'stream'])(
    'does not dispatch a disabled %s request to the regional coordinator',
    async (action) => {
      const response = await worker.fetch(
        new Request(`https://workbench.test/api/v1/airspace/atlanta/${action}`, {
          headers: { origin: 'https://workbench.test', upgrade: 'websocket' },
        }),
        await disabledWorkerEnv(),
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        error: 'LIVE_DISABLED',
        source: { mode: 'disabled' },
      });
      expect(unexpectedEgress).toBe(0);
    },
  );

  it('rejects browser source-selection queries and ignores source-selection headers', async () => {
    const queried = await worker.fetch(
      new Request('https://workbench.test/api/v1/regions?provider=mock'),
      workerEnv,
    );
    expect(queried.status).toBe(400);
    const response = await worker.fetch(
      new Request('https://workbench.test/api/v1/regions', {
        headers: { 'x-provider-mode': 'mock', 'x-provider-url': 'https://unexpected.invalid' },
      }),
      workerEnv,
    );
    expect(await response.json()).toMatchObject({
      source: { mode: 'live', providerId: 'adsb-lol', synthetic: false },
    });
  });

  it('fails closed before dispatch when production contains a mock binding', async () => {
    const response = await worker.fetch(new Request('https://workbench.test/api/v1/regions'), {
      ...workerEnv,
      LIVE_BUILD_TARGET: 'production',
      MOCK_PROVIDER: workerEnv.ASSETS,
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: 'SOURCE_CONFIGURATION_ERROR' });
  });

  it('minimizes static asset faults and applies the runtime security headers', async () => {
    const privateMessage = 'Controlled private asset storage failure.';
    const fakeEnv = {
      ...workerEnv,
      ASSETS: {
        fetch: vi.fn(async () => {
          throw new Error(privateMessage);
        }),
      } as unknown as WorkerEnv['ASSETS'],
    };
    const response = await worker.fetch(new Request('https://workbench.test/'), fakeEnv);
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({
      error: 'INTERNAL_ERROR',
      message: 'The Live Airspace service is temporarily unavailable.',
    });
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(response.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(body).not.toContain(privateMessage);
  });

  it('routes static assets through the compiled policy and overwrites forged security headers', async () => {
    const assetFetch = vi.fn(
      async () =>
        new Response('compiled client asset', {
          headers: {
            'cache-control': 'public, max-age=3600',
            'content-type': 'application/javascript; charset=utf-8',
            'content-security-policy': 'default-src *',
            'x-frame-options': 'SAMEORIGIN',
          },
        }),
    );
    const response = await worker.fetch(new Request('https://workbench.test/assets/client.js'), {
      ...workerEnv,
      ASSETS: { fetch: assetFetch } as unknown as WorkerEnv['ASSETS'],
    });

    expect(assetFetch).toHaveBeenCalledOnce();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('compiled client asset');
    expect(response.headers.get('cache-control')).toBe('public, max-age=3600');
    expect(response.headers.get('content-type')).toBe('application/javascript; charset=utf-8');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(response.headers.get('content-security-policy')).not.toContain('default-src *');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('cross-origin-opener-policy')).toBe('same-origin');
  });

  it('rebinds delegated regional responses to the compiled Worker security headers', async () => {
    const regionalFetch = vi.fn(
      async () =>
        new Response('regional payload', {
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'content-security-policy': 'default-src *',
            'x-frame-options': 'SAMEORIGIN',
          },
        }),
    );
    const response = await worker.fetch(
      new Request('https://workbench.test/api/v1/airspace/atlanta/snapshot'),
      {
        ...workerEnv,
        REGION_FEEDS: {
          idFromName: vi.fn((name: string) => name),
          get: vi.fn(() => ({ fetch: regionalFetch })),
        } as unknown as WorkerEnv['REGION_FEEDS'],
      },
    );

    expect(regionalFetch).toHaveBeenCalledOnce();
    expect(await response.text()).toBe('regional payload');
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(response.headers.get('content-security-policy')).not.toContain('default-src *');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
  });

  it.each([
    [
      'query',
      new Request('https://workbench.test/index.html?source=unexpected'),
      'STATIC_QUERY_NOT_SUPPORTED',
    ],
    [
      'method',
      new Request('https://workbench.test/index.html', { method: 'POST' }),
      'STATIC_METHOD_NOT_ALLOWED',
    ],
    [
      'body',
      new Request('https://workbench.test/index.html', { headers: { 'content-length': '1' } }),
      'STATIC_REQUEST_BODY_NOT_SUPPORTED',
    ],
    [
      'upgrade',
      new Request('https://workbench.test/index.html', { headers: { upgrade: 'websocket' } }),
      'STATIC_UPGRADE_NOT_SUPPORTED',
    ],
  ])('rejects a static %s before asset delegation', async (_label, request, code) => {
    const assetFetch = vi.fn(async () => new Response('unexpected asset dispatch'));
    const response = await worker.fetch(request, {
      ...workerEnv,
      ASSETS: { fetch: assetFetch } as unknown as WorkerEnv['ASSETS'],
    });

    expect(response.status).toBe(code === 'STATIC_METHOD_NOT_ALLOWED' ? 405 : 400);
    expect(await response.json()).toMatchObject({ error: code });
    if (code === 'STATIC_METHOD_NOT_ALLOWED') {
      expect(response.headers.get('allow')).toBe('GET, HEAD');
    }
    expect(assetFetch).not.toHaveBeenCalled();
  });

  it('keeps unknown reserved API routes out of the static asset binding', async () => {
    const assetFetch = vi.fn(async () => new Response('unexpected static fallback'));
    const fakeEnv = {
      ...workerEnv,
      ASSETS: { fetch: assetFetch } as unknown as WorkerEnv['ASSETS'],
    };
    for (const pathname of [
      '/api',
      '/api/v1/not-real',
      '/api/v1/airspace/ATLANTA/snapshot',
      '/a%70i/v1/not-real',
      '/api%2fv1/not-real',
      '/api%252fv1/not-real',
      '/api%25252525252fv1/not-real',
      '/api%5cv1/not-real',
      '//api/v1/not-real',
      '/%2Fapi/v1/not-real',
      '/map%2dassets/unlisted',
      '//map-assets/unlisted',
      '/%2Fmap-assets/unlisted',
    ]) {
      const response = await worker.fetch(
        new Request(`https://workbench.test${pathname}`),
        fakeEnv,
      );
      expect(response.status, pathname).toBe(404);
      expect(await response.json(), pathname).toMatchObject({ error: 'NOT_FOUND' });
    }
    expect(assetFetch).not.toHaveBeenCalled();
  });

  it.each([
    [
      'GET body',
      new Request('https://workbench.test/api/v1/regions', {
        headers: { 'content-length': '1' },
      }),
      'REQUEST_BODY_NOT_SUPPORTED',
    ],
    [
      'GET upgrade',
      new Request('https://workbench.test/api/v1/regions', {
        headers: { upgrade: 'websocket' },
      }),
      'UPGRADE_NOT_SUPPORTED',
    ],
    [
      'OPTIONS body',
      new Request('https://workbench.test/api/v1/regions', {
        method: 'OPTIONS',
        headers: { origin: 'https://workbench.test', 'content-length': '1' },
      }),
      'REQUEST_BODY_NOT_SUPPORTED',
    ],
    [
      'OPTIONS upgrade',
      new Request('https://workbench.test/api/v1/airspace/atlanta/stream', {
        method: 'OPTIONS',
        headers: { origin: 'https://workbench.test', upgrade: 'websocket' },
      }),
      'UPGRADE_NOT_SUPPORTED',
    ],
  ])('rejects an API %s from the compiled request contract', async (_label, request, code) => {
    const response = await worker.fetch(request, workerEnv);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: code });
  });

  it('preserves empty requests that explicitly declare a zero content length', async () => {
    const response = await worker.fetch(
      new Request('https://workbench.test/api/v1/regions', {
        headers: { 'content-length': '0' },
      }),
      workerEnv,
    );
    expect(response.status).toBe(200);
  });

  it('runs the guarded provider inside the actual Worker request implementation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => providerResponse()),
    );
    const snapshot = await configuredProvider(workerEnv)!.fetchRegion(REGION_CONFIGS[0]);
    expect(snapshot.aircraft).toHaveLength(1);
  });

  it('rejects upstream redirects without following their destination', async () => {
    const fetchMock = vi.fn(async (request: Request) => {
      expect(request.redirect).toBe('manual');
      return new Response(null, {
        status: 302,
        headers: { location: 'https://unexpected.invalid/' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      configuredProvider(workerEnv)!.fetchRegion(REGION_CONFIGS[0]),
    ).rejects.toMatchObject({ code: 'UPSTREAM_HTTP_ERROR', status: 302 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it('publishes only the fixed Atlanta preset for the real-source pilot', async () => {
    const response = await worker.fetch(
      new Request('https://workbench.test/api/v1/regions'),
      workerEnv,
    );
    const body = (await response.json()) as { regions: Array<{ id: string }> };

    expect(response.status).toBe(200);
    expect(body.regions.map(({ id }) => id)).toEqual(['atlanta']);
  });

  it('assembles one release-bound operations projection without provider work', async () => {
    const response = await worker.fetch(
      new Request('https://workbench.test/api/v1/operations'),
      workerEnv,
    );
    const projection = parseOperationsProjection(await response.json());
    expect(response.status).toBe(200);
    expect(projection.identity).toMatchObject({
      applicationVersion: workerEnv.APP_VERSION,
      releaseSha: workerEnv.RELEASE_SHA,
      policyId: workerEnv.RUNTIME_POLICY_ID,
      source: { target: 'live-staging', mode: 'live', providerId: 'adsb-lol' },
    });
    expect(projection.regions.map(({ regionId }) => regionId)).toEqual([
      'atlanta',
      'savannah-statesboro',
      'central-georgia',
    ]);
    expect(projection.application).toEqual({
      state: 'partial',
      reasonCodes: ['APPLICATION_PARTIAL_REGIONS'],
    });
    expect(projection.regions[0]?.availability.state).toBe('available');
    expect(
      projection.regions.slice(1).every(({ availability }) => availability.state === 'unavailable'),
    ).toBe(true);
    expect(projection.admission.scope).toBe('worker-isolate');
    expect(projection.limitations.globalAvailabilityProof).toBe('not-provided');
    expect(unexpectedEgress).toBe(0);
  });

  it('does not dispatch operations reads for future real-source presets', async () => {
    const realNamespace = workerEnv.REGION_FEEDS;
    const get = vi.fn((name: string) => realNamespace.getByName(name));
    const fakeEnv = {
      ...workerEnv,
      REGION_FEEDS: {
        idFromName: vi.fn((name: string) => name),
        get,
      } as unknown as WorkerEnv['REGION_FEEDS'],
    };
    const response = await worker.fetch(
      new Request('https://workbench.test/api/v1/operations'),
      fakeEnv,
    );
    const projection = parseOperationsProjection(await response.json());
    expect(response.status).toBe(200);
    expect(projection.application).toEqual({
      state: 'partial',
      reasonCodes: ['APPLICATION_PARTIAL_REGIONS'],
    });
    expect(projection.regions[0]?.availability.state).toBe('available');
    expect(projection.regions.slice(1)).toEqual([
      expect.objectContaining({
        regionId: 'savannah-statesboro',
        availability: { state: 'unavailable', reasonCodes: ['REGION_READ_UNAVAILABLE'] },
        windows: null,
      }),
      expect.objectContaining({
        regionId: 'central-georgia',
        availability: { state: 'unavailable', reasonCodes: ['REGION_READ_UNAVAILABLE'] },
        windows: null,
      }),
    ]);
    expect(get).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledWith('atlanta');
    expect(unexpectedEgress).toBe(0);
  });

  it('reports application unavailability when the active Atlanta operations read fails', async () => {
    const failedRead = vi.fn(() => Promise.reject(new Error('Controlled regional read failure.')));
    const fakeEnv = {
      ...workerEnv,
      REGION_FEEDS: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn(() => ({ fetch: failedRead })),
      } as unknown as WorkerEnv['REGION_FEEDS'],
    };

    const response = await worker.fetch(
      new Request('https://workbench.test/api/v1/operations'),
      fakeEnv,
    );
    const projection = parseOperationsProjection(await response.json());

    expect(response.status).toBe(200);
    expect(projection.application).toEqual({
      state: 'unavailable',
      reasonCodes: ['APPLICATION_UNAVAILABLE'],
    });
    expect(
      projection.regions.every(({ availability }) => availability.state === 'unavailable'),
    ).toBe(true);
    expect(failedRead).toHaveBeenCalledOnce();
    expect(unexpectedEgress).toBe(0);
  });

  it('keeps the legacy health response and regional state unchanged by an operations read', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(providerNow);
    const captureRegionalState = async () =>
      Promise.all(
        REGION_CONFIGS.map(({ id }) =>
          runInDurableObject(workerEnv.REGION_FEEDS.getByName(id), async (_instance, state) => ({
            regionId: id,
            entries: Object.fromEntries(await state.storage.list()),
            alarm: await state.storage.getAlarm(),
            webSocketCount: state.getWebSockets().length,
          })),
        ),
      );

    const healthBeforeResponse = await worker.fetch(
      new Request('https://workbench.test/api/v1/health'),
      workerEnv,
    );
    const healthBefore = (await healthBeforeResponse.json()) as {
      checkedAt: string;
      source: Record<string, unknown>;
      regions: Array<Record<string, unknown>>;
    };
    const stateBefore = await captureRegionalState();

    const operationsResponse = await worker.fetch(
      new Request('https://workbench.test/api/v1/operations'),
      workerEnv,
    );
    const operations = parseOperationsProjection(await operationsResponse.json());
    const stateAfterOperations = await captureRegionalState();
    const healthAfterResponse = await worker.fetch(
      new Request('https://workbench.test/api/v1/health'),
      workerEnv,
    );
    const healthAfter = (await healthAfterResponse.json()) as typeof healthBefore;

    expect(healthBeforeResponse.status).toBe(200);
    expect(operationsResponse.status).toBe(200);
    expect(healthAfterResponse.status).toBe(200);
    expect(Object.keys(healthBefore).sort()).toEqual([
      'applicationVersion',
      'checkedAt',
      'policyEpoch',
      'policyId',
      'regions',
      'releaseSha',
      'source',
      'status',
    ]);
    expect(Object.keys(healthBefore.source).sort()).toEqual([
      'label',
      'mode',
      'providerId',
      'synthetic',
      'target',
    ]);
    expect(healthBefore.regions).toHaveLength(1);
    for (const region of healthBefore.regions) {
      expect(Object.keys(region).sort()).toEqual([
        'checkedAt',
        'consecutiveFailures',
        'feedEpoch',
        'message',
        'providerId',
        'regionId',
        'schemaVersion',
        'status',
      ]);
    }
    const { checkedAt: checkedBefore, ...stableHealthBefore } = healthBefore;
    const { checkedAt: checkedAfter, ...stableHealthAfter } = healthAfter;
    expect(Date.parse(checkedBefore)).not.toBeNaN();
    expect(Date.parse(checkedAfter)).not.toBeNaN();
    expect(stableHealthAfter).toEqual(stableHealthBefore);
    expect(stateAfterOperations).toEqual(stateBefore);
    expect(operations.regions[0]?.regionId).toBe(healthBefore.regions[0]?.regionId);
    expect(operations.regions[0]?.availability.state).toBe('available');
    expect(
      operations.regions.slice(1).every(({ availability }) => availability.state === 'unavailable'),
    ).toBe(true);
    expect(unexpectedEgress).toBe(0);
  });

  it('rejects arbitrary regions and unsupported methods', async () => {
    const unknown = await worker.fetch(
      new Request('https://workbench.test/api/v1/airspace/worldwide/snapshot'),
      workerEnv,
    );
    expect(unknown.status).toBe(404);
    const futurePreset = await worker.fetch(
      new Request('https://workbench.test/api/v1/airspace/central-georgia/snapshot'),
      workerEnv,
    );
    expect(futurePreset.status).toBe(404);
    expect(unexpectedEgress).toBe(0);

    const method = await worker.fetch(
      new Request('https://workbench.test/api/v1/regions', { method: 'POST' }),
      workerEnv,
    );
    expect(method.status).toBe(405);
    expect(method.headers.get('allow')).toBe('GET, OPTIONS');
  });

  it('rejects malformed stream upgrades before regional activation', async () => {
    const regionalFetch = vi.fn(async () => Response.json({ error: 'UNEXPECTED_REGIONAL_CALL' }));
    const fakeEnv = {
      ...workerEnv,
      REGION_FEEDS: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn(() => ({ fetch: regionalFetch })),
      } as unknown as WorkerEnv['REGION_FEEDS'],
    };
    const response = await worker.fetch(
      new Request('https://workbench.test/api/v1/airspace/atlanta/stream', {
        headers: { origin: 'https://workbench.test' },
      }),
      fakeEnv,
    );
    expect(response.status).toBe(426);
    expect(await response.json()).toMatchObject({ error: 'UPGRADE_REQUIRED' });
    expect(regionalFetch).not.toHaveBeenCalled();
  });

  it('rejects health over its exact burst without another regional dispatch', async () => {
    const regionalFetch = vi.fn(async (request: Request) =>
      Response.json({ regionId: request.headers.get('x-region-id'), status: 'offline' }),
    );
    const fakeEnv = {
      ...workerEnv,
      REGION_FEEDS: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn(() => ({ fetch: regionalFetch })),
      } as unknown as WorkerEnv['REGION_FEEDS'],
    };
    for (let index = 0; index < REQUEST_ADMISSION_POLICY.health.burst; index++) {
      expect(
        (await worker.fetch(new Request('https://workbench.test/api/v1/health'), fakeEnv)).status,
      ).toBe(200);
    }
    expect(regionalFetch).toHaveBeenCalledTimes(REQUEST_ADMISSION_POLICY.health.burst);
    const rejected = await worker.fetch(
      new Request('https://workbench.test/api/v1/health'),
      fakeEnv,
    );
    expect(rejected.status).toBe(429);
    expect(await rejected.json()).toMatchObject({
      error: 'HEALTH_ADMISSION_LIMIT',
      admission: { scope: 'worker-isolate' },
    });
    expect(regionalFetch).toHaveBeenCalledTimes(REQUEST_ADMISSION_POLICY.health.burst);
  });

  it('holds the health lease until the active failed regional branch settles', async () => {
    let releaseRegional!: () => void;
    const pending = new Promise<void>((resolve) => {
      releaseRegional = resolve;
    });
    let calls = 0;
    const regionalFetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        await pending;
        throw new Error('Controlled regional health failure.');
      }
      return Response.json({ status: 'offline' });
    });
    const fakeEnv = {
      ...workerEnv,
      REGION_FEEDS: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn(() => ({ fetch: regionalFetch })),
      } as unknown as WorkerEnv['REGION_FEEDS'],
    };
    const request = () => new Request('https://workbench.test/api/v1/health');
    const failed = worker.fetch(request(), fakeEnv);
    await vi.waitFor(() => expect(regionalFetch).toHaveBeenCalledOnce());
    const busy = await worker.fetch(request(), fakeEnv);
    expect(busy.status).toBe(503);
    expect(await busy.json()).toMatchObject({ error: 'HEALTH_BUSY' });
    expect(regionalFetch).toHaveBeenCalledOnce();
    releaseRegional();
    const failedResponse = await failed;
    expect(failedResponse.status).toBe(500);
    expect(await failedResponse.json()).toEqual({
      error: 'INTERNAL_ERROR',
      message: 'The Live Airspace service is temporarily unavailable.',
    });
    expect(failedResponse.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(failedResponse.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect((await worker.fetch(request(), fakeEnv)).status).toBe(200);
    expect(regionalFetch).toHaveBeenCalledTimes(2);
  });

  it('rejects snapshot waiter nine without another regional invocation', async () => {
    let now = 0;
    resetRequestAdmissionForTests(() => now);
    let releaseRegional!: () => void;
    const pending = new Promise<void>((resolve) => {
      releaseRegional = resolve;
    });
    const regionalFetch = vi.fn(async () => {
      await pending;
      return Response.json({ status: 'ok' });
    });
    const fakeEnv = {
      ...workerEnv,
      REGION_FEEDS: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn(() => ({ fetch: regionalFetch })),
      } as unknown as WorkerEnv['REGION_FEEDS'],
    };
    const url = 'https://workbench.test/api/v1/airspace/atlanta/snapshot';
    const admitted = Array.from({ length: REQUEST_ADMISSION_POLICY.snapshot.concurrency }, () =>
      worker.fetch(new Request(url), fakeEnv),
    );
    await vi.waitFor(() => expect(regionalFetch).toHaveBeenCalledTimes(admitted.length));
    now += 250;
    const rejected = await worker.fetch(new Request(url), fakeEnv);
    expect(rejected.status).toBe(503);
    expect(await rejected.json()).toMatchObject({ error: 'REGION_BUSY' });
    expect(regionalFetch).toHaveBeenCalledTimes(admitted.length);
    releaseRegional();
    expect((await Promise.all(admitted)).every((response) => response.status === 200)).toBe(true);
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
    const snapshot = (await response.json()) as AirspaceSnapshot;

    expect(response.status).toBe(200);
    expect(snapshot.schemaVersion).toBe('airspace.v1');
    expect(snapshot.aircraft).toEqual([expect.objectContaining({ aircraftId: 'a1b2c3' })]);
    expect(snapshot.aircraft[0]).toHaveProperty('onGround', null);
    expect(snapshot.aircraft[0]).toHaveProperty('verticalRateBasis', 'barometric');
    expect(
      parseLiveStreamMessage({
        type: 'airspace.snapshot',
        protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
        snapshot,
      }).ok,
    ).toBe(true);

    const stub = workerEnv.REGION_FEEDS.getByName('atlanta');
    const keys = await runInDurableObject(stub, async (_instance, state) =>
      [...(await state.storage.list()).keys()].sort(),
    );
    expect(keys).toContain('state:sequence');
    expect(keys.some((key) => key.startsWith('metrics:'))).toBe(true);
    expect(keys.some((key) => /a1b2c3|DAL123/.test(key))).toBe(false);
  });

  it('adds current HTTP timing metadata without rewriting cached observation or receipt times', async () => {
    const fetchMock = vi.fn(async () => providerResponse());
    vi.stubGlobal('fetch', fetchMock);
    const request = () => new Request('https://workbench.test/api/v1/airspace/atlanta/snapshot');
    const beforeFirst = Date.now();
    const first = await worker.fetch(request(), workerEnv);
    const firstSnapshot = await first.json();
    const firstTime = Date.parse(first.headers.get('x-airspace-server-time') ?? '');
    expect(firstTime).toBeGreaterThanOrEqual(beforeFirst);
    expect(firstTime).toBeLessThanOrEqual(Date.now());
    expect(first.headers.get('cache-control')).toBe('no-store');

    const beforeSecond = Date.now();
    const second = await worker.fetch(request(), workerEnv);
    expect(await second.json()).toEqual(firstSnapshot);
    const secondTime = Date.parse(second.headers.get('x-airspace-server-time') ?? '');
    expect(secondTime).toBeGreaterThanOrEqual(beforeSecond);
    expect(secondTime).toBeLessThanOrEqual(Date.now());
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('shares one persisted identity across HTTP, sockets and health, with independent region epochs', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => providerResponse()),
    );
    const response = await worker.fetch(
      new Request('https://workbench.test/api/v1/airspace/atlanta/snapshot'),
      workerEnv,
    );
    const snapshot = (await response.json()) as AirspaceSnapshot;
    const binding: LiveFeedBinding = {
      providerId: snapshot.providerId,
      regionId: snapshot.regionId,
      feedEpoch: snapshot.feedEpoch,
    };
    expect(binding).toMatchObject({ providerId: 'adsb-lol', regionId: 'atlanta' });
    expect(binding.feedEpoch).toMatch(/^[a-f0-9-]{36}$/);
    const healthResponse = await worker.fetch(
      new Request('https://workbench.test/api/v1/health'),
      workerEnv,
    );
    const health = (await healthResponse.json()) as { regions: LiveFeedHealth[] };
    expect(health.regions.find((region) => region.regionId === 'atlanta')).toMatchObject(binding);
    expect(new Set(health.regions.map((region) => region.feedEpoch)).size).toBe(1);
    const stub = workerEnv.REGION_FEEDS.getByName('atlanta');
    const persisted = await runInDurableObject(stub, async (_instance, state) =>
      Object.fromEntries(
        await state.storage.get(['state:providerId', 'state:feedEpoch', 'state:sequence']),
      ),
    );
    expect(persisted).toMatchObject({
      'state:providerId': binding.providerId,
      'state:feedEpoch': binding.feedEpoch,
      'state:sequence': snapshot.sequence,
    });
    for (let connection = 0; connection < 2; connection++) {
      const socket = await unacceptedSocket();
      const hello = nextFrame(socket, 'hello');
      const streamedSnapshot = nextSnapshot(socket);
      const streamedHealth = nextFrame(socket, 'feed.health');
      socket.accept();
      try {
        expect(await hello).toMatchObject(binding);
        expect(await streamedSnapshot).toMatchObject(binding);
        expect((await streamedHealth).health).toMatchObject(binding);
        const attachments = await runInDurableObject(stub, (_instance, state) =>
          state.getWebSockets().map((server) => server.deserializeAttachment()),
        );
        expect(attachments).toContainEqual(
          expect.objectContaining({
            ...binding,
            attachmentVersion: 'delivery.v1',
          }),
        );
      } finally {
        socket.close(1000, 'Test complete');
      }
    }
  });

  it('retains epoch and sequence after actual eviction and restores hibernating socket identity', async () => {
    const fetchMock = vi.fn(async () => providerResponse());
    vi.stubGlobal('fetch', fetchMock);
    const socket = await unacceptedSocket();
    const hello = nextFrame(socket, 'hello');
    const delivered = nextSnapshot(socket);
    const initialHealth = nextFrame(socket, 'feed.health');
    socket.accept();
    try {
      const identity = await hello;
      const before = await delivered;
      await initialHealth;
      const stub = workerEnv.REGION_FEEDS.getByName('atlanta');
      await deliveriesSettled(stub);
      await evictDurableObject(stub, { webSockets: 'hibernate' });
      const pollsBeforePing = fetchMock.mock.calls.length;
      const deliveredPong = nextFrame(socket, 'pong');
      socket.send(
        JSON.stringify({
          type: 'ping',
          protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
          requestId: 'after-eviction',
        }),
      );
      expect(await deliveredPong).toMatchObject({
        providerId: identity.providerId,
        regionId: identity.regionId,
        feedEpoch: identity.feedEpoch,
        requestId: 'after-eviction',
      });
      expect(fetchMock.mock.calls.length).toBe(pollsBeforePing);
      await deliveriesSettled(stub);
      const deadline = await runInDurableObject(stub, (_instance, state) =>
        state.storage.get<number>('state:nextPollAt'),
      );
      expect(deadline).toBeDefined();
      vi.spyOn(Date, 'now').mockReturnValue(deadline!);
      const streamed = nextSnapshot(socket);
      const response = await worker.fetch(
        new Request('https://workbench.test/api/v1/airspace/atlanta/snapshot'),
        workerEnv,
      );
      const after = (await response.json()) as AirspaceSnapshot;
      expect(after.feedEpoch).toBe(before.feedEpoch);
      expect(after.sequence).toBeGreaterThan(before.sequence);
      expect(await streamed).toEqual(after);
      const persisted = await runInDurableObject(stub, async (_instance, state) =>
        state.storage.get('state:feedEpoch'),
      );
      expect(persisted).toBe(before.feedEpoch);
    } finally {
      socket.close(1000, 'Test complete');
    }
    // The workerd eviction API allows up to 30 seconds for in-flight requests to drain.
  }, 40_000);

  it('closes a hibernated established session at the bounded policy check and can re-enable on a new policy epoch', async () => {
    const fetchMock = vi.fn(async () => providerResponse());
    vi.stubGlobal('fetch', fetchMock);
    const socket = await unacceptedSocket();
    const hello = nextFrame(socket, 'hello');
    const delivered = nextSnapshot(socket);
    const initialHealth = nextFrame(socket, 'feed.health');
    socket.accept();
    const stub = workerEnv.REGION_FEEDS.getByName('atlanta');
    try {
      await Promise.all([hello, delivered, initialHealth]);
      await deliveriesSettled(stub);
      const scheduledAt = await runInDurableObject(stub, (_instance, state) =>
        state.storage.getAlarm(),
      );
      expect(scheduledAt).not.toBeNull();
      expect(scheduledAt!).toBeLessThanOrEqual(Date.now() + RUNTIME_POLICY_CHECK_INTERVAL_MS);

      await evictDurableObject(stub, { webSockets: 'hibernate' });
      await replaceRegionalRuntimeEnv(stub, await disabledWorkerEnv());
      const closed = nextClose(socket);
      const pollsBeforeDisablement = fetchMock.mock.calls.length;
      expect(await runDurableObjectAlarm(stub)).toBe(true);
      expect(await closed).toMatchObject({
        code: RUNTIME_POLICY_DISABLED_CLOSE_CODE,
        reason: RUNTIME_POLICY_DISABLED_CLOSE_REASON,
      });
      expect(fetchMock).toHaveBeenCalledTimes(pollsBeforeDisablement);
      expect(
        await runInDurableObject(stub, async (_instance, state) => ({
          alarm: await state.storage.getAlarm(),
          nextPollAt: await state.storage.get<number>('state:nextPollAt'),
          nextRetryAt: await state.storage.get<number>('state:nextRetryAt'),
          circuitOpenUntil: await state.storage.get<number>('state:circuitOpenUntil'),
          retryBlocked: await state.storage.get<boolean>('state:retryBlocked'),
        })),
      ).toEqual({
        alarm: null,
        nextPollAt: 0,
        nextRetryAt: 0,
        circuitOpenUntil: 0,
        retryBlocked: false,
      });
      expect(await runDurableObjectAlarm(stub)).toBe(false);

      const health = await stub.fetch(regionalRequest('/health'));
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({
        status: 'offline',
        message: 'Live data is disabled by the server.',
      });
      const disabledSnapshot = await stub.fetch(regionalRequest('/snapshot'));
      expect(disabledSnapshot.status).toBe(503);
      expect(await disabledSnapshot.json()).toMatchObject({
        error: 'LIVE_DISABLED',
        health: { status: 'offline' },
      });
      expect(fetchMock).toHaveBeenCalledTimes(pollsBeforeDisablement);

      await replaceRegionalRuntimeEnv(stub, workerEnv);
      const reenabled = await stub.fetch(regionalRequest('/snapshot'));
      expect(reenabled.status).toBe(200);
      expect(await reenabled.json()).toMatchObject({
        providerId: 'adsb-lol',
        regionId: 'atlanta',
      });
      expect(fetchMock).toHaveBeenCalledTimes(pollsBeforeDisablement + 1);
    } finally {
      socket.close(1000, 'Test complete');
    }
  }, 40_000);

  it('preempts provider backoff with the policy-check alarm and never polls after disablement', async () => {
    const fetchMock = vi.fn(
      async () => new Response('', { status: 429, headers: { 'retry-after': '60' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const socket = await unacceptedSocket();
    const providerError = nextFrame(socket, 'error');
    socket.accept();
    const stub = workerEnv.REGION_FEEDS.getByName('atlanta');
    try {
      await providerError;
      await deliveriesSettled(stub);
      const pending = await runInDurableObject(stub, async (_instance, state) => ({
        alarm: await state.storage.getAlarm(),
        nextRetryAt: await state.storage.get<number>('state:nextRetryAt'),
      }));
      expect(pending.alarm).not.toBeNull();
      expect(pending.nextRetryAt).toBeDefined();
      expect(pending.alarm!).toBeLessThan(pending.nextRetryAt!);
      expect(pending.alarm!).toBeLessThanOrEqual(Date.now() + RUNTIME_POLICY_CHECK_INTERVAL_MS);

      await replaceRegionalRuntimeEnv(stub, await disabledWorkerEnv());
      const closed = nextClose(socket);
      expect(await runDurableObjectAlarm(stub)).toBe(true);
      expect(await closed).toMatchObject({
        code: RUNTIME_POLICY_DISABLED_CLOSE_CODE,
        reason: RUNTIME_POLICY_DISABLED_CLOSE_REASON,
      });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(
        await runInDurableObject(stub, async (_instance, state) => ({
          alarm: await state.storage.getAlarm(),
          nextPollAt: await state.storage.get<number>('state:nextPollAt'),
          nextRetryAt: await state.storage.get<number>('state:nextRetryAt'),
          circuitOpenUntil: await state.storage.get<number>('state:circuitOpenUntil'),
          retryBlocked: await state.storage.get<boolean>('state:retryBlocked'),
        })),
      ).toEqual({
        alarm: null,
        nextPollAt: 0,
        nextRetryAt: 0,
        circuitOpenUntil: 0,
        retryBlocked: false,
      });
      expect(await runDurableObjectAlarm(stub)).toBe(false);
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      socket.close(1000, 'Test complete');
    }
  });

  it('discards an in-flight provider response when policy becomes disabled before publication', async () => {
    const fetchMock = vi.fn(async () => providerResponse());
    vi.stubGlobal('fetch', fetchMock);
    const socket = await unacceptedSocket();
    const initialSnapshot = nextSnapshot(socket);
    socket.accept();
    const stub = workerEnv.REGION_FEEDS.getByName('atlanta');
    try {
      const before = await initialSnapshot;
      await deliveriesSettled(stub);
      const nextPollAt = await runInDurableObject(stub, (_instance, state) =>
        state.storage.get<number>('state:nextPollAt'),
      );
      expect(nextPollAt).toBeDefined();
      vi.spyOn(Date, 'now').mockReturnValue(nextPollAt!);
      const publishedFrames: string[] = [];
      socket.addEventListener('message', (event) => publishedFrames.push(String(event.data)));

      const disabledEnv = await disabledWorkerEnv();
      const providerFetch = vi.fn(async () => {
        return {
          providerId: 'adsb-lol',
          providerGeneratedAt: new Date(providerNow).toISOString(),
          receivedAt: new Date(nextPollAt).toISOString(),
          aircraft: [],
          validation: {
            receivedAircraft: 0,
            acceptedAircraft: 0,
            rejectedAircraft: 0,
            duplicateAircraft: 0,
            invalidFields: 0,
          },
        };
      });
      const closed = nextClose(socket);
      await runInDurableObject(stub, async (instance) => {
        const runtime = instance as unknown as {
          env: WorkerEnv;
          provider: {
            id: string;
            label: string;
            attributionUrl: string;
            fetchRegion: typeof providerFetch;
          };
        };
        runtime.provider = {
          id: 'adsb-lol',
          label: 'Controlled pending provider',
          attributionUrl: '',
          fetchRegion: vi.fn(async (...args) => {
            runtime.env = disabledEnv;
            return providerFetch(...args);
          }),
        };
        await instance.alarm();
      });
      expect(await closed).toMatchObject({
        code: RUNTIME_POLICY_DISABLED_CLOSE_CODE,
        reason: RUNTIME_POLICY_DISABLED_CLOSE_REASON,
      });
      expect(publishedFrames).toEqual([]);
      expect(providerFetch).toHaveBeenCalledOnce();
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(
        await runInDurableObject(stub, async (_instance, state) => ({
          sequence: await state.storage.get<number>('state:sequence'),
          nextPollAt: await state.storage.get<number>('state:nextPollAt'),
          alarm: await state.storage.getAlarm(),
        })),
      ).toEqual({ sequence: before.sequence, nextPollAt: 0, alarm: null });
      const snapshot = await stub.fetch(regionalRequest('/snapshot'));
      expect(snapshot.status).toBe(503);
      expect(await snapshot.json()).toMatchObject({ error: 'LIVE_DISABLED' });
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      socket.close(1000, 'Test complete');
    }
  });

  it.each([
    { change: null, trigger: 'ping' },
    { change: { feedEpoch: 'obsolete-feed' }, trigger: 'ping' },
    { change: { providerId: 'another-provider' }, trigger: 'ping' },
    { change: { regionId: 'central-georgia' }, trigger: 'ping' },
    { change: { feedEpoch: 'obsolete-feed' }, trigger: 'broadcast' },
  ])('closes a socket with a missing or obsolete attachment: %j', async ({ change, trigger }) => {
    const fetchMock = vi.fn(async () => providerResponse());
    vi.stubGlobal('fetch', fetchMock);
    const socket = await unacceptedSocket();
    const hello = nextFrame(socket, 'hello');
    const delivered = nextSnapshot(socket);
    const initialHealth = nextFrame(socket, 'feed.health');
    socket.accept();
    try {
      await Promise.all([hello, delivered, initialHealth]);
      const stub = workerEnv.REGION_FEEDS.getByName('atlanta');
      // The reader acknowledges the initial delivery asynchronously. Settle it
      // before corrupting the binding so that this case is triggered only by
      // the declared ping or broadcast, not by a racing valid acknowledgment.
      await deliveriesSettled(stub);
      await runInDurableObject(stub, (_instance, state) => {
        const server = state.getWebSockets()[0]!;
        const binding = server.deserializeAttachment() as LiveFeedBinding;
        server.serializeAttachment(change ? { ...binding, ...change } : null);
      });
      const frames: string[] = [];
      socket.addEventListener('message', (event) => frames.push(String(event.data)));
      const closed = new Promise<CloseEvent>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Expected identity close.')), 2_000);
        socket.addEventListener(
          'close',
          (event) => {
            clearTimeout(timer);
            resolve(event);
          },
          { once: true },
        );
      });
      const pollsBeforePing = fetchMock.mock.calls.length;
      if (trigger === 'broadcast') {
        const deadline = await runInDurableObject(stub, (_instance, state) =>
          state.storage.get<number>('state:nextPollAt'),
        );
        expect(deadline).toBeDefined();
        vi.spyOn(Date, 'now').mockReturnValue(deadline!);
        expect(await runDurableObjectAlarm(stub)).toBe(true);
      } else
        socket.send(
          JSON.stringify({
            type: 'ping',
            protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
            requestId: 'invalid-attachment',
          }),
        );
      expect((await closed).code).toBe(1012);
      expect(frames).toEqual([]);
      expect(fetchMock.mock.calls.length).toBe(pollsBeforePing);
    } finally {
      socket.close(1000, 'Test complete');
    }
  });

  it('returns a validated timestamped pong over an actual socket without polling again', async () => {
    const fetchMock = vi.fn(async () => providerResponse());
    vi.stubGlobal('fetch', fetchMock);
    const socket = await unacceptedSocket();
    const hello = nextFrame(socket, 'hello');
    socket.accept();
    try {
      expect((await hello).regionId).toBe('atlanta');
      const delivered = nextFrame(socket, 'pong');
      const sentAt = Date.now();
      socket.send(
        JSON.stringify({
          type: 'ping',
          protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
          requestId: 'timing-1',
        }),
      );
      const pong = await delivered;
      expect(pong.requestId).toBe('timing-1');
      expect(Date.parse(pong.generatedAt)).toBeGreaterThanOrEqual(sentAt);
      expect(Date.parse(pong.generatedAt)).toBeLessThanOrEqual(Date.now());
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      socket.close(1000, 'timing test complete');
    }
  });

  it.each([
    'ping',
    JSON.stringify({
      type: 'ping',
      protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
      requestId: 'invalid request',
    }),
    'x'.repeat(513),
  ])('closes invalid keepalives with a bounded, non-echoed reason', async (payload) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => providerResponse()),
    );
    const socket = await unacceptedSocket();
    const hello = nextFrame(socket, 'hello');
    socket.accept();
    try {
      await hello;
      const delivered = nextClose(socket);
      socket.send(payload);
      const closed = await delivered;
      expect(closed).toMatchObject({
        code: 1008,
        reason: 'Invalid or excessive live control messages.',
      });
      expect(closed.reason.length).toBeLessThan(123);
    } finally {
      socket.close(1000, 'invalid keepalive test complete');
    }
  });

  it.each([
    { fields: { alt_baro: 'ground' }, ground: true, rate: 500, basis: 'barometric' },
    { fields: { alt_baro: 0 }, ground: null, rate: 500, basis: 'barometric' },
    { fields: { alt_baro: undefined }, ground: null, rate: 500, basis: 'barometric' },
    { fields: { alt_baro: null }, ground: null, rate: 500, basis: 'barometric' },
    { fields: { alt_baro: 'invalid' }, ground: null, rate: 500, basis: 'barometric' },
    { fields: { baro_rate: 0, geom_rate: 300 }, ground: null, rate: 0, basis: 'barometric' },
    { fields: { baro_rate: undefined, geom_rate: 0 }, ground: null, rate: 0, basis: 'geometric' },
    { fields: { baro_rate: null, geom_rate: 300 }, ground: null, rate: 300, basis: 'geometric' },
    { fields: { baro_rate: 'invalid', geom_rate: 0 }, ground: null, rate: 0, basis: 'geometric' },
    { fields: { baro_rate: undefined }, ground: null, rate: undefined, basis: undefined },
  ])(
    'preserves nullable/paired fields through the actual REST pipeline: $fields',
    async ({ fields, ground, rate, basis }) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => providerResponse(fields)),
      );
      const response = await worker.fetch(
        new Request('https://workbench.test/api/v1/airspace/atlanta/snapshot'),
        workerEnv,
      );
      expect(response.status).toBe(200);
      const snapshot = (await response.json()) as AirspaceSnapshot;
      expect(
        parseLiveStreamMessage({
          type: 'airspace.snapshot',
          protocolVersion: LIVE_STREAM_PROTOCOL_VERSION,
          snapshot,
        }).ok,
      ).toBe(true);
      expect(snapshot.aircraft[0]).toHaveProperty('onGround', ground);
      if (rate === undefined) {
        expect(snapshot.aircraft[0]).not.toHaveProperty('verticalRateFeetPerMinute');
        expect(snapshot.aircraft[0]).not.toHaveProperty('verticalRateBasis');
      } else {
        expect(snapshot.aircraft[0]).toHaveProperty('verticalRateFeetPerMinute', rate);
        expect(snapshot.aircraft[0]).toHaveProperty('verticalRateBasis', basis);
      }
    },
  );

  it('reports health without starting an upstream poll', async () => {
    const fetchMock = vi.fn(async () => providerResponse());
    vi.stubGlobal('fetch', fetchMock);

    const response = await worker.fetch(
      new Request('https://workbench.test/api/v1/health'),
      workerEnv,
    );
    const body = (await response.json()) as { regions: Array<{ status: string }> };

    expect(response.status).toBe(200);
    expect(body.regions).toHaveLength(1);
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
    let releaseProvider: (() => void) | undefined;
    const providerPending = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const fetchMock = vi.fn(async () => {
      await providerPending;
      return providerResponse({ baro_rate: 0, geom_rate: 300 });
    });
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
      const initialHealth = nextFrame(response.webSocket!, 'feed.health');
      response.webSocket?.accept();
      await initialHealth;
      return response.webSocket as WebSocket;
    };

    const first = await connect();
    const second = await connect();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    try {
      const delivered = Promise.all([nextSnapshot(first), nextSnapshot(second)]);
      releaseProvider?.();
      const [firstSnapshot, secondSnapshot] = await delivered;
      expect(secondSnapshot).toEqual(firstSnapshot);
      expect(firstSnapshot.aircraft[0]).toMatchObject({
        onGround: null,
        verticalRateFeetPerMinute: 0,
        verticalRateBasis: 'barometric',
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      first.close(1000, 'test complete');
      second.close(1000, 'test complete');
    }
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
    const fetchMock = vi.fn(async () => providerResponse());
    vi.stubGlobal('fetch', fetchMock);
    const response = await worker.fetch(
      new Request('https://workbench.test/api/v1/airspace/atlanta/snapshot'),
      workerEnv,
    );
    const snapshot = (await response.json()) as AirspaceSnapshot;

    const stub = workerEnv.REGION_FEEDS.getByName('atlanta');
    expect(await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm())).toBe(
      feedMetricExpiryAt(Date.parse(snapshot.generatedAt)),
    );
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
