import { env } from 'cloudflare:workers';
import { reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';

import type { WorkerEnv } from '../../worker/env';
import {
  feedMetricExpiryAt,
  METRIC_CLEANUP_RETRY_KEY,
  nextFeedMetricExpiry,
  nextFeedMetricMaintenance,
  OPERATIONS_METRICS_VERSION,
  readRegionalOperationsWindows,
  recordDeliveryMetrics,
  recordFeedMetric,
  removeExpiredFeedMetrics,
  type HourlyFeedMetrics,
} from '../../worker/metrics';
import { MAX_POLL_TIMESTAMP_MS } from '../../worker/polling';

const workerEnv = env as WorkerEnv;

afterEach(async () => reset());

describe('aggregate feed metrics', () => {
  it('derives the same expiry for every observation in an hour', () => {
    const start = Date.parse('2026-08-27T12:00:00.000Z');
    const expiry = Date.parse('2026-09-26T12:00:00.000Z');
    expect(feedMetricExpiryAt(start)).toBe(expiry);
    expect(feedMetricExpiryAt(start + 3_599_999)).toBe(expiry);
    expect(feedMetricExpiryAt(start + 3_600_000)).toBe(expiry + 3_600_000);
  });

  it.each([NaN, Infinity, -1, 1.5, MAX_POLL_TIMESTAMP_MS, MAX_POLL_TIMESTAMP_MS + 1])(
    'rejects an invalid or unrepresentable metric expiry for %s',
    (timestamp) => expect(() => feedMetricExpiryAt(timestamp)).toThrow(RangeError),
  );

  it.each([
    'metrics:invalid',
    'metrics:2026-08-27T12:00:00Z',
    'metrics:2026-08-27T12:15:00.000Z',
    'metrics:2026-02-29T12:00:00.000Z',
  ])('rejects a noncanonical persisted hour %s', async (key) => {
    const stub = workerEnv.REGION_FEEDS.getByName('invalid-metric-key');
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put(key, { hour: '2026-08-27T12:00:00.000Z' });
      await expect(nextFeedMetricExpiry(state.storage)).rejects.toThrow(
        'The persisted metric hour is invalid.',
      );
    });
  });

  it.each([null, NaN, Infinity, -1, 'tomorrow'])(
    'rejects a corrupt persisted maintenance retry %s',
    async (retryAt) => {
      const stub = workerEnv.REGION_FEEDS.getByName('invalid-metric-retry');
      await runInDurableObject(stub, async (_instance, state) => {
        await state.storage.put(METRIC_CLEANUP_RETRY_KEY, retryAt);
        await expect(nextFeedMetricMaintenance(state.storage)).rejects.toThrow(
          'The metric cleanup retry is invalid.',
        );
      });
    },
  );

  it('uses a canonical key rather than a mutable value field for expiry', async () => {
    const stub = workerEnv.REGION_FEEDS.getByName('metric-key-authority');
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await nextFeedMetricMaintenance(state.storage)).toBeUndefined();
      await state.storage.put('metrics:2026-08-27T12:00:00.000Z', { hour: '2099-01-01' });
      expect(await nextFeedMetricExpiry(state.storage)).toBe(
        Date.parse('2026-09-26T12:00:00.000Z'),
      );
    });
  });

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
      metricsVersion: OPERATIONS_METRICS_VERSION,
      hour: '2026-08-27T12:00:00.000Z',
      pollCount: 2,
      successCount: 1,
      failureCount: 1,
      rateLimitCount: 1,
      acceptedSnapshotCount: 1,
      rejectedSnapshotCount: 0,
      invalidFieldCount: 2,
      deliveryAcknowledgmentCount: 0,
      deliveryTimeoutCount: 0,
      deliverySendFailureCount: 0,
      deliveryInvalidControlCount: 0,
      deliveryHibernationLossCount: 0,
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

  it('projects exact current-hour and honest best-effort trailing aggregates', async () => {
    const stub = workerEnv.REGION_FEEDS.getByName('operations-window-test');
    const checkedAt = '2026-08-29T16:30:00.000Z';
    const result = await runInDurableObject(stub, async (_instance, state) => {
      const base = {
        rateLimited: false,
        latencyMs: 300,
        aircraftCount: 0,
        invalidFieldCount: 0,
      };
      await recordFeedMetric(state.storage, {
        ...base,
        timestampMs: Date.parse('2026-08-28T16:45:00.000Z'),
        success: true,
      });
      await recordFeedMetric(state.storage, {
        ...base,
        timestampMs: Date.parse('2026-08-28T17:15:00.000Z'),
        success: false,
        rateLimited: true,
      });
      await recordFeedMetric(state.storage, {
        ...base,
        timestampMs: Date.parse('2026-08-29T16:15:00.000Z'),
        success: true,
        invalidFieldCount: 2,
      });
      await recordDeliveryMetrics(state.storage, Date.parse('2026-08-29T16:20:00.000Z'), {
        acknowledgmentCount: 2,
        timeoutCount: 1,
        sendFailureCount: 0,
        invalidControlCount: 0,
        hibernationLossCount: 0,
      });
      return readRegionalOperationsWindows(state.storage, checkedAt, {
        acknowledgmentCount: 1,
        timeoutCount: 0,
        sendFailureCount: 1,
        invalidControlCount: 0,
        hibernationLossCount: 0,
      });
    });

    expect(result.currentHour).toMatchObject({
      startedAt: '2026-08-29T16:00:00.000Z',
      provider: {
        accounting: 'exact',
        pollCount: 1,
        successCount: 1,
        failureCount: 0,
      },
      validation: {
        accounting: 'exact',
        acceptedSnapshotCount: 1,
        rejectedSnapshotCount: 0,
        invalidFieldCount: 2,
      },
      delivery: {
        accounting: 'best-effort',
        acknowledgmentCount: 3,
        timeoutCount: 1,
        sendFailureCount: 1,
      },
    });
    expect(result.trailing24Hours).toMatchObject({
      startedAt: '2026-08-28T16:30:00.000Z',
      provider: {
        accounting: 'best-effort',
        pollCount: 2,
        successCount: 1,
        failureCount: 1,
        rateLimitCount: 1,
      },
      validation: {
        accounting: 'best-effort',
        acceptedSnapshotCount: 1,
        rejectedSnapshotCount: 0,
        invalidFieldCount: 2,
      },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /aircraft|callsign|registration|latitude|longitude|request|client/i,
    );
  });

  it('rejects corrupt or unknown versioned rows during an operations read', async () => {
    const stub = workerEnv.REGION_FEEDS.getByName('operations-corrupt-row-test');
    await runInDurableObject(stub, async (_instance, state) => {
      const timestampMs = Date.parse('2026-08-29T16:15:00.000Z');
      await recordFeedMetric(state.storage, {
        timestampMs,
        success: true,
        rateLimited: false,
        latencyMs: 100,
        aircraftCount: 0,
        invalidFieldCount: 0,
      });
      const key = 'metrics:2026-08-29T16:00:00.000Z';
      const row = await state.storage.get<Record<string, unknown>>(key);
      await state.storage.put(key, { ...row, metricsVersion: 'operations-metrics.v2' });
      await expect(
        readRegionalOperationsWindows(state.storage, '2026-08-29T16:30:00.000Z'),
      ).rejects.toThrow('persisted hourly metric');
    });
  });

  it('removes metric hours at exactly 30 days and retains a newer hour', async () => {
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
      await recordFeedMetric(state.storage, {
        ...observation,
        timestampMs: nowMs - 30 * 24 * 60 * 60 * 1_000 + 3_600_000,
      });
      const removed = await removeExpiredFeedMetrics(state.storage, nowMs);
      const keys = [...(await state.storage.list({ prefix: 'metrics:' })).keys()];
      return { removed, keys };
    });

    expect(result.removed).toBe(2);
    expect(result.keys).toEqual(['metrics:2026-08-01T14:00:00.000Z']);
  });
});
