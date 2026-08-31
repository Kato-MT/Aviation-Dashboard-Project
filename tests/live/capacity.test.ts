import { describe, expect, it } from 'vitest';
import {
  estimateContinuousRegionalUsage,
  regionalDeliveryCredit,
  summarizeDeliveryTraffic,
  summarizeRegionalOperations,
  type DeliveryTraffic,
  type RegionalOperationCounts,
} from '../../tools/live/capacityModel';
import { MAX_LIVE_MESSAGE_BYTES } from '../../src/live/validation';
import { MAX_LIVE_HANDSHAKE_BYTES } from '../../src/live/delivery';
import { MAX_REGIONAL_DELIVERY_BYTES, MAX_REGIONAL_VIEWERS } from '../../worker/deliveryPolicy';

const traffic = (overrides: Partial<DeliveryTraffic> = {}): DeliveryTraffic => ({
  offeredUpdates: 0,
  emittedDeliveries: 0,
  coalescedUpdates: 0,
  acceptedAcknowledgments: 0,
  incomingPings: 0,
  standalonePongs: 0,
  coDeliveredPongs: 0,
  healthOnlyDeliveries: 0,
  rejectedControls: 0,
  initialConnections: 0,
  reconnectAttempts: 0,
  acceptedReconnects: 0,
  rejectedReconnects: 0,
  ...overrides,
});
const operations = (overrides: Partial<RegionalOperationCounts> = {}): RegionalOperationCounts => ({
  successfulPolls: 0,
  failedPolls: 0,
  alarmSets: 0,
  alarmDeletes: 0,
  alarmReads: 0,
  alarmInvocations: 0,
  alarmRetryInvocations: 0,
  maintenancePuts: 0,
  deletedRows: 0,
  admissionPuts: 0,
  otherStatePuts: 0,
  attachmentWrites: 0,
  downstreamRequests: 0,
  ...overrides,
});

describe('source-counted continuous regional capacity model', () => {
  const baseline = { regions: 1, activeHoursPerRegion: 24, viewersPerRegion: 1 };

  it('counts control-state and alarm writes separately for one continuous region', () => {
    expect(estimateContinuousRegionalUsage(baseline)).toMatchObject({
      scheduledAttemptCeiling: 4_320,
      successKvRows: 38_880,
      scheduledAlarmRows: 8_640,
      minimumRowWritesAtSuccessCadence: 47_520,
      freeWriteHeadroomBeforeOtherWork: 52_480,
      incomingKeepaliveMessages: 2_880,
      keepaliveRequestEquivalent: 144,
      exceedsPublishedFreeWriteAllowance: false,
    });
  });

  it('flags the three-region continuous write budget before any unmodeled work', () => {
    expect(
      estimateContinuousRegionalUsage({
        ...baseline,
        regions: 3,
        viewersPerRegion: MAX_REGIONAL_VIEWERS,
      }),
    ).toMatchObject({
      scheduledAttemptCeiling: 12_960,
      minimumRowWritesAtSuccessCadence: 142_560,
      freeWriteHeadroomBeforeOtherWork: -42_560,
      incomingKeepaliveMessages: 216_000,
      keepaliveRequestEquivalent: 10_800,
      exceedsPublishedFreeWriteAllowance: true,
    });
  });

  it('does not multiply upstream polling or its base writes when viewer count increases', () => {
    const one = estimateContinuousRegionalUsage(baseline);
    const maximum = estimateContinuousRegionalUsage({
      ...baseline,
      viewersPerRegion: MAX_REGIONAL_VIEWERS,
    });
    expect(maximum.scheduledAttemptCeiling).toBe(one.scheduledAttemptCeiling);
    expect(maximum.minimumRowWritesAtSuccessCadence).toBe(one.minimumRowWritesAtSuccessCadence);
    expect(maximum.viewerConnectionHours).toBe(one.viewerConnectionHours * MAX_REGIONAL_VIEWERS);
    expect(maximum.incomingKeepaliveMessages).toBe(
      one.incomingKeepaliveMessages * MAX_REGIONAL_VIEWERS,
    );
  });

  it('handles zero active hours without inventing polls, connections or keepalives', () => {
    expect(estimateContinuousRegionalUsage({ ...baseline, activeHoursPerRegion: 0 })).toMatchObject(
      {
        scheduledAttemptCeiling: 0,
        initialConnections: 0,
        minimumRowWritesAtSuccessCadence: 0,
        incomingKeepaliveMessages: 0,
      },
    );
  });

  it('counts an initial attempt for a short continuous viewing window', () => {
    expect(
      estimateContinuousRegionalUsage({ ...baseline, activeHoursPerRegion: 1 / 3_600 })
        .scheduledAttemptCeiling,
    ).toBe(1);
  });

  it.each([
    { regions: 0 },
    { regions: 4 },
    { regions: 1.5 },
    { activeHoursPerRegion: -1 },
    { activeHoursPerRegion: 25 },
    { activeHoursPerRegion: Number.NaN },
    { viewersPerRegion: -1 },
    { viewersPerRegion: MAX_REGIONAL_VIEWERS + 1 },
    { viewersPerRegion: Infinity },
  ])('rejects an invalid scenario: %j', (change) => {
    expect(() => estimateContinuousRegionalUsage({ ...baseline, ...change })).toThrow(RangeError);
  });

  it.each([
    {
      regions: 1,
      dataAcknowledgments: 108_000,
      pings: 72_000,
      separate: 12_600,
      combined: 9_000,
    },
    {
      regions: 3,
      dataAcknowledgments: 324_000,
      pings: 216_000,
      separate: 37_800,
      combined: 27_000,
    },
  ])('counts ACK traffic separately from polling for $regions regions', (scenario) => {
    const input = {
      regions: scenario.regions,
      activeHoursPerRegion: 24,
      viewersPerRegion: MAX_REGIONAL_VIEWERS,
    };
    const separate = estimateContinuousRegionalUsage(input);
    expect(separate.dataAcknowledgments).toBe(scenario.dataAcknowledgments);
    expect(separate.steadyTraffic).toMatchObject({
      incomingPings: scenario.pings,
      standalonePongs: scenario.pings,
      acceptedAcknowledgments: scenario.dataAcknowledgments + scenario.pings,
      messageRequestEquivalent: scenario.separate,
    });
    const combined = estimateContinuousRegionalUsage({ ...input, pongDelivery: 'co-delivered' });
    expect(combined.steadyTraffic).toMatchObject({
      standalonePongs: 0,
      coDeliveredPongs: scenario.pings,
      acceptedAcknowledgments: scenario.dataAcknowledgments,
      messageRequestEquivalent: scenario.combined,
    });
  });

  it('does not invent provider polls for a zero-viewer maintenance-only period', () => {
    expect(estimateContinuousRegionalUsage({ ...baseline, viewersPerRegion: 0 })).toMatchObject({
      scheduledAttemptCeiling: 0,
      initialConnections: 0,
      incomingKeepaliveMessages: 0,
      dataAcknowledgments: 0,
      activeRegionHours: 0,
    });
    expect(
      summarizeRegionalOperations(
        operations({ deletedRows: 128, alarmInvocations: 1, alarmDeletes: 1 }),
      ),
    ).toMatchObject({
      pollKvRows: 0,
      documentedRowWrites: 128,
      assumedAlarmDeleteRows: 1,
      rowWriteEstimate: 129,
      activeGbSeconds: null,
    });
  });
});

describe('logical credit and explicit operation scenarios', () => {
  it('accounts for the entire envelope plus separately reserved handshake/close credit', () => {
    const maximum = MAX_LIVE_MESSAGE_BYTES;
    const reservedConnections = MAX_REGIONAL_VIEWERS * MAX_LIVE_HANDSHAKE_BYTES;
    expect(
      regionalDeliveryCredit(
        4,
        Array.from({ length: 4 }, () => ({ bytes: maximum })),
      ),
    ).toMatchObject({
      withinBudget: false,
      chargedBytes: MAX_REGIONAL_DELIVERY_BYTES + reservedConnections,
    });
    const exact = [maximum, maximum, maximum, maximum - reservedConnections].map((bytes) => ({
      bytes,
    }));
    expect(regionalDeliveryCredit(4, exact)).toMatchObject({
      withinBudget: true,
      availableBytes: 0,
    });
    exact[3]!.bytes += 1;
    expect(regionalDeliveryCredit(4, exact).withinBudget).toBe(false);
  });

  it('keeps all connection slots reserved as late viewers enter or leave', () => {
    const reservedConnections = MAX_REGIONAL_VIEWERS * MAX_LIVE_HANDSHAKE_BYTES;
    expect(regionalDeliveryCredit(0, [])).toMatchObject({
      handshakeAndCloseCredit: reservedConnections,
      chargedBytes: reservedConnections,
    });
    const windows = [
      { bytes: MAX_LIVE_MESSAGE_BYTES },
      { bytes: MAX_LIVE_MESSAGE_BYTES },
      { bytes: MAX_LIVE_MESSAGE_BYTES },
      { bytes: MAX_LIVE_MESSAGE_BYTES - reservedConnections },
    ];
    for (const viewers of [4, 5, MAX_REGIONAL_VIEWERS, 4]) {
      expect(regionalDeliveryCredit(viewers, windows)).toMatchObject({
        handshakeAndCloseCredit: reservedConnections,
        chargedBytes: MAX_REGIONAL_DELIVERY_BYTES,
        availableBytes: 0,
        withinBudget: true,
      });
    }
  });

  it('retains stalled and closing allocation until detachment, including mixed sizes', () => {
    const windows = [
      { bytes: 2_000, closing: true },
      { bytes: 64 * 1024 },
      { bytes: MAX_LIVE_MESSAGE_BYTES },
    ];
    const before = regionalDeliveryCredit(3, windows);
    expect(before.closingBytes).toBe(2_000);
    expect(regionalDeliveryCredit(3, windows).chargedBytes).toBe(before.chargedBytes);
    expect(regionalDeliveryCredit(2, windows.slice(1)).chargedBytes).toBe(
      before.chargedBytes - 2_000,
    );
    expect(
      regionalDeliveryCredit(
        MAX_REGIONAL_VIEWERS,
        Array.from({ length: MAX_REGIONAL_VIEWERS }, () => ({ bytes: 64 * 1024 })),
      ),
    ).toMatchObject({
      outstandingBytes: 1_638_400,
      withinBudget: true,
    });
  });

  it('uses explicit stalled/backoff counters instead of multiplying all offered updates', () => {
    const stalled = summarizeDeliveryTraffic(
      traffic({
        offeredUpdates: 1_000,
        emittedDeliveries: 100,
        coalescedUpdates: 900,
        healthOnlyDeliveries: 100,
        initialConnections: MAX_REGIONAL_VIEWERS,
        rejectedControls: 10,
      }),
    );
    expect(stalled).toMatchObject({
      acceptedAcknowledgments: 0,
      incomingMessages: 10,
      requestEquivalentIncludingConnections: 25.5,
    });
    const resumed = summarizeDeliveryTraffic(
      traffic({
        emittedDeliveries: 2,
        acceptedAcknowledgments: 2,
        healthOnlyDeliveries: 1,
        incomingPings: 1,
        standalonePongs: 1,
        initialConnections: 1,
        reconnectAttempts: 1,
        acceptedReconnects: 1,
      }),
    );
    expect(resumed).toMatchObject({
      incomingMessages: 3,
      openedConnections: 2,
      messageRequestEquivalent: 0.15,
    });

    const storm = summarizeDeliveryTraffic(
      traffic({
        initialConnections: MAX_REGIONAL_VIEWERS,
        reconnectAttempts: 30,
        acceptedReconnects: 1,
        rejectedReconnects: 29,
      }),
    );
    expect(storm).toMatchObject({
      openedConnections: MAX_REGIONAL_VIEWERS + 1,
      offeredConnectionAttempts: MAX_REGIONAL_VIEWERS + 30,
      rejectedReconnects: 29,
      requestEquivalentIncludingConnections: MAX_REGIONAL_VIEWERS + 30,
    });
  });

  it('counts changed alarms and maintenance separately instead of charging a write per ACK', () => {
    expect(
      summarizeRegionalOperations(operations({ attachmentWrites: 100, alarmReads: 100 })),
    ).toMatchObject({ rowWriteEstimate: 0, activeGbSeconds: null });
    expect(
      summarizeRegionalOperations(
        operations({
          successfulPolls: 1,
          failedPolls: 1,
          alarmSets: 2,
          alarmDeletes: 1,
          alarmReads: 20,
          alarmInvocations: 3,
          alarmRetryInvocations: 1,
          maintenancePuts: 1,
          deletedRows: 3,
          admissionPuts: 4,
          otherStatePuts: 1,
          attachmentWrites: 100,
          downstreamRequests: 10,
        }),
      ),
    ).toMatchObject({
      pollKvRows: 15,
      documentedRowWrites: 26,
      rowWriteEstimate: 27,
      computeRequestsBeforeWebSocketMessages: 13,
      activeGbSeconds: null,
    });
    expect(
      summarizeRegionalOperations(operations({ alarmSets: 2 }), [1_000, 2_000]).activeGbSeconds,
    ).toBeCloseTo(0.384);
  });

  it('rejects unsafe counts, invalid subsets and unverifiable duration inputs', () => {
    expect(() => regionalDeliveryCredit(MAX_REGIONAL_VIEWERS + 1, [])).toThrow(RangeError);
    expect(() => regionalDeliveryCredit(0, [{ bytes: 1 }])).toThrow(RangeError);
    expect(() => regionalDeliveryCredit(1, [{ bytes: MAX_LIVE_MESSAGE_BYTES + 1 }])).toThrow(
      RangeError,
    );
    expect(() =>
      summarizeDeliveryTraffic(traffic({ emittedDeliveries: 0, standalonePongs: 1 })),
    ).toThrow(RangeError);
    expect(() =>
      summarizeDeliveryTraffic(
        traffic({ emittedDeliveries: 1, healthOnlyDeliveries: 1, coDeliveredPongs: 1 }),
      ),
    ).toThrow(RangeError);
    expect(() => summarizeDeliveryTraffic(traffic({ acceptedAcknowledgments: -1 }))).toThrow(
      RangeError,
    );
    expect(() =>
      summarizeDeliveryTraffic(
        traffic({ reconnectAttempts: 2, acceptedReconnects: 1, rejectedReconnects: 0 }),
      ),
    ).toThrow(RangeError);
    expect(() =>
      summarizeRegionalOperations(operations({ successfulPolls: Number.MAX_SAFE_INTEGER })),
    ).toThrow(RangeError);
    expect(() => summarizeRegionalOperations(operations({ alarmRetryInvocations: 1 }))).toThrow(
      RangeError,
    );
    expect(() => summarizeRegionalOperations(operations(), [Infinity])).toThrow(RangeError);
    expect(() => summarizeRegionalOperations(operations(), [0, 0, 0, 0])).toThrow(RangeError);
  });
});
