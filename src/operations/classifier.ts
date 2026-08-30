import type { RegionId } from '../live/regions';
import { isCanonicalTimestamp } from '../live/validation';
import {
  MAX_OPERATIONS_AGE_SECONDS,
  MAX_OPERATIONS_COUNTER,
  OPERATIONS_CURRENT_MAX_SECONDS,
  OPERATIONS_DELAYED_MAX_SECONDS,
  OPERATIONS_REGION_IDS,
  OPERATIONS_STALE_MAX_SECONDS,
  OperationsContractError,
  type OperationsAdmissionState,
  type OperationsAvailabilityState,
  type OperationsClassification,
  type OperationsDeliveryState,
  type OperationsFreshness,
  type OperationsFreshnessState,
  type OperationsProviderState,
  type RegionOperations,
} from './contract';

export type ProviderOperationalSignal =
  | { readonly available: false }
  | {
      readonly available: true;
      readonly enabled: boolean;
      readonly connected: boolean;
      readonly acceptedSnapshot: boolean;
      readonly rateLimited: boolean;
      readonly retrying: boolean;
      readonly degraded: boolean;
    };

export type DeliveryOperationalSignal =
  | { readonly available: false }
  | {
      readonly available: true;
      readonly acknowledgmentCount: number;
      readonly timeoutCount: number;
      readonly sendFailureCount: number;
      readonly invalidControlCount: number;
      readonly hibernationLossCount: number;
    };

export type AdmissionOperationalSignal =
  | { readonly available: false }
  | {
      readonly available: true;
      readonly acceptedCount: number;
      readonly rateLimitRejectionCount: number;
      readonly capacityRejectionCount: number;
    };

export type RegionOperationalSignal =
  | { readonly regionId: RegionId; readonly readAvailable: false }
  | {
      readonly regionId: RegionId;
      readonly readAvailable: true;
      readonly provider: ProviderOperationalSignal;
      readonly delivery: DeliveryOperationalSignal;
      readonly lastObservationAt: string | null;
    };

export type ClassifiedRegionOperations = Omit<RegionOperations, 'windows'>;

function freezeClassification<State extends string>(
  state: State,
  reasonCodes: readonly OperationsClassification<State>['reasonCodes'][number][],
): Readonly<OperationsClassification<State>> {
  return Object.freeze({ state, reasonCodes: Object.freeze([...reasonCodes]) });
}

function assertBoolean(value: unknown): asserts value is boolean {
  if (typeof value !== 'boolean') throw new OperationsContractError('INVALID_CLASSIFICATION');
}

function assertSignalCounter(value: number): void {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_OPERATIONS_COUNTER
  ) {
    throw new OperationsContractError('INVALID_COUNTER');
  }
}

function assertSignalTotal(values: readonly number[]): void {
  let total = 0;
  for (const value of values) {
    assertSignalCounter(value);
    if (value > MAX_OPERATIONS_COUNTER - total) {
      throw new OperationsContractError('INVALID_COUNTER');
    }
    total += value;
  }
}

export function classifyProviderOperations(
  signal: ProviderOperationalSignal,
): Readonly<OperationsClassification<OperationsProviderState>> {
  assertBoolean(signal.available);
  if (!signal.available) return freezeClassification('unavailable', ['PROVIDER_UNAVAILABLE']);
  assertBoolean(signal.enabled);
  assertBoolean(signal.connected);
  assertBoolean(signal.acceptedSnapshot);
  assertBoolean(signal.rateLimited);
  assertBoolean(signal.retrying);
  assertBoolean(signal.degraded);
  if (!signal.enabled) return freezeClassification('disabled', ['PROVIDER_DISABLED']);
  if (signal.rateLimited) return freezeClassification('rate-limited', ['PROVIDER_RATE_LIMITED']);
  if (signal.retrying) return freezeClassification('retrying', ['PROVIDER_RETRYING']);
  if (!signal.connected) return freezeClassification('connecting', ['PROVIDER_CONNECTING']);
  if (!signal.acceptedSnapshot) return freezeClassification('empty', ['PROVIDER_EMPTY']);
  if (signal.degraded) return freezeClassification('degraded', ['PROVIDER_DEGRADED']);
  return freezeClassification('live', ['PROVIDER_LIVE']);
}

export function classifyDeliveryOperations(
  signal: DeliveryOperationalSignal,
): Readonly<OperationsClassification<OperationsDeliveryState>> {
  assertBoolean(signal.available);
  if (!signal.available) return freezeClassification('unavailable', ['DELIVERY_UNAVAILABLE']);
  assertSignalTotal([
    signal.acknowledgmentCount,
    signal.timeoutCount,
    signal.sendFailureCount,
    signal.invalidControlCount,
    signal.hibernationLossCount,
  ]);
  const reasons = [] as Array<
    | 'DELIVERY_DEGRADED_TIMEOUTS'
    | 'DELIVERY_DEGRADED_SEND_FAILURES'
    | 'DELIVERY_DEGRADED_INVALID_CONTROLS'
    | 'DELIVERY_HIBERNATION_LOSS_POSSIBLE'
  >;
  if (signal.timeoutCount > 0) reasons.push('DELIVERY_DEGRADED_TIMEOUTS');
  if (signal.sendFailureCount > 0) reasons.push('DELIVERY_DEGRADED_SEND_FAILURES');
  if (signal.invalidControlCount > 0) reasons.push('DELIVERY_DEGRADED_INVALID_CONTROLS');
  if (signal.hibernationLossCount > 0) reasons.push('DELIVERY_HIBERNATION_LOSS_POSSIBLE');
  return reasons.length > 0
    ? freezeClassification('degraded', reasons)
    : freezeClassification('healthy', ['DELIVERY_HEALTHY']);
}

export function classifyAdmissionOperations(
  signal: AdmissionOperationalSignal,
): Readonly<OperationsClassification<OperationsAdmissionState>> {
  assertBoolean(signal.available);
  if (!signal.available) return freezeClassification('unavailable', ['ADMISSION_UNAVAILABLE']);
  assertSignalTotal([
    signal.acceptedCount,
    signal.rateLimitRejectionCount,
    signal.capacityRejectionCount,
  ]);
  const reasons = [] as Array<'ADMISSION_LIMITED_RATE' | 'ADMISSION_LIMITED_CAPACITY'>;
  if (signal.rateLimitRejectionCount > 0) reasons.push('ADMISSION_LIMITED_RATE');
  if (signal.capacityRejectionCount > 0) reasons.push('ADMISSION_LIMITED_CAPACITY');
  return reasons.length > 0
    ? freezeClassification('limited', reasons)
    : freezeClassification('accepting', ['ADMISSION_ACCEPTING']);
}

export function classifyFreshnessOperations(
  checkedAt: string,
  lastObservationAt: string | null,
  regionAvailable = true,
): Readonly<OperationsFreshness> {
  assertBoolean(regionAvailable);
  if (!isCanonicalTimestamp(checkedAt)) throw new OperationsContractError('INVALID_TIMESTAMP');
  if (!regionAvailable) {
    return Object.freeze({
      ...freezeClassification<OperationsFreshnessState>('unavailable', ['FRESHNESS_UNAVAILABLE']),
      observationAgeSeconds: null,
    });
  }
  if (lastObservationAt === null) {
    return Object.freeze({
      ...freezeClassification<OperationsFreshnessState>('empty', ['FRESHNESS_EMPTY']),
      observationAgeSeconds: null,
    });
  }
  if (!isCanonicalTimestamp(lastObservationAt)) {
    throw new OperationsContractError('INVALID_TIMESTAMP');
  }
  const differenceMs = Date.parse(checkedAt) - Date.parse(lastObservationAt);
  if (differenceMs < 0) throw new OperationsContractError('INVALID_TIMESTAMP');
  const observationAgeSeconds = Math.ceil(differenceMs / 1_000);
  if (observationAgeSeconds > MAX_OPERATIONS_AGE_SECONDS) {
    throw new OperationsContractError('INVALID_CLASSIFICATION');
  }
  const state: OperationsFreshnessState =
    observationAgeSeconds <= OPERATIONS_CURRENT_MAX_SECONDS
      ? 'current'
      : observationAgeSeconds <= OPERATIONS_DELAYED_MAX_SECONDS
        ? 'delayed'
        : observationAgeSeconds <= OPERATIONS_STALE_MAX_SECONDS
          ? 'stale'
          : 'expired';
  const reason = {
    current: 'FRESHNESS_CURRENT',
    delayed: 'FRESHNESS_DELAYED',
    stale: 'FRESHNESS_STALE',
    expired: 'FRESHNESS_EXPIRED',
  } as const;
  return Object.freeze({
    ...freezeClassification<OperationsFreshnessState>(state, [reason[state]]),
    observationAgeSeconds,
  });
}

export function classifyRegionOperations(
  signal: RegionOperationalSignal,
  checkedAt: string,
): Readonly<ClassifiedRegionOperations> {
  if (!OPERATIONS_REGION_IDS.includes(signal.regionId)) {
    throw new OperationsContractError('INVALID_REGION_SET');
  }
  assertBoolean(signal.readAvailable);
  if (!signal.readAvailable) {
    return Object.freeze({
      regionId: signal.regionId,
      availability: freezeClassification<OperationsAvailabilityState>('unavailable', [
        'REGION_READ_UNAVAILABLE',
      ]),
      provider: freezeClassification<OperationsProviderState>('unavailable', [
        'PROVIDER_UNAVAILABLE',
      ]),
      delivery: freezeClassification<OperationsDeliveryState>('unavailable', [
        'DELIVERY_UNAVAILABLE',
      ]),
      freshness: classifyFreshnessOperations(checkedAt, null, false),
    });
  }
  if (!isCanonicalTimestamp(checkedAt)) throw new OperationsContractError('INVALID_TIMESTAMP');
  return Object.freeze({
    regionId: signal.regionId,
    availability: freezeClassification<OperationsAvailabilityState>('available', [
      'REGION_AVAILABLE',
    ]),
    provider: classifyProviderOperations(signal.provider),
    delivery: classifyDeliveryOperations(signal.delivery),
    freshness: classifyFreshnessOperations(checkedAt, signal.lastObservationAt),
  });
}

export function classifyApplicationOperations(
  regions: readonly ClassifiedRegionOperations[],
): Readonly<OperationsClassification<'available' | 'partial' | 'unavailable'>> {
  if (regions.length !== OPERATIONS_REGION_IDS.length) {
    throw new OperationsContractError('INVALID_REGION_SET');
  }
  for (let index = 0; index < OPERATIONS_REGION_IDS.length; index += 1) {
    const region = regions[index];
    if (!region || region.regionId !== OPERATIONS_REGION_IDS[index]) {
      throw new OperationsContractError('INVALID_REGION_SET');
    }
  }
  const available = regions.filter(({ availability }) => availability.state === 'available').length;
  if (available === regions.length) {
    return freezeClassification('available', ['APPLICATION_AVAILABLE']);
  }
  if (available === 0) {
    return freezeClassification('unavailable', ['APPLICATION_UNAVAILABLE']);
  }
  return freezeClassification('partial', ['APPLICATION_PARTIAL_REGIONS']);
}
