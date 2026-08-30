import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../../worker/index';
import { handleMapAsset } from '../../worker/mapAssets';
import type { WorkerEnv } from '../../worker/env';
import { findMapAsset, MAP_ID, MAP_PREFIX } from '../../src/map/assets';
import {
  REQUEST_ADMISSION_POLICY,
  WorkerRequestAdmission,
  resetRequestAdmissionForTests,
} from '../../worker/admission';

const workerEnv = env as WorkerEnv;
const bucket = workerEnv.MAP_ASSETS!;
const relative = 'fonts/Noto Sans Italic/10240-10495.pbf';
const asset = findMapAsset(encodeURI(MAP_PREFIX + relative))!;
const basemapAsset = findMapAsset(MAP_PREFIX + 'basemap.pmtiles')!;
const key = MAP_ID + '/' + relative;
const url = 'https://workbench.test' + encodeURI(MAP_PREFIX + relative);
// Exact empty-glyph fontstack fixture, from the pinned SIL-OFL asset distribution.
const bytes = Uint8Array.from(atob('ChoKC1NhbnMgSXRhbGljEgsxMDI0MC0xMDQ5NQ=='), (value) =>
  value.charCodeAt(0),
);
const fetchGuard = vi.fn(() => {
  throw new Error('Map tests cannot contact an external provider.');
});

beforeEach(async () => {
  resetRequestAdmissionForTests();
  fetchGuard.mockClear();
  vi.stubGlobal('fetch', fetchGuard);
  await bucket.put(key, bytes, { customMetadata: { sha256: asset.sha256 } });
});
afterEach(async () => {
  await reset();
  expect(fetchGuard).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});
function request(headers?: HeadersInit, method = 'GET') {
  return worker.fetch(new Request(url, { method, headers }), workerEnv);
}

describe('actual local R2 map delivery', () => {
  it('serves exact bytes and immutable identity without touching the aircraft feed', async () => {
    const response = await request();
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(response.headers.get('etag')).toBe(`"${asset.sha256}"`);
    expect(response.headers.get('cache-control')).toContain('immutable');
    expect(response.headers.get('x-map-id')).toBe(MAP_ID);
    expect(response.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('permissions-policy')).toContain('geolocation=()');
  });
  it.each([
    ['bytes=0-7', 0, 8],
    ['bytes=20-', 20, 8],
    ['bytes=-4', 24, 4],
    ['bytes=24-99', 24, 4],
  ])('delivers range %s', async (range, offset, length) => {
    const response = await request({ range: String(range) });
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe(
      `bytes ${offset}-${Number(offset) + Number(length) - 1}/28`,
    );
    expect(response.headers.get('content-length')).toBe(String(length));
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      bytes.slice(Number(offset), Number(offset) + Number(length)),
    );
  });
  it.each(['bytes=28-', 'bytes=0-1,4-6', 'bytes=-0'])('rejects invalid range %s', async (range) => {
    const response = await request({ range });
    expect(response.status).toBe(416);
    expect(response.headers.get('content-range')).toBe('bytes */28');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it('HEAD reports the full object and ignores Range', async () => {
    const response = await request({ range: 'bytes=invalid' }, 'HEAD');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-length')).toBe('28');
    expect(await response.text()).toBe('');
  });
  it('honors entity tag preconditions for a valid bounded Range', async () => {
    const unchanged = await request({
      'if-none-match': `W/"${asset.sha256}"`,
      range: 'bytes=0-7',
    });
    expect(unchanged.status).toBe(304);
    expect(await unchanged.text()).toBe('');
    expect((await request({ 'if-match': '"wrong"', range: 'bytes=0-7' })).status).toBe(412);
  });
  it('honors If-Range and ignores the range completely on a mismatch', async () => {
    expect((await request({ range: 'bytes=0-7', 'if-range': `"${asset.sha256}"` })).status).toBe(
      206,
    );
    const changed = await request({ range: 'bytes=0-7', 'if-range': '"different"' });
    expect(changed.status).toBe(200);
    expect(new Uint8Array(await changed.arrayBuffer())).toEqual(bytes);
  });
  it('honors date conditions and If-None-Match precedence', async () => {
    const metadata = await request(undefined, 'HEAD');
    const modified = metadata.headers.get('last-modified')!;
    expect((await request({ 'if-modified-since': modified })).status).toBe(304);
    expect(
      (await request({ 'if-none-match': '"different"', 'if-modified-since': modified })).status,
    ).toBe(200);
    expect((await request({ 'if-unmodified-since': 'Thu, 01 Jan 1970 00:00:00 GMT' })).status).toBe(
      412,
    );
    expect((await request({ range: 'bytes=0-1', 'if-range': modified })).status).toBe(206);
    expect(
      (await request({ range: 'bytes=0-1', 'if-range': 'Thu, 01 Jan 1970 00:00:00 GMT' })).status,
    ).toBe(200);
  });
  it('rejects disallowed keys, queries, methods and excessive headers', async () => {
    expect((await worker.fetch(new Request(url + '?source=other'), workerEnv)).status).toBe(400);
    expect(
      (await worker.fetch(new Request('https://workbench.test/map-assets/unlisted'), workerEnv))
        .status,
    ).toBe(404);
    expect((await request(undefined, 'POST')).status).toBe(405);
    const body = await request({ 'content-length': '1' });
    expect(body.status).toBe(400);
    expect(await body.json()).toMatchObject({ error: 'MAP_REQUEST_BODY_NOT_SUPPORTED' });
    const upgrade = await request({ upgrade: 'websocket' });
    expect(upgrade.status).toBe(400);
    expect(await upgrade.json()).toMatchObject({ error: 'MAP_UPGRADE_NOT_SUPPORTED' });
    expect((await request({ 'if-none-match': 'x'.repeat(1025) })).status).toBe(400);
    const oversized = await worker.fetch(
      new Request(`https://workbench.test${MAP_PREFIX}basemap.pmtiles`, {
        headers: { range: 'bytes=0-8388608' },
      }),
      workerEnv,
    );
    expect(oversized.status).toBe(416);
  });
  it('rejects large full objects, invalid ranges and unsupported conditions before R2', async () => {
    const countingBucket = {
      head: vi.fn(async () => undefined),
      get: vi.fn(async () => undefined),
    } as unknown as R2Bucket;
    const admission = new WorkerRequestAdmission();
    const basemap = `https://workbench.test${MAP_PREFIX}basemap.pmtiles`;
    expect((await handleMapAsset(new Request(basemap), countingBucket, admission)).status).toBe(
      416,
    );
    expect(
      (
        await handleMapAsset(
          new Request(basemap, { headers: { range: 'bytes=invalid' } }),
          countingBucket,
          admission,
        )
      ).status,
    ).toBe(416);
    expect(
      (
        await handleMapAsset(
          new Request(url, { headers: { 'if-custom-condition': 'value' } }),
          countingBucket,
          admission,
        )
      ).status,
    ).toBe(400);
    const unchanged = await handleMapAsset(
      new Request(basemap, {
        headers: { 'if-none-match': `W/"${basemapAsset.sha256}"` },
      }),
      countingBucket,
      admission,
    );
    expect(unchanged.status).toBe(304);
    const failedPrecondition = await handleMapAsset(
      new Request(basemap, {
        headers: { 'if-match': '"wrong"', range: 'bytes=invalid' },
      }),
      countingBucket,
      admission,
    );
    expect(failedPrecondition.status).toBe(412);
    expect(countingBucket.head).not.toHaveBeenCalled();
    expect(countingBucket.get).not.toHaveBeenCalled();
  });
  it('rejects map work at the exact operation boundary without an R2 call', async () => {
    const countingBucket = {
      head: vi.fn(async () => undefined),
      get: vi.fn(async () => undefined),
    } as unknown as R2Bucket;
    const admission = new WorkerRequestAdmission();
    for (let index = 0; index < REQUEST_ADMISSION_POLICY.map.operationBurst; index++) {
      const decision = admission.admitMap(1, 0);
      expect(decision.ok).toBe(true);
      if (decision.ok) decision.lease.release();
    }
    const response = await handleMapAsset(
      new Request(url, { method: 'HEAD' }),
      countingBucket,
      admission,
    );
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: 'MAP_CAPACITY' });
    expect(countingBucket.head).not.toHaveBeenCalled();
    expect(countingBucket.get).not.toHaveBeenCalled();
  });
  it('holds map concurrency through response streaming and releases on cancel and completion', async () => {
    const get = vi.fn(async () => ({
      size: asset.bytes,
      customMetadata: { sha256: asset.sha256 },
      uploaded: new Date('2026-08-28T00:00:00.000Z'),
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
    }));
    const countingBucket = { get, head: vi.fn() } as unknown as R2Bucket;
    const admission = new WorkerRequestAdmission();
    const responses = await Promise.all(
      Array.from({ length: REQUEST_ADMISSION_POLICY.map.concurrency }, () =>
        handleMapAsset(new Request(url), countingBucket, admission),
      ),
    );
    expect(responses.every((response) => response.status === 200)).toBe(true);
    const blocked = await handleMapAsset(new Request(url), countingBucket, admission);
    expect(blocked.status).toBe(503);
    expect(await blocked.json()).toMatchObject({ error: 'MAP_BUSY' });
    expect(get).toHaveBeenCalledTimes(REQUEST_ADMISSION_POLICY.map.concurrency);

    await responses[0]!.body!.cancel();
    const afterCancel = await handleMapAsset(new Request(url), countingBucket, admission);
    expect(afterCancel.status).toBe(200);
    expect(get).toHaveBeenCalledTimes(REQUEST_ADMISSION_POLICY.map.concurrency + 1);
    expect(new Uint8Array(await afterCancel.arrayBuffer())).toEqual(bytes);

    const afterCompletion = await handleMapAsset(new Request(url), countingBucket, admission);
    expect(afterCompletion.status).toBe(200);
    expect(get).toHaveBeenCalledTimes(REQUEST_ADMISSION_POLICY.map.concurrency + 2);
    await afterCompletion.body!.cancel();
    await Promise.all(responses.slice(1).map((response) => response.body!.cancel()));
  });
  it('fails closed on missing storage, absent assets and identity mismatch', async () => {
    expect((await handleMapAsset(new Request(url))).status).toBe(503);
    await bucket.delete(key);
    expect((await request()).status).toBe(503);
    await bucket.put(key, bytes, { customMetadata: { sha256: 'wrong' } });
    expect((await request()).status).toBe(503);
    expect((await request(undefined, 'HEAD')).status).toBe(503);
  });
});
