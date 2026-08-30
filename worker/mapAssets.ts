import { findMapAsset, MAP_ID, MAX_MAP_RANGE_BYTES, type MapAsset } from '../src/map/assets';
import { etagMatches, parseByteRange, type ByteRange } from '../src/map/ranges';
import { WorkerRequestAdmission, type AdmissionDecision } from './admission';
import { responseHeaders } from './responsePolicy';
import type { RuntimePolicyHeaderValues } from '../src/live/runtimePolicy';

const supportedConditionHeaders = new Set([
  'if-match',
  'if-none-match',
  'if-range',
  'if-modified-since',
  'if-unmodified-since',
]);

function failure(
  code: string,
  status: number,
  headers: HeadersInit | undefined,
  securityPolicy: Readonly<RuntimePolicyHeaderValues> | undefined,
) {
  return Response.json(
    { error: code },
    {
      status,
      headers: responseHeaders(
        {
          'cache-control': 'no-store',
          ...Object.fromEntries(new Headers(headers)),
        },
        securityPolicy,
      ),
    },
  );
}

function admissionFailure(
  decision: Exclude<AdmissionDecision, { ok: true }>,
  securityPolicy: Readonly<RuntimePolicyHeaderValues> | undefined,
): Response {
  return failure(
    decision.code,
    decision.status,
    {
      'retry-after': String(decision.retryAfterSeconds),
      'x-admission-scope': decision.scope,
    },
    securityPolicy,
  );
}

function matchesManifest(object: R2Object, asset: MapAsset): boolean {
  return object.size === asset.bytes && object.customMetadata?.sha256 === asset.sha256;
}

function identityHeaders(
  asset: MapAsset,
  securityPolicy: Readonly<RuntimePolicyHeaderValues> | undefined,
): Headers {
  return responseHeaders(
    {
      'content-type': asset.contentType,
      'cache-control': 'public, max-age=31536000, immutable',
      'accept-ranges': 'bytes',
      etag: `"${asset.sha256}"`,
      'x-map-id': MAP_ID,
    },
    securityPolicy,
  );
}

function headersFor(
  asset: MapAsset,
  object: R2Object,
  securityPolicy: Readonly<RuntimePolicyHeaderValues> | undefined,
): Headers {
  const headers = identityHeaders(asset, securityPolicy);
  headers.set('last-modified', object.uploaded.toUTCString());
  return headers;
}

function ifRangeMatches(value: string, etag: string, uploadedAt: number): boolean {
  if (value.startsWith('"') || value.startsWith('W/')) return value === etag;
  const date = Date.parse(value);
  return Number.isFinite(date) && date >= Math.floor(uploadedAt / 1000) * 1000;
}

function releaseWithBody(body: ReadableStream, release: () => void): ReadableStream {
  const reader = body.getReader();
  return new ReadableStream({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          release();
          controller.close();
        } else {
          controller.enqueue(result.value);
        }
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        release();
      }
    },
  });
}

export async function handleMapAsset(
  request: Request,
  bucket?: R2Bucket,
  admission = new WorkerRequestAdmission(),
  securityPolicy?: Readonly<RuntimePolicyHeaderValues>,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.search) return failure('MAP_QUERY_NOT_SUPPORTED', 400, undefined, securityPolicy);
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return failure('MAP_METHOD_NOT_ALLOWED', 405, { allow: 'GET, HEAD' }, securityPolicy);
  }
  const asset = findMapAsset(url.pathname);
  if (!asset) return failure('MAP_ASSET_NOT_FOUND', 404, undefined, securityPolicy);
  if (!bucket) return failure('MAP_ASSETS_UNAVAILABLE', 503, undefined, securityPolicy);
  const key = `${MAP_ID}/${asset.path}`;
  const etag = `"${asset.sha256}"`;
  const rangeHeader = request.method === 'GET' ? request.headers.get('range') : null;
  let ignoreRange = false;
  for (const name of supportedConditionHeaders) {
    if ((request.headers.get(name)?.length ?? 0) > 1024) {
      return failure('MAP_CONDITION_TOO_LONG', 400, undefined, securityPolicy);
    }
  }
  if (
    [...request.headers.keys()].some(
      (name) => name.startsWith('if-') && !supportedConditionHeaders.has(name),
    )
  ) {
    return failure('MAP_CONDITION_NOT_SUPPORTED', 400, undefined, securityPolicy);
  }
  const ifMatch = request.headers.get('if-match');
  if (ifMatch !== null && !etagMatches(ifMatch, etag, false)) {
    return failure('MAP_PRECONDITION_FAILED', 412, undefined, securityPolicy);
  }
  const ifNoneMatch = request.headers.get('if-none-match');
  if (ifNoneMatch !== null && etagMatches(ifNoneMatch, etag, true)) {
    return new Response(null, { status: 304, headers: identityHeaders(asset, securityPolicy) });
  }
  let range: ByteRange | undefined;
  if (rangeHeader !== null) {
    range = parseByteRange(rangeHeader, asset.bytes);
    if (!range || range.length > MAX_MAP_RANGE_BYTES) {
      return failure(
        'MAP_RANGE_NOT_SATISFIABLE',
        416,
        { 'content-range': `bytes */${asset.bytes}` },
        securityPolicy,
      );
    }
  }
  if (request.method === 'GET' && asset.bytes > MAX_MAP_RANGE_BYTES && !range) {
    return failure(
      'MAP_RANGE_REQUIRED',
      416,
      { 'content-range': `bytes */${asset.bytes}` },
      securityPolicy,
    );
  }
  const conditional = [...supportedConditionHeaders].some((name) => request.headers.has(name));
  const operations = request.method === 'HEAD' ? 1 : conditional ? 2 : 1;
  const reservedBytes =
    request.method === 'HEAD'
      ? 0
      : asset.bytes <= MAX_MAP_RANGE_BYTES
        ? asset.bytes
        : range!.length;
  const decision = admission.admitMap(operations, reservedBytes);
  if (!decision.ok) return admissionFailure(decision, securityPolicy);
  let bodyOwnsLease = false;
  try {
    if (request.method === 'HEAD' || conditional) {
      const metadata = await bucket.head(key);
      if (!metadata) return failure('MAP_ASSET_NOT_READY', 503, undefined, securityPolicy);
      if (!matchesManifest(metadata, asset))
        return failure('MAP_ASSET_IDENTITY_MISMATCH', 503, undefined, securityPolicy);
      const headers = headersFor(asset, metadata, securityPolicy);
      const modified = Math.floor(metadata.uploaded.getTime() / 1000) * 1000;
      const unmodifiedSince = request.headers.get('if-unmodified-since');
      if (
        (ifMatch !== null && !etagMatches(ifMatch, etag, false)) ||
        (ifMatch === null && unmodifiedSince !== null && Date.parse(unmodifiedSince) < modified)
      ) {
        return failure('MAP_PRECONDITION_FAILED', 412, undefined, securityPolicy);
      }
      const modifiedSince = request.headers.get('if-modified-since');
      if (
        (ifNoneMatch !== null && etagMatches(ifNoneMatch, etag, true)) ||
        (ifNoneMatch === null && modifiedSince !== null && Date.parse(modifiedSince) >= modified)
      ) {
        return new Response(null, { status: 304, headers });
      }
      if (request.method === 'HEAD') {
        headers.set('content-length', String(asset.bytes));
        return new Response(null, { headers });
      }
      const ifRange = request.headers.get('if-range');
      if (ifRange !== null && !ifRangeMatches(ifRange, etag, modified)) ignoreRange = true;
    }
    if (ignoreRange && asset.bytes > MAX_MAP_RANGE_BYTES) {
      return failure(
        'MAP_RANGE_REQUIRED',
        416,
        { 'content-range': `bytes */${asset.bytes}` },
        securityPolicy,
      );
    }
    const responseRange = ignoreRange ? undefined : range;
    const object = await bucket.get(key, responseRange ? { range: responseRange } : {});
    if (!object) return failure('MAP_ASSET_NOT_READY', 503, undefined, securityPolicy);
    if (!matchesManifest(object, asset)) {
      await object.body.cancel();
      return failure('MAP_ASSET_IDENTITY_MISMATCH', 503, undefined, securityPolicy);
    }
    const headers = headersFor(asset, object, securityPolicy);
    headers.set('content-length', String(responseRange?.length ?? asset.bytes));
    if (responseRange) {
      headers.set(
        'content-range',
        `bytes ${responseRange.offset}-${responseRange.offset + responseRange.length - 1}/${asset.bytes}`,
      );
    }
    const response = new Response(releaseWithBody(object.body, decision.lease.release), {
      status: responseRange ? 206 : 200,
      headers,
    });
    bodyOwnsLease = true;
    return response;
  } catch {
    return failure('MAP_STORAGE_UNAVAILABLE', 503, undefined, securityPolicy);
  } finally {
    if (!bodyOwnsLease) decision.lease.release();
  }
}
