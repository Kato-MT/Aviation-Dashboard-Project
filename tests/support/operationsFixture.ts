import { describeLiveSource } from '../../src/live/source';
import type { RegionId } from '../../src/live/regions';
import {
  OPERATIONS_LIMITATIONS,
  operationsWindowStarts,
  type OperationsAggregateWindow,
  type OperationsProjection,
  type RegionOperations,
} from '../../src/operations/contract';

export const OPERATIONS_CHECKED_AT = '2026-08-29T16:30:00.000Z';

function aggregateWindow(startedAt: string, trailing: boolean): OperationsAggregateWindow {
  return {
    startedAt,
    provider: {
      accounting: trailing ? 'best-effort' : 'exact',
      pollCount: trailing ? 10 : 2,
      successCount: trailing ? 8 : 2,
      failureCount: trailing ? 2 : 0,
      rateLimitCount: trailing ? 1 : 0,
    },
    validation: {
      accounting: trailing ? 'best-effort' : 'exact',
      acceptedSnapshotCount: trailing ? 8 : 2,
      rejectedSnapshotCount: trailing ? 2 : 0,
      invalidFieldCount: trailing ? 4 : 0,
    },
    delivery: {
      accounting: 'best-effort',
      acknowledgmentCount: trailing ? 10 : 2,
      timeoutCount: trailing ? 1 : 0,
      sendFailureCount: 0,
      invalidControlCount: 0,
      hibernationLossCount: trailing ? 1 : 0,
    },
  };
}

function region(regionId: RegionId): RegionOperations {
  const starts = operationsWindowStarts(OPERATIONS_CHECKED_AT);
  return {
    regionId,
    availability: { state: 'available', reasonCodes: ['REGION_AVAILABLE'] },
    provider: { state: 'live', reasonCodes: ['PROVIDER_LIVE'] },
    delivery: { state: 'healthy', reasonCodes: ['DELIVERY_HEALTHY'] },
    freshness: {
      state: 'current',
      reasonCodes: ['FRESHNESS_CURRENT'],
      observationAgeSeconds: 10,
    },
    windows: {
      currentHour: aggregateWindow(starts.currentHour, false),
      trailing24Hours: aggregateWindow(starts.trailing24Hours, true),
    },
  };
}

export function operationsFixture(): OperationsProjection {
  const starts = operationsWindowStarts(OPERATIONS_CHECKED_AT);
  return {
    schemaVersion: 'operations.v1',
    identity: {
      applicationVersion: '3.0.0-dev',
      releaseSha: 'local-unreleased',
      source: describeLiveSource('local-mock', 'mock'),
      policyId: 'a'.repeat(64),
    },
    checkedAt: OPERATIONS_CHECKED_AT,
    application: { state: 'available', reasonCodes: ['APPLICATION_AVAILABLE'] },
    admission: {
      state: 'accepting',
      reasonCodes: ['ADMISSION_ACCEPTING'],
      scope: 'worker-isolate',
      windows: {
        currentHour: {
          startedAt: starts.currentHour,
          counters: {
            accounting: 'best-effort',
            acceptedCount: 3,
            rateLimitRejectionCount: 0,
            capacityRejectionCount: 0,
          },
        },
        trailing24Hours: {
          startedAt: starts.trailing24Hours,
          counters: {
            accounting: 'best-effort',
            acceptedCount: 20,
            rateLimitRejectionCount: 1,
            capacityRejectionCount: 1,
          },
        },
      },
    },
    limitations: OPERATIONS_LIMITATIONS,
    regions: [region('atlanta'), region('savannah-statesboro'), region('central-georgia')],
  };
}
