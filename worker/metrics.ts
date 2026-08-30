import {
  MAX_OPERATIONS_COUNTER,
  operationsWindowStarts,
  type OperationsAccounting,
  type OperationsAggregateWindow,
  type OperationsAggregateWindows,
  type OperationsDeliveryCounters,
} from '../src/operations/contract';
import { isCanonicalTimestamp, isJsonRecord } from '../src/live/validation';
import { validPollTimestamp } from './polling';

export const OPERATIONS_METRICS_VERSION = 'operations-metrics.v1' as const;

export interface HourlyFeedMetrics {
  metricsVersion: typeof OPERATIONS_METRICS_VERSION;
  hour: string;
  pollCount: number;
  successCount: number;
  failureCount: number;
  rateLimitCount: number;
  acceptedSnapshotCount: number;
  rejectedSnapshotCount: number;
  invalidFieldCount: number;
  deliveryAcknowledgmentCount: number;
  deliveryTimeoutCount: number;
  deliverySendFailureCount: number;
  deliveryInvalidControlCount: number;
  deliveryHibernationLossCount: number;
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
  validationRejected?: boolean;
}

export interface DeliveryMetricDelta {
  acknowledgmentCount: number;
  timeoutCount: number;
  sendFailureCount: number;
  invalidControlCount: number;
  hibernationLossCount: number;
}

const METRIC_PREFIX = 'metrics:';
const HOUR_MS = 60 * 60 * 1_000;
const MAX_OPERATIONS_WINDOW_ROWS = 25;
export const METRIC_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const METRIC_CLEANUP_BATCH_SIZE = 128;
export const METRIC_CLEANUP_RETRY_MS = 60_000;
export const METRIC_CLEANUP_RETRY_KEY = 'state:metricCleanupRetryAt';
export const METRIC_LAST_CLEANUP_KEY = 'state:lastMetricCleanupAt';

type MetricTransaction = Pick<
  DurableObjectTransaction,
  'get' | 'put' | 'list' | 'delete' | 'getAlarm' | 'setAlarm'
>;

function metricHour(timestampMs: number): string {
  if (!validPollTimestamp(timestampMs)) throw new RangeError('Invalid metric timestamp.');
  return new Date(timestampMs).toISOString().slice(0, 13) + ':00:00.000Z';
}

export function feedMetricExpiryAt(timestampMs: number): number {
  const expiry = Date.parse(metricHour(timestampMs)) + METRIC_RETENTION_MS;
  if (!validPollTimestamp(expiry)) throw new RangeError('Invalid metric expiry.');
  return expiry;
}

function expiryFromKey(key: string): number {
  const hour = key.slice(METRIC_PREFIX.length);
  const timestamp = Date.parse(hour);
  if (!validPollTimestamp(timestamp) || hour !== metricHour(timestamp))
    throw new Error('The persisted metric hour is invalid.');
  return feedMetricExpiryAt(timestamp);
}

export async function nextFeedMetricExpiry(
  storage: Pick<DurableObjectTransaction, 'list'>,
): Promise<number | undefined> {
  const entries = await storage.list({ prefix: METRIC_PREFIX, limit: 1 });
  const first = entries.keys().next();
  return first.done ? undefined : expiryFromKey(first.value);
}

export async function nextFeedMetricMaintenance(
  storage: Pick<DurableObjectTransaction, 'list' | 'get'>,
): Promise<number | undefined> {
  const storedRetry = await storage.get(METRIC_CLEANUP_RETRY_KEY);
  const retryAt = storedRetry === undefined ? 0 : storedRetry;
  if (!validPollTimestamp(retryAt)) throw new Error('The metric cleanup retry is invalid.');
  // A failed metric read is itself deferred. Repeating it before the retry would
  // block unrelated polling and continually move the maintenance deadline.
  return retryAt || nextFeedMetricExpiry(storage);
}

async function armEarlierAlarm(storage: MetricTransaction, deadline: number): Promise<void> {
  const current = await storage.getAlarm();
  if (current === null || deadline < current) await storage.setAlarm(deadline);
}

function emptyMetrics(hour: string): HourlyFeedMetrics {
  return {
    metricsVersion: OPERATIONS_METRICS_VERSION,
    hour,
    pollCount: 0,
    successCount: 0,
    failureCount: 0,
    rateLimitCount: 0,
    acceptedSnapshotCount: 0,
    rejectedSnapshotCount: 0,
    invalidFieldCount: 0,
    deliveryAcknowledgmentCount: 0,
    deliveryTimeoutCount: 0,
    deliverySendFailureCount: 0,
    deliveryInvalidControlCount: 0,
    deliveryHibernationLossCount: 0,
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

const legacyMetricKeys = new Set([
  'hour',
  'pollCount',
  'successCount',
  'failureCount',
  'rateLimitCount',
  'invalidFieldCount',
  'aircraftCountSum',
  'aircraftCountMinimum',
  'aircraftCountMaximum',
  'latencyBuckets',
]);
const versionedMetricKeys = new Set([
  'metricsVersion',
  ...legacyMetricKeys,
  'acceptedSnapshotCount',
  'rejectedSnapshotCount',
  'deliveryAcknowledgmentCount',
  'deliveryTimeoutCount',
  'deliverySendFailureCount',
  'deliveryInvalidControlCount',
  'deliveryHibernationLossCount',
]);
const latencyBucketKeys = new Set([
  'under250Ms',
  'under500Ms',
  'under1000Ms',
  'under2500Ms',
  'over2500Ms',
]);

function metricCounter(value: unknown, label: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_OPERATIONS_COUNTER
  ) {
    throw new Error(`The persisted ${label} metric is invalid.`);
  }
  return value;
}

function addMetricCounter(current: number, increment: number, label: string): number {
  const boundedIncrement = metricCounter(increment, label);
  if (boundedIncrement > MAX_OPERATIONS_COUNTER - current) {
    throw new Error(`The persisted ${label} metric is exhausted.`);
  }
  return current + boundedIncrement;
}

function readHourlyMetrics(value: unknown, expectedHour: string): HourlyFeedMetrics {
  if (!isJsonRecord(value)) throw new Error('The persisted hourly metric is invalid.');
  const versioned = value.metricsVersion !== undefined;
  const expectedKeys = versioned ? versionedMetricKeys : legacyMetricKeys;
  if (
    (versioned && value.metricsVersion !== OPERATIONS_METRICS_VERSION) ||
    Object.keys(value).length !== expectedKeys.size ||
    Object.keys(value).some((key) => !expectedKeys.has(key)) ||
    value.hour !== expectedHour ||
    !isJsonRecord(value.latencyBuckets) ||
    Object.keys(value.latencyBuckets).length !== latencyBucketKeys.size ||
    Object.keys(value.latencyBuckets).some((key) => !latencyBucketKeys.has(key))
  ) {
    throw new Error('The persisted hourly metric is invalid.');
  }

  const metrics: HourlyFeedMetrics = {
    metricsVersion: OPERATIONS_METRICS_VERSION,
    hour: expectedHour,
    pollCount: metricCounter(value.pollCount, 'poll count'),
    successCount: metricCounter(value.successCount, 'success count'),
    failureCount: metricCounter(value.failureCount, 'failure count'),
    rateLimitCount: metricCounter(value.rateLimitCount, 'rate-limit count'),
    acceptedSnapshotCount: metricCounter(
      versioned ? value.acceptedSnapshotCount : value.successCount,
      'accepted-snapshot count',
    ),
    rejectedSnapshotCount: metricCounter(
      versioned ? value.rejectedSnapshotCount : 0,
      'rejected-snapshot count',
    ),
    invalidFieldCount: metricCounter(value.invalidFieldCount, 'invalid-field count'),
    deliveryAcknowledgmentCount: metricCounter(
      versioned ? value.deliveryAcknowledgmentCount : 0,
      'delivery acknowledgment count',
    ),
    deliveryTimeoutCount: metricCounter(
      versioned ? value.deliveryTimeoutCount : 0,
      'delivery timeout count',
    ),
    deliverySendFailureCount: metricCounter(
      versioned ? value.deliverySendFailureCount : 0,
      'delivery send-failure count',
    ),
    deliveryInvalidControlCount: metricCounter(
      versioned ? value.deliveryInvalidControlCount : 0,
      'delivery invalid-control count',
    ),
    deliveryHibernationLossCount: metricCounter(
      versioned ? value.deliveryHibernationLossCount : 0,
      'delivery hibernation-loss count',
    ),
    aircraftCountSum: metricCounter(value.aircraftCountSum, 'aircraft-count sum'),
    aircraftCountMinimum:
      value.aircraftCountMinimum === null
        ? null
        : metricCounter(value.aircraftCountMinimum, 'aircraft-count minimum'),
    aircraftCountMaximum:
      value.aircraftCountMaximum === null
        ? null
        : metricCounter(value.aircraftCountMaximum, 'aircraft-count maximum'),
    latencyBuckets: {
      under250Ms: metricCounter(value.latencyBuckets.under250Ms, 'latency bucket'),
      under500Ms: metricCounter(value.latencyBuckets.under500Ms, 'latency bucket'),
      under1000Ms: metricCounter(value.latencyBuckets.under1000Ms, 'latency bucket'),
      under2500Ms: metricCounter(value.latencyBuckets.under2500Ms, 'latency bucket'),
      over2500Ms: metricCounter(value.latencyBuckets.over2500Ms, 'latency bucket'),
    },
  };
  const latencyTotal = Object.values(metrics.latencyBuckets).reduce(
    (total, count) => addMetricCounter(total, count, 'latency total'),
    0,
  );
  const validationTotal = addMetricCounter(
    metrics.acceptedSnapshotCount,
    metrics.rejectedSnapshotCount,
    'validation total',
  );
  if (
    metrics.successCount + metrics.failureCount !== metrics.pollCount ||
    metrics.rateLimitCount > metrics.failureCount ||
    validationTotal > metrics.pollCount ||
    latencyTotal !== metrics.pollCount ||
    (metrics.pollCount === 0 &&
      (metrics.aircraftCountMinimum !== null || metrics.aircraftCountMaximum !== null)) ||
    (metrics.pollCount > 0 &&
      (metrics.aircraftCountMinimum === null || metrics.aircraftCountMaximum === null)) ||
    (metrics.aircraftCountMinimum !== null &&
      metrics.aircraftCountMaximum !== null &&
      metrics.aircraftCountMinimum > metrics.aircraftCountMaximum)
  ) {
    throw new Error('The persisted hourly metric counters are inconsistent.');
  }
  return metrics;
}

function validateObservation(observation: FeedMetricObservation): void {
  feedMetricExpiryAt(observation.timestampMs);
  if (
    typeof observation.success !== 'boolean' ||
    typeof observation.rateLimited !== 'boolean' ||
    (observation.validationRejected !== undefined &&
      typeof observation.validationRejected !== 'boolean') ||
    (observation.rateLimited && observation.success) ||
    (observation.validationRejected === true && observation.success) ||
    !Number.isFinite(observation.latencyMs) ||
    observation.latencyMs < 0
  ) {
    throw new Error('The feed metric observation is invalid.');
  }
  metricCounter(observation.aircraftCount, 'aircraft count');
  metricCounter(observation.invalidFieldCount, 'invalid-field count');
}

function validateDeliveryDelta(delta: DeliveryMetricDelta): void {
  metricCounter(delta.acknowledgmentCount, 'delivery acknowledgment count');
  metricCounter(delta.timeoutCount, 'delivery timeout count');
  metricCounter(delta.sendFailureCount, 'delivery send-failure count');
  metricCounter(delta.invalidControlCount, 'delivery invalid-control count');
  metricCounter(delta.hibernationLossCount, 'delivery hibernation-loss count');
}

function isEmptyDeliveryDelta(delta: DeliveryMetricDelta): boolean {
  return Object.values(delta).every((value) => value === 0);
}

function recordLatency(metrics: HourlyFeedMetrics, latencyMs: number): void {
  const key =
    latencyMs < 250
      ? 'under250Ms'
      : latencyMs < 500
        ? 'under500Ms'
        : latencyMs < 1_000
          ? 'under1000Ms'
          : latencyMs < 2_500
            ? 'under2500Ms'
            : 'over2500Ms';
  metrics.latencyBuckets[key] = addMetricCounter(metrics.latencyBuckets[key], 1, 'latency bucket');
}

export async function recordFeedMetric(
  storage: DurableObjectStorage,
  observation: FeedMetricObservation,
): Promise<void> {
  validateObservation(observation);
  const hour = metricHour(observation.timestampMs);
  const key = `${METRIC_PREFIX}${hour}`;
  await storage.transaction(async (transaction) => {
    const stored = await transaction.get(key);
    const metrics = stored === undefined ? emptyMetrics(hour) : readHourlyMetrics(stored, hour);
    metrics.pollCount = addMetricCounter(metrics.pollCount, 1, 'poll count');
    metrics.successCount = addMetricCounter(
      metrics.successCount,
      observation.success ? 1 : 0,
      'success count',
    );
    metrics.failureCount = addMetricCounter(
      metrics.failureCount,
      observation.success ? 0 : 1,
      'failure count',
    );
    metrics.rateLimitCount = addMetricCounter(
      metrics.rateLimitCount,
      observation.rateLimited ? 1 : 0,
      'rate-limit count',
    );
    metrics.acceptedSnapshotCount = addMetricCounter(
      metrics.acceptedSnapshotCount,
      observation.success ? 1 : 0,
      'accepted-snapshot count',
    );
    metrics.rejectedSnapshotCount = addMetricCounter(
      metrics.rejectedSnapshotCount,
      observation.validationRejected === true ? 1 : 0,
      'rejected-snapshot count',
    );
    metrics.invalidFieldCount = addMetricCounter(
      metrics.invalidFieldCount,
      observation.invalidFieldCount,
      'invalid-field count',
    );
    metrics.aircraftCountSum = addMetricCounter(
      metrics.aircraftCountSum,
      observation.aircraftCount,
      'aircraft-count sum',
    );
    metrics.aircraftCountMinimum =
      metrics.aircraftCountMinimum === null
        ? observation.aircraftCount
        : Math.min(metrics.aircraftCountMinimum, observation.aircraftCount);
    metrics.aircraftCountMaximum =
      metrics.aircraftCountMaximum === null
        ? observation.aircraftCount
        : Math.max(metrics.aircraftCountMaximum, observation.aircraftCount);
    recordLatency(metrics, observation.latencyMs);
    await transaction.put(key, metrics);
    // A committed metric must never be left without a durable wakeup, even if
    // the coordinator disappears before its ordinary polling reschedule.
    const maintenance = await nextFeedMetricMaintenance(transaction);
    if (maintenance === undefined) throw new Error('The metric expiry obligation is missing.');
    await armEarlierAlarm(transaction, maintenance);
  });
}

export async function recordDeliveryMetrics(
  storage: DurableObjectStorage,
  timestampMs: number,
  delta: DeliveryMetricDelta,
): Promise<void> {
  feedMetricExpiryAt(timestampMs);
  validateDeliveryDelta(delta);
  if (isEmptyDeliveryDelta(delta)) return;
  const hour = metricHour(timestampMs);
  const key = `${METRIC_PREFIX}${hour}`;
  await storage.transaction(async (transaction) => {
    const stored = await transaction.get(key);
    const metrics = stored === undefined ? emptyMetrics(hour) : readHourlyMetrics(stored, hour);
    metrics.deliveryAcknowledgmentCount = addMetricCounter(
      metrics.deliveryAcknowledgmentCount,
      delta.acknowledgmentCount,
      'delivery acknowledgment count',
    );
    metrics.deliveryTimeoutCount = addMetricCounter(
      metrics.deliveryTimeoutCount,
      delta.timeoutCount,
      'delivery timeout count',
    );
    metrics.deliverySendFailureCount = addMetricCounter(
      metrics.deliverySendFailureCount,
      delta.sendFailureCount,
      'delivery send-failure count',
    );
    metrics.deliveryInvalidControlCount = addMetricCounter(
      metrics.deliveryInvalidControlCount,
      delta.invalidControlCount,
      'delivery invalid-control count',
    );
    metrics.deliveryHibernationLossCount = addMetricCounter(
      metrics.deliveryHibernationLossCount,
      delta.hibernationLossCount,
      'delivery hibernation-loss count',
    );
    await transaction.put(key, metrics);
    const maintenance = await nextFeedMetricMaintenance(transaction);
    if (maintenance === undefined) throw new Error('The metric expiry obligation is missing.');
    await armEarlierAlarm(transaction, maintenance);
  });
}

function emptyDeliveryCounters(accounting: OperationsAccounting): OperationsDeliveryCounters {
  return {
    accounting,
    acknowledgmentCount: 0,
    timeoutCount: 0,
    sendFailureCount: 0,
    invalidControlCount: 0,
    hibernationLossCount: 0,
  };
}

function addRowToWindow(
  aggregate: OperationsAggregateWindow,
  row: HourlyFeedMetrics,
): OperationsAggregateWindow {
  return {
    ...aggregate,
    provider: {
      ...aggregate.provider,
      pollCount: addMetricCounter(aggregate.provider.pollCount, row.pollCount, 'poll count'),
      successCount: addMetricCounter(
        aggregate.provider.successCount,
        row.successCount,
        'success count',
      ),
      failureCount: addMetricCounter(
        aggregate.provider.failureCount,
        row.failureCount,
        'failure count',
      ),
      rateLimitCount: addMetricCounter(
        aggregate.provider.rateLimitCount,
        row.rateLimitCount,
        'rate-limit count',
      ),
    },
    validation: {
      ...aggregate.validation,
      acceptedSnapshotCount: addMetricCounter(
        aggregate.validation.acceptedSnapshotCount,
        row.acceptedSnapshotCount,
        'accepted-snapshot count',
      ),
      rejectedSnapshotCount: addMetricCounter(
        aggregate.validation.rejectedSnapshotCount,
        row.rejectedSnapshotCount,
        'rejected-snapshot count',
      ),
      invalidFieldCount: addMetricCounter(
        aggregate.validation.invalidFieldCount,
        row.invalidFieldCount,
        'invalid-field count',
      ),
    },
    delivery: {
      ...aggregate.delivery,
      acknowledgmentCount: addMetricCounter(
        aggregate.delivery.acknowledgmentCount,
        row.deliveryAcknowledgmentCount,
        'delivery acknowledgment count',
      ),
      timeoutCount: addMetricCounter(
        aggregate.delivery.timeoutCount,
        row.deliveryTimeoutCount,
        'delivery timeout count',
      ),
      sendFailureCount: addMetricCounter(
        aggregate.delivery.sendFailureCount,
        row.deliverySendFailureCount,
        'delivery send-failure count',
      ),
      invalidControlCount: addMetricCounter(
        aggregate.delivery.invalidControlCount,
        row.deliveryInvalidControlCount,
        'delivery invalid-control count',
      ),
      hibernationLossCount: addMetricCounter(
        aggregate.delivery.hibernationLossCount,
        row.deliveryHibernationLossCount,
        'delivery hibernation-loss count',
      ),
    },
  };
}

function emptyOperationsWindow(
  startedAt: string,
  accounting: OperationsAccounting,
): OperationsAggregateWindow {
  return {
    startedAt,
    provider: {
      accounting,
      pollCount: 0,
      successCount: 0,
      failureCount: 0,
      rateLimitCount: 0,
    },
    validation: {
      accounting,
      acceptedSnapshotCount: 0,
      rejectedSnapshotCount: 0,
      invalidFieldCount: 0,
    },
    delivery: emptyDeliveryCounters('best-effort'),
  };
}

function addPendingDelivery(
  aggregate: OperationsAggregateWindow,
  pending: DeliveryMetricDelta,
): OperationsAggregateWindow {
  return {
    ...aggregate,
    delivery: {
      ...aggregate.delivery,
      acknowledgmentCount: addMetricCounter(
        aggregate.delivery.acknowledgmentCount,
        pending.acknowledgmentCount,
        'delivery acknowledgment count',
      ),
      timeoutCount: addMetricCounter(
        aggregate.delivery.timeoutCount,
        pending.timeoutCount,
        'delivery timeout count',
      ),
      sendFailureCount: addMetricCounter(
        aggregate.delivery.sendFailureCount,
        pending.sendFailureCount,
        'delivery send-failure count',
      ),
      invalidControlCount: addMetricCounter(
        aggregate.delivery.invalidControlCount,
        pending.invalidControlCount,
        'delivery invalid-control count',
      ),
      hibernationLossCount: addMetricCounter(
        aggregate.delivery.hibernationLossCount,
        pending.hibernationLossCount,
        'delivery hibernation-loss count',
      ),
    },
  };
}

export async function readRegionalOperationsWindows(
  storage: Pick<DurableObjectStorage, 'list'>,
  checkedAt: string,
  pendingDelivery: DeliveryMetricDelta = {
    acknowledgmentCount: 0,
    timeoutCount: 0,
    sendFailureCount: 0,
    invalidControlCount: 0,
    hibernationLossCount: 0,
  },
): Promise<OperationsAggregateWindows> {
  if (!isCanonicalTimestamp(checkedAt)) throw new Error('The operations clock is invalid.');
  validateDeliveryDelta(pendingDelivery);
  const starts = operationsWindowStarts(checkedAt);
  const trailingStartMs = Date.parse(starts.trailing24Hours);
  const firstCompleteHourMs =
    trailingStartMs % HOUR_MS === 0
      ? trailingStartMs
      : trailingStartMs - (trailingStartMs % HOUR_MS) + HOUR_MS;
  const currentHourMs = Date.parse(starts.currentHour);
  const entries = await storage.list({
    start: `${METRIC_PREFIX}${new Date(firstCompleteHourMs).toISOString()}`,
    end: `${METRIC_PREFIX}${new Date(currentHourMs + HOUR_MS).toISOString()}`,
    limit: MAX_OPERATIONS_WINDOW_ROWS + 1,
  });
  if (entries.size > MAX_OPERATIONS_WINDOW_ROWS) {
    throw new Error('The operations metric window exceeds its bounded row limit.');
  }

  let currentHour = emptyOperationsWindow(starts.currentHour, 'exact');
  let trailing24Hours = emptyOperationsWindow(starts.trailing24Hours, 'best-effort');
  for (const [key, value] of entries) {
    if (!key.startsWith(METRIC_PREFIX)) {
      throw new Error('The persisted operations metric key is invalid.');
    }
    const hour = key.slice(METRIC_PREFIX.length);
    const timestamp = Date.parse(hour);
    if (!validPollTimestamp(timestamp) || hour !== metricHour(timestamp)) {
      throw new Error('The persisted operations metric key is invalid.');
    }
    const row = readHourlyMetrics(value, hour);
    trailing24Hours = addRowToWindow(trailing24Hours, row);
    if (hour === starts.currentHour) currentHour = addRowToWindow(currentHour, row);
  }
  return {
    currentHour: addPendingDelivery(currentHour, pendingDelivery),
    trailing24Hours: addPendingDelivery(trailing24Hours, pendingDelivery),
  };
}

/** Call within the transaction that also commits the next regional alarm. */
export async function removeExpiredFeedMetrics(
  storage: Pick<DurableObjectTransaction, 'list' | 'delete'>,
  nowMs: number,
): Promise<number> {
  if (!validPollTimestamp(nowMs)) throw new RangeError('Invalid metric cleanup timestamp.');
  const entries = await storage.list({
    prefix: METRIC_PREFIX,
    limit: METRIC_CLEANUP_BATCH_SIZE,
  });
  const expiredKeys = [...entries.keys()].filter((key) => expiryFromKey(key) <= nowMs);
  if (expiredKeys.length > 0) {
    await storage.delete(expiredKeys);
  }
  return expiredKeys.length;
}

export async function deferFeedMetricCleanup(
  storage: DurableObjectStorage,
  nowMs: number,
): Promise<void> {
  const retryAt = nowMs + METRIC_CLEANUP_RETRY_MS;
  if (!validPollTimestamp(nowMs) || !validPollTimestamp(retryAt))
    throw new RangeError('Invalid metric cleanup retry timestamp.');
  await storage.transaction(async (transaction) => {
    await transaction.put(METRIC_CLEANUP_RETRY_KEY, retryAt);
    const current = await transaction.getAlarm();
    // Keep a future poll alarm, but never repeatedly retry overdue cleanup at now.
    if (current === null || current <= nowMs || current > retryAt)
      await transaction.setAlarm(retryAt);
  });
}
