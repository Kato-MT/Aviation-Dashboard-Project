import {
  CAPACITY_SOURCE_CHECKED_AT,
  CURRENT_SUCCESS_ALARM_ROWS_WITH_VIEWERS,
  CURRENT_SUCCESS_KV_ROWS,
  estimateContinuousRegionalUsage,
  PUBLISHED_FREE_DO_WRITES_PER_DAY,
  regionalDeliveryCredit,
  summarizeDeliveryTraffic,
  summarizeRegionalOperations,
  type RegionalOperationCounts,
} from './capacityModel';
import {
  LIVE_DELIVERY_ACK_TIMEOUT_MS,
  LIVE_CONTROL_WINDOW_MS,
  MAX_REGIONAL_CONTROL_BURST,
  MAX_REGIONAL_DELIVERY_BYTES,
  MAX_REGIONAL_VIEWERS,
  MAX_SOCKET_CONTROLS_PER_WINDOW,
  REGIONAL_CONTROL_REFILL_PER_SECOND,
} from '../../worker/deliveryPolicy';
import { MAX_LIVE_HANDSHAKE_BYTES } from '../../src/live/delivery';
import { MAX_LIVE_MESSAGE_BYTES } from '../../src/live/validation';
import { REQUEST_ADMISSION_POLICY } from '../../worker/admission';
import { MAX_MAP_RANGE_BYTES } from '../../src/map/assets';

const scenarios = [1, 10, MAX_REGIONAL_VIEWERS].flatMap((viewersPerRegion) => [
  { regions: 1, activeHoursPerRegion: 24, viewersPerRegion },
  { regions: 3, activeHoursPerRegion: 8, viewersPerRegion },
  { regions: 3, activeHoursPerRegion: 24, viewersPerRegion },
]);
const operations: RegionalOperationCounts = {
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
};

console.log(
  JSON.stringify(
    {
      kind: 'calculated-source-counted-scenario-not-platform-billing',
      sourceCheckedAt: CAPACITY_SOURCE_CHECKED_AT,
      source: 'https://developers.cloudflare.com/durable-objects/platform/pricing/',
      assumptions: {
        continuousWindowPerRegion: true,
        successfulPolling: true,
        currentSuccessKvRows: CURRENT_SUCCESS_KV_ROWS,
        alarmRowsPerScheduledAttemptWithHealthyViewers: CURRENT_SUCCESS_ALARM_ROWS_WITH_VIEWERS,
        publishedFreeDoRowWritesPerDay: PUBLISHED_FREE_DO_WRITES_PER_DAY,
        steadyTraffic:
          'Healthy viewers receive and acknowledge every poll; standalone pongs have their own ACK. This is an offered-load scenario, not measured throughput.',
        initialConnections:
          'Reported separately from steady message request-equivalents. Bootstrap, health-only entry batches and reconnects require explicit traffic counts.',
        logicalCredit: {
          maxAttachedSockets: MAX_REGIONAL_VIEWERS,
          regionalBytes: MAX_REGIONAL_DELIVERY_BYTES,
          handshakeAndCloseBytesPerPossibleSocket: MAX_LIVE_HANDSHAKE_BYTES,
          connectionSlotsReservedUpFront: MAX_REGIONAL_VIEWERS,
          ackTimeoutMs: LIVE_DELIVERY_ACK_TIMEOUT_MS,
        },
        requestAdmission: {
          counterScope: 'one Worker isolate; counters reset when that isolate is replaced',
          fixedKeysOnly: true,
          persistentRequestIdentity: false,
          storageWritesPerAdmission: 0,
          policy: REQUEST_ADMISSION_POLICY,
          largeMapObjectsRequireRange: true,
          maximumMapRangeBytes: MAX_MAP_RANGE_BYTES,
        },
        socketControlAdmission: {
          perSocketWindowMs: LIVE_CONTROL_WINDOW_MS,
          perSocketMaximum: MAX_SOCKET_CONTROLS_PER_WINDOW,
          regionalRuntimeBurst: MAX_REGIONAL_CONTROL_BURST,
          regionalRuntimeRefillPerSecond: REGIONAL_CONTROL_REFILL_PER_SECOND,
          resetBehavior:
            'The regional runtime bucket resets on Durable Object eviction; the per-socket window survives hibernation in bounded attachment metadata.',
        },
        duration:
          'Unknown unless measured active-time unions are supplied per region. Handler times must not be added across overlapping work.',
      },
      excluded: [
        'Steady projections exclude bootstrap batches, HTTP arrivals, admission/reconnect work, early alarms and aggregate cleanup. Explicit operation inputs below illustrate how these are counted.',
        'Attachment metering, actual Worker CPU and Durable Object active duration, storage reads, map/R2 operations and other account workloads require measurements.',
        'Eight MiB logical credit is not a measurement of JavaScript heap, platform buffers or three-hub isolate memory.',
        'Measured admitted and rejected route traffic, full-envelope sizes, ACK latency and an owner-approved daily operating envelope remain open.',
        'Actual account entitlements, provider quota and any approval to enable live or paid service',
      ],
      scenarios: scenarios.map(estimateContinuousRegionalUsage),
      coDeliveredPongAlternative: estimateContinuousRegionalUsage({
        regions: 3,
        activeHoursPerRegion: 24,
        viewersPerRegion: MAX_REGIONAL_VIEWERS,
        pongDelivery: 'co-delivered',
      }),
      creditScenarios: {
        pilotMaximumStalled64KiB: regionalDeliveryCredit(
          MAX_REGIONAL_VIEWERS,
          Array.from({ length: MAX_REGIONAL_VIEWERS }, () => ({ bytes: 64 * 1024 })),
        ),
        fourMaximumEnvelopesDoNotFitWithHandshakeCredit: regionalDeliveryCredit(
          4,
          Array.from({ length: 4 }, () => ({ bytes: MAX_LIVE_MESSAGE_BYTES })),
        ),
        closingStillCharged: regionalDeliveryCredit(2, [
          { bytes: MAX_LIVE_MESSAGE_BYTES, closing: true },
          { bytes: 64 * 1024 },
        ]),
      },
      illustrativeEventInputsNotMeasuredTraffic: {
        backoffHealthAndPong: summarizeDeliveryTraffic({
          offeredUpdates: 1,
          emittedDeliveries: 2,
          coalescedUpdates: 0,
          acceptedAcknowledgments: 2,
          incomingPings: 1,
          standalonePongs: 1,
          coDeliveredPongs: 0,
          healthOnlyDeliveries: 1,
          rejectedControls: 0,
          initialConnections: 1,
          reconnectAttempts: 0,
          acceptedReconnects: 0,
          rejectedReconnects: 0,
        }),
        fullRegionReconnectBurst: summarizeDeliveryTraffic({
          offeredUpdates: 0,
          emittedDeliveries: 0,
          coalescedUpdates: 0,
          acceptedAcknowledgments: 0,
          incomingPings: 0,
          standalonePongs: 0,
          coDeliveredPongs: 0,
          healthOnlyDeliveries: 0,
          rejectedControls: 0,
          initialConnections: MAX_REGIONAL_VIEWERS,
          reconnectAttempts: 30,
          acceptedReconnects: 1,
          rejectedReconnects: 29,
        }),
        unchangedAlarmAfterAck: summarizeRegionalOperations({
          ...operations,
          alarmReads: 1,
          attachmentWrites: 1,
        }),
        earlierExpiryThenAckRestoration: summarizeRegionalOperations({
          ...operations,
          alarmSets: 2,
          alarmReads: 2,
          attachmentWrites: 3,
        }),
        maintenanceWithoutViewers: summarizeRegionalOperations({
          ...operations,
          alarmInvocations: 1,
          deletedRows: 128,
          maintenancePuts: 1,
          alarmSets: 1,
        }),
      },
      conclusion:
        'The one-region 20-second pilot baseline is below the published Free write allowance before unmodeled work; the three-region continuous baseline still exceeds it. Neither calculation is account entitlement, measured billing, provider approval, or production readiness.',
    },
    null,
    2,
  ),
);
