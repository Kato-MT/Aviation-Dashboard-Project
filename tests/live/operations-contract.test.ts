import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import operationsSchema from '../../schemas/operations-v1.schema.json';
import { describeLiveSource } from '../../src/live/source';
import {
  MAX_OPERATIONS_COUNTER,
  OPERATIONS_LIMITATIONS,
  OperationsContractError,
  operationsWindowStarts,
  parseOperationsProjection,
} from '../../src/operations/contract';

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validateSchema = ajv.compile(operationsSchema);
const CHECKED_AT = '2026-08-29T16:30:00.000Z';

function providerCounters(
  pollCount: number,
  successCount: number,
  failureCount: number,
  accounting: 'exact' | 'best-effort',
) {
  return {
    accounting,
    pollCount,
    successCount,
    failureCount,
    rateLimitCount: failureCount > 0 ? 1 : 0,
  };
}

function aggregateWindow(startedAt: string, trailing = false) {
  return {
    startedAt,
    provider: trailing
      ? providerCounters(10, 8, 2, 'best-effort')
      : providerCounters(2, 1, 1, 'exact'),
    validation: {
      accounting: trailing ? 'best-effort' : 'exact',
      acceptedSnapshotCount: trailing ? 8 : 1,
      rejectedSnapshotCount: trailing ? 2 : 1,
      invalidFieldCount: trailing ? 4 : 1,
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

function windows() {
  const starts = operationsWindowStarts(CHECKED_AT);
  return {
    currentHour: aggregateWindow(starts.currentHour),
    trailing24Hours: aggregateWindow(starts.trailing24Hours, true),
  };
}

function region(regionId: string) {
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
    windows: windows(),
  };
}

function admissionWindows() {
  const starts = operationsWindowStarts(CHECKED_AT);
  return {
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
  };
}

function operationsFixture(): Record<string, any> {
  return {
    schemaVersion: 'operations.v1',
    identity: {
      applicationVersion: '3.0.0-dev',
      releaseSha: 'local-unreleased',
      source: { ...describeLiveSource('local-mock', 'mock') },
      policyId: 'a'.repeat(64),
    },
    checkedAt: CHECKED_AT,
    application: { state: 'available', reasonCodes: ['APPLICATION_AVAILABLE'] },
    admission: {
      state: 'accepting',
      reasonCodes: ['ADMISSION_ACCEPTING'],
      scope: 'worker-isolate',
      windows: admissionWindows(),
    },
    limitations: { ...OPERATIONS_LIMITATIONS },
    regions: [region('atlanta'), region('savannah-statesboro'), region('central-georgia')],
  };
}

function nestedRecords(value: unknown, records: Record<string, any>[] = []): Record<string, any>[] {
  if (Array.isArray(value)) {
    for (const entry of value) nestedRecords(entry, records);
    return records;
  }
  if (typeof value !== 'object' || value === null) return records;
  const record = value as Record<string, any>;
  records.push(record);
  for (const entry of Object.values(record)) nestedRecords(entry, records);
  return records;
}

function expectRejected(value: unknown, code?: string): void {
  expect(validateSchema(value), JSON.stringify(validateSchema.errors)).toBe(false);
  try {
    parseOperationsProjection(value);
    throw new Error('Expected operations.v1 rejection.');
  } catch (error) {
    expect(error).toBeInstanceOf(OperationsContractError);
    if (code) expect((error as OperationsContractError).code).toBe(code);
  }
}

function expectRuntimeRejected(value: unknown, code: string): void {
  try {
    parseOperationsProjection(value);
    throw new Error('Expected operations.v1 runtime rejection.');
  } catch (error) {
    expect(error).toBeInstanceOf(OperationsContractError);
    expect((error as OperationsContractError).code).toBe(code);
  }
}

describe('operations.v1 closed contract', () => {
  it('accepts the exact three-region projection in JSON Schema and runtime validation', () => {
    const value = operationsFixture();
    expect(validateSchema(value), JSON.stringify(validateSchema.errors)).toBe(true);
    const parsed = parseOperationsProjection(value);
    expect(parsed).toEqual(value);
    expect(parsed.identity.source).toEqual(describeLiveSource('local-mock', 'mock'));
    expect(parsed.admission.scope).toBe('worker-isolate');
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.identity)).toBe(true);
    expect(Object.isFrozen(parsed.identity.source)).toBe(true);
    expect(Object.isFrozen(parsed.regions)).toBe(true);
    expect(Object.isFrozen(parsed.regions[0].windows?.currentHour.delivery)).toBe(true);
    expect(Object.isFrozen(parsed.admission.windows.trailing24Hours.counters)).toBe(true);
  });

  it.each([
    ['top level', (value: Record<string, any>) => (value.extra = true)],
    ['identity', (value: Record<string, any>) => (value.identity.extra = true)],
    ['classification', (value: Record<string, any>) => (value.application.detail = 'okay')],
    ['region', (value: Record<string, any>) => (value.regions[0].extra = true)],
    ['window', (value: Record<string, any>) => (value.regions[0].windows.extra = true)],
    [
      'counter group',
      (value: Record<string, any>) => (value.regions[0].windows.currentHour.provider.extra = 0),
    ],
  ])('rejects an unknown property at the %s boundary', (_label, mutate) => {
    const value = operationsFixture();
    mutate(value);
    expectRejected(value);
  });

  it('property-tests unknown and privacy-sensitive fields across every nested record', () => {
    fc.assert(
      fc.property(
        fc.nat(),
        fc.stringMatching(/^[a-z][a-z0-9]{0,20}$/u),
        fc.jsonValue(),
        (recordIndex, suffix, generatedValue) => {
          const value = operationsFixture();
          const records = nestedRecords(value);
          records[recordIndex % records.length]![`unknown_${suffix}`] = generatedValue;
          expectRejected(value);
        },
      ),
      { numRuns: 128, seed: 20260830 },
    );

    fc.assert(
      fc.property(
        fc.nat(),
        fc.constantFrom<readonly [string, unknown]>(
          ['aircraftId', '000001'] as const,
          ['callsign', 'TEST01'] as const,
          ['registration', 'N12345'] as const,
          ['latitude', 33.64] as const,
          ['longitude', -84.43] as const,
          ['providerPayload', { raw: true }] as const,
          ['ipAddress', '192.0.2.1'] as const,
          ['userAgent', 'synthetic-browser'] as const,
          ['clientIdentifier', 'synthetic-client'] as const,
          ['requestUrl', 'https://example.test/private'] as const,
          ['movementTrail', []] as const,
        ),
        (recordIndex, [key, generatedValue]) => {
          const value = operationsFixture();
          const records = nestedRecords(value);
          records[recordIndex % records.length]![key] = generatedValue;
          expectRejected(value, 'FORBIDDEN_FIELD');
        },
      ),
      { numRuns: 128, seed: 20260831 },
    );

    fc.assert(
      fc.property(fc.string({ minLength: 129, maxLength: 512 }), (unboundedText) => {
        const value = operationsFixture();
        value.identity.releaseSha = unboundedText;
        expectRejected(value, 'FORBIDDEN_FIELD');
      }),
      { numRuns: 64, seed: 20260832 },
    );
  });

  it('rejects reordered, duplicate, missing, and sparse regional envelopes', () => {
    const reordered = operationsFixture();
    [reordered.regions[0], reordered.regions[1]] = [reordered.regions[1], reordered.regions[0]];
    expectRejected(reordered, 'INVALID_REGION_SET');

    const duplicate = operationsFixture();
    duplicate.regions[1].regionId = 'atlanta';
    expectRejected(duplicate, 'INVALID_REGION_SET');

    const missing = operationsFixture();
    missing.regions.pop();
    expectRejected(missing, 'INVALID_REGION_SET');

    const sparse = operationsFixture();
    delete sparse.regions[1];
    expectRejected(sparse);
  });

  it.each([
    ['checkedAt', (value: Record<string, any>) => (value.checkedAt = '2026-08-29T16:30:00Z')],
    [
      'current hour',
      (value: Record<string, any>) => (value.regions[0].windows.currentHour.startedAt = CHECKED_AT),
    ],
    [
      'trailing 24 hours',
      (value: Record<string, any>) =>
        (value.admission.windows.trailing24Hours.startedAt = '2026-08-28T16:00:00.000Z'),
    ],
  ])('rejects a noncanonical or inconsistent %s timestamp', (label, mutate) => {
    const value = operationsFixture();
    mutate(value);
    if (label === 'checkedAt') expectRejected(value);
    else expectRuntimeRejected(value, 'INVALID_WINDOW');
  });

  it.each([
    [
      'applicationVersion',
      (value: Record<string, any>) => (value.identity.applicationVersion = ''),
    ],
    ['releaseSha', (value: Record<string, any>) => (value.identity.releaseSha = 'x'.repeat(65))],
    ['policyId', (value: Record<string, any>) => (value.identity.policyId = 'A'.repeat(64))],
    ['source tuple', (value: Record<string, any>) => (value.identity.source.synthetic = false)],
  ])('rejects an invalid %s identity', (_label, mutate) => {
    const value = operationsFixture();
    mutate(value);
    expectRejected(value, 'INVALID_IDENTITY');
  });

  it('rejects overflow and inconsistent counters instead of coercing them', () => {
    const overflow = operationsFixture();
    overflow.regions[0].windows.currentHour.provider.pollCount = MAX_OPERATIONS_COUNTER + 1;
    expectRejected(overflow, 'INVALID_COUNTER');

    const aggregateOverflow = operationsFixture();
    aggregateOverflow.regions[0].windows.trailing24Hours.delivery.acknowledgmentCount =
      MAX_OPERATIONS_COUNTER;
    aggregateOverflow.regions[0].windows.trailing24Hours.delivery.timeoutCount = 1;
    expectRuntimeRejected(aggregateOverflow, 'INVALID_COUNTER');

    const inconsistent = operationsFixture();
    inconsistent.regions[0].windows.currentHour.provider.successCount = 2;
    expectRuntimeRejected(inconsistent, 'INVALID_COUNTER');

    const shrinking = operationsFixture();
    shrinking.regions[0].windows.trailing24Hours.delivery.acknowledgmentCount = 1;
    expectRuntimeRejected(shrinking, 'INVALID_WINDOW');
  });

  it('rejects sparse windows and the wrong accounting labels', () => {
    const sparse = operationsFixture();
    delete sparse.regions[0].windows.trailing24Hours;
    expectRejected(sparse);

    const providerLabel = operationsFixture();
    providerLabel.regions[0].windows.currentHour.provider.accounting = 'best-effort';
    expectRejected(providerLabel, 'INVALID_COUNTER');

    const deliveryLabel = operationsFixture();
    deliveryLabel.regions[0].windows.currentHour.delivery.accounting = 'exact';
    expectRejected(deliveryLabel, 'INVALID_COUNTER');

    const trailingProviderLabel = operationsFixture();
    trailingProviderLabel.regions[0].windows.trailing24Hours.provider.accounting = 'exact';
    expectRejected(trailingProviderLabel, 'INVALID_COUNTER');

    const trailingValidationLabel = operationsFixture();
    trailingValidationLabel.regions[0].windows.trailing24Hours.validation.accounting = 'exact';
    expectRejected(trailingValidationLabel, 'INVALID_COUNTER');

    const shrinkingAdmission = operationsFixture();
    shrinkingAdmission.admission.windows.trailing24Hours.counters.acceptedCount = 2;
    expectRuntimeRejected(shrinkingAdmission, 'INVALID_WINDOW');
  });

  it('rejects a non-isolate admission scope and unavailable windows on an available read', () => {
    const scope = operationsFixture();
    scope.admission.scope = 'regional';
    expectRejected(scope, 'INVALID_CLASSIFICATION');

    const missingWindows = operationsFixture();
    missingWindows.regions[0].windows = null;
    expectRuntimeRejected(missingWindows, 'INVALID_WINDOW');
  });

  it('rejects unknown, duplicate, and state-incompatible reason codes', () => {
    const unknown = operationsFixture();
    unknown.regions[0].provider.reasonCodes = ['PROVIDER_MAGIC'];
    expectRejected(unknown, 'INVALID_CLASSIFICATION');

    const duplicate = operationsFixture();
    duplicate.regions[0].delivery.reasonCodes = ['DELIVERY_HEALTHY', 'DELIVERY_HEALTHY'];
    expectRejected(duplicate, 'INVALID_CLASSIFICATION');

    const mismatched = operationsFixture();
    mismatched.regions[0].provider.reasonCodes = ['PROVIDER_DISABLED'];
    expectRuntimeRejected(mismatched, 'INVALID_CLASSIFICATION');
  });

  it('enforces freshness state boundaries and explicit null semantics', () => {
    const wrongBoundary = operationsFixture();
    wrongBoundary.regions[0].freshness.observationAgeSeconds = 16;
    expectRejected(wrongBoundary, 'INVALID_CLASSIFICATION');

    const emptyWithAge = operationsFixture();
    emptyWithAge.regions[0].freshness = {
      state: 'empty',
      reasonCodes: ['FRESHNESS_EMPTY'],
      observationAgeSeconds: 0,
    };
    expectRejected(emptyWithAge, 'INVALID_CLASSIFICATION');
  });

  it.each([
    [
      'aircraft identifier key',
      (value: Record<string, any>) => (value.regions[0].aircraftId = 'abcdef'),
    ],
    ['callsign key', (value: Record<string, any>) => (value.regions[0].callsign = 'N123')],
    ['coordinate key', (value: Record<string, any>) => (value.regions[0].latitude = 33.6)],
    [
      'provider payload key',
      (value: Record<string, any>) => (value.regions[0].providerPayload = {}),
    ],
    ['IP value', (value: Record<string, any>) => (value.identity.releaseSha = '192.168.1.1')],
    [
      'complete URL value',
      (value: Record<string, any>) => (value.identity.releaseSha = 'https://example.test/x'),
    ],
    [
      'unbounded text',
      (value: Record<string, any>) => (value.identity.releaseSha = 'x'.repeat(129)),
    ],
  ])('recursively rejects the privacy sentinel %s', (_label, mutate) => {
    const value = operationsFixture();
    mutate(value);
    expectRejected(value, 'FORBIDDEN_FIELD');
  });

  it('represents one failed region as partial without discarding successful evidence', () => {
    const value = operationsFixture();
    value.application = {
      state: 'partial',
      reasonCodes: ['APPLICATION_PARTIAL_REGIONS'],
    };
    value.regions[1] = {
      regionId: 'savannah-statesboro',
      availability: { state: 'unavailable', reasonCodes: ['REGION_READ_UNAVAILABLE'] },
      provider: { state: 'unavailable', reasonCodes: ['PROVIDER_UNAVAILABLE'] },
      delivery: { state: 'unavailable', reasonCodes: ['DELIVERY_UNAVAILABLE'] },
      freshness: {
        state: 'unavailable',
        reasonCodes: ['FRESHNESS_UNAVAILABLE'],
        observationAgeSeconds: null,
      },
      windows: null,
    };
    expect(validateSchema(value), JSON.stringify(validateSchema.errors)).toBe(true);
    const parsed = parseOperationsProjection(value);
    expect(parsed.application.state).toBe('partial');
    expect(parsed.regions[0].windows?.currentHour.provider.pollCount).toBe(2);
    expect(parsed.regions[1].windows).toBeNull();
    expect(parsed.regions[2].provider.state).toBe('live');
  });

  it('rejects application state that does not match independent regional read outcomes', () => {
    const value = operationsFixture();
    value.application = {
      state: 'partial',
      reasonCodes: ['APPLICATION_PARTIAL_REGIONS'],
    };
    expectRuntimeRejected(value, 'INCONSISTENT_APPLICATION');
  });
});
