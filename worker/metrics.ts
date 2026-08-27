export interface HourlyFeedMetrics {
  hour: string;
  pollCount: number;
  successCount: number;
  failureCount: number;
  rateLimitCount: number;
  invalidFieldCount: number;
  aircraftCountSum: number;
  aircraftCountMinimum: number | null;
  aircraftCountMaximum: number | null;
  latencyBuckets: {
    under250Ms: number;
    under500Ms: number;
    under1000Ms: number;
    under2500Ms: number;
    over2500Ms: number;
  };
}

export interface FeedMetricObservation {
  timestampMs: number;
  success: boolean;
  rateLimited: boolean;
  latencyMs: number;
  aircraftCount: number;
  invalidFieldCount: number;
}

const METRIC_PREFIX = 'metrics:';
const RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

function metricHour(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 13) + ':00:00.000Z';
}

function emptyMetrics(hour: string): HourlyFeedMetrics {
  return {
    hour,
    pollCount: 0,
    successCount: 0,
    failureCount: 0,
    rateLimitCount: 0,
    invalidFieldCount: 0,
    aircraftCountSum: 0,
    aircraftCountMinimum: null,
    aircraftCountMaximum: null,
    latencyBuckets: {
      under250Ms: 0,
      under500Ms: 0,
      under1000Ms: 0,
      under2500Ms: 0,
      over2500Ms: 0,
    },
  };
}

function recordLatency(metrics: HourlyFeedMetrics, latencyMs: number): void {
  if (latencyMs < 250) metrics.latencyBuckets.under250Ms += 1;
  else if (latencyMs < 500) metrics.latencyBuckets.under500Ms += 1;
  else if (latencyMs < 1_000) metrics.latencyBuckets.under1000Ms += 1;
  else if (latencyMs < 2_500) metrics.latencyBuckets.under2500Ms += 1;
  else metrics.latencyBuckets.over2500Ms += 1;
}

export async function recordFeedMetric(
  storage: DurableObjectStorage,
  observation: FeedMetricObservation,
): Promise<void> {
  const hour = metricHour(observation.timestampMs);
  const key = `${METRIC_PREFIX}${hour}`;
  const metrics = (await storage.get<HourlyFeedMetrics>(key)) ?? emptyMetrics(hour);
  metrics.pollCount += 1;
  metrics.successCount += observation.success ? 1 : 0;
  metrics.failureCount += observation.success ? 0 : 1;
  metrics.rateLimitCount += observation.rateLimited ? 1 : 0;
  metrics.invalidFieldCount += observation.invalidFieldCount;
  metrics.aircraftCountSum += observation.aircraftCount;
  metrics.aircraftCountMinimum =
    metrics.aircraftCountMinimum === null
      ? observation.aircraftCount
      : Math.min(metrics.aircraftCountMinimum, observation.aircraftCount);
  metrics.aircraftCountMaximum =
    metrics.aircraftCountMaximum === null
      ? observation.aircraftCount
      : Math.max(metrics.aircraftCountMaximum, observation.aircraftCount);
  recordLatency(metrics, observation.latencyMs);
  await storage.put(key, metrics);
}

export async function removeExpiredFeedMetrics(
  storage: DurableObjectStorage,
  nowMs: number,
): Promise<number> {
  const entries = await storage.list<HourlyFeedMetrics>({ prefix: METRIC_PREFIX });
  const expiredKeys = [...entries.entries()]
    .filter(([, metrics]) => Date.parse(metrics.hour) < nowMs - RETENTION_MS)
    .map(([key]) => key);
  if (expiredKeys.length > 0) {
    await storage.delete(expiredKeys);
  }
  return expiredKeys.length;
}
