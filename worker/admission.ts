import { isCanonicalTimestamp, MAX_LIVE_MESSAGE_BYTES } from '../src/live/validation';
import { REGION_CONFIGS, type RegionId } from '../src/live/regions';
import { RUNTIME_POLICY_LIMITS } from '../src/live/runtimePolicyLimits';
import { classifyAdmissionOperations } from '../src/operations/classifier';
import {
  MAX_OPERATIONS_COUNTER,
  operationsWindowStarts,
  type OperationsAdmission,
} from '../src/operations/contract';
import { validPollTimestamp } from './polling';

export const REQUEST_ADMISSION_POLICY = RUNTIME_POLICY_LIMITS.admission;

export type AdmissionCounterScope = 'worker-isolate';

export interface AdmissionLease {
  release(): void;
}

export type AdmissionDecision =
  | { ok: true; lease: AdmissionLease }
  | {
      ok: false;
      status: 429 | 503;
      code: string;
      retryAfterSeconds: number;
      scope: AdmissionCounterScope;
    };

interface TokenPolicy {
  burst: number;
  refillPerSecond: number;
}

type AdmissionClock = () => number;
interface AdmissionAggregateFields {
  acceptedCount: number;
  rateLimitRejectionCount: number;
  capacityRejectionCount: number;
}

const HOUR_MS = 60 * 60 * 1_000;

function emptyAdmissionAggregate(): AdmissionAggregateFields {
  return {
    acceptedCount: 0,
    rateLimitRejectionCount: 0,
    capacityRejectionCount: 0,
  };
}

const acceptedWithoutLease: AdmissionDecision = {
  ok: true,
  lease: Object.freeze({ release() {} }),
};

class TokenBucket {
  private tokens: number;
  private updatedAt: number;

  constructor(
    private readonly policy: TokenPolicy,
    private readonly clock: AdmissionClock,
  ) {
    if (
      !Number.isSafeInteger(policy.burst) ||
      policy.burst < 1 ||
      !Number.isFinite(policy.refillPerSecond) ||
      policy.refillPerSecond <= 0
    ) {
      throw new Error('Admission token policy is invalid.');
    }
    this.tokens = policy.burst;
    this.updatedAt = this.readClock();
  }

  consume(amount = 1): { ok: true } | { ok: false; retryAfterMilliseconds: number } {
    if (!Number.isSafeInteger(amount) || amount < 0 || amount > this.policy.burst) {
      throw new Error('Admission token amount is invalid.');
    }
    const now = this.readClock();
    if (now < this.updatedAt) throw new Error('Admission clock regressed.');
    const elapsedSeconds = (now - this.updatedAt) / 1_000;
    this.tokens = Math.min(
      this.policy.burst,
      this.tokens + elapsedSeconds * this.policy.refillPerSecond,
    );
    this.updatedAt = now;
    if (this.tokens + Number.EPSILON >= amount) {
      this.tokens = Math.max(0, this.tokens - amount);
      return { ok: true };
    }
    return {
      ok: false,
      retryAfterMilliseconds: Math.ceil(
        ((amount - this.tokens) / this.policy.refillPerSecond) * 1_000,
      ),
    };
  }

  private readClock(): number {
    const value = this.clock();
    if (!Number.isFinite(value) || value < 0) throw new Error('Admission clock is invalid.');
    return value;
  }
}

class Semaphore {
  private active = 0;

  constructor(private readonly maximum: number) {
    if (!Number.isSafeInteger(maximum) || maximum < 1)
      throw new Error('Admission concurrency policy is invalid.');
  }

  acquire(): AdmissionLease | undefined {
    if (this.active >= this.maximum) return undefined;
    this.active += 1;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.active -= 1;
      },
    };
  }
}

function fixedRegion(regionId: string): asserts regionId is RegionId {
  if (!REGION_CONFIGS.some((region) => region.id === regionId)) {
    throw new Error('Admission requires a fixed regional preset.');
  }
}

function rejection(
  code: string,
  status: 429 | 503,
  retryAfterMilliseconds: number,
): AdmissionDecision {
  return {
    ok: false,
    code,
    status,
    retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMilliseconds / 1_000)),
    scope: 'worker-isolate',
  };
}

export class WorkerRequestAdmission {
  private readonly total: TokenBucket;
  private readonly preflight: TokenBucket;
  private readonly regionCatalog: TokenBucket;
  private readonly health: TokenBucket;
  private readonly snapshot = new Map<RegionId, TokenBucket>();
  private readonly snapshotBytes = new Map<RegionId, TokenBucket>();
  private readonly stream = new Map<RegionId, TokenBucket>();
  private readonly mapOperations: TokenBucket;
  private readonly mapBytes: TokenBucket;
  private readonly healthConcurrency = new Semaphore(REQUEST_ADMISSION_POLICY.health.concurrency);
  private readonly snapshotConcurrency = new Map<RegionId, Semaphore>();
  private readonly streamConcurrency = new Map<RegionId, Semaphore>();
  private readonly mapConcurrency = new Semaphore(REQUEST_ADMISSION_POLICY.map.concurrency);
  private readonly aggregateHours = new Map<string, AdmissionAggregateFields>();
  private unavailableHour: string | undefined;

  constructor(clock: AdmissionClock = () => performance.now()) {
    this.total = new TokenBucket(REQUEST_ADMISSION_POLICY.total, clock);
    this.preflight = new TokenBucket(REQUEST_ADMISSION_POLICY.preflight, clock);
    this.regionCatalog = new TokenBucket(REQUEST_ADMISSION_POLICY.regionCatalog, clock);
    this.health = new TokenBucket(REQUEST_ADMISSION_POLICY.health, clock);
    this.mapOperations = new TokenBucket(
      {
        burst: REQUEST_ADMISSION_POLICY.map.operationBurst,
        refillPerSecond: REQUEST_ADMISSION_POLICY.map.operationsPerSecond,
      },
      clock,
    );
    this.mapBytes = new TokenBucket(
      {
        burst: REQUEST_ADMISSION_POLICY.map.responseByteBurst,
        refillPerSecond: REQUEST_ADMISSION_POLICY.map.responseBytesPerSecond,
      },
      clock,
    );
    for (const region of REGION_CONFIGS) {
      this.snapshot.set(region.id, new TokenBucket(REQUEST_ADMISSION_POLICY.snapshot, clock));
      this.snapshotBytes.set(
        region.id,
        new TokenBucket(
          {
            burst: REQUEST_ADMISSION_POLICY.snapshot.responseByteBurst,
            refillPerSecond: REQUEST_ADMISSION_POLICY.snapshot.responseBytesPerSecond,
          },
          clock,
        ),
      );
      this.stream.set(region.id, new TokenBucket(REQUEST_ADMISSION_POLICY.stream, clock));
      this.snapshotConcurrency.set(
        region.id,
        new Semaphore(REQUEST_ADMISSION_POLICY.snapshot.concurrency),
      );
      this.streamConcurrency.set(
        region.id,
        new Semaphore(REQUEST_ADMISSION_POLICY.stream.concurrency),
      );
    }
  }

  admitTotalAttempt(): AdmissionDecision {
    const decision = this.consume(this.total, 'REQUEST_ADMISSION_LIMIT');
    if (!decision.ok) this.recordDecision(decision);
    return decision;
  }

  admitPreflight(): AdmissionDecision {
    return this.recordDecision(this.consume(this.preflight, 'PREFLIGHT_ADMISSION_LIMIT'));
  }

  admitRegionCatalog(): AdmissionDecision {
    return this.recordDecision(this.consume(this.regionCatalog, 'REGION_CATALOG_ADMISSION_LIMIT'));
  }

  admitHealth(): AdmissionDecision {
    const rate = this.consume(this.health, 'HEALTH_ADMISSION_LIMIT');
    if (!rate.ok) return this.recordDecision(rate);
    return this.recordDecision(this.acquire(this.healthConcurrency, 'HEALTH_BUSY'));
  }

  admitSnapshot(regionId: string): AdmissionDecision {
    fixedRegion(regionId);
    const rate = this.consume(this.snapshot.get(regionId)!, 'SNAPSHOT_ADMISSION_LIMIT');
    if (!rate.ok) return this.recordDecision(rate);
    const bytes = this.consume(
      this.snapshotBytes.get(regionId)!,
      'SNAPSHOT_ADMISSION_LIMIT',
      MAX_LIVE_MESSAGE_BYTES,
    );
    if (!bytes.ok) return this.recordDecision(bytes);
    return this.recordDecision(
      this.acquire(this.snapshotConcurrency.get(regionId)!, 'REGION_BUSY'),
    );
  }

  admitStream(regionId: string): AdmissionDecision {
    fixedRegion(regionId);
    const rate = this.consume(this.stream.get(regionId)!, 'STREAM_ADMISSION_LIMIT');
    if (!rate.ok) return this.recordDecision(rate);
    return this.recordDecision(this.acquire(this.streamConcurrency.get(regionId)!, 'REGION_BUSY'));
  }

  admitMap(operations: number, responseBytes: number): AdmissionDecision {
    const operation = this.consume(this.mapOperations, 'MAP_CAPACITY', operations);
    if (!operation.ok) return this.recordDecision(operation);
    const bytes = this.consume(this.mapBytes, 'MAP_CAPACITY', responseBytes);
    if (!bytes.ok) return this.recordDecision(bytes);
    return this.recordDecision(this.acquire(this.mapConcurrency, 'MAP_BUSY'));
  }

  /** Runtime-local best-effort aggregate; the Worker entrypoint owns projection wiring. */
  operationsSnapshot(checkedAt = new Date().toISOString()): Readonly<OperationsAdmission> {
    if (!isCanonicalTimestamp(checkedAt))
      throw new Error('The admission operations clock is invalid.');
    const starts = operationsWindowStarts(checkedAt);
    const trailingStartMs = Date.parse(starts.trailing24Hours);
    const firstCompleteHourMs =
      trailingStartMs % HOUR_MS === 0
        ? trailingStartMs
        : trailingStartMs - (trailingStartMs % HOUR_MS) + HOUR_MS;
    const current = {
      ...emptyAdmissionAggregate(),
      ...(this.aggregateHours.get(starts.currentHour) ?? {}),
    };
    const trailing = emptyAdmissionAggregate();
    for (const [hour, counters] of this.aggregateHours) {
      const hourMs = Date.parse(hour);
      if (hourMs < firstCompleteHourMs || hourMs > Date.parse(starts.currentHour)) continue;
      for (const key of Object.keys(trailing) as Array<keyof AdmissionAggregateFields>) {
        trailing[key] = Math.min(MAX_OPERATIONS_COUNTER, trailing[key] + counters[key]);
      }
    }
    const classification = classifyAdmissionOperations(
      this.unavailableHour === starts.currentHour
        ? { available: false }
        : { available: true, ...current },
    );
    return Object.freeze({
      ...classification,
      scope: 'worker-isolate',
      windows: Object.freeze({
        currentHour: Object.freeze({
          startedAt: starts.currentHour,
          counters: Object.freeze({ accounting: 'best-effort', ...current }),
        }),
        trailing24Hours: Object.freeze({
          startedAt: starts.trailing24Hours,
          counters: Object.freeze({ accounting: 'best-effort', ...trailing }),
        }),
      }),
    });
  }

  private consume(bucket: TokenBucket, code: string, amount = 1): AdmissionDecision {
    try {
      const decision = bucket.consume(amount);
      return decision.ok
        ? acceptedWithoutLease
        : rejection(code, 429, decision.retryAfterMilliseconds);
    } catch {
      return rejection('REQUEST_ADMISSION_UNAVAILABLE', 503, 1_000);
    }
  }

  private acquire(semaphore: Semaphore, code: string): AdmissionDecision {
    const lease = semaphore.acquire();
    return lease ? { ok: true, lease } : rejection(code, 503, 1_000);
  }

  private recordDecision(decision: AdmissionDecision): AdmissionDecision {
    const now = Date.now();
    if (!validPollTimestamp(now)) {
      this.unavailableHour = undefined;
      return decision;
    }
    const hour = new Date(now - (now % HOUR_MS)).toISOString();
    const counters = this.aggregateHours.get(hour) ?? emptyAdmissionAggregate();
    if (decision.ok) {
      counters.acceptedCount = Math.min(MAX_OPERATIONS_COUNTER, counters.acceptedCount + 1);
    } else if (decision.status === 429) {
      counters.rateLimitRejectionCount = Math.min(
        MAX_OPERATIONS_COUNTER,
        counters.rateLimitRejectionCount + 1,
      );
    } else if (decision.code === 'REQUEST_ADMISSION_UNAVAILABLE') {
      this.unavailableHour = hour;
    } else {
      counters.capacityRejectionCount = Math.min(
        MAX_OPERATIONS_COUNTER,
        counters.capacityRejectionCount + 1,
      );
    }
    this.aggregateHours.set(hour, counters);
    const oldest = now - 24 * HOUR_MS;
    for (const candidate of this.aggregateHours.keys()) {
      if (Date.parse(candidate) < oldest - (oldest % HOUR_MS))
        this.aggregateHours.delete(candidate);
    }
    return decision;
  }
}

let isolateAdmission = new WorkerRequestAdmission();

export function requestAdmission(): WorkerRequestAdmission {
  return isolateAdmission;
}

/** Test isolation only; production creates one bounded controller per Worker isolate. */
export function resetRequestAdmissionForTests(clock?: AdmissionClock): void {
  isolateAdmission = new WorkerRequestAdmission(clock);
}
