import { LIVE_PILOT_POLICY } from './pilotPolicy';

export const RUNTIME_POLICY_LIMITS_SCHEMA_VERSION = 'runtime-policy-limits.v2' as const;

function deepFreeze<T>(value: T, visited = new WeakSet<object>()): Readonly<T> {
  if (typeof value !== 'object' || value === null || visited.has(value)) return value;
  visited.add(value);
  for (const child of Object.values(value)) deepFreeze(child, visited);
  return Object.freeze(value);
}

/**
 * The one versioned numeric contract shared by runtime enforcement and release gates.
 * Values are intentionally target-independent until an approved operating envelope
 * introduces a separately reviewed policy version.
 */
export const RUNTIME_POLICY_LIMITS = deepFreeze({
  schemaVersion: RUNTIME_POLICY_LIMITS_SCHEMA_VERSION,
  protocol: {
    maximumMessageBytes: 2 * 1024 * 1024,
    maximumAircraft: 2_000,
    maximumValidationErrors: 32,
    maximumFutureOffsetMs: 5_000,
  },
  provider: {
    maximumResponseBytes: 2 * 1024 * 1024,
    maximumAircraft: 2_000,
    requestTimeoutMs: 8_000,
    pollIntervalMs: LIVE_PILOT_POLICY.pollIntervalMs,
    circuitBreakerFailures: 3,
    circuitBreakerMs: 60_000,
  },
  history: {
    retentionMs: 15 * 60 * 1_000,
    maximumSamplesPerAircraft: 120,
    maximumAircraft: 500,
    maximumQualityEvents: 200,
  },
  delivery: {
    maximumRegionalViewers: LIVE_PILOT_POLICY.maximumConcurrentViewers,
    maximumRegionalBytes: 8 * 1024 * 1024,
    acknowledgmentTimeoutMs: 10_000,
    minimumPingIntervalMs: 1_000,
    maximumViewerAttachmentBytes: 1_024,
    controlWindowMs: 1_000,
    maximumControlsPerWindow: 8,
    maximumRegionalControlBurst: 512,
    regionalControlRefillPerSecond: 256,
    maximumControlBytes: 512,
    maximumHandshakeBytes: 1_024,
    maximumMessagesPerDelivery: 4,
  },
  admission: {
    total: { burst: 512, refillPerSecond: 64 },
    preflight: { burst: 64, refillPerSecond: 2 },
    regionCatalog: { burst: 128, refillPerSecond: 4 },
    health: { burst: 6, refillPerSecond: 0.2, concurrency: 1 },
    snapshot: {
      burst: 128,
      refillPerSecond: 4,
      responseByteBurst: 16 * 1024 * 1024,
      responseBytesPerSecond: 8 * 1024 * 1024,
      concurrency: 8,
    },
    stream: { burst: 128, refillPerSecond: 4, concurrency: 8 },
    map: {
      operationBurst: 128,
      operationsPerSecond: 16,
      responseByteBurst: 64 * 1024 * 1024,
      responseBytesPerSecond: 16 * 1024 * 1024,
      concurrency: 8,
    },
  },
  map: {
    maximumRangeBytes: 8 * 1024 * 1024,
  },
  browser: {
    bundle: {
      initialShellGzipBytes: 200 * 1024,
      lazyMapGzipBytes: 500 * 1024,
    },
    performance: {
      paintWarmups: 5,
      paintIterations: 30,
      paintP95Ms: { desktop: 500, mobile: 750 },
      interactionLimitMs: { desktop: 1_000, mobile: 1_000 },
      ageTickLimitMs: { desktop: 250, mobile: 375 },
      browserJsHeapBytes: 512 * 1024 * 1024,
      ageTickJsHeapGrowthBytes: 16 * 1024 * 1024,
      responseBodyBytes: 64 * 1024 * 1024,
    },
  },
} as const);

export type RuntimePolicyLimits = typeof RUNTIME_POLICY_LIMITS;
