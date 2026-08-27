import { env } from 'cloudflare:workers';
import { reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';

import type { WorkerEnv } from '../../worker/env';
import {
  recordFeedMetric,
  removeExpiredFeedMetrics,
  type HourlyFeedMetrics,
} from '../../worker/metrics';

const workerEnv = env as WorkerEnv;

afterEach(async () => reset());

describe('aggregate feed metrics', () => {
  it('stores only bounded hourly counts and latency buckets', async () => {
    const stub = workerEnv.REGION_FEEDS.getByName('metrics-hourly-test');
    const metrics = await runInDurableObject(stub, async (_instance, state) => {
      const timestampMs = Date.parse('2026-08-27T12:15:00.000Z');
      await recordFeedMetric(state.storage, {
        timestampMs,
        success: true,
        rateLimited: false,
        latencyMs: 240,
        aircraftCount: 42,
        invalidFieldCount: 2,
      });
      await recordFeedMetric(state.storage, {
        timestampMs: timestampMs + 10_000,
        success: false,
        rateLimited: true,
        latencyMs: 2_600,
        aircraftCount: 0,
        invalidFieldCount: 0,
      });
      const entries = await state.storage.list<HourlyFeedMetrics>({ prefix: 'metrics:' });
      return [...entries.values()][0];
    });

    expect(metrics).toEqual({
      hour: '2026-08-27T12:00:00.000Z',
      pollCount: 2,
      successCount: 1,
      failureCount: 1,
      rateLimitCount: 1,
      invalidFieldCount: 2,
      aircraftCountSum: 42,
      aircraftCountMinimum: 0,
      aircraftCountMaximum: 42,
      latencyBuckets: {
        under250Ms: 1,
        under500Ms: 0,
        under1000Ms: 0,
        under2500Ms: 0,
        over2500Ms: 1,
      },
    });
    expect(JSON.stringify(metrics)).not.toMatch(
      /aircraftId|callsign|registration|latitude|longitude/i,
    );
  });

  it('removes metric hours older than 30 days and retains the boundary hour', async () => {
    const stub = workerEnv.REGION_FEEDS.getByName('metrics-retention-test');
    const result = await runInDurableObject(stub, async (_instance, state) => {
      const nowMs = Date.parse('2026-08-31T13:00:00.000Z');
      const observation = {
        success: true,
        rateLimited: false,
        latencyMs: 300,
        aircraftCount: 10,
        invalidFieldCount: 0,
      };
      await recordFeedMetric(state.storage, {
        ...observation,
        timestampMs: nowMs - 31 * 24 * 60 * 60 * 1_000,
      });
      await recordFeedMetric(state.storage, {
        ...observation,
        timestampMs: nowMs - 30 * 24 * 60 * 60 * 1_000,
      });
      const removed = await removeExpiredFeedMetrics(state.storage, nowMs);
      const keys = [...(await state.storage.list({ prefix: 'metrics:' })).keys()];
      return { removed, keys };
    });

    expect(result.removed).toBe(1);
    expect(result.keys).toEqual(['metrics:2026-08-01T13:00:00.000Z']);
  });
});
