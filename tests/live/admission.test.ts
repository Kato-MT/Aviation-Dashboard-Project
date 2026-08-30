import { describe, expect, it, vi } from 'vitest';

import {
  REQUEST_ADMISSION_POLICY,
  WorkerRequestAdmission,
  type AdmissionDecision,
} from '../../worker/admission';
import { MAX_LIVE_MESSAGE_BYTES } from '../../src/live/validation';

function accepted(decision: AdmissionDecision) {
  expect(decision.ok).toBe(true);
  if (!decision.ok) throw new Error(`Expected admission, received ${decision.code}.`);
  return decision.lease;
}

function rejected(decision: AdmissionDecision, code: string, status: 429 | 503) {
  expect(decision).toMatchObject({ ok: false, code, status, scope: 'worker-isolate' });
  if (decision.ok) throw new Error('Expected admission rejection.');
  expect(decision.retryAfterSeconds).toBeGreaterThanOrEqual(1);
}

describe('bounded Worker request admission', () => {
  it('executes below, exact, over, recovery and ten-times sustained paths for every class', () => {
    const cases = [
      {
        name: 'total',
        burst: REQUEST_ADMISSION_POLICY.total.burst,
        rate: REQUEST_ADMISSION_POLICY.total.refillPerSecond,
        code: 'REQUEST_ADMISSION_LIMIT',
        admit: (controller: WorkerRequestAdmission) => controller.admitTotalAttempt(),
      },
      {
        name: 'preflight',
        burst: REQUEST_ADMISSION_POLICY.preflight.burst,
        rate: REQUEST_ADMISSION_POLICY.preflight.refillPerSecond,
        code: 'PREFLIGHT_ADMISSION_LIMIT',
        admit: (controller: WorkerRequestAdmission) => controller.admitPreflight(),
      },
      {
        name: 'region catalog',
        burst: REQUEST_ADMISSION_POLICY.regionCatalog.burst,
        rate: REQUEST_ADMISSION_POLICY.regionCatalog.refillPerSecond,
        code: 'REGION_CATALOG_ADMISSION_LIMIT',
        admit: (controller: WorkerRequestAdmission) => controller.admitRegionCatalog(),
      },
      {
        name: 'health',
        burst: REQUEST_ADMISSION_POLICY.health.burst,
        rate: REQUEST_ADMISSION_POLICY.health.refillPerSecond,
        code: 'HEALTH_ADMISSION_LIMIT',
        admit: (controller: WorkerRequestAdmission) => controller.admitHealth(),
      },
      {
        name: 'snapshot response bytes',
        burst: REQUEST_ADMISSION_POLICY.snapshot.responseByteBurst / MAX_LIVE_MESSAGE_BYTES,
        rate: REQUEST_ADMISSION_POLICY.snapshot.responseBytesPerSecond / MAX_LIVE_MESSAGE_BYTES,
        code: 'SNAPSHOT_ADMISSION_LIMIT',
        admit: (controller: WorkerRequestAdmission) => controller.admitSnapshot('atlanta'),
      },
      {
        name: 'stream',
        burst: REQUEST_ADMISSION_POLICY.stream.burst,
        rate: REQUEST_ADMISSION_POLICY.stream.refillPerSecond,
        code: 'STREAM_ADMISSION_LIMIT',
        admit: (controller: WorkerRequestAdmission) => controller.admitStream('atlanta'),
      },
      {
        name: 'map operations',
        burst: REQUEST_ADMISSION_POLICY.map.operationBurst,
        rate: REQUEST_ADMISSION_POLICY.map.operationsPerSecond,
        code: 'MAP_CAPACITY',
        admit: (controller: WorkerRequestAdmission) => controller.admitMap(1, 0),
      },
    ] as const;

    for (const testCase of cases) {
      let now = 0;
      let controller = new WorkerRequestAdmission(() => now);
      const take = () => {
        const decision = testCase.admit(controller);
        if (decision.ok) decision.lease.release();
        return decision;
      };
      accepted(take());
      for (let index = 1; index < testCase.burst; index++) accepted(take());
      rejected(take(), testCase.code, 429);
      now += Math.ceil(1_000 / testCase.rate) + 1;
      accepted(take());

      now = 0;
      controller = new WorkerRequestAdmission(() => now);
      const offeredRate = testCase.rate * 10;
      const durationSeconds = 10;
      const attempts = Math.ceil(offeredRate * durationSeconds);
      let admitted = 0;
      for (let index = 0; index < attempts; index++) {
        const decision = testCase.admit(controller);
        if (decision.ok) {
          admitted += 1;
          decision.lease.release();
        }
        now += 1_000 / offeredRate;
      }
      const theoreticalMaximum = Math.floor(testCase.burst + testCase.rate * durationSeconds);
      expect(admitted, testCase.name).toBeLessThanOrEqual(theoreticalMaximum);
      expect(admitted, testCase.name).toBeGreaterThanOrEqual(theoreticalMaximum - 1);
    }
  });

  it('enforces the exact total-attempt boundary and refills from a monotonic clock', () => {
    let now = 0;
    const admission = new WorkerRequestAdmission(() => now);
    for (let index = 0; index < REQUEST_ADMISSION_POLICY.total.burst; index++) {
      accepted(admission.admitTotalAttempt());
    }
    rejected(admission.admitTotalAttempt(), 'REQUEST_ADMISSION_LIMIT', 429);
    now += 16;
    accepted(admission.admitTotalAttempt());
  });

  it('bounds sustained traffic at ten times the configured total rate', () => {
    let now = 0;
    const admission = new WorkerRequestAdmission(() => now);
    let admitted = 0;
    const attempts = REQUEST_ADMISSION_POLICY.total.refillPerSecond * 10 * 10;
    for (let index = 0; index < attempts; index++) {
      if (admission.admitTotalAttempt().ok) admitted += 1;
      now += 1_000 / (REQUEST_ADMISSION_POLICY.total.refillPerSecond * 10);
    }
    const theoreticalMaximum =
      REQUEST_ADMISSION_POLICY.total.burst + REQUEST_ADMISSION_POLICY.total.refillPerSecond * 10;
    expect(admitted).toBeLessThanOrEqual(theoreticalMaximum);
    expect(admitted).toBeGreaterThanOrEqual(theoreticalMaximum - 1);
  });

  it('separately bounds health amplification and one in-flight fan-out', () => {
    let now = 0;
    const admission = new WorkerRequestAdmission(() => now);
    const first = accepted(admission.admitHealth());
    rejected(admission.admitHealth(), 'HEALTH_BUSY', 503);
    first.release();
    for (let index = 2; index < REQUEST_ADMISSION_POLICY.health.burst; index++) {
      const lease = accepted(admission.admitHealth());
      lease.release();
    }
    rejected(admission.admitHealth(), 'HEALTH_ADMISSION_LIMIT', 429);
    now += 5_000;
    accepted(admission.admitHealth()).release();
  });

  it('charges maximum snapshot bytes before regional work and recovers exactly', () => {
    let now = 0;
    const admission = new WorkerRequestAdmission(() => now);
    const immediate = REQUEST_ADMISSION_POLICY.snapshot.responseByteBurst / MAX_LIVE_MESSAGE_BYTES;
    for (let index = 0; index < immediate; index++) {
      accepted(admission.admitSnapshot('atlanta')).release();
    }
    rejected(admission.admitSnapshot('atlanta'), 'SNAPSHOT_ADMISSION_LIMIT', 429);
    now +=
      (MAX_LIVE_MESSAGE_BYTES / REQUEST_ADMISSION_POLICY.snapshot.responseBytesPerSecond) * 1_000;
    accepted(admission.admitSnapshot('atlanta')).release();
  });

  it('holds exact regional snapshot and stream concurrency leases', () => {
    let now = 0;
    const admission = new WorkerRequestAdmission(() => now);
    const snapshots = Array.from({ length: REQUEST_ADMISSION_POLICY.snapshot.concurrency }, () =>
      accepted(admission.admitSnapshot('savannah-statesboro')),
    );
    now += 250;
    rejected(admission.admitSnapshot('savannah-statesboro'), 'REGION_BUSY', 503);
    snapshots[0]!.release();
    now += 250;
    accepted(admission.admitSnapshot('savannah-statesboro')).release();
    snapshots.slice(1).forEach((lease) => lease.release());

    const streams = Array.from({ length: REQUEST_ADMISSION_POLICY.stream.concurrency }, () =>
      accepted(admission.admitStream('central-georgia')),
    );
    rejected(admission.admitStream('central-georgia'), 'REGION_BUSY', 503);
    streams.forEach((lease) => lease.release());
  });

  it('bounds map operations, response bytes and streaming concurrency independently', () => {
    let now = 0;
    let admission = new WorkerRequestAdmission(() => now);
    const mapLeases = Array.from({ length: REQUEST_ADMISSION_POLICY.map.concurrency }, () =>
      accepted(admission.admitMap(1, 0)),
    );
    rejected(admission.admitMap(1, 0), 'MAP_BUSY', 503);
    mapLeases.forEach((lease) => lease.release());

    admission = new WorkerRequestAdmission(() => now);
    for (let index = 0; index < REQUEST_ADMISSION_POLICY.map.operationBurst; index++) {
      accepted(admission.admitMap(1, 0)).release();
    }
    rejected(admission.admitMap(1, 0), 'MAP_CAPACITY', 429);

    admission = new WorkerRequestAdmission(() => now);
    const maximumRange = 8 * 1024 * 1024;
    for (
      let bytes = 0;
      bytes < REQUEST_ADMISSION_POLICY.map.responseByteBurst;
      bytes += maximumRange
    ) {
      accepted(admission.admitMap(1, maximumRange)).release();
    }
    rejected(admission.admitMap(1, maximumRange), 'MAP_CAPACITY', 429);
    now += 500;
    accepted(admission.admitMap(1, maximumRange)).release();
  });

  it('fails closed on clock regression and rejects unbounded region keys', () => {
    let now = 100;
    const admission = new WorkerRequestAdmission(() => now);
    now = 99;
    rejected(admission.admitTotalAttempt(), 'REQUEST_ADMISSION_UNAVAILABLE', 503);
    expect(() => admission.admitSnapshot('worldwide')).toThrow(
      'Admission requires a fixed regional preset.',
    );
  });

  it('exposes only bounded worker-isolate admission aggregates', () => {
    const wallClock = Date.parse('2026-08-29T16:30:00.000Z');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(wallClock);
    try {
      const admission = new WorkerRequestAdmission(() => 0);
      const first = accepted(admission.admitHealth());
      rejected(admission.admitHealth(), 'HEALTH_BUSY', 503);
      const snapshot = admission.operationsSnapshot('2026-08-29T16:30:00.000Z');
      expect(snapshot).toMatchObject({
        state: 'limited',
        reasonCodes: ['ADMISSION_LIMITED_CAPACITY'],
        scope: 'worker-isolate',
        windows: {
          currentHour: {
            startedAt: '2026-08-29T16:00:00.000Z',
            counters: {
              accounting: 'best-effort',
              acceptedCount: 1,
              rateLimitRejectionCount: 0,
              capacityRejectionCount: 1,
            },
          },
          trailing24Hours: {
            startedAt: '2026-08-28T16:30:00.000Z',
            counters: {
              accounting: 'best-effort',
              acceptedCount: 1,
              rateLimitRejectionCount: 0,
              capacityRejectionCount: 1,
            },
          },
        },
      });
      expect(Object.isFrozen(snapshot.windows.currentHour.counters)).toBe(true);
      expect(JSON.stringify(snapshot)).not.toMatch(/requestId|client|ipAddress|userAgent/i);
      first.release();
    } finally {
      clock.mockRestore();
    }
  });
});
