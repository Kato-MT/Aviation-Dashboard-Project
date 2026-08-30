import { env } from 'cloudflare:workers';
import { reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RegionOperations } from '../../src/operations/contract';
import type { WorkerEnv } from '../../worker/env';
import { OPERATIONS_CHECKED_AT_HEADER } from '../../worker/regionalFeedHub';

const workerEnv = env as WorkerEnv;
const stub = () => workerEnv.REGION_FEEDS.getByName('operations-atlanta');
const checkedAt = '2026-08-29T16:30:00.000Z';
const clock = Date.parse(checkedAt);
let unexpectedEgress: number;

function internalRequest(path: '/health' | '/operations' | '/snapshot'): Request {
  return new Request(`https://regional-feed.internal${path}`, {
    headers: {
      'x-region-id': 'atlanta',
      [OPERATIONS_CHECKED_AT_HEADER]: checkedAt,
    },
  });
}

async function storedState(): Promise<{ entries: Record<string, unknown>; alarm: number | null }> {
  return runInDurableObject(stub(), async (_instance, state) => ({
    entries: Object.fromEntries(await state.storage.list()),
    alarm: await state.storage.getAlarm(),
  }));
}

beforeEach(() => {
  unexpectedEgress = 0;
  vi.spyOn(Date, 'now').mockReturnValue(clock);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      unexpectedEgress += 1;
      throw new Error('Unexpected provider work during an operations read.');
    }),
  );
});

afterEach(async () => {
  try {
    await reset();
    expect(unexpectedEgress).toBe(0);
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

describe('regional operations projection', () => {
  it('reads a privacy-safe empty projection without changing health, storage, or provider work', async () => {
    const healthBefore = await (await stub().fetch(internalRequest('/health'))).json();
    const before = await storedState();
    const response = await stub().fetch(internalRequest('/operations'));
    expect(response.status).toBe(200);
    const operations = (await response.json()) as RegionOperations;
    const after = await storedState();
    const healthAfter = await (await stub().fetch(internalRequest('/health'))).json();

    expect(operations).toMatchObject({
      regionId: 'atlanta',
      availability: { state: 'available', reasonCodes: ['REGION_AVAILABLE'] },
      provider: { state: 'connecting', reasonCodes: ['PROVIDER_CONNECTING'] },
      delivery: { state: 'healthy', reasonCodes: ['DELIVERY_HEALTHY'] },
      freshness: {
        state: 'empty',
        reasonCodes: ['FRESHNESS_EMPTY'],
        observationAgeSeconds: null,
      },
      windows: {
        currentHour: {
          startedAt: '2026-08-29T16:00:00.000Z',
          provider: { accounting: 'exact', pollCount: 0 },
          validation: { accounting: 'exact', acceptedSnapshotCount: 0 },
          delivery: { accounting: 'best-effort', acknowledgmentCount: 0 },
        },
        trailing24Hours: {
          startedAt: '2026-08-28T16:30:00.000Z',
          provider: { accounting: 'best-effort', pollCount: 0 },
          validation: { accounting: 'best-effort', acceptedSnapshotCount: 0 },
          delivery: { accounting: 'best-effort', acknowledgmentCount: 0 },
        },
      },
    });
    expect(after).toEqual(before);
    expect(healthAfter).toEqual(healthBefore);
    expect(JSON.stringify(operations)).not.toMatch(
      /aircraft|callsign|registration|latitude|longitude|requestId|clientId|ipAddress|userAgent/i,
    );
  });

  it('reports provider validation rejection as aggregate counters without a raw payload', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{', { headers: { 'content-type': 'application/json' } })),
    );
    const snapshot = await stub().fetch(internalRequest('/snapshot'));
    expect(snapshot.status).toBe(503);
    await snapshot.json();
    const response = await stub().fetch(internalRequest('/operations'));
    const operations = (await response.json()) as RegionOperations;

    expect(operations.provider).toEqual({
      state: 'retrying',
      reasonCodes: ['PROVIDER_RETRYING'],
    });
    expect(operations.windows?.currentHour).toMatchObject({
      provider: { pollCount: 1, successCount: 0, failureCount: 1, rateLimitCount: 0 },
      validation: {
        acceptedSnapshotCount: 0,
        rejectedSnapshotCount: 1,
        invalidFieldCount: 0,
      },
    });
    expect(JSON.stringify(operations)).not.toContain('{"ac"');
  });

  it('rejects a noncanonical shared clock without touching provider work', async () => {
    const response = await stub().fetch(
      new Request('https://regional-feed.internal/operations', {
        headers: {
          'x-region-id': 'atlanta',
          [OPERATIONS_CHECKED_AT_HEADER]: '2026-08-29T16:30:00Z',
        },
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'INVALID_OPERATIONS_CLOCK' });
  });
});
