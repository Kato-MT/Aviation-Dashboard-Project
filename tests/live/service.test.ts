import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadLiveServiceInfo, parseLiveServiceInfo } from '../../src/live/service';
import { describeLiveSource } from '../../src/live/source';

const metadata = {
  schemaVersion: 'airspace.v1',
  source: describeLiveSource('local-mock', 'mock'),
  applicationVersion: '3.0.0-dev',
  releaseSha: 'local-unreleased',
  regions: [],
};
afterEach(() => vi.unstubAllGlobals());

describe('live service bootstrap', () => {
  it('loads bounded same-origin provenance before starting a runtime', async () => {
    const fetchMock = vi.fn(async () => Response.json(metadata));
    vi.stubGlobal('fetch', fetchMock);
    expect(await loadLiveServiceInfo()).toEqual({
      source: metadata.source,
      applicationVersion: metadata.applicationVersion,
      releaseSha: metadata.releaseSha,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/regions',
      expect.objectContaining({ redirect: 'error' }),
    );
  });
  it.each([
    null,
    [],
    {},
    { ...metadata, schemaVersion: 'unknown' },
    { ...metadata, source: {} },
    { ...metadata, applicationVersion: 'x'.repeat(65) },
    { ...metadata, releaseSha: 'bad\nvalue' },
  ])('rejects invalid metadata: %j', (value) => {
    expect(() => parseLiveServiceInfo(value)).toThrow();
  });
  it.each([
    new Response('unavailable', { status: 503 }),
    new Response('invalid json'),
    new Response('x'.repeat(33 * 1024)),
  ])('withholds startup on HTTP, format or body-size failure', async (response) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response),
    );
    await expect(loadLiveServiceInfo()).rejects.toThrow();
  });
  it('honors cancellation without issuing a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    controller.abort();
    await expect(loadLiveServiceInfo(controller.signal)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
