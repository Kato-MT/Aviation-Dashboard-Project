import { POLL_INTERVAL_MS } from '../../worker/polling';
import { MAX_REGIONAL_DELIVERY_BYTES, MAX_REGIONAL_VIEWERS } from '../../worker/deliveryPolicy';
import { MAX_LIVE_HANDSHAKE_BYTES } from '../../src/live/delivery';
import { MAX_LIVE_MESSAGE_BYTES } from '../../src/live/validation';

export const CAPACITY_SOURCE_CHECKED_AT = '2026-08-31';
export const PUBLISHED_FREE_DO_WRITES_PER_DAY = 100_000;
export const CURRENT_SUCCESS_KV_ROWS = 9;
export const CURRENT_FAILURE_KV_ROWS = 6;
export const CURRENT_SUCCESS_ALARM_ROWS_WITH_VIEWERS = 2;
const KEEPALIVE_INTERVAL_MS = 30_000;

export interface ContinuousRegionalEnvelope {
  regions: number;
  activeHoursPerRegion: number;
  viewersPerRegion: number;
  pongDelivery?: 'standalone' | 'co-delivered';
}

function count(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError(name + ' must be a nonnegative safe integer.');
  return value;
}

export interface DeliveryTraffic {
  offeredUpdates: number;
  emittedDeliveries: number;
  coalescedUpdates: number;
  acceptedAcknowledgments: number;
  incomingPings: number;
  standalonePongs: number;
  coDeliveredPongs: number;
  healthOnlyDeliveries: number;
  rejectedControls: number;
  initialConnections: number;
  reconnectAttempts: number;
  acceptedReconnects: number;
  rejectedReconnects: number;
}

/** Explicit event counts can describe stalled/backoff traces without assuming every poll is sent. */
export function summarizeDeliveryTraffic(input: DeliveryTraffic) {
  for (const [key, value] of Object.entries(input)) count(value, key);
  if (
    input.standalonePongs + input.healthOnlyDeliveries > input.emittedDeliveries ||
    input.coDeliveredPongs >
      input.emittedDeliveries - input.standalonePongs - input.healthOnlyDeliveries
  )
    throw new RangeError('Pong and health subsets must fit the emitted delivery count.');
  if (input.acceptedReconnects + input.rejectedReconnects !== input.reconnectAttempts) {
    throw new RangeError('Every reconnect attempt must be classified as accepted or rejected.');
  }
  const incomingMessages = count(
    input.acceptedAcknowledgments + input.incomingPings + input.rejectedControls,
    'incomingMessages',
  );
  const openedConnections = count(
    input.initialConnections + input.acceptedReconnects,
    'openedConnections',
  );
  const offeredConnectionAttempts = count(
    input.initialConnections + input.reconnectAttempts,
    'offeredConnectionAttempts',
  );
  return {
    ...input,
    incomingMessages,
    openedConnections,
    offeredConnectionAttempts,
    // This ratio is billing-only. It is not an enforcement or account-entitlement guarantee.
    messageRequestEquivalent: incomingMessages / 20,
    requestEquivalentIncludingConnections: incomingMessages / 20 + offeredConnectionAttempts,
  };
}

export function regionalDeliveryCredit(
  attachedSockets: number,
  outstanding: readonly { bytes: number; closing?: boolean }[],
) {
  count(attachedSockets, 'attachedSockets');
  if (attachedSockets > MAX_REGIONAL_VIEWERS || outstanding.length > attachedSockets)
    throw new RangeError('The scenario exceeds the attached-viewer policy.');
  let outstandingBytes = 0;
  let closingBytes = 0;
  for (const window of outstanding) {
    count(window.bytes, 'encodedEnvelopeBytes');
    if (window.bytes < 1 || window.bytes > MAX_LIVE_MESSAGE_BYTES)
      throw new RangeError('Every outstanding window must contain one bounded encoded envelope.');
    outstandingBytes += window.bytes;
    if (window.closing) closingBytes += window.bytes;
  }
  // Fixed logical reservation, not measured memory or an allocation made at connection time.
  const handshakeAndCloseCredit = MAX_REGIONAL_VIEWERS * MAX_LIVE_HANDSHAKE_BYTES;
  const chargedBytes = handshakeAndCloseCredit + outstandingBytes;
  return {
    attachedSockets,
    outstandingWindows: outstanding.length,
    outstandingBytes,
    closingBytes,
    handshakeAndCloseCredit,
    chargedBytes,
    regionalBudgetBytes: MAX_REGIONAL_DELIVERY_BYTES,
    availableBytes: Math.max(0, MAX_REGIONAL_DELIVERY_BYTES - chargedBytes),
    withinBudget: chargedBytes <= MAX_REGIONAL_DELIVERY_BYTES,
  };
}

export interface RegionalOperationCounts {
  successfulPolls: number;
  failedPolls: number;
  alarmSets: number;
  alarmDeletes: number;
  alarmReads: number;
  alarmInvocations: number;
  alarmRetryInvocations: number;
  maintenancePuts: number;
  deletedRows: number;
  admissionPuts: number;
  otherStatePuts: number;
  attachmentWrites: number;
  downstreamRequests: number;
}

/** Counts actual operations; one ACK does not imply one (or two) alarm writes. */
export function summarizeRegionalOperations(
  input: RegionalOperationCounts,
  activeMillisecondsByRegion?: readonly number[],
) {
  for (const [key, value] of Object.entries(input)) count(value, key);
  if (input.alarmRetryInvocations > input.alarmInvocations)
    throw new RangeError('Retry invocations are a subset of all alarm invocations.');
  const pollKvRows = count(
    input.successfulPolls * CURRENT_SUCCESS_KV_ROWS + input.failedPolls * CURRENT_FAILURE_KV_ROWS,
    'pollKvRows',
  );
  const documentedRowWrites = count(
    pollKvRows +
      input.alarmSets +
      input.maintenancePuts +
      input.deletedRows +
      input.admissionPuts +
      input.otherStatePuts,
    'documentedRowWrites',
  );
  if (
    activeMillisecondsByRegion &&
    (activeMillisecondsByRegion.length > 3 ||
      activeMillisecondsByRegion.some(
        (value) => !Number.isFinite(value) || value < 0 || value > 86_400_000,
      ))
  )
    throw new RangeError(
      'Provide zero to three daily active-time unions, measured separately per region.',
    );
  return {
    ...input,
    pollKvRows,
    documentedRowWrites,
    // Conservatively reserve one row per deleteAlarm call; expose the assumption separately.
    assumedAlarmDeleteRows: input.alarmDeletes,
    rowWriteEstimate: count(documentedRowWrites + input.alarmDeletes, 'rowWriteEstimate'),
    computeRequestsBeforeWebSocketMessages: count(
      input.downstreamRequests + input.alarmInvocations,
      'computeRequests',
    ),
    activeGbSeconds: activeMillisecondsByRegion
      ? activeMillisecondsByRegion.reduce(
          (total, milliseconds) => total + (milliseconds / 1_000) * 0.128,
          0,
        )
      : null,
  };
}

/** A source-counted, one-continuous-window scenario, not billing or provider entitlement. */
export function estimateContinuousRegionalUsage(input: ContinuousRegionalEnvelope) {
  if (!Number.isInteger(input.regions) || input.regions < 1 || input.regions > 3)
    throw new RangeError('regions must be an integer from 1 through 3.');
  if (
    !Number.isFinite(input.activeHoursPerRegion) ||
    input.activeHoursPerRegion < 0 ||
    input.activeHoursPerRegion > 24
  )
    throw new RangeError('activeHoursPerRegion must be between zero and 24.');
  if (
    !Number.isInteger(input.viewersPerRegion) ||
    input.viewersPerRegion < 0 ||
    input.viewersPerRegion > MAX_REGIONAL_VIEWERS
  )
    throw new RangeError(
      `viewersPerRegion must be an integer from zero through ${MAX_REGIONAL_VIEWERS}.`,
    );

  const pongDelivery = input.pongDelivery ?? 'standalone';
  if (pongDelivery !== 'standalone' && pongDelivery !== 'co-delivered')
    throw new RangeError('pongDelivery must be standalone or co-delivered.');

  const activeMs = input.activeHoursPerRegion * 3_600_000;
  const scheduledAttemptCeiling =
    input.viewersPerRegion > 0 ? input.regions * Math.ceil(activeMs / POLL_INTERVAL_MS) : 0;
  const incomingKeepaliveMessages =
    input.regions * input.viewersPerRegion * Math.ceil(activeMs / KEEPALIVE_INTERVAL_MS);
  const initialConnections = activeMs > 0 ? input.regions * input.viewersPerRegion : 0;
  const successKvRows = scheduledAttemptCeiling * CURRENT_SUCCESS_KV_ROWS;
  // With a 20-second poll cadence and 10-second delivery receipt deadline, a
  // healthy delivery first arms the earlier ACK alarm, then restores the later
  // poll alarm after acknowledgments settle.
  const scheduledAlarmRows = scheduledAttemptCeiling * CURRENT_SUCCESS_ALARM_ROWS_WITH_VIEWERS;
  const minimumRowWritesAtSuccessCadence = successKvRows + scheduledAlarmRows;
  const dataAcknowledgments = scheduledAttemptCeiling * input.viewersPerRegion;
  const standalonePongs = pongDelivery === 'standalone' ? incomingKeepaliveMessages : 0;
  const steadyTraffic = summarizeDeliveryTraffic({
    offeredUpdates: dataAcknowledgments,
    emittedDeliveries: dataAcknowledgments + standalonePongs,
    coalescedUpdates: 0,
    acceptedAcknowledgments: dataAcknowledgments + standalonePongs,
    incomingPings: incomingKeepaliveMessages,
    standalonePongs,
    coDeliveredPongs: pongDelivery === 'co-delivered' ? incomingKeepaliveMessages : 0,
    healthOnlyDeliveries: 0,
    rejectedControls: 0,
    initialConnections: 0,
    reconnectAttempts: 0,
    acceptedReconnects: 0,
    rejectedReconnects: 0,
  });
  return {
    envelope: { ...input },
    activeRegionHours: input.viewersPerRegion > 0 ? input.regions * input.activeHoursPerRegion : 0,
    viewerConnectionHours: input.regions * input.viewersPerRegion * input.activeHoursPerRegion,
    scheduledAttemptCeiling,
    initialConnections,
    incomingKeepaliveMessages,
    dataAcknowledgments,
    steadyTraffic,
    pongDelivery,
    // Cloudflare describes a 20:1 billing ratio; metrics still report raw messages.
    // This is not a claim about the account's actual Free quota enforcement.
    keepaliveRequestEquivalent: incomingKeepaliveMessages / 20,
    successKvRows,
    scheduledAlarmRows,
    minimumRowWritesAtSuccessCadence,
    freeWriteHeadroomBeforeOtherWork:
      PUBLISHED_FREE_DO_WRITES_PER_DAY - minimumRowWritesAtSuccessCadence,
    exceedsPublishedFreeWriteAllowance:
      minimumRowWritesAtSuccessCadence > PUBLISHED_FREE_DO_WRITES_PER_DAY,
  };
}
