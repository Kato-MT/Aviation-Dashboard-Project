import { REGION_CONFIGS, getRegionConfig } from '../src/live/regions';
import type { RegionConfig } from '../src/live/types';
import type { WorkerEnv } from './env';
import { RegionalFeedHub } from './regionalFeedHub';

export { RegionalFeedHub };

const API_PREFIX = '/api/v1';

function apiResponse(value: unknown, status = 200, extraHeaders: HeadersInit = {}): Response {
  return Response.json(value, {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
      'x-content-type-options': 'nosniff',
      ...Object.fromEntries(new Headers(extraHeaders)),
    },
  });
}

function regionalStub(env: WorkerEnv, region: RegionConfig): DurableObjectStub<RegionalFeedHub> {
  return env.REGION_FEEDS.get(env.REGION_FEEDS.idFromName(region.id));
}

function allowedOrigin(request: Request, env: WorkerEnv): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  if (origin === new URL(request.url).origin) return true;
  return env.ALLOWED_ORIGINS.split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .includes(origin);
}

function internalRequest(request: Request, pathname: string, regionId: string): Request {
  const headers = new Headers(request.headers);
  headers.set('x-region-id', regionId);
  return new Request(`https://regional-feed.internal${pathname}`, {
    method: request.method,
    headers,
    body: request.body,
  });
}

async function regionHealth(env: WorkerEnv, region: RegionConfig): Promise<unknown> {
  const response = await regionalStub(env, region).fetch(
    new Request('https://regional-feed.internal/health', {
      headers: { 'x-region-id': region.id },
    }),
  );
  return response.json();
}

async function handleApi(request: Request, env: WorkerEnv): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== 'GET' && request.method !== 'OPTIONS') {
    return apiResponse({ error: 'METHOD_NOT_ALLOWED', message: 'Only GET is supported.' }, 405, {
      allow: 'GET, OPTIONS',
    });
  }
  if (request.method === 'OPTIONS') {
    if (!allowedOrigin(request, env)) {
      return apiResponse({ error: 'ORIGIN_NOT_ALLOWED' }, 403);
    }
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': request.headers.get('origin') ?? '',
        'access-control-allow-methods': 'GET, OPTIONS',
        'access-control-allow-headers': 'content-type',
        'access-control-max-age': '600',
      },
    });
  }

  if (url.pathname === `${API_PREFIX}/regions`) {
    return apiResponse({ schemaVersion: 'airspace.v1', regions: REGION_CONFIGS });
  }
  if (url.pathname === `${API_PREFIX}/health`) {
    const regions = await Promise.all(REGION_CONFIGS.map((region) => regionHealth(env, region)));
    return apiResponse({
      status: 'ok',
      applicationVersion: env.APP_VERSION,
      releaseSha: env.RELEASE_SHA,
      checkedAt: new Date().toISOString(),
      regions,
    });
  }

  const match = url.pathname.match(/^\/api\/v1\/airspace\/([a-z0-9-]+)\/(snapshot|stream)$/);
  if (!match) return apiResponse({ error: 'NOT_FOUND', message: 'Unknown API route.' }, 404);
  const regionId = match[1] ?? '';
  const action = match[2] ?? '';
  const region = getRegionConfig(regionId);
  if (!region) {
    return apiResponse({ error: 'REGION_NOT_FOUND', message: 'Unknown region preset.' }, 404);
  }
  if (action === 'stream' && !allowedOrigin(request, env)) {
    return apiResponse(
      { error: 'ORIGIN_NOT_ALLOWED', message: 'Stream origin is not allowed.' },
      403,
    );
  }
  return regionalStub(env, region).fetch(internalRequest(request, `/${action}`, region.id));
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return handleApi(request, env);
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<WorkerEnv>;
