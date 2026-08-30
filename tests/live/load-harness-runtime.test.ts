import { performance as monotonicClock } from 'node:perf_hooks';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildMeasurementEvidence,
  captureSequenceWatermarkAtBoundary,
  expectedMemorySchedule,
  freezeAndDrainAcknowledgments,
  freshMetrics,
  loadHarnessClientOrigin,
  startMemorySampler,
  type DeliveryFrameReceipt,
  type MeasurementClient,
  type ProbeObservation,
  type RecordedAckTiming,
  type SnapshotReceipt,
} from '../../tools/live/loadHarness';
import type { WorkerdMemorySampler } from '../../tools/live/workerdMemorySampler';

let monotonicMs = 0;

async function advanceMonotonicTimeBy(durationMs: number): Promise<void> {
  monotonicMs += durationMs;
  await vi.advanceTimersByTimeAsync(durationMs);
}

function workerdReader(sampleDurationsMs: readonly number[] = []) {
  let sampleIndex = 0;
  const sample = vi.fn(async () => {
    const startedAtMonotonicMs = monotonicClock.now();
    const requestedDurationMs = sampleDurationsMs[sampleIndex] ?? 0;
    sampleIndex += 1;
    if (requestedDurationMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, requestedDurationMs));
    }
    const completedAtMonotonicMs = monotonicClock.now();
    return {
      status: 'available' as const,
      pids: [41],
      rssBytes: 256 * 1_024 * 1_024,
      error: null,
      message: 'Synthetic targeted workerd sample.',
      startedAtMonotonicMs,
      completedAtMonotonicMs,
      durationMs: completedAtMonotonicMs - startedAtMonotonicMs,
    };
  });
  const reader: WorkerdMemorySampler = {
    discovery: {
      status: 'available',
      pids: [41],
      error: null,
      message: 'Synthetic workerd discovery.',
      startedAtMonotonicMs: 0,
      completedAtMonotonicMs: 0,
      durationMs: 0,
    },
    sample,
    async close() {
      const now = monotonicClock.now();
      return {
        status: 'closed',
        pids: [41],
        error: null,
        message: 'Synthetic workerd sampler closed.',
        startedAtMonotonicMs: now,
        completedAtMonotonicMs: now,
        durationMs: 0,
      };
    },
  };
  return { reader, sample };
}

function client(index: number, openedAtMonotonicMs = 0): MeasurementClient {
  return { index, regionId: 'atlanta', stalled: false, openedAtMonotonicMs };
}

function snapshotReceipt(
  clientIndex: number,
  sequence: number,
  receivedAtMonotonicMs: number,
  bytes = 100,
  deliveryId = `delivery-${sequence}-${clientIndex}`,
): SnapshotReceipt {
  return {
    regionId: 'atlanta',
    sequence,
    clientIndex,
    deliveryId,
    receivedAtMonotonicMs,
    bytes,
  };
}

function acknowledgment(receipt: SnapshotReceipt, callbackMonotonicMs: number): RecordedAckTiming {
  return {
    clientIndex: receipt.clientIndex,
    deliveryId: receipt.deliveryId,
    configuredDelayMs: 0,
    receivedMonotonicMs: receipt.receivedAtMonotonicMs,
    timerFiredMonotonicMs: callbackMonotonicMs,
    callbackMonotonicMs,
    regionId: receipt.regionId,
    snapshotSequence: receipt.sequence,
    succeeded: true,
  };
}

function ackProbe(
  receipt: SnapshotReceipt,
  ack: RecordedAckTiming,
  sentAtMonotonicMs: number,
  completedAtMonotonicMs: number,
): ProbeObservation {
  return {
    requestId: `probe-${receipt.deliveryId}`,
    clientIndex: receipt.clientIndex,
    purpose: 'ack-proof',
    precedingAcknowledgment: {
      deliveryId: receipt.deliveryId,
      regionId: receipt.regionId,
      snapshotSequence: receipt.sequence,
      callbackMonotonicMs: ack.callbackMonotonicMs,
    },
    sentAtMonotonicMs,
    outcome: 'matched',
    completedAtMonotonicMs,
    roundTripMs: completedAtMonotonicMs - sentAtMonotonicMs,
  };
}

function deliveryFrame(receipt: SnapshotReceipt): DeliveryFrameReceipt {
  return {
    clientIndex: receipt.clientIndex,
    regionId: receipt.regionId,
    deliveryId: receipt.deliveryId,
    snapshotSequence: receipt.sequence,
    receivedAtMonotonicMs: receipt.receivedAtMonotonicMs,
    bytes: receipt.bytes,
  };
}

describe('load-harness compiled origin binding', () => {
  it('uses the generated policy-bound origin without mutating Worker bindings', () => {
    expect(
      loadHarnessClientOrigin({
        vars: {
          ALLOWED_ORIGINS: 'http://127.0.0.1:4174,http://localhost:4174',
        },
      }),
    ).toBe('http://127.0.0.1:4174');
    expect(() =>
      loadHarnessClientOrigin({ vars: { ALLOWED_ORIGINS: 'http://127.0.0.1:4174/' } }),
    ).toThrow('Generated Worker allowed origins are invalid.');
  });
});

describe('load-harness absolute memory sampler', () => {
  beforeEach(() => {
    monotonicMs = 0;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.spyOn(monotonicClock, 'now').mockImplementation(() => monotonicMs);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('samples on absolute deadlines and adds one explicit final-boundary sample', async () => {
    const metrics = freshMetrics();
    const { reader, sample } = workerdReader();
    const startedAt = monotonicClock.now();
    const sampler = startMemorySampler(metrics, startedAt, 1_000, 2_500, reader);

    await advanceMonotonicTimeBy(0);
    await advanceMonotonicTimeBy(1_000);
    await advanceMonotonicTimeBy(1_000);
    await advanceMonotonicTimeBy(500);
    const result = await sampler.stop();

    expect(result).toEqual({ missedScheduledSlots: 0 });
    expect(sample).toHaveBeenCalledTimes(4);
    expect(metrics.memory.map((entry) => entry.scheduledAtOffsetMs)).toEqual(
      expectedMemorySchedule(2_500, 1_000),
    );
    expect(metrics.memory.map((entry) => entry.startedAtOffsetMs)).toEqual([
      0, 1_000, 2_000, 2_500,
    ]);
    expect(metrics.memory.at(-1)).toMatchObject({
      scheduledAtOffsetMs: 2_500,
      startedAtOffsetMs: 2_500,
      completedAtOffsetMs: 2_500,
    });
  });

  it('skips elapsed slots after a delayed sample without shifting later deadlines', async () => {
    const metrics = freshMetrics();
    const { reader } = workerdReader([2_500]);
    const startedAt = monotonicClock.now();
    const sampler = startMemorySampler(metrics, startedAt, 1_000, 4_500, reader);

    await advanceMonotonicTimeBy(2_500);
    await advanceMonotonicTimeBy(500);
    await advanceMonotonicTimeBy(1_000);
    await advanceMonotonicTimeBy(500);
    const result = await sampler.stop();

    expect(result).toEqual({ missedScheduledSlots: 2 });
    expect(metrics.memory.map((entry) => entry.scheduledAtOffsetMs)).toEqual([
      0, 3_000, 4_000, 4_500,
    ]);
    expect(metrics.memory.map((entry) => entry.startedAtOffsetMs)).toEqual([
      0, 3_000, 4_000, 4_500,
    ]);
    expect(metrics.memory[0]).toMatchObject({
      scheduledAtOffsetMs: 0,
      completedAtOffsetMs: 2_500,
      pollDurationMs: 2_500,
    });
  });

  it('makes stop idempotent and records the final boundary only once', async () => {
    const metrics = freshMetrics();
    const { reader, sample } = workerdReader();
    const sampler = startMemorySampler(metrics, monotonicClock.now(), 1_000, 5_000, reader);
    await advanceMonotonicTimeBy(0);

    const firstStop = sampler.stop();
    const secondStop = sampler.stop();
    const [firstResult, secondResult] = await Promise.all([firstStop, secondStop]);
    const thirdResult = await sampler.stop();

    expect(firstResult).toEqual({ missedScheduledSlots: 0 });
    expect(secondResult).toEqual(firstResult);
    expect(thirdResult).toEqual(firstResult);
    expect(sample).toHaveBeenCalledTimes(2);
    expect(metrics.memory.map((entry) => entry.scheduledAtOffsetMs)).toEqual([0, 5_000]);
  });
});

describe('load-harness bounded ACK drain', () => {
  beforeEach(() => {
    monotonicMs = 0;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.spyOn(monotonicClock, 'now').mockImplementation(() => monotonicMs);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('freezes ACK admission synchronously and resolves after outstanding callbacks drain', async () => {
    const clients = [
      { acceptingAcknowledgments: true, pendingAcknowledgments: 1 },
      { acceptingAcknowledgments: true, pendingAcknowledgments: 2 },
    ];

    const drained = freezeAndDrainAcknowledgments(clients, 100);
    expect(clients.map((entry) => entry.acceptingAcknowledgments)).toEqual([false, false]);

    setTimeout(() => {
      clients[0]!.pendingAcknowledgments = 0;
      clients[1]!.pendingAcknowledgments = 0;
    }, 40);
    await advanceMonotonicTimeBy(50);

    await expect(drained).resolves.toBe(true);
  });

  it('returns false at the bounded timeout when an ACK callback never drains', async () => {
    const clients = [{ acceptingAcknowledgments: true, pendingAcknowledgments: 1 }];
    const drained = freezeAndDrainAcknowledgments(clients, 60);

    await advanceMonotonicTimeBy(60);

    await expect(drained).resolves.toBe(false);
    expect(clients[0]!.acceptingAcknowledgments).toBe(false);
  });
});

describe('load-harness measurement boundaries', () => {
  it('captures only provider calls at or before the exact start boundary', () => {
    const result = captureSequenceWatermarkAtBoundary(
      ['atlanta'],
      new Map([['atlanta', [50, 199, 200, 201, 500]]]),
      1_000,
      () => 1_200,
    );

    expect(result.capturedAtMonotonicMs).toBe(1_200);
    expect(result.target.get('atlanta')).toBe(3);
  });

  it('excludes a provider call colliding with measurement start from measured cadence', () => {
    const metrics = freshMetrics();
    metrics.snapshotReceipts.push(snapshotReceipt(0, 2, 220), snapshotReceipt(0, 3, 410));

    const evidence = buildMeasurementEvidence({
      clients: [client(0)],
      metrics,
      regionIds: ['atlanta'],
      providerCallOffsetsByRegion: new Map([['atlanta', [100, 200, 400]]]),
      runStartedAtMonotonicMs: 0,
      measurementStartedAtMonotonicMs: 100,
      measurementFinishedAtMonotonicMs: 400,
      startSequenceByRegion: new Map([['atlanta', 1]]),
      endSequenceByRegion: new Map([['atlanta', 3]]),
    });

    expect(evidence.providerCallOffsetsByRegion.get('atlanta')).toEqual([200, 400]);
    expect(evidence.sequenceCoverage).toEqual([
      {
        regionId: 'atlanta',
        startSequence: 1,
        endSequence: 3,
        expectedSequences: 2,
        completeSequences: 2,
        expectedReceipts: 2,
        coveredReceipts: 2,
        duplicateReceipts: 0,
      },
    ]);
    expect(evidence.snapshotReceipts.map((receipt) => receipt.sequence)).toEqual([2, 3]);
  });

  it('keeps a complete in-window sequence while explicitly recording its late drain', () => {
    const metrics = freshMetrics();
    const first = snapshotReceipt(0, 1, 175);
    const late = snapshotReceipt(1, 1, 220);
    const firstAck = acknowledgment(first, 180);
    const lateAck = acknowledgment(late, 230);
    metrics.snapshotReceipts.push(first, late);
    metrics.ackTimings.push(firstAck, lateAck);
    metrics.probeObservations.push(
      ackProbe(first, firstAck, 185, 190),
      ackProbe(late, lateAck, 231, 240),
    );

    const evidence = buildMeasurementEvidence({
      clients: [client(0), client(1)],
      metrics,
      regionIds: ['atlanta'],
      providerCallOffsetsByRegion: new Map([['atlanta', [150]]]),
      runStartedAtMonotonicMs: 0,
      measurementStartedAtMonotonicMs: 100,
      measurementFinishedAtMonotonicMs: 200,
      startSequenceByRegion: new Map([['atlanta', 0]]),
      endSequenceByRegion: new Map([['atlanta', 1]]),
    });

    expect(evidence.sequenceCoverage[0]).toMatchObject({
      expectedSequences: 1,
      completeSequences: 1,
      expectedReceipts: 2,
      coveredReceipts: 2,
    });
    expect(evidence.snapshotReceipts).toHaveLength(2);
    expect(evidence.ackTimings).toHaveLength(2);
    expect(evidence.probes).toHaveLength(2);
    expect(evidence.fanoutSpreadMs).toEqual([45]);
    expect(evidence.drain).toEqual({
      snapshotReceiptsAfterBoundary: 1,
      ackCallbacksAfterBoundary: 1,
      probeMatchesAfterBoundary: 1,
    });
  });

  it('excludes an ACK probe caused by setup traffic even when it completes in the window', () => {
    const metrics = freshMetrics();
    const measured = snapshotReceipt(0, 2, 160);
    const setup = snapshotReceipt(0, 1, 80, 100, 'setup-delivery');
    const measuredAck = acknowledgment(measured, 165);
    const setupAck = acknowledgment(setup, 85);
    metrics.snapshotReceipts.push(setup, measured);
    metrics.ackTimings.push(setupAck, measuredAck);
    metrics.probeObservations.push(
      ackProbe(setup, setupAck, 110, 115),
      ackProbe(measured, measuredAck, 170, 175),
    );

    const evidence = buildMeasurementEvidence({
      clients: [client(0)],
      metrics,
      regionIds: ['atlanta'],
      providerCallOffsetsByRegion: new Map([['atlanta', [50, 150]]]),
      runStartedAtMonotonicMs: 0,
      measurementStartedAtMonotonicMs: 100,
      measurementFinishedAtMonotonicMs: 200,
      startSequenceByRegion: new Map([['atlanta', 1]]),
      endSequenceByRegion: new Map([['atlanta', 2]]),
    });

    expect(evidence.snapshotReceipts.map((receipt) => receipt.deliveryId)).toEqual([
      measured.deliveryId,
    ]);
    expect(evidence.ackTimings.map((timing) => timing.deliveryId)).toEqual([measured.deliveryId]);
    expect(evidence.probes.map((probe) => probe.requestId)).toEqual([
      `probe-${measured.deliveryId}`,
    ]);
  });

  it('separates genuine post-boundary traffic from a late in-window delivery', () => {
    const metrics = freshMetrics();
    const lateInWindow = snapshotReceipt(0, 1, 220, 111);
    const postBoundary = snapshotReceipt(0, 2, 260, 777);
    metrics.snapshotReceipts.push(lateInWindow, postBoundary);
    metrics.deliveryFrameReceipts.push(deliveryFrame(lateInWindow), deliveryFrame(postBoundary), {
      clientIndex: 0,
      regionId: 'atlanta',
      deliveryId: 'control-after-boundary',
      snapshotSequence: null,
      receivedAtMonotonicMs: 270,
      bytes: 55,
    });

    const evidence = buildMeasurementEvidence({
      clients: [client(0)],
      metrics,
      regionIds: ['atlanta'],
      providerCallOffsetsByRegion: new Map([['atlanta', [150, 250]]]),
      runStartedAtMonotonicMs: 0,
      measurementStartedAtMonotonicMs: 100,
      measurementFinishedAtMonotonicMs: 200,
      startSequenceByRegion: new Map([['atlanta', 0]]),
      endSequenceByRegion: new Map([['atlanta', 1]]),
    });

    expect(evidence.snapshotReceipts).toEqual([lateInWindow]);
    expect(evidence.drain.snapshotReceiptsAfterBoundary).toBe(1);
    expect(evidence.postBoundary).toEqual({
      providerCalls: 1,
      deliveryFrames: 1,
      snapshotReceipts: 1,
      receivedBytes: 777,
      lateInWindowDeliveryFrames: 1,
      controlDeliveryFramesAfterBoundary: 1,
    });
  });
});
