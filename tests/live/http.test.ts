import { afterEach, describe, expect, it, vi } from 'vitest';

import { readBoundedLiveText, withLiveRequestDeadline } from '../../src/live/http';
import { createAdsbLolProvider } from '../../src/live/providers/adsbLol';
import { REGION_CONFIGS } from '../../src/live/regions';

const region = REGION_CONFIGS[0]!;
const now = Date.parse('2026-08-27T12:00:10.000Z');
const payload = JSON.stringify({ now, ac: [] });
const encoder = new TextEncoder();

function chunkedResponse(
  options: { headers?: Record<string, string>; chunks?: number; status?: number } = {},
) {
  let produced = 0;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (produced === (options.chunks ?? 100)) {
        controller.close();
        return;
      }
      produced++;
      controller.enqueue(encoder.encode('12345'));
    },
    cancel,
  });
  return {
    response: new Response(body, {
      status: options.status ?? 200,
      ...(options.headers ? { headers: options.headers } : {}),
    }),
    produced: () => produced,
    cancel,
  };
}

describe('bounded live HTTP bodies and request deadlines', () => {
  afterEach(() => vi.useRealTimers());

  it('accepts an exact byte budget across split UTF-8 code points', async () => {
    const bytes = encoder.encode('{"text":"é🛩"}');
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    });
    expect(await readBoundedLiveText(new Response(body), { maxBytes: bytes.length })).toBe(
      '{"text":"é🛩"}',
    );
  });

  it('rejects invalid UTF-8 instead of silently substituting characters', async () => {
    await expect(
      readBoundedLiveText(new Response(Uint8Array.of(0xc3, 0x28))),
    ).rejects.toMatchObject({
      code: 'INVALID_ENCODING',
    });
  });

  it('returns empty text for a bodyless response', async () => {
    expect(await readBoundedLiveText(new Response(null))).toBe('');
  });

  it.each([0, -1, 1.5, Number.NaN, 2 * 1024 * 1024 + 1])(
    'rejects invalid body budget %s',
    async (maxBytes) => {
      const source = chunkedResponse();
      await expect(readBoundedLiveText(source.response, { maxBytes })).rejects.toThrow('maxBytes');
      expect(source.cancel).toHaveBeenCalledOnce();
    },
  );

  it('cancels chunked overflow without buffering the full response', async () => {
    const source = chunkedResponse();
    await expect(readBoundedLiveText(source.response, { maxBytes: 8 })).rejects.toMatchObject({
      code: 'TOO_LARGE',
    });
    expect(source.produced()).toBeLessThanOrEqual(3);
    expect(source.cancel).toHaveBeenCalledOnce();
  });

  it('does not trust a falsely small Content-Length', async () => {
    const source = chunkedResponse({ headers: { 'content-length': '1' } });
    await expect(readBoundedLiveText(source.response, { maxBytes: 8 })).rejects.toMatchObject({
      code: 'TOO_LARGE',
    });
    expect(source.cancel).toHaveBeenCalledOnce();
    expect(source.produced()).toBeLessThanOrEqual(3);
  });

  it('cancels an oversized declared body before consuming it', async () => {
    const source = chunkedResponse({ headers: { 'content-length': '1000' } });
    await expect(readBoundedLiveText(source.response, { maxBytes: 8 })).rejects.toMatchObject({
      code: 'TOO_LARGE',
    });
    expect(source.cancel).toHaveBeenCalledOnce();
    expect(source.produced()).toBeLessThanOrEqual(1);
  });

  it('rejects an aborted request before starting any work', async () => {
    const controller = new AbortController();
    controller.abort();
    const action = vi.fn(async () => 'unused');
    await expect(
      withLiveRequestDeadline(action, { timeoutMs: 100, signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'ABORTED' });
    expect(action).not.toHaveBeenCalled();
  });

  it('bounds a fetch implementation that ignores abort', async () => {
    vi.useFakeTimers();
    const action = vi.fn(() => new Promise<string>(() => undefined));
    const result = withLiveRequestDeadline(action, { timeoutMs: 100 }).catch(
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toMatchObject({ code: 'TIMEOUT' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('includes stalled body consumption in the request deadline', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }));
    const result = withLiveRequestDeadline((signal) => readBoundedLiveText(response, { signal }), {
      timeoutMs: 100,
    }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toMatchObject({ code: 'TIMEOUT' });
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('relays cancellation during body consumption and removes request listeners', async () => {
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }));
    const result = withLiveRequestDeadline((signal) => readBoundedLiveText(response, { signal }), {
      timeoutMs: 1000,
      signal: controller.signal,
    }).catch((error: unknown) => error);
    await Promise.resolve();
    controller.abort();
    expect(await result).toMatchObject({ code: 'ABORTED' });
    expect(cancel).toHaveBeenCalledOnce();
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('cleans up its deadline after successful work', async () => {
    vi.useFakeTimers();
    expect(await withLiveRequestDeadline(async () => 'done', { timeoutMs: 100 })).toBe('done');
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, -1, 1.5, Number.NaN, 2_147_483_648])(
    'rejects invalid deadline %s',
    async (timeoutMs) => {
      await expect(withLiveRequestDeadline(async () => 'unused', { timeoutMs })).rejects.toThrow(
        'timeoutMs',
      );
    },
  );

  it('cancels the response arriving after a deadline', async () => {
    vi.useFakeTimers();
    let resolveResponse!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    const result = withLiveRequestDeadline(
      async (signal) => readBoundedLiveText(await pending, { signal }),
      { timeoutMs: 100 },
    ).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toMatchObject({ code: 'TIMEOUT' });
    const source = chunkedResponse();
    resolveResponse(source.response);
    await vi.advanceTimersByTimeAsync(0);
    expect(source.cancel).toHaveBeenCalledOnce();
  });
});

describe('provider HTTP boundary regressions', () => {
  afterEach(() => vi.useRealTimers());

  it('cancels a chunked oversized provider response early', async () => {
    const source = chunkedResponse({ headers: { 'content-length': '1' } });
    const provider = createAdsbLolProvider({
      fetcher: async () => source.response,
      maxResponseBytes: 8,
    });
    await expect(provider.fetchRegion(region)).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    expect(source.cancel).toHaveBeenCalledOnce();
    expect(source.produced()).toBeLessThanOrEqual(3);
  });

  it('cancels a provider error body without trying to parse or drain it', async () => {
    const source = chunkedResponse({ status: 429, headers: { 'retry-after': '300' } });
    const provider = createAdsbLolProvider({
      fetcher: async () => source.response,
      now: () => now,
    });
    await expect(provider.fetchRegion(region)).rejects.toMatchObject({
      code: 'UPSTREAM_RATE_LIMITED',
      retryAfterSeconds: 300,
    });
    expect(source.cancel).toHaveBeenCalledOnce();
    expect(source.produced()).toBeLessThanOrEqual(1);
  });

  it('times out a never-ending provider body within eight seconds', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
        },
        cancel,
      }),
    );
    const provider = createAdsbLolProvider({ fetcher: async () => response });
    let settled: unknown;
    const pending = provider.fetchRegion(region).catch((error: unknown) => {
      settled = error;
    });
    await vi.advanceTimersByTimeAsync(8_000);
    try {
      expect(settled).toMatchObject({ code: 'NETWORK_ERROR' });
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      if (!cancel.mock.calls.length) streamController.close();
      await pending;
    }
  });

  it('uses an absolute deadline for numeric Retry-After at header receipt', async () => {
    const provider = createAdsbLolProvider({
      fetcher: async () => new Response(null, { status: 429, headers: { 'retry-after': '300' } }),
      now: () => now,
    });
    await expect(provider.fetchRegion(region)).rejects.toMatchObject({
      retryAfterSeconds: 300,
      retryAtMs: now + 300_000,
    });
  });

  it('supports HTTP-date Retry-After without shortening the provider delay', async () => {
    const provider = createAdsbLolProvider({
      fetcher: async () =>
        new Response(null, {
          status: 503,
          headers: { 'retry-after': new Date(now + 300_000).toUTCString() },
        }),
      now: () => now,
    });
    await expect(provider.fetchRegion(region)).rejects.toMatchObject({
      code: 'UPSTREAM_HTTP_ERROR',
      retryAfterSeconds: 300,
      retryAtMs: now + 300_000,
    });
  });

  it('accepts a successful response exactly at the byte limit', async () => {
    const body = payload.padEnd(128, ' ');
    const provider = createAdsbLolProvider({
      fetcher: async () => new Response(body),
      maxResponseBytes: 128,
      now: () => now,
    });
    expect((await provider.fetchRegion(region)).aircraft).toEqual([]);
  });

  it('does not start a provider request after cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn(async () => new Response(payload));
    await expect(
      createAdsbLolProvider({ fetcher }).fetchRegion(region, controller.signal),
    ).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('cancels a provider response that arrives after its fetch deadline', async () => {
    vi.useFakeTimers();
    let resolveResponse!: (response: Response) => void;
    const fetcher = () =>
      new Promise<Response>((resolve) => {
        resolveResponse = resolve;
      });
    const pending = createAdsbLolProvider({ fetcher })
      .fetchRegion(region)
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(await pending).toMatchObject({ code: 'NETWORK_ERROR' });
    const source = chunkedResponse({ status: 503 });
    resolveResponse(source.response);
    await vi.advanceTimersByTimeAsync(0);
    expect(source.cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('maps invalid UTF-8 to a safe malformed-JSON provider failure', async () => {
    const provider = createAdsbLolProvider({
      fetcher: async () => new Response(Uint8Array.of(0xc3, 0x28)),
    });
    await expect(provider.fetchRegion(region)).rejects.toMatchObject({ code: 'MALFORMED_JSON' });
  });

  it('does not expose a response-body failure message', async () => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error('upstream private detail'));
        },
      }),
    );
    await expect(
      createAdsbLolProvider({ fetcher: async () => response }).fetchRegion(region),
    ).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
      message: 'The live aircraft provider request failed.',
    });
  });

  it('propagates a fail-closed retry directive for a valid but unrepresentable delay', async () => {
    const provider = createAdsbLolProvider({
      fetcher: async () =>
        new Response(null, {
          status: 429,
          headers: { 'retry-after': '9'.repeat(100) },
        }),
    });
    await expect(provider.fetchRegion(region)).rejects.toMatchObject({ retryBlocked: true });
  });

  it.each([0, -1, Number.NaN, 2 * 1024 * 1024 + 1])(
    'rejects unsafe provider byte limit %s',
    (maxResponseBytes) => {
      expect(() => createAdsbLolProvider({ maxResponseBytes })).toThrow('maxResponseBytes');
    },
  );

  it.each([0, -1, Number.NaN, 2001])('rejects unsafe provider record limit %s', (maxAircraft) => {
    expect(() => createAdsbLolProvider({ maxAircraft })).toThrow('maxAircraft');
  });
});
