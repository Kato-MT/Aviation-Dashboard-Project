import { describe, expect, it } from 'vitest';

import {
  MAX_LIVE_CONTROL_BYTES,
  MAX_LIVE_DELIVERY_MESSAGES,
  MAX_LIVE_HANDSHAKE_BYTES,
} from '../../src/live/delivery';
import {
  LIVE_HISTORY_MAX_AIRCRAFT,
  LIVE_HISTORY_MAX_QUALITY_EVENTS,
  LIVE_HISTORY_MAX_SAMPLES,
  LIVE_HISTORY_RETENTION_MS,
} from '../../src/live/history';
import { MAX_MAP_RANGE_BYTES } from '../../src/map/assets';
import {
  RUNTIME_POLICY_LIMITS,
  RUNTIME_POLICY_LIMITS_SCHEMA_VERSION,
} from '../../src/live/runtimePolicyLimits';
import {
  MAX_LIVE_AIRCRAFT,
  MAX_LIVE_FUTURE_OFFSET_MS,
  MAX_LIVE_MESSAGE_BYTES,
  MAX_LIVE_PROTOCOL_ERRORS,
} from '../../src/live/validation';
import { DEFAULT_BROWSER_BUDGETS } from '../../tools/live/verifyBrowserBudgets';
import { parseLoadHarnessCli } from '../../tools/live/loadHarnessReport';
import { REQUEST_ADMISSION_POLICY } from '../../worker/admission';
import {
  LIVE_CONTROL_WINDOW_MS,
  LIVE_DELIVERY_ACK_TIMEOUT_MS,
  MAX_REGIONAL_CONTROL_BURST,
  MAX_REGIONAL_DELIVERY_BYTES,
  MAX_REGIONAL_VIEWERS,
  MAX_SOCKET_CONTROLS_PER_WINDOW,
  MAX_VIEWER_ATTACHMENT_BYTES,
  MIN_LIVE_PING_INTERVAL_MS,
  REGIONAL_CONTROL_REFILL_PER_SECOND,
} from '../../worker/deliveryPolicy';
import { POLL_INTERVAL_MS } from '../../worker/polling';

function expectDeeplyFrozen(value: unknown, visited = new WeakSet<object>()): void {
  if (typeof value !== 'object' || value === null || visited.has(value)) return;
  visited.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectDeeplyFrozen(child, visited);
}

describe('runtime-policy numeric contract', () => {
  it('is one versioned, deeply immutable limits tree', () => {
    expect(RUNTIME_POLICY_LIMITS.schemaVersion).toBe(RUNTIME_POLICY_LIMITS_SCHEMA_VERSION);
    expectDeeplyFrozen(RUNTIME_POLICY_LIMITS);
    expect(() => {
      (RUNTIME_POLICY_LIMITS.provider as unknown as { pollIntervalMs: number }).pollIntervalMs = 1;
    }).toThrow(TypeError);
  });

  it('drives protocol, provider cadence, history, delivery, admission, map, and browser gates', () => {
    expect({
      maximumMessageBytes: MAX_LIVE_MESSAGE_BYTES,
      maximumAircraft: MAX_LIVE_AIRCRAFT,
      maximumValidationErrors: MAX_LIVE_PROTOCOL_ERRORS,
      maximumFutureOffsetMs: MAX_LIVE_FUTURE_OFFSET_MS,
    }).toEqual(RUNTIME_POLICY_LIMITS.protocol);
    expect({
      retentionMs: LIVE_HISTORY_RETENTION_MS,
      maximumSamplesPerAircraft: LIVE_HISTORY_MAX_SAMPLES,
      maximumAircraft: LIVE_HISTORY_MAX_AIRCRAFT,
      maximumQualityEvents: LIVE_HISTORY_MAX_QUALITY_EVENTS,
    }).toEqual(RUNTIME_POLICY_LIMITS.history);
    expect({
      maximumRegionalViewers: MAX_REGIONAL_VIEWERS,
      maximumRegionalBytes: MAX_REGIONAL_DELIVERY_BYTES,
      acknowledgmentTimeoutMs: LIVE_DELIVERY_ACK_TIMEOUT_MS,
      minimumPingIntervalMs: MIN_LIVE_PING_INTERVAL_MS,
      maximumViewerAttachmentBytes: MAX_VIEWER_ATTACHMENT_BYTES,
      controlWindowMs: LIVE_CONTROL_WINDOW_MS,
      maximumControlsPerWindow: MAX_SOCKET_CONTROLS_PER_WINDOW,
      maximumRegionalControlBurst: MAX_REGIONAL_CONTROL_BURST,
      regionalControlRefillPerSecond: REGIONAL_CONTROL_REFILL_PER_SECOND,
      maximumControlBytes: MAX_LIVE_CONTROL_BYTES,
      maximumHandshakeBytes: MAX_LIVE_HANDSHAKE_BYTES,
      maximumMessagesPerDelivery: MAX_LIVE_DELIVERY_MESSAGES,
    }).toEqual(RUNTIME_POLICY_LIMITS.delivery);
    expect(POLL_INTERVAL_MS).toBe(RUNTIME_POLICY_LIMITS.provider.pollIntervalMs);
    expect(REQUEST_ADMISSION_POLICY).toBe(RUNTIME_POLICY_LIMITS.admission);
    expect(MAX_MAP_RANGE_BYTES).toBe(RUNTIME_POLICY_LIMITS.map.maximumRangeBytes);
    expect(DEFAULT_BROWSER_BUDGETS).toBe(RUNTIME_POLICY_LIMITS.browser.bundle);

    const smoke = parseLoadHarnessCli(['--artifact-root', 'dist-mock-staging']).scenario;
    const maximum = parseLoadHarnessCli([
      '--artifact-root',
      'dist-mock-staging',
      '--profile',
      'maximum',
    ]).scenario;
    expect(smoke.recordsPerSnapshot).toBe(RUNTIME_POLICY_LIMITS.history.maximumAircraft);
    expect(maximum.recordsPerSnapshot).toBe(RUNTIME_POLICY_LIMITS.protocol.maximumAircraft);
    expect(smoke.admittedViewers).toBe(RUNTIME_POLICY_LIMITS.delivery.maximumRegionalViewers);
    expect(smoke.offeredViewers).toBe(RUNTIME_POLICY_LIMITS.delivery.maximumRegionalViewers + 1);
  });
});
