import { REGION_CONFIGS, getRegionConfig } from '../src/live/regions';
import {
  evaluateRuntimePolicyRequest,
  resolveRuntimePolicyRoute,
  type RuntimePolicyRequestViolation,
  type RuntimePolicyHeaderValues,
  type RuntimePolicyRoute,
  type RuntimePolicyV1,
} from '../src/live/runtimePolicy';
import type { RegionConfig } from '../src/live/types';
import {
  OPERATIONS_LIMITATIONS,
  OPERATIONS_SCHEMA_VERSION,
  parseOperationsProjection,
  parseRegionOperations,
  type RegionOperations,
} from '../src/operations/contract';
import {
  classifyApplicationOperations,
  classifyRegionOperations,
} from '../src/operations/classifier';
import type { WorkerEnv } from './env';
import { OPERATIONS_CHECKED_AT_HEADER, RegionalFeedHub } from './regionalFeedHub';
import { handleMapAsset } from './mapAssets';
import { requestAdmission, type AdmissionDecision, type WorkerRequestAdmission } from './admission';
import { responseHeaders } from './responsePolicy';
import { runtimePolicyForWorkerEnv } from './runtimePolicy';

export { RegionalFeedHub };

function apiResponse(
  value: unknown,
  status = 200,
  extraHeaders: HeadersInit = {},
  policy?: Readonly<RuntimePolicyV1>,
): Response {
  return Response.json(value, {
    status,
    headers: responseHeaders(
      {
        'cache-control': 'no-store',
        'content-type': 'application/json; charset=utf-8',
        ...Object.fromEntries(new Headers(extraHeaders)),
      },
      policy?.headers.worker,
    ),
  });
}

function admissionResponse(
  decision: Exclude<AdmissionDecision, { ok: true }>,
  policy: Readonly<RuntimePolicyV1>,
): Response {
  return apiResponse(
    {
      error: decision.code,
      message: 'This bounded Live Airspace request pool is temporarily full.',
      admission: {
        scope: decision.scope,
        retryAfterSeconds: decision.retryAfterSeconds,
      },
    },
    decision.status,
    { 'retry-after': String(decision.retryAfterSeconds) },
    policy,
  );
}

function regionalStub(env: WorkerEnv, region: RegionConfig): DurableObjectStub<RegionalFeedHub> {
  return env.REGION_FEEDS.get(env.REGION_FEEDS.idFromName(region.id));
}

function allowedOrigin(request: Request, policy: Readonly<RuntimePolicyV1>): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  if (origin === new URL(request.url).origin) return true;
  return policy.origins.allowed.includes(origin);
}

function internalRequest(request: Request, pathname: string, regionId: string): Request {
  const headers = new Headers(request.headers);
  headers.set('x-region-id', regionId);
  return new Request(`https://regional-feed.internal${pathname}`, {
    method: request.method,
    headers,
    signal: request.signal,
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

async function regionOperations(
  request: Request,
  env: WorkerEnv,
  region: (typeof REGION_CONFIGS)[number],
  checkedAt: string,
): Promise<Readonly<RegionOperations>> {
  const internal = internalRequest(request, '/operations', region.id);
  internal.headers.set(OPERATIONS_CHECKED_AT_HEADER, checkedAt);
  const response = await regionalStub(env, region).fetch(internal);
  if (!response.ok) throw new Error('The regional operations read failed.');
  return parseRegionOperations(await response.json(), region.id, checkedAt);
}

async function applicationOperations(
  request: Request,
  env: WorkerEnv,
  admission: WorkerRequestAdmission,
  policy: Readonly<RuntimePolicyV1>,
): Promise<Response> {
  const decision = admission.admitHealth();
  if (!decision.ok) return admissionResponse(decision, policy);
  const checkedAt = new Date().toISOString();
  try {
    const settled = await Promise.allSettled(
      REGION_CONFIGS.map((region) => regionOperations(request, env, region, checkedAt)),
    );
    const regions = settled.map((result, index) => {
      if (result.status === 'fulfilled') return result.value;
      return Object.freeze({
        ...classifyRegionOperations(
          { regionId: REGION_CONFIGS[index]!.id, readAvailable: false },
          checkedAt,
        ),
        windows: null,
      });
    }) as [RegionOperations, RegionOperations, RegionOperations];
    const projection = parseOperationsProjection({
      schemaVersion: OPERATIONS_SCHEMA_VERSION,
      identity: {
        applicationVersion: policy.release.applicationVersion,
        releaseSha: policy.release.releaseSha,
        source: policy.source.descriptor,
        policyId: policy.policyId,
      },
      checkedAt,
      application: classifyApplicationOperations(regions),
      admission: admission.operationsSnapshot(checkedAt),
      limitations: OPERATIONS_LIMITATIONS,
      regions,
    });
    return apiResponse(projection, 200, {}, policy);
  } finally {
    decision.lease.release();
  }
}

function requestHasBody(request: Request): boolean {
  const contentLength = request.headers.get('content-length');
  return (
    request.body !== null ||
    (contentLength !== null && contentLength !== '0') ||
    request.headers.has('transfer-encoding')
  );
}

function requestPolicyFailure(
  route: Readonly<RuntimePolicyRoute>,
  violation: RuntimePolicyRequestViolation,
  policy: Readonly<RuntimePolicyV1>,
): Response {
  const family = route.feature === 'maps' ? 'MAP' : route.feature === 'static' ? 'STATIC' : 'API';
  if (violation === 'method-forbidden') {
    return apiResponse(
      {
        error: family === 'API' ? 'METHOD_NOT_ALLOWED' : `${family}_METHOD_NOT_ALLOWED`,
        message: `Allowed methods: ${route.methods.join(', ')}.`,
      },
      405,
      { allow: route.methods.join(', ') },
      policy,
    );
  }
  if (violation === 'upgrade-required') {
    return apiResponse(
      { error: 'UPGRADE_REQUIRED', message: 'WebSocket upgrade required.' },
      426,
      {},
      policy,
    );
  }
  const suffix =
    violation === 'query-forbidden'
      ? 'QUERY_NOT_SUPPORTED'
      : violation === 'body-forbidden'
        ? 'REQUEST_BODY_NOT_SUPPORTED'
        : 'UPGRADE_NOT_SUPPORTED';
  return apiResponse({ error: family === 'API' ? suffix : `${family}_${suffix}` }, 400, {}, policy);
}

function disabledRouteResponse(
  route: Readonly<RuntimePolicyRoute>,
  policy: Readonly<RuntimePolicyV1>,
): Response {
  if (route.feature !== 'live-source') {
    return apiResponse({ error: 'ROUTE_DISABLED' }, 503, {}, policy);
  }
  return apiResponse(
    {
      error: 'LIVE_DISABLED',
      reason: policy.featureGates.live.reason,
      source: policy.source.descriptor,
      policyId: policy.policyId,
      policyEpoch: policy.policyEpoch,
      message: 'Live data is disabled by the server.',
    },
    503,
    {},
    policy,
  );
}

function responseWithPolicySecurityHeaders(
  response: Response,
  securityHeaders: Readonly<RuntimePolicyHeaderValues>,
): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(securityHeaders)) headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
    webSocket: response.webSocket,
  });
}

async function handleApi(
  request: Request,
  env: WorkerEnv,
  admission: WorkerRequestAdmission,
  policy: Readonly<RuntimePolicyV1>,
  route: Readonly<RuntimePolicyRoute>,
  regionId: string | undefined,
): Promise<Response> {
  const regionsRoute = route.id === 'api-regions';
  const healthRoute = route.id === 'api-health';
  const operationsRoute = route.id === 'api-operations';
  const action =
    route.id === 'api-snapshot' ? 'snapshot' : route.id === 'api-stream' ? 'stream' : undefined;
  const region =
    action === undefined || regionId === undefined ? undefined : getRegionConfig(regionId);
  if (action !== undefined && !region) {
    return apiResponse(
      { error: 'REGION_NOT_FOUND', message: 'Unknown region preset.' },
      404,
      {},
      policy,
    );
  }
  if (request.method === 'OPTIONS') {
    if (!allowedOrigin(request, policy)) {
      return apiResponse({ error: 'ORIGIN_NOT_ALLOWED' }, 403, {}, policy);
    }
    const decision = admission.admitPreflight();
    if (!decision.ok) return admissionResponse(decision, policy);
    return new Response(null, {
      status: 204,
      headers: responseHeaders(
        {
          'cache-control': 'no-store',
          'access-control-allow-origin': request.headers.get('origin') ?? '',
          'access-control-allow-methods': route.methods.join(', '),
          'access-control-allow-headers': 'content-type',
          'access-control-max-age': '600',
        },
        policy.headers.worker,
      ),
    });
  }

  if (operationsRoute) return applicationOperations(request, env, admission, policy);

  if (regionsRoute) {
    const decision = admission.admitRegionCatalog();
    if (!decision.ok) return admissionResponse(decision, policy);
    return apiResponse(
      {
        schemaVersion: 'airspace.v1',
        regions: REGION_CONFIGS,
        source: policy.source.descriptor,
        applicationVersion: policy.release.applicationVersion,
        releaseSha: policy.release.releaseSha,
        policyId: policy.policyId,
        policyEpoch: policy.policyEpoch,
      },
      200,
      {},
      policy,
    );
  }
  if (healthRoute) {
    const decision = admission.admitHealth();
    if (!decision.ok) return admissionResponse(decision, policy);
    try {
      const settledRegions = await Promise.allSettled(
        REGION_CONFIGS.map((item) => regionHealth(env, item)),
      );
      const failedRegion = settledRegions.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      if (failedRegion) throw failedRegion.reason;
      const regions = settledRegions.map(
        (result) => (result as PromiseFulfilledResult<unknown>).value,
      );
      return apiResponse(
        {
          status: 'ok',
          source: policy.source.descriptor,
          applicationVersion: policy.release.applicationVersion,
          releaseSha: policy.release.releaseSha,
          policyId: policy.policyId,
          policyEpoch: policy.policyEpoch,
          checkedAt: new Date().toISOString(),
          regions,
        },
        200,
        {},
        policy,
      );
    } finally {
      decision.lease.release();
    }
  }

  if (action === undefined || regionId === undefined || region === undefined) {
    throw new Error(`Compiled runtime policy route ${route.id} has no API handler.`);
  }

  if (action === 'stream' && !allowedOrigin(request, policy)) {
    return apiResponse(
      { error: 'ORIGIN_NOT_ALLOWED', message: 'Stream origin is not allowed.' },
      403,
      {},
      policy,
    );
  }
  const decision =
    action === 'snapshot' ? admission.admitSnapshot(regionId) : admission.admitStream(regionId);
  if (!decision.ok) return admissionResponse(decision, policy);
  try {
    const response = await regionalStub(env, region).fetch(
      internalRequest(request, `/${action}`, region.id),
    );
    return responseWithPolicySecurityHeaders(response, policy.headers.worker);
  } finally {
    decision.lease.release();
  }
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    let policy: Readonly<RuntimePolicyV1>;
    try {
      policy = await runtimePolicyForWorkerEnv(env);
    } catch {
      return apiResponse(
        {
          error: 'SOURCE_CONFIGURATION_ERROR',
          message: 'The feed is disabled by its server configuration.',
        },
        503,
      );
    }
    try {
      const url = new URL(request.url);
      const resolution = resolveRuntimePolicyRoute(policy, url.pathname);
      const admission = requestAdmission();
      if (resolution.kind === 'reserved') {
        const decision = admission.admitTotalAttempt();
        if (!decision.ok) return admissionResponse(decision, policy);
        return apiResponse({ error: 'NOT_FOUND', message: 'Unknown API route.' }, 404, {}, policy);
      }
      if (resolution.kind === 'unmatched') {
        return apiResponse({ error: 'NOT_FOUND' }, 404, {}, policy);
      }
      const { route, parameters } = resolution;
      if (route.feature !== 'static') {
        const decision = admission.admitTotalAttempt();
        if (!decision.ok) return admissionResponse(decision, policy);
      }
      if (!route.enabled) return disabledRouteResponse(route, policy);
      const requestDecision = evaluateRuntimePolicyRequest(route, {
        method: request.method,
        hasQuery: url.search.length > 0,
        hasBody: requestHasBody(request),
        upgradeHeader: request.headers.has('upgrade') ? request.headers.get('upgrade') : null,
      });
      if (!requestDecision.ok) {
        return requestPolicyFailure(route, requestDecision.violation, policy);
      }
      if (route.id === 'map-assets') {
        return await handleMapAsset(request, env.MAP_ASSETS, admission, policy.headers.worker);
      }
      if (route.id === 'static-assets') {
        return responseWithPolicySecurityHeaders(
          await env.ASSETS.fetch(request),
          policy.headers.static,
        );
      }
      return await handleApi(request, env, admission, policy, route, parameters.regionId);
    } catch {
      return apiResponse(
        {
          error: 'INTERNAL_ERROR',
          message: 'The Live Airspace service is temporarily unavailable.',
        },
        500,
        {},
        policy,
      );
    }
  },
} satisfies ExportedHandler<WorkerEnv>;
